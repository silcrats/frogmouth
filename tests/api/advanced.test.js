// Advanced search hands people's own text to a query parser, so the checks that
// matter are that it can't name a hidden field or step outside the role filter.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');

const enc = encodeURIComponent;
const advanced = (q, extra = '') => `/api/search?mode=advanced&q=${enc(q)}${extra}`;
const SECRET = 'smb://srv/share/secret.pdf';

test('advanced search', async t => {
  const app = await startApp();
  t.after(() => app.stop());
  const [alice, bob] = await Promise.all(['alice', 'bob'].map(app.login));

  await t.test('is offered with vector search off', async () => {
    assert.deepEqual((await alice.call('GET', '/api/config')).body.search_modes, ['keyword', 'advanced']);
    assert.equal((await alice.call('GET', advanced('report'))).status, 200);
    assert.equal((await alice.call('GET', '/api/search?mode=semantic&q=x')).status, 400, 'semantic still needs it');
  });

  await t.test('sends a query_string inside the role filter, with field names rewritten', async () => {
    await app.control('clear');
    const { body } = await alice.call('GET', advanced('from:alice AND report'));
    assert.equal(body.mode, 'advanced');
    const [req] = await app.control('requests');
    const inner = req.query.bool.must[0].query_string;
    assert.equal(inner.query, 'email_from:alice AND report');
    assert.equal(inner.allow_leading_wildcard, false);
    assert.equal(inner.default_operator, 'AND');
    assert.equal(inner.lenient, true);
    assert.deepEqual(req.query.bool.filter.find(c => c.terms && c.terms.role).terms.role.includes('1alice'), true);
    assert.equal(req.query.bool.filter.find(c => c.terms && c.terms.role).terms.role.includes('1bob'), false);
    assert.equal(req.timeout, '30s');
  });

  await t.test('can\'t reach a document the user isn\'t allowed', async () => {
    assert.ok((await alice.call('GET', advanced('secret'))).body.docs.some(d => d.id === SECRET));
    for (const q of ['secret', 'secret OR report', 'title:secret', 'NOT nothinglikethis', '(secret) OR (NOT secret)', 'secret OR title:secret']) {
      const { status, body } = await bob.call('GET', advanced(q));
      assert.equal(status, 200, q);
      assert.ok(!body.docs.some(d => d.id === SECRET), q);
    }
  });

  await t.test('refuses a hidden field before OpenSearch sees it, everywhere it\'s accepted', async () => {
    const c = (await alice.call('POST', '/api/collections', { name: 'Adv' })).body;
    await alice.call('POST', `/api/collections/${c.id}/items/bulk`, { ids: [SECRET] });
    await app.control('clear');
    for (const q of ['role:1alice', 'role : 1alice', 'ro\\le:x', 'ro*e:x', '*:x', '_exists_:role', '"role":x', 'from:(role:x)', '[a\\] role:x [b TO c]']) {
      for (const [method, path] of [
        ['GET', advanced(q)],
        ['GET', advanced(q, `&collection=${c.id}`)],
        ['GET', `/api/collections/${c.id}/timeline?mode=advanced&q=${enc(q)}`],
        ['POST', `/api/collections/${c.id}/items/from-search?mode=advanced&q=${enc(q)}`],
      ]) {
        const r = await alice.call(method, path);
        assert.equal(r.status, 400, `${method} ${path}`);
        assert.ok(r.body.error);
      }
    }
    assert.deepEqual(await app.control('requests'), [], 'none reached the index');
  });

  await t.test('other modes aren\'t checked, as their text is never parsed as a query', async () => {
    const r = await alice.call('GET', `/api/search?q=${enc('role:1alice')}`);
    assert.equal(r.status, 200);
  });

  await t.test('a query only OpenSearch objects to is a 400 with a plain message', async () => {
    const c = (await alice.call('POST', '/api/collections', { name: 'Adv2' })).body;
    for (const [method, path] of [
      ['GET', advanced('FORCEPARSEERROR')],
      ['GET', `/api/collections/${c.id}/timeline?mode=advanced&q=FORCEPARSEERROR`],
      ['POST', `/api/collections/${c.id}/items/from-search?mode=advanced&q=FORCEPARSEERROR`],
    ]) {
      const r = await alice.call(method, path);
      assert.equal(r.status, 400, path);
      assert.match(r.body.error, /couldn't read that search/);
      assert.equal(r.body.detail, undefined, 'no internals');
    }
    assert.equal((await alice.call('GET', '/api/search?q=FORCEPARSEERROR')).status, 502, 'in keyword mode it\'s a failure of ours');
  });

  await t.test('works in a collection, its timeline, and Add all', async () => {
    const docs = (await alice.call('GET', '/api/search?q=&rows=30')).body.docs;
    const c = (await alice.call('POST', '/api/collections', { name: 'Adv3' })).body;
    await alice.call('POST', `/api/collections/${c.id}/items/bulk`, { ids: docs.slice(0, 6).map(d => d.id) });
    const one = docs[0].title;
    const inside = await alice.call('GET', advanced(`title:"${one}"`, `&collection=${c.id}`));
    assert.ok(inside.body.docs.every(d => docs.slice(0, 6).some(x => x.id === d.id)));
    const timeline = await alice.call('GET', `/api/collections/${c.id}/timeline?mode=advanced&q=${enc('NOT nothinglikethis')}`);
    assert.equal(timeline.status, 200);
    assert.equal(timeline.body.numFound, 6);
    const target = (await alice.call('POST', '/api/collections', { name: 'Adv4' })).body;
    const added = await alice.call('POST', `/api/collections/${target.id}/items/from-search?mode=advanced&q=${enc('report')}`);
    assert.equal(added.status, 201);
    assert.ok(added.body.added.length > 0);
  });

  await t.test('attachment:false is checked and sent as a question about emails', async () => {
    await app.control('clear');
    assert.equal((await alice.call('GET', advanced('attachment:false'))).status, 200);
    const [req] = await app.control('requests');
    assert.equal(req.query.bool.must[0].query_string.query, '(_exists_:email_from NOT _exists_:email_attachments)');
    assert.ok(req.query.bool.filter.some(c => c.terms && c.terms.role), 'inside the role filter');
  });

  await t.test('a blank search browses', async () => {
    const r = await alice.call('GET', '/api/search?mode=advanced&q=');
    assert.equal(r.body.mode, 'keyword');
    assert.ok(r.body.numFound > 0);
  });
});

test('advanced search with vector search on', async t => {
  const app = await startApp({ vector: true });
  t.after(() => app.stop());
  const alice = await app.login('alice');
  assert.deepEqual((await alice.call('GET', '/api/config')).body.search_modes, ['keyword', 'semantic', 'hybrid', 'advanced']);
  await app.control('clear');
  await alice.call('GET', advanced('report'));
  const [req] = await app.control('requests');
  assert.ok(req.query.bool.must[0].query_string, 'not hybrid');
});
