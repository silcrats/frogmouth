const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestBoard, meaningPairs } = require('../../lib/board-suggest');

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
  const result = suggestBoard({ similar: true, cards: [
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
  const meaning = suggestBoard({ cards, similar: true }).connections.filter(c => c.kind === 'meaning');
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
    for (let i = 0; i < n; i++) cards.push({ id: `L${i}`, time: i, group: null, text: `dynegy merger fastow article number ${i} `.repeat(6), vector: near(centre, 0.2), doc: { id: `smb://s/L/${i}` } });
    for (let k = 1; k < 4; k++) {
      const other = randomVector();
      for (let i = 0; i < n; i++) cards.push({ id: `N${k}x${i}`, time: i, group: null, text: `different wording set${k} entry ${i} `.repeat(8), vector: near(other, 0.2), doc: { id: `smb://s/N${k}/${i}` } });
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
  const words = [['raptor hedge credit capacity position vehicle ledger '.repeat(4), 'a'], ['alpha beta gamma delta epsilon zeta eta '.repeat(5), 'b']];
  const cards = words.flatMap(([text, p]) => Array.from({ length: 12 }, (_, i) => ({ id: `${p}${i}`, time: i, group: null, text: `${text} ${p}note${i}`, doc: { id: `smb://s/${p}/${i}` } })));
  const topic = suggestBoard({ cards }).groupings.find(g => g.key === 'topic');
  assert.ok(topic.groups.every(g => g.quality.shared >= 0.5));
});

test('the fast comparison finds exactly what comparing every pair both ways does', () => {
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const base = Array.from({ length: 4 }, () => Array.from({ length: 32 }, random));
  const entries = Array.from({ length: 120 }, (_, i) => {
    const raw = base[i % 4].map(x => x + random() * 0.5);
    const norm = Math.hypot(...raw);
    return {
      v: Float32Array.from(raw, x => x / norm),
      copies: [],
      card: { id: `c${i}`, text: 'body text here '.repeat(20), doc: { id: `smb://s/${i}`, email_subject: i % 10 === 0 ? 'Weekly report' : `Subject ${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26))}` } },
    };
  });
  // Ties too: identical vectors have to keep their order.
  entries[5].v = entries[9].v;
  entries[50].v = entries[9].v;
  const slow = [];
  const seen = new Set();
  const seriesOf = e => e.card.doc.email_subject.toLowerCase();
  for (const a of entries) {
    const near = [];
    for (const b of entries) {
      if (a === b || (seriesOf(a) && seriesOf(a) === seriesOf(b))) continue;
      let score = 0;
      for (let k = 0; k < a.v.length; k++) score += a.v[k] * b.v[k];
      if (score >= 0.6) near.push([b, score]);
    }
    near.sort((x, y) => y[1] - x[1]).slice(0, 3).forEach(([b, score]) => {
      const key = [a.card.id, b.card.id].sort().join('|');
      if (!seen.has(key)) { seen.add(key); slow.push([a.card.id, b.card.id, score]); }
    });
  }
  assert.ok(slow.length > 50);
  assert.deepEqual(meaningPairs(entries).map(p => [p.a.id, p.b.id, p.score]), slow);
});

test('comparing documents with each other is only done on request', () => {
  const mk = (id, text) => ({ id, time: 1, group: null, text, doc: { id: `smb://s/${id}`, filename: `${id}.txt` } });
  const cards = [mk('a', 'harbour dredging contract tender '.repeat(9)), mk('b', 'harbour dredging contract tender '.repeat(9) + 'extra'),
    ...Array.from({ length: 8 }, (_, i) => mk(`p${i}`, `unrelated words number ${i} `.repeat(9)))];
  const quick = suggestBoard({ cards });
  assert.equal(quick.similar_included, false);
  assert.ok(!quick.connections.some(c => c.kind === 'similar'));
  const full = suggestBoard({ cards, similar: true });
  assert.equal(full.similar_included, true);
  assert.ok(full.connections.some(c => c.kind === 'similar'));
});

test('topics can offer as many groups as a board holds', () => {
  const word = i => `w${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + Math.floor(i / 676))}x`;
  const pairs = n => Array.from({ length: n }, (_, i) => {
    const text = `${word(i * 3)} ${word(i * 3 + 1)} ${word(i * 3 + 2)} `.repeat(20);
    return ['a', 'b'].map(side => ({ id: `${i}${side}`, time: i, group: null, text, doc: { id: `smb://s/${i}${side}`, filename: `${i}${side}.txt` } }));
  }).flat();
  const topics = n => suggestBoard({ cards: pairs(n) }).groupings.find(g => g.key === 'topic');
  const some = topics(60);
  assert.equal(some.groups.length, 60);
  assert.equal(some.left_out, 0);
  assert.ok(some.groups.every(g => g.quality), 'all rated');
  const many = topics(230);
  assert.equal(many.groups.length, 200);
  assert.equal(many.left_out, 30);
});

const emailCard = (id, body, extra = {}) => ({ id, time: 1, group: null, text: `Subject: s${id}\n\n${body}`, doc: { id: `smb://s/${id}`, email_from: 'john.delainey@x.example', email_subject: `s${id}`, ...extra } });
const unitRandom = (centre, spread) => {
  const raw = centre.map(x => x + random() * spread);
  const norm = Math.hypot(...raw);
  return raw.map(x => x / norm);
};

test('emails of a line or two go in Short notes, not in a topic', () => {
  const long = i => `quarterly gas pipeline capacity tariff review number ${i} `.repeat(8);
  const centre = randomVector();
  const cards = [
    ...Array.from({ length: 30 }, (_, i) => ({ ...emailCard(`l${i}`, long(i)), vector: unitRandom(centre, 0.2) })),
    ...Array.from({ length: 12 }, (_, i) => ({ ...emailCard(`n${i}`, `call me ${i}`), vector: unitRandom(centre, 0.2) })),
  ];
  const elsewhere = randomVector();
  const second = Array.from({ length: 10 }, (_, i) => ({ ...emailCard(`l2${i}`, `harbour dredging licence tender round ${i} `.repeat(8)), vector: unitRandom(elsewhere, 0.05) }));
  cards.splice(30, 0, ...second);
  const topic = suggestBoard({ cards }).groupings.find(g => g.key === 'topic');
  const notes = topic.groups.filter(g => g.short);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'Short notes');
  assert.equal(notes[0].members.length, 12);
  assert.ok(topic.groups.filter(g => !g.short).every(g => g.members.every(id => id.startsWith('l'))));
  // Without vectors, the same.
  const words = suggestBoard({ cards: cards.map(({ vector, ...c }) => c) }).groupings.find(g => g.key === 'topic');
  assert.equal(words.groups.find(g => g.short).members.length, 12);
  // One alone has no group, and a card already grouped is left where it is.
  const lone = suggestBoard({ cards: [...cards.slice(0, 40), cards[40], { ...cards[41], group: 'g' }] }).groupings.find(g => g.key === 'topic');
  assert.equal(lone.groups.some(g => g.short), false);
});

test('a topic is named from what its emails say, not who sent and received them', () => {
  const body = i => `john delainey discussed pipeline capacity tariff with arnold ${i} `.repeat(8);
  const centre = randomVector();
  const elsewhere = randomVector();
  const cards = [
    ...Array.from({ length: 24 }, (_, i) => ({ ...emailCard(`t${i}`, body(i), { email_to: 'arnold@x.example' }), vector: unitRandom(centre, 0.05) })),
    ...Array.from({ length: 24 }, (_, i) => ({ ...emailCard(`u${i}`, `harbour dredging licence tender round ${i} `.repeat(8)), vector: unitRandom(elsewhere, 0.05) })),
  ];
  for (const result of [suggestBoard({ cards }), suggestBoard({ cards: cards.map(({ vector, ...c }) => c) })]) {
    const { title } = result.groupings.find(g => g.key === 'topic').groups.find(g => g.members.includes('t0'));
    assert.doesNotMatch(title, /john|delainey|arnold/);
    assert.match(title, /pipeline|capacity|tariff|discussed/);
  }
});

test('a large, loose topic is split, and a tight one is left whole', () => {
  const texts = (name, i) => `alpha beta gamma delta epsilon zeta eta theta iota kappa ${name} number ${i} `.repeat(6);
  const make = (name, centre, spread, n) => Array.from({ length: n }, (_, i) => ({ ...emailCard(`${name}${i}`, texts(name, i)), vector: unitRandom(centre, spread) }));
  const [a, b, filler] = [randomVector(), randomVector(), randomVector()];
  // Two themes that sit close enough for one pass at the low bar to merge them.
  const mixed = a.map((x, i) => x * 0.6 + b[i] * 0.4);
  const other = a.map((x, i) => x * 0.4 + b[i] * 0.6);
  const loose = [...make('a', mixed, 0.7, 40), ...make('b', other, 0.7, 40), ...make('e', filler, 0.02, 25)];
  const tight = [...make('c', a, 0.02, 40), ...make('e', filler, 0.02, 25)];
  const biggest = cards => Math.max(...suggestBoard({ cards }).groupings.find(g => g.key === 'topic').groups.map(g => g.members.length));
  assert.ok(biggest(loose) < 80, `loose stayed at ${biggest(loose)}`);
  assert.ok(biggest(tight) >= 40, 'tight stays together');
});
