const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteLucene, luceneFields, LuceneError, MAX_LENGTH, MAX_CLAUSES } = require('../../lib/lucene');

const fields = luceneFields({
  fields: { id: 'url', source: 'host', share: 'share', title: 'title', filename: 'filename', type: 'filetype', created: 'timestamp', modified: 'last_modified', size: 'content_length', content: 'content' },
  extra_fields: ['email_from', 'email_to', 'email_cc', 'email_subject', 'email_attachments', 'email_thread_id'],
});
const rw = q => rewriteLucene(q, fields);
const refused = (q, re) => assert.throws(() => rw(q), e => e instanceof LuceneError && e.status === 400 && (!re || re.test(e.message)), `should refuse: ${q}`);

test('ordinary queries come through unchanged', () => {
  for (const q of [
    'budget', 'budget review', 'a AND b', 'a OR b', 'NOT a', 'a && b', 'a || b', '+a -b', '!a',
    '"exact phrase"', '"a phrase"~3', 'wor*', 'te?t', 'word~', 'word~2', 'word^3', '(a OR b) AND c',
    '((a))', '"a\\"b"', 'a\\:b', 'well-known', '[a TO b]', '{a TO b}', '[a TO b}',
  ]) assert.equal(rw(q), q);
});

test('line breaks are just spaces', () => {
  assert.equal(rw('from:alice\nAND (budget\r\nOR forecast)'), 'email_from:alice\nAND (budget\r\nOR forecast)');
  refused('a\nrole:x');
  refused('role\n:x');
});

test('friendly names become the indexed fields', () => {
  assert.equal(rw('from:alice'), 'email_from:alice');
  assert.equal(rw('to:a cc:b subject:c attachment:d thread:e'), 'email_to:a email_cc:b email_subject:c email_attachments:d email_thread_id:e');
  assert.equal(rw('type:pdf file:x body:y'), 'filetype:pdf filename:x content:y');
  assert.equal(rw('size:>=10 source:h share:s title:t'), 'content_length:>=10 host:h share:s title:t');
  assert.equal(rw('from : alice'), 'email_from: alice');
  assert.equal(rw('from:(alice OR bob)'), 'email_from:(alice OR bob)');
  assert.equal(rw('-from:alice +to:bob !cc:carol'), '-email_from:alice +email_to:bob !email_cc:carol');
  assert.equal(rw('date:[2001-01-01 TO 2001-12-31]'), 'timestamp:[2001-01-01 TO 2001-12-31]');
  assert.equal(rw('date:[2001-01-01T00:00:00 TO *]'), 'timestamp:[2001-01-01T00:00:00 TO *]');
  assert.equal(rw('email_from:alice'), 'email_from:alice');
  assert.equal(rw('"from:alice"'), '"from:alice"', 'inside quotes it\'s text');
});

test('no way of naming another field gets through', () => {
  for (const q of [
    'role:x', 'ROLE:x', 'role :x', 'role : x', 'role\t:x', 'role\n:x', 'role　:x', 'role :x', 'role:(x y)',
    'a OR role:x', '(role:x)', '((a) OR (role:x))', '+role:x', '-role:x', '!role:x', 'NOT role:x',
    'ro\\le:x', '\\role:x', 'role\\:x:y', 'r\\u006fle:x', 'ro*e:x', 'rol?:x', '*:x', '?:x', '_exists_:role', '_id:1',
    '_index:documents', 'url:x', 'content_embedding:x', 'content_chunks:x', 'title.keyword:x',
    '"role":x', '"role" : x', 'from:role:x', 'from:a:b', 'a~role:x', 'a^2:x', 'a^role:x', 'a!role:x', 'a&&role:x', 'a||role:x',
    '>=role:x', '<role:x', 'from:(role:x)', 'from:(a OR (role:x))',
    '[a TO b]:x', '[a TO b]role:x'.replace(']', ']:'),
  ]) refused(q);
});

test('nothing can hide a field name inside something else', () => {
  // Lucene ends a range word at ], so a backslash doesn't protect it.
  refused('[a\\] role:x [b TO c]');
  refused('{a\\} role:x {b TO c}');
  refused('[a" TO b] role:x "c]');
  refused('[a TO b role:x]');
  assert.throws(() => rw('[a TO b] role:x'), /isn't a field/, 'a range ends where it ends');
  assert.throws(() => rw('"a" role:x "b"'), /isn't a field/);
  assert.throws(() => rw('"a\\" b" role:x'), /isn't a field/);
  refused('"a\\" role:x');
});

test('slow or unavailable forms are refused', () => {
  refused('/ab+c/', /Regular expressions/);
  refused('a/b/c', /Regular expressions/);
  refused('from:/ab/', /Regular expressions/);
  refused('*', /wildcard/);
  refused('*abc', /wildcard/);
  refused('?abc', /wildcard/);
  refused('from:*x', /wildcard/);
  refused('+*abc', /wildcard/);
  refused('a*b*c*d*e*f', /wildcards/);
  assert.equal(rw('\\*abc'), '\\*abc', 'an escaped star is just a star');
  refused('x'.repeat(MAX_LENGTH + 1), /up to/);
  refused(Array.from({ length: MAX_CLAUSES + 1 }, (_, i) => `w${i}`).join(' '), /terms/);
  assert.ok(rw(Array.from({ length: MAX_CLAUSES }, (_, i) => `w${i}`).join(' ')));
  refused(`${'('.repeat(21)}a${')'.repeat(21)}`, /nest/);
  refused('a\u0000b');
});

test('mistakes get a message saying where', () => {
  refused('(a', /bracket at character 1 is never closed/);
  refused('a)', /closing bracket .* at character 2/);
  refused('a]', /closing bracket/);
  refused('"a', /quote at character 1 is never closed/);
  refused('[a TO', /range at character 1/);
  refused('a\\', /backslash/);
  refused(':a', /colon with no field/);
  refused('from:', /nothing to search/);
  refused('(from:)', /nothing to search/);
  refused('nosuch:a', /"nosuch" isn't a field you can search at character 1/);
  refused('12:30', /put the term in quotes/);
});

test('a year or month means all of it', () => {
  assert.equal(rw('date:2001'), 'timestamp:[2001-01-01 TO 2001-12-31]');
  assert.equal(rw('date:2001-12'), 'timestamp:[2001-12-01 TO 2001-12-31]');
  assert.equal(rw('date:2004-02'), 'timestamp:[2004-02-01 TO 2004-02-29]', 'a leap year');
  assert.equal(rw('date:2001-02'), 'timestamp:[2001-02-01 TO 2001-02-28]');
  assert.equal(rw('modified:2001'), 'last_modified:[2001-01-01 TO 2001-12-31]');
  assert.equal(rw('timestamp:2001'), 'timestamp:[2001-01-01 TO 2001-12-31]');
  assert.equal(rw('date: 2001'), 'timestamp: [2001-01-01 TO 2001-12-31]');
  assert.equal(rw('date:"2001"'), 'timestamp:[2001-01-01 TO 2001-12-31]');
  assert.equal(rw('-date:2001'), '-timestamp:[2001-01-01 TO 2001-12-31]');
  assert.equal(rw('date:2001^2'), 'timestamp:[2001-01-01 TO 2001-12-31]^2');
  assert.equal(rw('date:2001 AND 2001'), 'timestamp:[2001-01-01 TO 2001-12-31] AND 2001', 'only that term');
  assert.equal(rw('date:(2001 OR 2003-05)'), 'timestamp:([2001-01-01 TO 2001-12-31] OR [2003-05-01 TO 2003-05-31])');
  assert.equal(rw('date:(2001) budget'), 'timestamp:([2001-01-01 TO 2001-12-31]) budget');
});

test('exact dates are left alone', () => {
  for (const d of ['2001-05-14', '>=2001-05-14', '<2001-05-14', '"2001-05-14T10:30:00"', '"2001-05-14T10:30:00Z"', '[2001-01-01 TO 2001-12-31]', '{2001-01-01 TO *}', '[* TO 2001-12-31]', '[2001-01-01T00:00:00 TO *]']) {
    assert.equal(rw(`date:${d}`), `timestamp:${d}`);
  }
});

test('comparing with a year or month treats it as a whole period', () => {
  assert.equal(rw('date:>=2001-12'), 'timestamp:>=2001-12-01');
  assert.equal(rw('date:>2001-12'), 'timestamp:>=2002-01-01');
  assert.equal(rw('date:<2001-12'), 'timestamp:<2001-12-01');
  assert.equal(rw('date:<=2001-12'), 'timestamp:<=2001-12-31');
  assert.equal(rw('date:>2001'), 'timestamp:>=2002-01-01');
  assert.equal(rw('date:<=2001'), 'timestamp:<=2001-12-31');
});

test('a range covers its whole first and last period', () => {
  assert.equal(rw('date:[2001 TO 2001]'), 'timestamp:[2001-01-01 TO 2001-12-31]');
  assert.equal(rw('date:[2001-05 TO 2001-06]'), 'timestamp:[2001-05-01 TO 2001-06-30]');
  assert.equal(rw('date:[2001 TO *]'), 'timestamp:[2001-01-01 TO *]');
  assert.equal(rw('date:[* TO 2001-06]'), 'timestamp:[* TO 2001-06-30]');
  assert.equal(rw('date:{2001 TO 2003}'), 'timestamp:[2002-01-01 TO 2003-01-01}', 'excludes both years');
  assert.equal(rw('date:[2001-05-14 TO 2001-06]'), 'timestamp:[2001-05-14 TO 2001-06-30]');
  assert.equal(rw('date:"2001"'.replace('"2001"', '["2001" TO "2002"]')), 'timestamp:[2001-01-01 TO 2002-12-31]');
  assert.equal(rw('[2001 TO 2002]'), '[2001 TO 2002]', 'not in a date field');
});

test('anything but an ISO date is refused in a date field', () => {
  for (const d of ['December', '2001-13', '2001-00', '2001-1', '2001-02-30', '2001-2-3', '01-2001', '200', '20011', '2001*', '200?', '*', '01/2001', '2001-05-14T25', 'AND']) {
    refused(`date:${d}`, /isn't a date|ISO/);
  }
  refused('date:(2001 OR banana)', /isn't a date/);
  refused('date:[banana TO 2001]', /isn't a date/);
  refused('modified:banana', /isn't a date/);
  refused('date:2001/12', /slash/);
  refused('date:>= 2001', /isn't a date/);
});

test('date handling opens no gap in the field check', () => {
  refused('date:2001 role:x', /isn't a field/);
  refused('date:(2001 OR role:x)', /isn't a field/);
  refused('date:(from:(role:x))', /isn't a field/);
  assert.equal(rw('date:(2001 AND from:bob)'), 'timestamp:([2001-01-01 TO 2001-12-31] AND email_from:bob)');
  assert.equal(rw('size:2001 from:2001'), 'content_length:2001 email_from:2001', 'other fields are untouched');
  assert.equal(rw('date:(from:2001 OR 2002)'), 'timestamp:(email_from:2001 OR [2002-01-01 TO 2002-12-31])');
});

test('attachment:true and false ask whether an email has any', () => {
  const none = '(_exists_:email_from NOT _exists_:email_attachments)';
  assert.equal(rw('attachment:true'), '_exists_:email_attachments');
  assert.equal(rw('attachment:false'), none);
  assert.equal(rw('attachment : TRUE'), '_exists_:email_attachments');
  assert.equal(rw('email_attachments:false'), none);
  assert.equal(rw('subject:x AND attachment:false'), `email_subject:x AND ${none}`);
  assert.equal(rw('-attachment:true'), '-_exists_:email_attachments');
  assert.equal(rw('(attachment:true)'), '(_exists_:email_attachments)');
  assert.equal(rw('attachment:"true"'), 'email_attachments:"true"', 'in quotes it\'s a name');
  assert.equal(rw('attachment:trueish'), 'email_attachments:trueish');
  assert.equal(rw('attachment:(true)'), 'email_attachments:(true)');
  assert.equal(rw('subject:true body:false'), 'email_subject:true content:false', 'only this field');
  refused('_exists_:email_attachments', /isn't a field/);
  refused('attachment:true role:x', /isn't a field/);
});

test('the list of fields comes from the configuration, and never holds the role field', () => {
  assert.equal(fields.has('role'), false);
  assert.equal(fields.has('url'), false);
  const bare = luceneFields({ fields: { title: 'name' }, extra_fields: [] });
  assert.equal(bare.get('title'), 'name');
  assert.equal(bare.has('from'), false);
  assert.equal(bare.has('content'), false);
});

test('every example in the guide is accepted', () => {
  const help = fs.readFileSync(path.join(__dirname, '../../public/help.html'), 'utf8');
  const table = /<table id="advanced-examples">([\s\S]*?)<\/table>/.exec(help)[1];
  const examples = [...table.matchAll(/<code>(.*?)<\/code>/g)].map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  assert.ok(examples.length >= 30);
  for (const q of examples) assert.ok(rw(q), q);
});
