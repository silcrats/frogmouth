const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startApp } = require('../support/harness');

const SECRET = 'smb://srv/share/secret.pdf';
const doc = i => `smb://srv/share/file${i}.${['pdf', 'docx', 'eml', 'xlsx'][i % 4]}`;

test('collections, searching them and their timeline', async t => {
  const app = await startApp();
  t.after(() => app.stop());
  const alice = await app.login('alice');
  const make = async (name, ids = []) => {
    const c = (await alice.call('POST', '/api/collections', { name })).body;
    if (ids.length) await alice.call('POST', `/api/collections/${c.id}/items/bulk`, { ids });
    return c;
  };

  await t.test('names must be present, sensible and unique', async () => {
    assert.equal((await alice.call('POST', '/api/collections', { name: '' })).status, 400);
    assert.equal((await alice.call('POST', '/api/collections', { name: 'x'.repeat(101) })).status, 400);
    await make('dup');
    assert.equal((await alice.call('POST', '/api/collections', { name: 'dup' })).status, 409);
  });

  const c = await make('scoped', [doc(0), doc(1), doc(6), SECRET]);
  const P = `/api/collections/${c.id}`;

  await t.test('a search stays inside a collection', async () => {
    assert.equal((await alice.call('GET', `/api/search?q=&collection=${c.id}&rows=50`)).body.numFound, 4);
    const r = await alice.call('GET', `/api/search?q=harbour&collection=${c.id}`);
    assert.deepEqual(r.body.docs.map(d => d.id).sort(), [doc(0), doc(1)].sort());
    assert.ok((await alice.call('GET', '/api/search?q=vaccine')).body.numFound > 0);
    assert.equal((await alice.call('GET', `/api/search?q=vaccine&collection=${c.id}`)).body.numFound, 0);
  });

  await t.test('missing and malformed collections are refused', async () => {
    for (const id of ['999999', 'abc']) assert.equal((await alice.call('GET', `/api/search?q=&collection=${id}`)).status, 404);
  });

  await t.test('the timeline narrows to a search, oldest first', async () => {
    const r = (await alice.call('GET', `${P}/timeline?q=harbour`)).body;
    assert.equal(r.numFound, 2);
    assert.equal(r.buckets.reduce((sum, b) => sum + b.count, 0), 2);
    assert.ok(r.docs[0].created <= r.docs[1].created);
    assert.equal((await alice.call('GET', `${P}/timeline`)).body.numFound, 4);
    assert.equal((await alice.call('GET', `${P}/timeline?q=nothinglikethis`)).body.numFound, 0);
  });

  await t.test('the timeline\'s search is limited to the collection in the query itself', async () => {
    // Regression: filtering afterwards loses matches once the index has over 1,000
    // better ones, which a small test index can't show by its results alone.
    await app.control('clear');
    await alice.call('GET', `${P}/timeline?q=harbour`);
    const search = (await app.control('requests')).find(r => r.size === 1000 && r.query.bool && r.query.bool.must);
    assert.ok(search.query.bool.filter.some(f => f.terms && f.terms.url && f.terms.url.length === 4));
  });

  await t.test('matches can be copied to another collection', async () => {
    const other = await make('copy');
    const r = await alice.call('POST', `/api/collections/${other.id}/items/from-search?q=harbour&collection=${c.id}`);
    assert.equal(r.status, 201);
    assert.equal(r.body.added.length, 2);
  });

  await t.test('facets stay in the collection', async () => {
    await app.control('clear');
    assert.equal((await alice.call('GET', `/api/facets?collection=${c.id}`)).status, 200);
    const [req] = await app.control('requests');
    assert.ok(JSON.stringify(req.query).includes(doc(0)));
  });

  await t.test('pages go up to 1,000 and no further', async () => {
    assert.equal((await alice.call('GET', `${P}?rows=5000`)).status, 200);
    await app.control('clear');
    await alice.call('GET', '/api/search?q=&rows=5000');
    assert.equal((await app.control('requests'))[0].size, 1000);
  });

  await t.test('hybrid search reaches as deep as the page asked for', async () => {
    const vector = await startApp({ vector: true });
    t.after(() => vector.stop());
    const bob = await vector.login('bob');
    await bob.call('GET', '/api/search?q=x&mode=hybrid&rows=1000');
    assert.equal((await vector.control('requests')).at(-1).query.hybrid.pagination_depth, 1000);
    assert.equal((await alice.call('GET', '/api/search?q=x&mode=hybrid')).status, 400, 'not offered with vector search off');
  });

  await t.test('deleting a collection takes its board and versions with it', async () => {
    const gone = await make('gone', [doc(1)]);
    const G = `/api/collections/${gone.id}`;
    await alice.call('PUT', `${G}/board`, { revision: 0, board: { objects: [] } });
    await alice.call('POST', `${G}/board/versions`, { name: 'v' });
    await alice.call('DELETE', G);
    const db = new DatabaseSync(app.dbPath);
    assert.equal(db.prepare('select count(*) n from boards where collection_id = ?').get(gone.id).n, 0);
    assert.equal(db.prepare('select count(*) n from board_versions where collection_id = ?').get(gone.id).n, 0);
    db.close();
  });
});

test('filters', async t => {
  const app = await startApp();
  t.after(() => app.stop());
  const alice = await app.login('alice');
  const search = (rows, extra = '') => alice.call('GET', `/api/search?q=&rows=50&filters=${encodeURIComponent(JSON.stringify(rows))}${extra}`);
  const all = (await alice.call('GET', '/api/search?q=&rows=50')).body;
  const inside = d => d.created >= '2016-01-01' && d.created < '2017-01-01';
  const range = '2016-01-01..2016-12-31';
  const expected = all.docs.filter(d => d.created && inside(d)).length;

  await t.test('date range: is', async () => {
    const r = await search([{ field: 'date_range', value: range }]);
    assert.equal(r.body.numFound, expected);
    assert.ok(expected > 0 && r.body.docs.every(inside));
  });

  await t.test('date range: is not keeps undated documents', async () => {
    const r = await search([{ field: 'date_range', value: range, not: true }]);
    assert.equal(r.body.numFound, all.numFound - expected);
    assert.ok(!r.body.docs.some(d => d.created && inside(d)));
    assert.ok(r.body.docs.some(d => !d.created));
  });

  await t.test('date range: either way round, or one end', async () => {
    assert.equal((await search([{ field: 'date_range', value: '2016-12-31..2016-01-01' }])).body.numFound, expected);
    assert.ok((await search([{ field: 'date_range', value: '2016-01-01..' }])).body.docs.every(d => d.created >= '2016-01-01'));
    assert.ok((await search([{ field: 'date_range', value: '..2015-12-31' }])).body.docs.every(d => d.created < '2016-01-01'));
  });

  await t.test('two ranges with ANY and ALL', async () => {
    const two = [{ field: 'date_range', value: '2015-01-01..2015-06-30' }, { field: 'date_range', value: '2017-01-01..2017-06-30' }];
    const any = await search(two, '&logic=OR');
    assert.ok(any.body.numFound > 0 && any.body.docs.every(d => /^(2015|2017)/.test(d.created)));
    assert.equal((await search(two, '&logic=AND')).body.numFound, 0);
  });

  await t.test('bad ranges are refused, and an unfinished row ignored', async () => {
    for (const value of ['nonsense', '2026-02-31..', '..2026-13-01', '..', '2016-01-01', '2016-01-01..2016-02-01..2016-03-01']) {
      assert.equal((await search([{ field: 'date_range', value }])).status, 400, value);
    }
    assert.equal((await search([{ field: 'date_range', value: '' }])).body.numFound, all.numFound);
  });

  await t.test('malformed filters are refused, not sent on', async () => {
    assert.equal((await alice.call('GET', '/api/search?q=&filters=notjson')).status, 400);
    assert.equal((await alice.call('GET', '/api/search?q=&filters=%7B%7D')).status, 400);
    assert.equal((await alice.call('GET', '/api/search?q=&dateFrom=yesterday')).status, 400);
    assert.equal((await alice.call('GET', '/api/search?q=&q=b')).status, 400);
    assert.equal((await alice.call('GET', '/api/search?q=x&mode=nonsense')).status, 400);
  });

  await t.test('the old date parameters still work', async () => {
    assert.equal((await alice.call('GET', '/api/search?q=&dateFrom=2016-01-01&dateTo=2016-12-31')).status, 200);
  });
});
