const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanBoard } = require('../../lib/board');

const note = (id, extra = {}) => ({ id, kind: 'note', x: 0, y: 0, ...extra });

test('a group\'s sections are kept, checked and only with an arrangement', () => {
  const g = extra => ({ id: 'g', x: 0, y: 0, w: 400, h: 300, ...extra });
  const objects = [{ id: 'd', kind: 'note', x: 0, y: 0, group: 'g' }];
  const section = { id: 's1', title: '<b>2001</b>', y: 40, members: ['d'], junk: 1 };
  const kept = cleanBoard({ objects, groups: [g({ arrange: 'date', sections: [section] })] }).groups[0];
  assert.equal(kept.arrange, 'date');
  assert.deepEqual(kept.sections, [{ id: 's1', title: '<b>2001</b>', y: 40, members: ['d'] }]);
  const across = cleanBoard({ objects, groups: [g({ arrange: 'date', sections: [{ ...section, x: 24, w: 460, h: 200 }] })] }).groups[0];
  assert.deepEqual([across.sections[0].x, across.sections[0].w, across.sections[0].h], [24, 460, 200]);
  const plain = cleanBoard({ objects, groups: [g({ sections: [section] })] }).groups[0];
  assert.equal('sections' in plain, false);
  assert.equal('arrange' in plain, false);
  for (const bad of [
    { arrange: 'role', sections: [] },
    { arrange: 'date', sections: [{ ...section, y: -1 }] },
    { arrange: 'date', sections: [{ ...section, y: 'x' }] },
    { arrange: 'date', sections: [{ ...section, id: 'a b' }] },
    { arrange: 'date', sections: [{ ...section, title: 'x'.repeat(201) }] },
    { arrange: 'date', sections: [{ ...section, members: ['a b'] }] },
    { arrange: 'date', sections: Array.from({ length: 201 }, (_, i) => ({ ...section, id: `s${i}` })) },
  ]) assert.throws(() => cleanBoard({ objects, groups: [g(bad)] }), /section|arrangement|title|id|up to|Invalid/i, JSON.stringify(bad).slice(0, 60));
});

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
  const note = i => ({ id: `n${i}`, kind: 'note', x: 0, y: 0 });
  assert.equal(cleanBoard({ objects: Array.from({ length: 5500 }, (_, i) => note(i)) }).objects.length, 5500);
  assert.throws(() => cleanBoard({ objects: Array.from({ length: 5501 }, (_, i) => note(i)) }), /up to 5500/);
  assert.throws(() => cleanBoard({ groups: Array.from({ length: 1001 }, (_, i) => ({ id: `g${i}`, x: 0, y: 0, w: 200, h: 200 })) }), /1000 groups/);
});
