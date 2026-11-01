const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');

const SECRET = 'smb://srv/share/secret.pdf';
const doc = i => `smb://srv/share/file${i}.${['pdf', 'docx', 'eml', 'xlsx'][i % 4]}`;
const card = (id, docId, extra = {}) => ({ id, kind: 'doc', doc_id: docId, x: 0, y: 0, ...extra });

async function boardWithAll(user) {
  const c = (await user.call('POST', '/api/collections', { name: `b${Date.now()}${Math.random()}` })).body;
  const P = `/api/collections/${c.id}`;
  const { docs } = (await user.call('GET', '/api/search?q=&rows=30')).body;
  await user.call('POST', `${P}/items/bulk`, { ids: docs.map(d => d.id) });
  return { P, docs };
}

for (const vector of [false, true]) {
  test(`boards, with vector search ${vector ? 'on' : 'off'}`, async t => {
    const app = await startApp({ vector });
    t.after(() => app.stop());
    const alice = await app.login('alice');

    await t.test('saving checks the revision, so an old window can\'t overwrite a newer save', async () => {
      const c = (await alice.call('POST', '/api/collections', { name: 'rev' })).body;
      const P = `/api/collections/${c.id}/board`;
      await alice.call('POST', `/api/collections/${c.id}/items`, { id: doc(1) });
      assert.equal((await alice.call('GET', P)).body.board.revision, 0);
      assert.equal((await alice.call('PUT', P, { revision: 0, board: { objects: [card('a', doc(1))] } })).body.revision, 1);
      assert.equal((await alice.call('PUT', P, { revision: 0, board: {} })).status, 409);
      assert.equal((await alice.call('PUT', P, { revision: '1', board: {} })).status, 400);
      assert.equal((await alice.call('GET', P)).body.docs[doc(1)].content, undefined, 'no text is sent');
    });

    await t.test('documents must come from the collection, but stay if removed from it', async () => {
      const c = (await alice.call('POST', '/api/collections', { name: 'membership' })).body;
      const P = `/api/collections/${c.id}`;
      await alice.call('POST', `${P}/items`, { id: doc(1) });
      assert.equal((await alice.call('PUT', `${P}/board`, { revision: 0, board: { objects: [card('a', doc(2))] } })).status, 400);
      await alice.call('PUT', `${P}/board`, { revision: 0, board: { objects: [card('a', doc(1))] } });
      await alice.call('DELETE', `${P}/items?id=${encodeURIComponent(doc(1))}`);
      const r = (await alice.call('GET', `${P}/board`)).body;
      assert.ok(r.docs[doc(1)] && !r.items.includes(doc(1)));
      assert.equal((await alice.call('PUT', `${P}/board`, { revision: 1, board: r.board })).status, 200);
    });

    await t.test('a full board fits in a save', async () => {
      const c = (await alice.call('POST', '/api/collections', { name: 'big' })).body;
      const objects = Array.from({ length: 1400 }, (_, i) => ({ id: `n${i}`, kind: 'note', x: i, y: 0, text: 'y'.repeat(2000) }));
      assert.equal((await alice.call('PUT', `/api/collections/${c.id}/board`, { revision: 0, board: { objects } })).status, 200);
    });

    await t.test('the view is kept, and checked', async () => {
      const c = (await alice.call('POST', '/api/collections', { name: 'view' })).body;
      const P = `/api/collections/${c.id}/board`;
      await alice.call('PUT', P, { revision: 0, board: { view: { x: 10.5, y: -20, k: 0.5, junk: 1 } } });
      assert.deepEqual((await alice.call('GET', P)).body.board.view, { x: 10.5, y: -20, k: 0.5 });
      for (const view of [{ x: 'a', y: 0, k: 1 }, { x: 0, y: 0, k: 0 }, { x: 1e12, y: 0, k: 1 }, 'x']) {
        assert.equal((await alice.call('PUT', P, { revision: 1, board: { view } })).status, 400);
      }
    });

    await t.test('versions: saved, restored, limited', async () => {
      const c = (await alice.call('POST', '/api/collections', { name: 'versions' })).body;
      const P = `/api/collections/${c.id}`;
      const R = `${P}/board`;
      await alice.call('POST', `${P}/items`, { id: doc(1) });
      await alice.call('PUT', R, { revision: 0, board: { objects: [card('a', doc(1))] } });
      const v1 = (await alice.call('POST', `${R}/versions`, { name: '  One  ' })).body.id;
      for (const name of ['', '   ', 'x'.repeat(101), 5]) assert.equal((await alice.call('POST', `${R}/versions`, { name })).status, 400);
      const other = (await alice.call('POST', '/api/collections', { name: 'othervers' })).body;
      assert.equal((await alice.call('POST', `/api/collections/${other.id}/board/versions/${v1}/restore`, { revision: 0 })).status, 404, 'another collection\'s version');
      assert.equal((await alice.call('POST', `${R}/versions/abc/restore`, { revision: 1 })).status, 400);
      await alice.call('PUT', R, { revision: 1, board: { objects: [] } });
      assert.equal((await alice.call('POST', `${R}/versions/${v1}/restore`, { revision: 1 })).status, 409, 'stale');
      await alice.call('DELETE', `${P}/items?id=${encodeURIComponent(doc(1))}`);
      assert.equal((await alice.call('POST', `${R}/versions/${v1}/restore`, { revision: 2 })).body.revision, 3);
      assert.equal((await alice.call('GET', R)).body.board.objects.length, 1, 'even with the document since removed');
      let { versions } = (await alice.call('GET', `${R}/versions`)).body;
      assert.equal(versions.length, 2);
      assert.equal(versions[0].auto, true);
      assert.equal(versions[1].name, 'One');
      assert.equal(versions[1].data, undefined, 'the list has no contents');
      for (let i = versions.length; i < 30; i++) await alice.call('POST', `${R}/versions`, { name: `n${i}` });
      assert.equal((await alice.call('POST', `${R}/versions`, { name: 'over' })).status, 400);
      assert.equal((await alice.call('POST', `${R}/versions`, { name: 'auto', auto: true })).status, 201, 'automatic makes room');
      ({ versions } = (await alice.call('GET', `${R}/versions`)).body);
      assert.equal(versions.length, 30);
      assert.ok(versions.some(v => v.name === 'One'), 'a named one stays');
      assert.equal((await alice.call('DELETE', `${R}/versions/${v1}`)).status, 200);
    });

    await t.test('suggestions, with reasons, and nothing stored', async () => {
      const { P, docs } = await boardWithAll(alice);
      const idOf = n => `d${docs.findIndex(d => [].concat(d.title)[0] === `Report ${n}`)}`;
      const objects = docs.map((d, i) => card(`d${i}`, d.id, { x: i }));
      objects.push({ id: 'p1', kind: 'person', x: 0, y: 0, title: 'alice nguyen' }, { id: 'p2', kind: 'person', x: 0, y: 0, title: 'al' }, { id: 'p3', kind: 'person', x: 0, y: 0, title: '(.*)+$' });
      await alice.call('PUT', `${P}/board`, { revision: 0, board: { objects, connections: [{ id: 'k', from: idOf(6), to: idOf(7) }] } });
      const r = await alice.call('GET', `${P}/board/suggestions?similar=1`);
      assert.equal(r.status, 200);
      const S = r.body;
      const of = kind => S.connections.filter(c => c.kind === kind);
      const has = (kind, x, y) => of(kind).some(c => [c.from, c.to].includes(idOf(x)) && [c.from, c.to].includes(idOf(y)));
      assert.ok(has('attachment', 8, 10), 'attachment');
      assert.equal(of('attachment')[0].from, idOf(8));
      assert.ok(of('attachment')[0].directed);
      assert.ok(has('thread', 8, 9), 'thread by headers');
      assert.ok(has('name', 12, 13), 'same file name');
      assert.ok(!has('thread', 14, 15), 'nobody in common');
      assert.ok(!has('name', 16, 17), 'numbered files');
      assert.ok(has('similar', 0, 1) && has('similar', 2, 4), 'similar');
      assert.ok(!has('similar', 0, 2), 'unrelated');
      assert.ok(!has('similar', 20, 21), 'only headers in common');
      assert.ok(!S.connections.some(c => [c.from, c.to].includes(idOf(6)) && [c.from, c.to].includes(idOf(7))), 'already connected');
      assert.deepEqual(of('mention').map(c => [c.from, c.to]), [[idOf(0), 'p1']]);
      assert.ok(S.groupings.some(g => g.key === 'topic' && g.quality));
      assert.equal(S.meaning_used, vector);
      if (vector) {
        const m = of('meaning').find(c => [c.from, c.to].includes(idOf(18)));
        assert.ok(m, 'reworded pair');
        assert.match(m.reason, /^Closest passages:.*passage/);
        assert.equal(m.sure, false);
      } else {
        assert.equal(of('meaning').length, 0);
      }
      const saved = (await alice.call('GET', `${P}/board`)).body;
      assert.ok(!JSON.stringify(saved.board).includes('audit'));
      saved.board.dismissed = [[idOf(0), idOf(1)].sort().join('|')];
      await alice.call('PUT', `${P}/board`, { revision: 1, board: saved.board });
      const after = (await alice.call('GET', `${P}/board/suggestions?similar=1`)).body.connections;
      assert.ok(!after.some(c => [c.from, c.to].includes(idOf(0)) && [c.from, c.to].includes(idOf(1))), 'dismissed stays gone');
    });

    await t.test('rating one group', async () => {
      const { P, docs } = await boardWithAll(alice);
      const objects = docs.map((d, i) => card(`d${i}`, d.id, { x: i, group: i < 10 ? 'g' : i === 10 ? 'one' : null }));
      objects.push({ id: 'n', kind: 'note', x: 0, y: 0, group: 'g', title: 'mine' });
      const groups = ['g', 'one', 'none'].map(id => ({ id, x: 0, y: 0, w: 300, h: 300 }));
      await alice.call('PUT', `${P}/board`, { revision: 0, board: { objects, groups } });
      const r = await alice.call('POST', `${P}/board/groups/g/rate`);
      assert.equal(r.body.rated, 10);
      assert.equal(r.body.quality.members.length, 11);
      assert.ok(['near_identical', 'clear', 'some', 'unclear', 'too_few'].includes(r.body.quality.rating));
      assert.ok(!r.text.includes('audit'), 'figures only');
      const board = (await alice.call('GET', `${P}/board`)).body.board;
      board.groups[0].quality = r.body.quality;
      assert.equal((await alice.call('PUT', `${P}/board`, { revision: 1, board })).status, 200, 'the result can be saved');
      assert.equal((await alice.call('POST', `${P}/board/groups/one/rate`)).status, 400);
      assert.equal((await alice.call('POST', `${P}/board/groups/none/rate`)).status, 400);
      assert.equal((await alice.call('POST', `${P}/board/groups/nope/rate`)).status, 404);
    });

    await t.test('secret documents stay hidden from suggestions for others', async () => {
      const dave = await app.login('dave');
      const c = (await alice.call('POST', '/api/collections', { name: 'secretsug' })).body;
      await alice.call('POST', `/api/collections/${c.id}/items`, { id: SECRET });
      assert.equal((await dave.call('GET', `/api/collections/${c.id}/board/suggestions`)).status, 404);
    });
  });
}
