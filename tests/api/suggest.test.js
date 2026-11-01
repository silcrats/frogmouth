// Suggest's speed-ups: none of them may change who sees what.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');

const knnRequests = async app => (await app.control('requests')).filter(r => JSON.stringify(r._source || '').includes('content_embedding.knn'));

async function fullBoard(user) {
  const c = (await user.call('POST', '/api/collections', { name: `Suggest ${Math.random()}` })).body;
  const P = `/api/collections/${c.id}`;
  const { docs } = (await user.call('GET', '/api/search?q=&rows=30')).body;
  await user.call('POST', `${P}/items/bulk`, { ids: docs.map(d => d.id) });
  const objects = docs.map((d, i) => ({ id: `d${i}`, kind: 'doc', doc_id: d.id, x: i, y: 0 }));
  const saved = await user.call('PUT', `${P}/board`, { revision: 0, board: { objects } });
  return { P, docs, objects, revision: saved.body.revision };
}

for (const docVectors of [true, false]) {
  test(`suggestions, ${docVectors ? 'with' : 'without'} whole-document vectors in the index`, async t => {
    const app = await startApp({ vector: true, docVectors });
    t.after(() => app.stop());
    const alice = await app.login('alice');
    const { P } = await fullBoard(alice);

    await t.test('plain Suggest leaves out similar documents and offers groups', async () => {
      await app.control('clear');
      const r = await alice.call('GET', `${P}/board/suggestions`);
      assert.equal(r.status, 200);
      assert.equal(r.body.similar_included, false);
      assert.ok(!r.body.connections.some(c => ['similar', 'meaning'].includes(c.kind)));
      assert.ok(r.body.groupings.some(g => g.key === 'topic'));
      assert.equal(r.body.meaning_used, true);
      assert.equal(r.body.timings, undefined, 'timings stay in the log');
      const asked = (await knnRequests(app)).flatMap(q => q.query.bool.filter[0].terms.url);
      if (docVectors) assert.ok(asked.length < r.body.analysed / 2, `passages fetched for only those without: ${asked.length}`);
      else assert.equal(asked.length, r.body.analysed, 'passages fetched for all');
      assert.match(app.log(), /Suggestions on \d+ cards: reading \d+ms/);
    });

    await t.test('Find similar adds them, with passages as evidence', async () => {
      const r = await alice.call('GET', `${P}/board/suggestions?similar=1`);
      assert.equal(r.body.similar_included, true);
      const meaning = r.body.connections.filter(c => c.kind === 'meaning');
      assert.ok(meaning.length > 0);
      assert.ok(meaning.some(c => /^Closest passages:/.test(c.reason)));
      assert.ok(r.body.connections.some(c => c.kind === 'similar'));
    });

    await t.test('every read carries the role filter', async () => {
      await app.control('clear');
      await alice.call('POST', `${P}/board/suggestions`).catch(() => {});
      const c = await alice.call('GET', `${P}/board`);
      c.body.board.dismissed = ['a|b'];
      await alice.call('PUT', `${P}/board`, { revision: c.body.board.revision, board: c.body.board });
      await alice.call('GET', `${P}/board/suggestions?similar=1`);
      const reads = await app.control('requests');
      assert.ok(reads.length > 2);
      for (const req of reads) {
        assert.ok(JSON.stringify(req.query).includes('1alice'), JSON.stringify(req._source));
      }
    });
  });
}

test('the last answer is remembered, for exactly the same situation', async t => {
  const app = await startApp({ vector: true, docVectors: true });
  t.after(() => app.stop());
  const [alice, bob] = await Promise.all(['alice', 'bob'].map(app.login));
  const { P, docs, objects } = await fullBoard(alice);
  const get = () => alice.call('GET', `${P}/board/suggestions`);
  const board = async () => (await alice.call('GET', `${P}/board`)).body.board;
  const save = async change => {
    const b = await board();
    change(b);
    return alice.call('PUT', `${P}/board`, { revision: b.revision, board: b });
  };

  const first = await get();
  assert.equal(first.body.remembered, undefined);

  await t.test('an unchanged board comes straight back, without reading documents', async () => {
    await app.control('clear');
    const again = await get();
    assert.equal(again.body.remembered, true);
    assert.deepEqual(again.body.connections, first.body.connections);
    const reads = await app.control('requests');
    assert.ok(reads.every(r => !r.script_fields), 'no text read');
    assert.ok(reads.every(r => JSON.stringify(r.query).includes('1alice')), 'visibility is still checked');
  });

  await t.test('moving a card changes nothing that matters', async () => {
    await save(b => { b.objects[0].x = 900; });
    assert.equal((await get()).body.remembered, true);
  });

  await t.test('plain and similar are remembered apart', async () => {
    const full = await alice.call('GET', `${P}/board/suggestions?similar=1`);
    assert.equal(full.body.remembered, undefined);
    assert.equal(full.body.similar_included, true);
    assert.equal((await get()).body.similar_included, false);
  });

  for (const [name, change] of [
    ['a new connection', b => { b.connections.push({ id: 'k1', from: 'd0', to: 'd1' }); }],
    ['a dismissal', b => { b.dismissed.push('d0|d2'); }],
    ['a card put in a group', b => { b.groups.push({ id: 'g1', x: 0, y: 0, w: 200, h: 200, title: 'G' }); b.objects[3].group = 'g1'; }],
    ['a card removed', b => { b.objects.pop(); }],
    ['a person added', b => { b.objects.push({ id: 'p1', kind: 'person', x: 0, y: 0, title: 'alice nguyen' }); }],
  ]) {
    await t.test(`${name} works it out again`, async () => {
      await save(change);
      assert.equal((await get()).body.remembered, undefined);
      assert.equal((await get()).body.remembered, true);
    });
  }

  await t.test('losing access to a document works it out again, and drops it', async () => {
    assert.ok(docs.some(d => d.id === 'smb://srv/share/secret.pdf'), 'the secret is on the board');
    const before = (await get()).body;
    await app.control('revoke');
    const after = (await get()).body;
    await app.control('grant');
    assert.equal(after.remembered, undefined);
    assert.equal(after.analysed, before.analysed - 1);
    assert.equal(after.unavailable, before.unavailable + 1);
    assert.ok(objects.length);
  });

  await t.test('nobody else gets it', async () => {
    assert.equal((await bob.call('GET', `${P}/board/suggestions`)).status, 404);
    assert.equal((await bob.call('GET', `${P}/board/suggestions/status`)).status, 404);
  });
});

test('progress is there while it runs, and the server keeps answering', async t => {
  const app = await startApp({ vector: true, docVectors: true });
  t.after(() => app.stop());
  const alice = await app.login('alice');
  const { P } = await fullBoard(alice);
  assert.deepEqual((await alice.call('GET', `${P}/board/suggestions/status`)).body, { stage: null });
  const running = alice.call('GET', `${P}/board/suggestions?similar=1`);
  const during = await Promise.all([alice.call('GET', '/api/whoami'), alice.call('GET', `${P}/board/suggestions/status`)]);
  assert.equal(during[0].status, 200);
  assert.equal(during[1].status, 200);
  assert.equal((await running).status, 200);
  assert.deepEqual((await alice.call('GET', `${P}/board/suggestions/status`)).body, { stage: null }, 'cleared afterwards');
});
