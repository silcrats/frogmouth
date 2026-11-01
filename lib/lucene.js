// ---------------------------------------------------------------------
// Advanced search: Lucene query syntax, checked before OpenSearch sees it.
// query_string lets a query name any field, so every field name has to be one
// of those listed here: a person's roles, for one, aren't searchable. The
// scanner follows Lucene's own rules for where a token ends, and refuses
// whatever it can't be sure of (a backslash in a range, say), because a query
// read differently here and there could hide a field name from this check.
// The role filter is applied outside this query in any case.
// ---------------------------------------------------------------------
const MAX_LENGTH = 2000;
const MAX_CLAUSES = 200;
const MAX_DEPTH = 20;
const MAX_WILDCARDS_PER_WORD = 4;

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '　']);
const ENDS_WORD = new Set([...WHITESPACE, '(', ')', '"', '[', ']', '{', '}', '^', '~', ':', '!', '/']);
// Lucene's range words stop at these, with no escaping, so neither is allowed here.
const RANGE_WORD = '(?:"[^"\\\\]*"|[^\\s"\\\\\\[\\]{}()]+)';
const RANGE = new RegExp(`^([\\[{])[ \\t]*(${RANGE_WORD})[ \\t]+TO[ \\t]+(${RANGE_WORD})[ \\t]*([\\]}])`);
const ISO_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(?:[01]\d|2[0-3])(?::[0-5]\d(?::[0-5]\d(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)?)?$/;
const pad = n => String(n).padStart(2, '0');

class LuceneError extends Error {
  constructor(message) { super(message); this.status = 400; this.expose = true; }
}

// OpenSearch only fills in a date's missing time, not a missing month or day:
// on its own "2001" means one instant and finds nothing. So a year or month is
// turned here into the days it covers. Returns those days, or just the date if
// it's more exact than a month, or null if it isn't a real ISO date.
function parseDate(text) {
  const m = ISO_DATE.exec(text);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), m[2] && Number(m[2]), m[3] && Number(m[3])];
  if (month !== undefined && (month < 1 || month > 12)) return null;
  const lastDay = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (day !== undefined) {
    if (day < 1 || day > lastDay(year, month)) return null;
    return { first: text, last: text };
  }
  if (month === undefined) {
    return { partial: true, first: `${m[1]}-01-01`, last: `${m[1]}-12-31`, after: `${pad4(year + 1)}-01-01` };
  }
  const after = month === 12 ? `${pad4(year + 1)}-01-01` : `${m[1]}-${pad(month + 1)}-01`;
  return { partial: true, first: `${m[1]}-${m[2]}-01`, last: `${m[1]}-${m[2]}-${pad(lastDay(year, month))}`, after };
}
const pad4 = n => String(n).padStart(4, '0');

// Names people can type, and the indexed field each means.
function luceneFields(config) {
  const F = config.fields;
  const extras = new Set(config.extra_fields || []);
  const email = (name, field) => (extras.has(field) ? { [name]: field } : {});
  const named = {
    content: F.content, body: F.content,
    title: F.title,
    file: F.filename, filename: F.filename,
    type: F.type,
    share: F.share,
    source: F.source,
    date: F.created,
    modified: F.modified,
    size: F.size,
    ...email('from', 'email_from'),
    ...email('to', 'email_to'),
    ...email('cc', 'email_cc'),
    ...email('subject', 'email_subject'),
    ...email('attachment', 'email_attachments'),
    ...email('thread', 'email_thread_id'),
  };
  const fields = new Map();
  fields.dates = new Set([F.created, F.modified].filter(Boolean));
  // Whether an email has attachments: the field is only there if it does, and
  // every email has a sender, which keeps other files out of "has none".
  if (extras.has('email_attachments') && extras.has('email_from')) {
    fields.attachmentFlag = { field: 'email_attachments', email: 'email_from' };
  }
  for (const [name, field] of Object.entries(named)) {
    if (!field) continue;
    fields.set(name, field);
    fields.set(field, field); // the indexed name works too
  }
  return fields;
}

function rewriteLucene(query, fields) {
  if (query.length > MAX_LENGTH) throw new LuceneError(`An advanced search can be up to ${MAX_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(query)) throw new LuceneError('This search has a character that can\'t be used');

  const at = i => `at character ${i + 1}`;
  const out = [];
  const open = [];
  let clauses = 0;
  let i = 0;
  let dateNext = null; // after a field's colon: whether that field holds dates

  const inDates = () => dateNext ?? (open.length > 0 && open[open.length - 1].dates);
  const readDate = (text, where) => {
    const date = parseDate(text);
    if (!date) throw new LuceneError(`"${text.slice(0, 50)}" isn't a date ${at(where)}. Dates use ISO format: 2001, 2001-12 or 2001-12-31`);
    return date;
  };
  const dateWord = (word, where) => {
    const [, op, text] = /^(>=|<=|>|<)?(.*)$/s.exec(word);
    const date = readDate(text, where);
    if (!date.partial) return word;
    if (op === '>=') return `>=${date.first}`;
    if (op === '>') return `>=${date.after}`;
    if (op === '<') return `<${date.first}`;
    if (op === '<=') return `<=${date.last}`;
    return `[${date.first} TO ${date.last}]`;
  };
  const dateRange = (m, where) => {
    const unquote = text => text.replace(/^"|"$/g, '');
    const [opening, low, high, closing] = [m[1], unquote(m[2]), unquote(m[3]), m[4]];
    let [start, from] = [opening, low];
    if (low !== '*') {
      const date = readDate(low, where);
      if (date.partial) [start, from] = opening === '[' ? ['[', date.first] : ['[', date.after];
    }
    let [to, end] = [high, closing];
    if (high !== '*') {
      const date = readDate(high, where);
      if (date.partial) [to, end] = closing === ']' ? [date.last, ']'] : [date.first, '}'];
    }
    return `${start}${from} TO ${to}${end}`;
  };

  const skipSpace = from => {
    let j = from;
    while (j < query.length && WHITESPACE.has(query[j])) j++;
    return j;
  };
  const isColonAt = j => query[skipSpace(j)] === ':';
  const countClause = () => {
    if (++clauses > MAX_CLAUSES) throw new LuceneError(`An advanced search can have up to ${MAX_CLAUSES} terms`);
  };

  while (i < query.length) {
    const c = query[i];
    if (WHITESPACE.has(c) || c === '^' || c === '~' || c === '!' || c === '+' || c === '-') {
      out.push(c);
      i++;
    } else if (c === '(') {
      open.push({ at: i, dates: inDates() });
      dateNext = null;
      if (open.length > MAX_DEPTH) throw new LuceneError(`An advanced search can nest brackets up to ${MAX_DEPTH} deep`);
      out.push(c);
      i++;
    } else if (c === ')') {
      if (!open.length) throw new LuceneError(`There's a closing bracket with no opening one ${at(i)}`);
      open.pop();
      out.push(c);
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < query.length && query[j] !== '"') j += query[j] === '\\' ? 2 : 1;
      if (j >= query.length) throw new LuceneError(`The quote ${at(i)} is never closed`);
      if (isColonAt(j + 1)) throw new LuceneError(`A field name can't be in quotes ${at(i)}`);
      countClause();
      if (inDates()) {
        const date = readDate(query.slice(i + 1, j), i);
        out.push(date.partial ? `[${date.first} TO ${date.last}]` : query.slice(i, j + 1));
      } else out.push(query.slice(i, j + 1));
      dateNext = null;
      i = j + 1;
    } else if (c === '[' || c === '{') {
      const m = RANGE.exec(query.slice(i));
      if (!m) throw new LuceneError(`The range ${at(i)} should look like [2001-01-01 TO 2001-12-31], with no backslashes`);
      if (isColonAt(i + m[0].length)) throw new LuceneError(`A range can't be followed by a colon ${at(i)}`);
      countClause();
      out.push(inDates() ? dateRange(m, i) : m[0]);
      dateNext = null;
      i += m[0].length;
    } else if (c === ']' || c === '}') {
      throw new LuceneError(`There's a closing bracket with no opening one ${at(i)}`);
    } else if (c === '/') {
      throw new LuceneError(`Regular expressions aren't available. To search for a slash ${at(i)}, put the term in quotes`);
    } else if (c === ':') {
      throw new LuceneError(`There's a colon with no field name ${at(i)}`);
    } else {
      // A word, or an operator such as + or AND, or a field name if a colon follows.
      let j = i;
      while (j < query.length && !ENDS_WORD.has(query[j])) {
        if (query[j] === '\\') {
          if (j + 1 >= query.length) throw new LuceneError('A search can\'t end with a backslash');
          j += 2;
        } else j++;
      }
      const word = query.slice(i, j);
      if (isColonAt(j)) {
        const field = fields.get(word);
        if (!field) {
          throw new LuceneError(`"${word.slice(0, 50)}" isn't a field you can search ${at(i)}. To search for a colon, put the term in quotes`);
        }
        const flag = fields.attachmentFlag && fields.attachmentFlag.field === field
          ? /^(true|false)(?=[ \t\r\n\u3000)]|$)/i.exec(query.slice(skipSpace(skipSpace(j) + 1))) : null;
        if (flag) {
          const { email } = fields.attachmentFlag;
          countClause();
          out.push(flag[1].toLowerCase() === 'true' ? `_exists_:${field}` : `(_exists_:${email} NOT _exists_:${field})`);
          i = skipSpace(skipSpace(j) + 1) + flag[0].length;
          continue;
        }
        out.push(`${field}:`);
        dateNext = fields.dates.has(field);
        i = skipSpace(j) + 1;
        const next = skipSpace(i);
        if (next >= query.length || query[next] === ')') throw new LuceneError(`The field ${word} has nothing to search for ${at(i - 1)}`);
      } else if (inDates() && (dateNext || !['AND', 'OR', 'NOT', '&&', '||'].includes(word))) {
        out.push(dateWord(word, i));
        countClause();
        dateNext = null;
        i = j;
      } else {
        if (word !== '&&' && word !== '||') {
          if (/^[*?]/.test(word)) throw new LuceneError(`A term can't start with a wildcard ${at(i)}`);
          if ((word.replace(/\\./g, '').match(/[*?]/g) || []).length > MAX_WILDCARDS_PER_WORD) {
            throw new LuceneError(`A term can have up to ${MAX_WILDCARDS_PER_WORD} wildcards ${at(i)}`);
          }
          if (!['AND', 'OR', 'NOT'].includes(word)) countClause();
        }
        dateNext = null;
        out.push(word);
        i = j;
      }
    }
  }
  if (open.length) throw new LuceneError(`The bracket ${at(open[open.length - 1].at)} is never closed`);
  return out.join('');
}

module.exports = { rewriteLucene, luceneFields, LuceneError, MAX_LENGTH, MAX_CLAUSES };
