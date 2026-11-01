// Who can reach what. These are the tests that matter most: every way of reading
// documents has to apply the signed-in user's roles, and each user's collections
// have to be theirs alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');

const SECRET = 'smb://srv/share/secret.pdf';
const LEDGER = 'smb://srv/finance/ledger.pdf';
const PUBLIC = 'smb://srv/share/file1.docx';
const enc = encodeURIComponent;

test('access', async t => {
  const app = await startApp();
  t.after(() => app.stop());
  const [alice, bob, dave] = await Promise.all(['alice', 'bob', 'dave'].map(app.login));

  await t.test('nothing without signing in', async () => {
    for (const path of ['/api/search?q=x', '/api/collections', '/api/whoami', `/api/document?id=${enc(PUBLIC)}`, `/api/download?id=${enc(PUBLIC)}`, '/api/facets']) {
      assert.equal((await fetch(app.url + path)).status, 401, path);
    }
  });

  await t.test('a wrong password is refused', async () => {
    const res = await fetch(`${app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'wrong' }) });
    assert.equal(res.status, 401);
  });

  await t.test('every search carries the user\'s roles, in every mode', async () => {
    for (const q of ['', 'report']) {
      await app.control('clear');
      await dave.call('GET', `/api/search?q=${q}`);
      const [req] = await app.control('requests');
      const json = JSON.stringify(req.query);
      assert.ok(json.includes('"role":["Rguest","1dave"]'), json.slice(0, 200));
    }
  });

  await t.test('a search shows only what each user may see', async () => {
    const found = async user => (await user.call('GET', '/api/search?q=&rows=100')).body.docs.map(d => d.id);
    const [a, b, d] = [await found(alice), await found(bob), await found(dave)];
    assert.ok(a.includes(SECRET) && a.includes(LEDGER), 'alice');
    assert.ok(!b.includes(SECRET) && !b.includes(LEDGER), 'bob');
    assert.ok(!d.includes(SECRET) && !d.includes(LEDGER), 'dave');
  });

  await t.test('roles sent by the browser are ignored', async () => {
    const r = await dave.call('GET', '/api/search?q=&rows=100&roles=1alice&role=1alice');
    assert.ok(!r.body.docs.some(d => d.id === SECRET));
  });

  await t.test('text and downloads check access by id', async () => {
    assert.equal((await alice.call('GET', `/api/document?id=${enc(SECRET)}`)).status, 200);
    assert.equal((await dave.call('GET', `/api/document?id=${enc(SECRET)}`)).status, 403);
    assert.equal((await dave.call('GET', `/api/download?id=${enc(SECRET)}`)).status, 403);
    assert.ok(!(await dave.call('GET', `/api/document?id=${enc(SECRET)}`)).text.includes('payroll'));
  });

  await t.test('a document you can\'t see can\'t be added to a collection', async () => {
    const c = (await dave.call('POST', '/api/collections', { name: 'mine' })).body;
    assert.equal((await dave.call('POST', `/api/collections/${c.id}/items`, { id: SECRET })).status, 403);
    const bulk = (await dave.call('POST', `/api/collections/${c.id}/items/bulk`, { ids: [SECRET, PUBLIC] })).body;
    assert.deepEqual(bulk.added, [PUBLIC]);
    assert.equal(bulk.unavailable, 1);
    await dave.call('DELETE', `/api/collections/${c.id}`);
  });

  await t.test('collections belong to their owner', async () => {
    const c = (await alice.call('POST', '/api/collections', { name: 'private' })).body;
    await alice.call('POST', `/api/collections/${c.id}/items`, { id: SECRET });
    assert.ok(!(await bob.call('GET', '/api/collections')).text.includes('private'));
    for (const [method, path, body] of [
      ['GET', `/api/collections/${c.id}`], ['PATCH', `/api/collections/${c.id}`, { name: 'x' }], ['DELETE', `/api/collections/${c.id}`],
      ['POST', `/api/collections/${c.id}/items`, { id: PUBLIC }], ['GET', `/api/collections/${c.id}/timeline`], ['GET', `/api/collections/${c.id}/similar`],
      ['GET', `/api/collections/${c.id}/board`], ['PUT', `/api/collections/${c.id}/board`, { revision: 0, board: {} }],
      ['GET', `/api/collections/${c.id}/board/suggestions`], ['POST', `/api/collections/${c.id}/board/groups/g/rate`],
      ['GET', `/api/collections/${c.id}/board/versions`], ['POST', `/api/collections/${c.id}/board/versions`, { name: 'x' }],
      ['GET', `/api/search?q=&collection=${c.id}`], ['GET', `/api/facets?collection=${c.id}`],
      ['GET', `/api/collections/${c.id}/download/summary`],
    ]) {
      assert.equal((await bob.call(method, path, body)).status, 404, `${method} ${path}`);
    }
    await alice.call('DELETE', `/api/collections/${c.id}`);
  });

  await t.test('losing access hides a document everywhere, and a board shows nothing of it', async () => {
    const c = (await alice.call('POST', '/api/collections', { name: 'revoked' })).body;
    const P = `/api/collections/${c.id}`;
    await alice.call('POST', `${P}/items/bulk`, { ids: [SECRET, PUBLIC] });
    await alice.call('PUT', `${P}/board`, { revision: 0, board: { objects: [{ id: 's', kind: 'doc', doc_id: SECRET, x: 0, y: 0, text: 'my note' }, { id: 'p', kind: 'doc', doc_id: PUBLIC, x: 0, y: 0 }] } });
    assert.ok((await alice.call('GET', `${P}/board`)).text.includes('SECRET TITLE'));
    await app.control('revoke');
    for (const path of [P, `${P}/timeline`, `${P}/board`, `${P}/board/suggestions`, `/api/search?q=&rows=100&collection=${c.id}`, `${P}/timeline?q=report`]) {
      const r = await alice.call('GET', path);
      assert.equal(r.status, 200, path);
      assert.ok(!/SECRET TITLE|payroll/.test(r.text), `leaks in ${path}`);
    }
    const board = (await alice.call('GET', `${P}/board`)).body;
    assert.equal(board.board.objects.length, 2, 'the card stays');
    assert.equal(board.board.objects[0].text, 'my note', 'with the note');
    assert.equal(board.hidden, 1);
    assert.equal((await alice.call('GET', `/api/document?id=${enc(SECRET)}`)).status, 403);
    await app.control('grant');
    await alice.call('DELETE', P);
  });

  await t.test('nothing from a document is stored on a board', async () => {
    const c = (await alice.call('POST', '/api/collections', { name: 'nostore' })).body;
    const P = `/api/collections/${c.id}`;
    await alice.call('POST', `${P}/items`, { id: SECRET });
    await alice.call('PUT', `${P}/board`, { revision: 0, board: { objects: [{ id: 's', kind: 'doc', doc_id: SECRET, x: 0, y: 0, title: 'SECRET TITLE' }] } });
    assert.ok(!JSON.stringify((await alice.call('GET', `${P}/board`)).body.board).includes('SECRET TITLE'));
    await alice.call('DELETE', P);
  });
});
