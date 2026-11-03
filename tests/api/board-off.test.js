const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');

test('with the board turned off', async t => {
  const app = await startApp({ board: false });
  t.after(() => app.stop());
  const alice = await app.login('alice');

  await t.test('the browser is told not to offer it', async () => {
    assert.equal((await (await fetch(`${app.url}/api/config`)).json()).board, false);
  });

  await t.test('none of its API answers, but collections still work', async () => {
    const c = (await alice.call('POST', '/api/collections', { name: 'no board' })).body;
    const P = `/api/collections/${c.id}`;
    const [first] = (await alice.call('GET', '/api/search?q=&rows=1')).body.docs;
    assert.equal((await alice.call('POST', `${P}/items`, { id: first.id })).status, 201);
    for (const [method, path, body] of [
      ['GET', '/board'], ['PUT', '/board', { revision: 0, board: {} }], ['GET', '/board/versions'],
      ['POST', '/board/versions', { name: 'v' }], ['GET', '/board/suggestions'], ['GET', '/board/suggestions/status'],
    ]) {
      assert.equal((await alice.call(method, P + path, body)).status, 404, `${method} ${path}`);
    }
    assert.equal((await alice.call('GET', P)).status, 200);
    assert.equal((await alice.call('GET', `${P}/timeline`)).status, 200);
  });
});

test('the board is on by default', async t => {
  const app = await startApp();
  t.after(() => app.stop());
  assert.equal((await (await fetch(`${app.url}/api/config`)).json()).board, true);
  const alice = await app.login('alice');
  const c = (await alice.call('POST', '/api/collections', { name: 'board' })).body;
  assert.equal((await alice.call('GET', `/api/collections/${c.id}/board`)).status, 200);
});
