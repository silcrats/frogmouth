const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');

const group = (id, title, color = 'teal') => ({ id, title, color, x: 0, y: 0, w: 400, h: 300 });
const card = (id, docId, extra = {}) => ({ id, kind: 'doc', doc_id: docId, x: 0, y: 0, ...extra });

test('the timeline and the board', async t => {
  const app = await startApp();
  t.after(() => app.stop());
  const alice = await app.login('alice');
  const c = (await alice.call('POST', '/api/collections', { name: 'timeline groups' })).body;
  const P = `/api/collections/${c.id}`;
  const { docs } = (await alice.call('GET', '/api/search?q=&rows=10')).body;
  await alice.call('POST', `${P}/items/bulk`, { ids: docs.map(d => d.id) });
  const [a, b, d] = docs.map(x => x.id);
  const saved = await alice.call('PUT', `${P}/board`, { revision: 0, board: {
    groups: [group('g1', 'Contracts'), group('g2', '', 'amber'), group('g3', 'Empty', 'red')],
    objects: [card('c1', a, { group: 'g1', text: 'Signed the day before.\nCheck the second page.' }), card('c2', b, { group: 'g1' }),
              card('c3', d, { group: 'g2' }), { id: 'n1', kind: 'note', x: 0, y: 0, text: 'not a document' }],
  } });
  assert.equal(saved.status, 200);
  const timeline = async query => (await alice.call('GET', `${P}/timeline?rows=50${query}`)).body;
  const total = buckets => buckets.reduce((sum, x) => sum + x.count, 0);

  await t.test('lists the groups with how many documents each holds', async () => {
    const { board, numFound } = await timeline('');
    assert.deepEqual(board.groups.map(g => [g.id, g.title, g.color, g.count]),
      [['g1', 'Contracts', 'teal', 2], ['g2', 'Untitled group', 'amber', 1], ['g3', 'Empty', 'red', 0]]);
    assert.equal(board.ungrouped, docs.length - 3, 'including documents not on the board');
    assert.equal(board.group, '');
    assert.equal(numFound, docs.length);
  });

  await t.test('a group narrows the chart and the cards to its documents', async () => {
    const r = await timeline('&group=g1');
    assert.deepEqual(r.docs.map(x => x.id).sort(), [a, b].sort());
    assert.equal(total(r.buckets), 2);
    assert.equal(r.board.group, 'g1');
    assert.equal(r.board.groups[0].count, 2, 'counts still cover every group');
    const none = await timeline('&group=none');
    assert.equal(none.numFound, docs.length - 3);
    assert.ok(!none.docs.some(x => [a, b, d].includes(x.id)));
  });

  await t.test('each card says its group and carries your note', async () => {
    const { cards } = await timeline('&group=g1');
    assert.deepEqual(cards[a], { group: { id: 'g1', title: 'Contracts', color: 'teal' }, note: 'Signed the day before.\nCheck the second page.' });
    assert.deepEqual(cards[b], { group: { id: 'g1', title: 'Contracts', color: 'teal' }, note: '' });
    assert.equal(Object.keys(cards).length, 2, 'only this page\'s cards');
  });

  await t.test('a group since deleted means all documents', async () => {
    const r = await timeline('&group=gone');
    assert.equal(r.board.group, '');
    assert.equal(r.numFound, docs.length);
  });

  await t.test('ticked documents go into a new group, out of any old one', async () => {
    const [, , , e] = docs.map(x => x.id);
    const r = await alice.call('POST', `${P}/board/groups`, { ids: [b, e, 'smb://elsewhere/not-in-it.pdf'], title: '  Follow up  ' });
    assert.equal(r.status, 201);
    assert.equal(r.body.group.title, 'Follow up');
    assert.equal(r.body.count, 2);
    assert.equal(r.body.skipped, 1);
    const { board } = (await alice.call('GET', `${P}/board`)).body;
    const made = board.groups.find(g => g.id === r.body.group.id);
    assert.equal(made.pending, true, 'for the board to lay out');
    const cardOf = id => board.objects.filter(o => o.doc_id === id);
    assert.equal(cardOf(b).length, 1, 'a card already on the board moves');
    assert.equal(cardOf(b)[0].group, made.id);
    assert.equal(cardOf(e).length, 1, 'one not on the board gets a card');
    assert.equal(cardOf(e)[0].group, made.id);
    assert.equal(cardOf(a)[0].group, 'g1', 'others stay put');
    const versions = (await alice.call('GET', `${P}/board/versions`)).body.versions;
    assert.equal(versions[0].name, 'Before grouping from the timeline');
    const { board: tl } = await timeline('');
    assert.equal(tl.groups.find(g => g.id === made.id).count, 2);
    assert.equal(tl.groups.find(g => g.id === 'g1').count, 1);
  });

  await t.test('grouping needs a name and documents from this collection', async () => {
    assert.equal((await alice.call('POST', `${P}/board/groups`, { ids: [a], title: ' ' })).status, 400);
    assert.equal((await alice.call('POST', `${P}/board/groups`, { ids: [], title: 'x' })).status, 400);
    assert.equal((await alice.call('POST', `${P}/board/groups`, { ids: ['smb://elsewhere/x.pdf'], title: 'x' })).status, 400);
    assert.equal((await alice.call('POST', `${P}/board/groups`, { ids: [a], title: 'x'.repeat(201) })).status, 400);
  });

  await t.test('another user sees none of it', async () => {
    const bob = await app.login('bob');
    assert.equal((await bob.call('GET', `${P}/timeline`)).status, 404);
    assert.equal((await bob.call('POST', `${P}/board/groups`, { ids: [a], title: 'x' })).status, 404);
  });
});

test('with the board turned off, the timeline says nothing about it', async t => {
  const app = await startApp({ board: false });
  t.after(() => app.stop());
  const alice = await app.login('alice');
  const c = (await alice.call('POST', '/api/collections', { name: 'plain' })).body;
  const r = (await alice.call('GET', `/api/collections/${c.id}/timeline?group=none`)).body;
  assert.equal(r.board, undefined);
  assert.equal(r.cards, undefined);
});
