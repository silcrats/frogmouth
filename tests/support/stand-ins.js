// Preloaded into the server under test (node -r): sign-in without LDAP, and a small
// OpenSearch that evaluates the parts of the query language Frogmouth uses. It sits
// on the port in STUB_OS_PORT, and also answers /__ requests to control it and show
// what it was asked, so that a test can check the queries themselves.
const http = require('http');
const Module = require('module');
const { makeDocs } = require('./fixtures');

const USERS = { alice: ['Finance'], bob: ['Engineering'], dave: [] };
const load = Module._load;
Module._load = function stubbed(request, ...rest) {
  if (!request.endsWith('auth/ldap')) return load.call(this, request, ...rest);
  return {
    createLdapAuth: () => ({
      describe: () => 'stand-in',
      authenticate: async (username, password) => {
        if (password === 'wrong' || !Object.hasOwn(USERS, String(username).toLowerCase())) throw new Error('bad credentials');
        return { groups: USERS[String(username).toLowerCase()], displayName: username };
      },
    }),
  };
};

let docs = makeDocs();
let requests = [];
let failNext = 0;
const secret = () => docs.find(d => d.url.endsWith('secret.pdf'));

const text = d => [d.title, d.content, d.email_subject, d.filename, d.email_from].map(x => String(x || '').toLowerCase());

// Enough of query_string for tests: words and field:word, with AND, OR and NOT.
function queryString(doc, query) {
  const parts = query.replace(/[()]/g, ' ').match(/"[^"]*"|\S+/g) || [];
  let result = null;
  let join = 'AND';
  let negate = false;
  for (const part of parts) {
    if (part === 'AND' || part === 'OR') { join = part; continue; }
    if (part === 'NOT') { negate = true; continue; }
    const [, field, raw] = /^(?:([\w.]+):)?(.*)$/.exec(part);
    const word = raw.replace(/"/g, '').replace(/[*~^\d.]+$/, '').toLowerCase();
    let hit = field
      ? [].concat(doc[field] ?? []).some(v => String(v).toLowerCase().includes(word))
      : text(doc).some(v => v.includes(word));
    if (negate) hit = !hit;
    result = result === null ? hit : join === 'OR' ? result || hit : result && hit;
    join = 'AND';
    negate = false;
  }
  return result ?? true;
}

function matches(doc, clause) {
  if (!clause) return true;
  if (clause.bool) {
    const b = clause.bool;
    return (b.must || []).every(c => matches(doc, c)) && (b.filter || []).every(c => matches(doc, c))
      && !(b.must_not || []).some(c => matches(doc, c)) && (!b.should || b.should.some(c => matches(doc, c)));
  }
  if (clause.terms) {
    const [field, values] = Object.entries(clause.terms)[0];
    return [].concat(doc[field] ?? []).some(v => values.includes(v));
  }
  if (clause.term) {
    const [field, value] = Object.entries(clause.term)[0];
    return [].concat(doc[field] ?? []).includes(value);
  }
  if (clause.range) {
    const [field, range] = Object.entries(clause.range)[0];
    if (!doc[field]) return false;
    const time = Date.parse(doc[field]);
    return (!range.gte || time >= Date.parse(range.gte)) && (!range.lte || time <= Date.parse(range.lte));
  }
  if (clause.multi_match && clause.multi_match.query) {
    const q = clause.multi_match.query.toLowerCase();
    return text(doc).some(v => v.includes(q));
  }
  if (clause.query_string) return queryString(doc, clause.query_string.query);
  return true;  // match_all, and nearest-neighbour queries: everything is some distance away
}

function pick(doc, fields) {
  if (!Array.isArray(fields)) return doc;
  const kept = {};
  for (const [key, value] of Object.entries(doc)) {
    if (fields.includes(key) || (key === 'content_embedding' && fields.includes('content_embedding.knn'))) kept[key] = value;
  }
  return kept;
}

function search(body) {
  const hits = docs.filter(doc => matches(doc, body.query));
  const from = body.from || 0;
  const size = body.size ?? 10;
  return {
    _shards: { total: 1, failed: 0 },
    hits: {
      total: { value: hits.length },
      hits: hits.slice(from, from + size).map(doc => ({
        _source: pick(doc, body._source),
        ...(body.script_fields && { fields: { like_text: [String(doc.content || '').slice(0, 20000)] } }),
      })),
    },
  };
}

function parseError() {
  return { error: { root_cause: [{ type: 'query_shard_exception', reason: 'Failed to parse query [stand-in]' }], type: 'search_phase_execution_exception', reason: 'all shards failed' }, status: 400 };
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const reply = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    if (req.url === '/__requests') return reply(200, requests);
    if (req.url === '/__clear') { requests = []; return reply(200, {}); }
    if (req.url === '/__revoke') { secret().role = ['nobody']; return reply(200, {}); }
    if (req.url === '/__grant') { secret().role = ['1alice']; return reply(200, {}); }
    if (req.url === '/__reset') { docs = makeDocs(); requests = []; return reply(200, {}); }
    if (req.url.startsWith('/__fail')) { failNext = Number(req.url.split('=')[1]) || 1; return reply(200, {}); }
    if (!req.url.includes('_search')) return reply(200, { count: docs.length });
    const body = JSON.parse(raw || '{}');
    requests.push(body);
    if (failNext > 0) { failNext--; return reply(500, { error: 'stand-in failure' }); }
    if (JSON.stringify(body.query || {}).includes('FORCEPARSEERROR')) return reply(400, parseError());
    return reply(200, search(body));
  });
}).listen(Number(process.env.STUB_OS_PORT), '127.0.0.1');
