const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestBoard } = require('../../lib/board-suggest');

let seed = 11;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
const DIM = 64;
const randomVector = () => Array.from({ length: DIM }, random);
const unit = v => {
  const n = Math.hypot(...v);
  return Float32Array.from(v.map(x => x / n));
};
const near = (centre, spread) => unit(centre.map(x => x * (1 - spread) + random() * spread * 2));
const email = (id, fields, time = 1) => ({ id, time, group: null, text: `Subject: s\n\nbody ${id}`, doc: { id: `smb://s/m/${id}`, email_from: 'a@x', email_subject: fields.subject || 'Hello', ...fields } });
const threadLinks = cards => suggestBoard({ cards }).connections.filter(c => c.kind === 'thread');
const linked = (links, a, b) => links.some(c => [c.from, c.to].includes(a) && [c.from, c.to].includes(b));

test('threads follow reply headers, even when the subject changes', () => {
  const links = threadLinks([
    email('root', { email_message_id: '<r@x>' }, 1),
    email('reply', { email_message_id: '<a@x>', email_in_reply_to: '<r@x>', email_references: ['<r@x>'], subject: 'CHANGED' }, 2),
    email('parentonly', { email_message_id: '<b@x>', email_in_reply_to: '<a@x>' }, 3),
  ]);
  assert.ok(linked(links, 'root', 'reply'));
  assert.ok(linked(links, 'reply', 'parentonly'));
  assert.match(links[0].reason, /reply headers/);
});

test('two replies to a message not on the board are one conversation', () => {
  assert.ok(linked(threadLinks([
    email('a', { email_message_id: '<c@x>', email_in_reply_to: '<gone@x>', subject: 'Other' }),
    email('b', { email_message_id: '<d@x>', email_in_reply_to: '<gone@x>', subject: 'Re: Other' }, 2),
  ]), 'a', 'b'));
});

test("Outlook's thread index joins a conversation without other headers", () => {
  assert.ok(linked(threadLinks([
    email('a', { email_message_id: '<e@x>', email_thread_index: 'IDX', subject: 'One' }),
    email('b', { email_message_id: '<f@x>', email_thread_index: 'IDX', subject: 'Two' }, 2),
  ]), 'a', 'b'));
});

test('one subject with different reply headers stays apart', () => {
  assert.ok(!linked(threadLinks([
    email('a', { email_message_id: '<g@x>', email_in_reply_to: '<p@x>', subject: 'Meeting' }),
    email('b', { email_message_id: '<h@x>', email_in_reply_to: '<q@x>', subject: 'Meeting' }, 2),
  ]), 'a', 'b'));
});

test('with no reply headers, a subject and someone in common will do', () => {
  const links = threadLinks([email('a', { subject: 'Budget' }), email('b', { subject: 'Re: Budget' }, 2), email('c', { subject: 'Budget', email_from: 'z@y' }, 3)]);
  assert.ok(linked(links, 'a', 'b'));
  assert.match(links[0].reason, /Same subject/);
  assert.ok(!linked(links, 'b', 'c'), 'nobody in common');
});

test('one email filed twice is not a conversation', () => {
  const result = suggestBoard({ cards: [email('a', { email_message_id: '<same@x>', subject: 'Memo' }), email('b', { email_message_id: '<same@x>', subject: 'Memo' }, 2)] });
  assert.ok(!result.connections.some(c => /reply headers/.test(c.reason)));
  assert.ok(!(result.groupings.find(g => g.key === 'thread')));
});

test('thread groups stay apart when they share a subject', () => {
  const groups = suggestBoard({ cards: [
    email('p', { email_message_id: '<1@x>', email_in_reply_to: '<z1@x>', subject: 'Same' }), email('q', { email_message_id: '<2@x>', email_in_reply_to: '<z1@x>', subject: 'Same' }, 2),
    email('r', { email_message_id: '<3@x>', email_in_reply_to: '<z2@x>', subject: 'Same' }, 3), email('s', { email_message_id: '<4@x>', email_in_reply_to: '<z2@x>', subject: 'Same' }, 4),
  ] }).groupings.find(g => g.key === 'thread').groups;
  assert.deepEqual(groups.map(g => g.title).sort(), ['same', 'same (2)']);
});

test('headers and routing addresses alone do not relate emails', () => {
  const mk = (id, text) => ({ id, time: 1, group: null, text, doc: { id: `smb://s/${id}`, email_from: 'john.arnold@x', email_subject: id } });
  const padding = Array.from({ length: 6 }, (_, i) => mk(`p${i}`, `Subject: q\nFrom: other\n\nsomething entirely different number ${i} words words`));
  const result = suggestBoard({ cards: [
    mk('a', 'Subject: z\nFrom: john arnold\nTo: bob\n\ntb + 9.5 for 250'),
    mk('b', 'Subject: y\nFrom: john arnold\nTo: bob\n\n----- Forwarded by john arnold/hou/ect on 1/1 -----\nFrom: john arnold\nthat would be great'),
    ...padding,
  ] });
  assert.ok(!result.connections.some(c => c.kind === 'similar' && [c.from, c.to].includes('a') && [c.from, c.to].includes('b')));
});

test('numbered file names and emails are not "same file name"', () => {
  const file = (id, filename) => ({ id, time: 1, group: null, text: `unique ${id}`, doc: { id: `smb://s/${id}`, filename } });
  const kinds = cards => suggestBoard({ cards }).connections.filter(c => c.kind === 'name');
  assert.equal(kinds([file('a', '5.eml'), file('b', '5.eml')]).length, 0);
  assert.equal(kinds([file('a', 'minutes.pdf'), file('b', 'minutes.pdf')]).length, 1);
});

test('mentions match whole names, literally, in documents only', () => {
  const doc = { id: 'd', time: 1, group: null, text: 'Signed by Alice  Nguyen, not Malice.', doc: { id: 'smb://s/d' } };
  const found = ents => suggestBoard({ cards: [doc], entities: ents }).connections.filter(c => c.kind === 'mention').map(c => c.to);
  assert.deepEqual(found([{ id: 'p1', title: 'alice nguyen' }, { id: 'p2', title: '(.*)+$' }, { id: 'p3', title: 'al' }]), ['p1']);
});

test('no kind crowds out the rest of the suggestions', () => {
  const cards = [];
  for (let i = 0; i < 900; i++) cards.push({ id: `c${i}`, time: i, group: null, text: `${'word '.repeat(60)}${i % 3 === 0 ? 'same' : i}`, vector: unit(randomVector()), doc: { id: `smb://s/x/${i}`, filename: `f${i % 2}.pdf` } });
  const { connections, connections_total: total } = suggestBoard({ cards });
  const kinds = new Set(connections.map(c => c.kind));
  assert.ok(connections.length <= 300);
  assert.ok(total >= connections.length);
  assert.ok(kinds.size >= 2);
});

test('similar meaning skips dated issues of one series', () => {
  const centre = randomVector();
  const cards = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, time: i, group: null, text: `x${i} `.repeat(60), vector: unit(randomVector()), doc: { id: `smb://s/n${i}`, email_from: `f${i}@x`, email_subject: `Note ${i}x` } }));
  cards.push(
    { id: 's1', time: 1, group: null, text: 'alpha '.repeat(60), vector: near(centre, 0.05), doc: { id: 'smb://s/1', email_from: 'a@x', email_subject: 'Daily digest 11/20/01' } },
    { id: 's2', time: 2, group: null, text: 'beta '.repeat(60), vector: near(centre, 0.05), doc: { id: 'smb://s/2', email_from: 'b@x', email_subject: 'Daily digest 11/21/01' } },
    { id: 'o1', time: 3, group: null, text: 'gamma '.repeat(60), vector: near(centre, 0.05), doc: { id: 'smb://s/3', email_from: 'c@x', email_subject: 'Something else' } },
  );
  const meaning = suggestBoard({ cards }).connections.filter(c => c.kind === 'meaning');
  const has = (a, b) => meaning.some(c => [c.from, c.to].includes(a) && [c.from, c.to].includes(b));
  assert.ok(!has('s1', 's2'), 'one series');
  assert.ok(has('s1', 'o1') || has('s2', 'o1'), 'different subjects can match');
});

test('groupings offer at most 50 groups, and say how many they left out', () => {
  const cards = Array.from({ length: 800 }, (_, i) => ({ id: `c${i}`, text: '', time: null, group: null, doc: { id: `smb://s/share/f${i % 400}/x${i}.pdf`, type: 'pdf' } }));
  const folder = suggestBoard({ cards }).groupings.find(g => g.key === 'folder');
  assert.equal(folder.groups.length, 50);
  assert.equal(folder.left_out, 350);
});

test('cards already in a group are left out of groupings', () => {
  const cards = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, text: 'x', time: null, group: i < 4 ? 'g' : null, doc: { id: `smb://s/share/f${i % 2}/x${i}.pdf` } }));
  const folder = suggestBoard({ cards }).groupings.find(g => g.key === 'folder');
  assert.ok(!folder || folder.groups.flatMap(g => g.members).every(id => Number(id.slice(1)) >= 4));
});

test('a large group needs to be more alike than a small one to count as very alike', () => {
  const centre = randomVector();
  const board = n => {
    const cards = [];
    for (let i = 0; i < n; i++) cards.push({ id: `L${i}`, time: i, group: null, text: `dynegy merger fastow article number ${i}`, vector: near(centre, 0.2), doc: { id: `smb://s/L/${i}` } });
    for (let k = 1; k < 4; k++) {
      const other = randomVector();
      for (let i = 0; i < n; i++) cards.push({ id: `N${k}x${i}`, time: i, group: null, text: `different wording set${k} entry ${i}`, vector: near(other, 0.2), doc: { id: `smb://s/N${k}/${i}` } });
    }
    return suggestBoard({ cards }).groupings.find(g => g.key === 'topic').groups.find(g => g.members.some(m => m[0] === 'L'));
  };
  const [big, small] = [board(30), board(15)];
  assert.ok(big.quality.alike >= 0.6 && big.quality.alike < 0.8, `test group is between the bars: ${big.quality.alike}`);
  assert.notEqual(big.quality.rating, 'near_identical');
  assert.ok(small.quality.alike >= 0.6);
  assert.equal(small.quality.rating, 'near_identical');
});

test('topics rate by shared wording, not by being large', () => {
  const words = [['raptor hedge credit capacity position vehicle ledger', 'a'], ['alpha beta gamma delta epsilon zeta eta', 'b']];
  const cards = words.flatMap(([text, p]) => Array.from({ length: 12 }, (_, i) => ({ id: `${p}${i}`, time: i, group: null, text: `${text} ${p}note${i}`, doc: { id: `smb://s/${p}/${i}` } })));
  const topic = suggestBoard({ cards }).groupings.find(g => g.key === 'topic');
  assert.ok(topic.groups.every(g => g.quality.shared >= 0.5));
});
