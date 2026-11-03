const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');

const TYPES = ['pdf', 'docx', 'eml', 'xlsx'];
const doc = i => `smb://srv/share/file${i}.${TYPES[i % 4]}`;
const card = (id, docId) => ({ id, kind: 'doc', doc_id: docId, x: 0, y: 0 });

test('searching a board', async t => {
  const app = await startApp();
  t.after(() => app.stop());
  const alice = await app.login('alice');
  const c = (await alice.call('POST', '/api/collections', { name: 'find' })).body;
  const P = `/api/collections/${c.id}`;
  await alice.call('POST', `${P}/items/bulk`, { ids: [0, 1, 2, 8, 10].map(doc) });
  assert.equal((await alice.call('PUT', `${P}/board`, { revision: 0, board: { objects: [card('a', doc(0)), card('b', doc(1)), card('c', doc(8))] } })).status, 200);
  // Taken out of the collection, but still on the board, so still searched.
  await alice.call('POST', `${P}/items/bulk-remove`, { ids: [doc(1)] });
  const find = async (q, mode) => alice.call('GET', `${P}/board/search?q=${encodeURIComponent(q)}${mode ? `&mode=${mode}` : ''}`);

  await t.test('finds the collection\'s and the board\'s documents, and only those', async () => {
    const r = await find('budget');
    assert.equal(r.status, 200);
    assert.deepEqual(new Set(r.body.ids), new Set([doc(0), doc(1), doc(8)]));
    const vaccine = (await find('vaccine')).body.ids;
    assert.deepEqual(vaccine, [doc(2)], 'not file4, which also mentions it but is in neither');
  });

  await t.test('takes advanced queries', async () => {
    assert.deepEqual((await find('vaccine AND cohort', 'advanced')).body.ids, [doc(2)]);
    assert.equal((await find('secret:x', 'advanced')).status, 400);
  });

  await t.test('needs something to search for', async () => {
    assert.equal((await find('  ')).status, 400);
  });

  await t.test('is only for the collection\'s owner', async () => {
    const bob = await app.login('bob');
    assert.equal((await bob.call('GET', `${P}/board/search?q=budget`)).status, 404);
  });
});

test('with the board turned off, there\'s no board to search', async t => {
  const app = await startApp({ board: false });
  t.after(() => app.stop());
  const alice = await app.login('alice');
  const c = (await alice.call('POST', '/api/collections', { name: 'x' })).body;
  assert.equal((await alice.call('GET', `/api/collections/${c.id}/board/search?q=budget`)).status, 404);
});
