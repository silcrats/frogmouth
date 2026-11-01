const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanBoard } = require('../../lib/board');

const note = (id, extra = {}) => ({ id, kind: 'note', x: 0, y: 0, ...extra });

test('keeps only known fields, and rounds positions', () => {
  const b = cleanBoard({ objects: [note('n', { x: 1.4, junk: 1, title: 't' })] });
  assert.equal(b.objects[0].x, 1);
  assert.equal(b.objects[0].junk, undefined);
});

test('a document card stores only its id, never a title', () => {
  const b = cleanBoard({ objects: [{ id: 'd', kind: 'doc', doc_id: 'smb://a', x: 0, y: 0, title: 'From the document' }] });
  assert.equal(b.objects[0].title, undefined);
});

for (const [name, board] of [
  ['the same document twice', { objects: [{ id: 'a', kind: 'doc', doc_id: 'x', x: 0, y: 0 }, { id: 'b', kind: 'doc', doc_id: 'x', x: 0, y: 0 }] }],
  ['the same id twice', { objects: [note('a'), note('a')] }],
  ['a connection to nothing', { objects: [note('a')], connections: [{ id: 'c', from: 'a', to: 'zz' }] }],
  ['a connection to itself', { objects: [note('a')], connections: [{ id: 'c', from: 'a', to: 'a' }] }],
  ['a missing group', { objects: [note('a', { group: 'q' })] }],
  ['an impossible date', { objects: [note('a', { date: '2026-02-31' })] }],
  ['an unknown kind', { objects: [{ id: 'a', kind: 'x', x: 0, y: 0 }] }],
  ['an unknown colour', { objects: [note('a', { color: 'url(x)' })] }],
  ['a position that is not a number', { objects: [note('a', { x: '1' })] }],
  ['markup in an id', { objects: [note('<a>')] }],
  ['over-long notes', { objects: [note('a', { text: 'x'.repeat(2001) })] }],
  ['nothing', null],
  ['a list', []],
  ['a bad dismissed pair', { dismissed: ['<bad>'] }],
  ['a bad view', { view: { x: 0, y: 0, k: 99 } }],
  ['a bad rating', { groups: [{ id: 'g', x: 0, y: 0, w: 200, h: 200, quality: { rating: '<b>', basis: 'meaning', alike: 0.4, shared: 0.6, members: [], weak_fits: [], left_out: 0 } }] }],
]) {
  test(`refuses ${name}`, () => assert.throws(() => cleanBoard(board), err => err.status === 400));
}

test('limits how many of each a board can hold', () => {
  assert.throws(() => cleanBoard({ groups: Array.from({ length: 201 }, (_, i) => ({ id: `g${i}`, x: 0, y: 0, w: 200, h: 200 })) }), /200 groups/);
});
