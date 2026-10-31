// ---------------------------------------------------------------------
// Suggestions for a board: connections and groupings worked out from what the
// viewer can already see of its documents. Nothing here changes the board, and
// every connection carries a plain reason, so that someone can judge it. Text
// similarity is ordinary TF-IDF on the start of each document, so it works
// without vector search and can say which words two documents share. Where
// vector search is on, passage vectors also find documents close in meaning,
// and sort cards into topics, which they do far more completely than words.
//
// A card is { id, doc, text, time, group, vector }: its object id, normalised
// document, text, date in epoch milliseconds or null, any group it's already
// in, and optionally the unit-length mean of its passage vectors.
// ---------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CONNECTIONS = 300;
const MAX_GROUPS_OFFERED = 50; // the biggest; more frames than this wouldn't tidy anything
const MAX_REASON = 300;
const MAX_ENTITIES = 200;
const MIN_ENTITY_CHARS = 3;
const MIN_COPY_CHARS = 200;
const MAX_TERMS = 40;          // kept per document
const SIMILAR_MIN = 0.3;       // cosine, to suggest a connection
const SIMILAR_PER_DOC = 3;
const TOPIC_MIN = 0.2;         // cosine to a topic's centre, to join it
const SHARED_TERMS_SHOWN = 5;
const COMMON_TERM_SHARE = 0.5; // in more than this share of documents says nothing
// Vectors from one set of documents are all alike until what they have in
// common is taken away, and that needs enough of them to tell.
const MIN_VECTOR_CARDS = 20;
const MEANING_MIN = 0.6;       // cosine after that, to suggest a connection
const MEANING_PER_DOC = 3;
const MEANING_MIN_CHARS = 150; // a line or two has too little meaning to compare
const VECTOR_TOPIC_MIN = 0.3;
const PASSAGE_SHOWN = 110;
// How clear a topic is. Vector similarity turned out to separate near-identical
// documents from the rest, but not real topics from jumbled ones, so that's all
// it's used for. Clarity is whether words picked from half of a group turn up in
// the other half. On Enron and govdocs, that caught jumbled groups well, but also
// flagged some real topics, so it only ever advises.
const NEAR_IDENTICAL = 0.6;    // average similarity between a group's documents
// A big group can reach that just by being about one thing: 146 different news
// articles on Enron's collapse scored 0.65, against 0.93 for 22 copies of a template.
const LARGE_GROUP = 20;
const NEAR_IDENTICAL_LARGE = 0.8;
const MIN_TO_RATE = 8;         // documents, to have two meaningful halves
const CLARITY_WORDS = 5;
const CLARITY_MATCHES = 2;     // of those words, for a document to count
const CLEAR_SHARE = 0.5;
const UNCLEAR_SHARE = 0.2;
const WEAK_FIT_MAX = 0.2;      // average similarity to the rest of the group
const WEAK_FIT_SPREAD = 1;     // standard deviations below its group's average
const MIN_DISTINCT_FOR_WEAK_FITS = 3;

// Strongest first: a pair linked by several rules is suggested for the first.
const KINDS = {
  attachment: { label: 'attached', directed: true, sure: true },
  copy: { label: 'same content', directed: false, sure: true },
  thread: { label: 'same thread', directed: false, sure: true },
  mention: { label: 'mentions', directed: true, sure: true },
  name: { label: 'same file name', directed: false, sure: false },
  similar: { label: 'similar text', directed: false, sure: false },
  meaning: { label: 'similar meaning', directed: false, sure: false },
};
const KIND_ORDER = Object.keys(KINDS);

const STOPWORDS = new Set(`about above after again against all also although always among and another any are
because been before being below between both but can cannot could did does doing done down during each either
every few for from further had has have having her here hers him his how however into its itself just least less
may might more most much must nor not now off once one only other our ours out over own per same she should since
some such than that the their theirs them then there these they this those through thus too under until upon use
used using very was were what when where which while who whom whose why will with within without would you your
yours page pages http https www com org net html forwarded original message subject sent regards thanks`.split(/\s+/));

const first = v => (Array.isArray(v) ? v[0] : v);
const all = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function cardName(card) {
  const { doc } = card;
  return String(first(doc.email_subject) || first(doc.title) || first(doc.filename) || String(doc.id).split(/[\\/]/).pop() || 'Untitled');
}

function fileName(doc) {
  const name = first(doc.filename) || String(doc.id).split(/[\\/]/).pop();
  return name ? String(name).trim().toLowerCase() : '';
}

// Whether a file's name says anything: an email's or a numbered file's doesn't,
// and two of them sharing one is a coincidence.
const meaningfulName = (doc, name) => !first(doc.email_from) && !first(doc.email_subject) && !/^\d+(\.\w+)?$/.test(name);

const addresses = doc => new Set([...all(doc.email_from), ...all(doc.email_to), ...all(doc.email_cc)]
  .map(a => String(a).trim().toLowerCase()).filter(Boolean));
const shareAddress = (a, b) => {
  const others = addresses(b);
  return [...addresses(a)].some(x => others.has(x));
};

const threadSubject = doc => String(first(doc.email_subject) || '')
  .replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase();

// A subject without its dates, so that the issues of a regular report or digest
// count as one series.
const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/g;
const seriesOf = doc => threadSubject(doc).replace(MONTHS, ' ').replace(/[^\p{L}]+/gu, ' ').trim();

// ----- Email threads -----
// Emails joined by the ids in their reply headers, including ids of messages not
// on the board: two replies to the same absent message are still one conversation.
// Outlook's Thread-Index joins them too, where the other headers were dropped.
// Returns the threads of two or more in date order, and the emails with nothing
// to go on, which are left to subject matching.
function emailThreads(cards) {
  const parent = new Map();
  const find = key => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    let at = key;
    while (parent.get(at) !== root) {
      const next = parent.get(at);
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const join = (a, b) => {
    for (const key of [a, b]) if (!parent.has(key)) parent.set(key, key);
    parent.set(find(a), find(b));
  };
  const withHeaders = [];
  const unlinked = [];
  for (const card of cards) {
    const { doc } = card;
    const ids = [...all(doc.email_references), ...all(doc.email_in_reply_to)].map(id => `id:${String(id).trim()}`);
    const threadIndex = first(doc.email_thread_index);
    if (threadIndex) ids.push(`index:${threadIndex}`);
    const own = first(doc.email_message_id);
    const key = `card:${card.id}`;
    join(key, key);
    if (own) join(key, `id:${String(own).trim()}`);
    ids.forEach(id => join(key, id));
    // An email with an id but no reply headers may be a thread's first message,
    // or from an archive without them: only other emails can say which.
    withHeaders.push({ card, key });
  }
  const groups = new Map();
  for (const { card, key } of withHeaders) {
    const root = find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(card);
  }
  // Sharing a Message-ID alone only means copies of one email, as when it was
  // filed in two mailboxes. A conversation takes at least one reply header.
  const hasReplyHeaders = ({ doc }) => first(doc.email_in_reply_to) || all(doc.email_references).length || first(doc.email_thread_index);
  const threads = [];
  for (const members of groups.values()) {
    if (members.length > 1 && members.some(hasReplyHeaders)) {
      threads.push(members.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || (a.id < b.id ? -1 : 1)));
    } else {
      unlinked.push(...members.filter(card => !hasReplyHeaders(card) && (first(card.doc.email_from) || first(card.doc.email_subject))));
    }
  }
  return { threads, unlinked };
}

// ----- What an email says -----
// Pelican's text for an email opens with its headers, and replies carry the
// headers and sign-offs of those quoted in them. Names there would relate any
// two messages between the same people, whatever they're about. Mail systems'
// routing addresses (a name/dept/company@host) would do the same.
const QUOTED_LINE = /^[ \t>]*(from|sent|to|cc|bcc|date|subject)\s*:.*$/gim;
const FORWARD_LINE = /^[ \t>]*-{2,}\s*(original message|forwarded by|forwarded message).*$/gim;
const ROUTING = /[\w.&-]+(\/[\w.&-]+)+(@[\w.-]+)?/g;

// Worked out once per card and kept: comparing every pair of documents asks for
// these millions of times, and long emails make each one slow.
function once(compute) {
  const known = new WeakMap();
  return key => {
    if (!known.has(key)) known.set(key, compute(key));
    return known.get(key);
  };
}

const bodyOf = once(card => {
  const text = String(card.text);
  const { doc } = card;
  if (!first(doc.email_from) && !first(doc.email_subject)) return text;
  const blank = /^Subject:/.test(text) ? text.search(/\r?\n\r?\n/) : -1;
  return (blank < 0 ? text : text.slice(blank))
    .replace(FORWARD_LINE, ' ').replace(QUOTED_LINE, ' ').replace(ROUTING, ' ');
});

const textKey = once(card => bodyOf(card).replace(/\s+/g, ' ').trim().toLowerCase());

// ----- Text similarity -----
function tokens(text) {
  const words = String(text).toLowerCase().match(/[\p{L}][\p{L}\p{N}'-]{2,29}/gu) || [];
  return words.filter(w => !STOPWORDS.has(w));
}

// Each card with text as a unit-length { term: weight }, its heaviest terms only.
function termVectors(cards) {
  const counted = cards.map(card => {
    const counts = new Map();
    const isMail = first(card.doc.email_from) || first(card.doc.email_subject);
    for (const w of tokens(isMail ? bodyOf(card) : `${first(card.doc.title) || ''} ${card.text}`)) {
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    return { card, counts };
  }).filter(c => c.counts.size);
  const df = new Map();
  for (const { counts } of counted) for (const w of counts.keys()) df.set(w, (df.get(w) || 0) + 1);
  const n = counted.length;
  const maxDf = Math.max(2, n * COMMON_TERM_SHARE);
  return counted.map(({ card, counts }) => {
    const weights = [];
    for (const [w, count] of counts) {
      const seen = df.get(w);
      // A word in one document can't relate it to another.
      if (seen < 2 || seen > maxDf) continue;
      weights.push([w, (1 + Math.log(count)) * Math.log(1 + n / seen)]);
    }
    weights.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const top = weights.slice(0, MAX_TERMS);
    const norm = Math.hypot(...top.map(t => t[1])) || 1;
    return { card, terms: new Map(top.map(([w, v]) => [w, v / norm])) };
  }).filter(v => v.terms.size);
}

function sharedTerms(a, b) {
  const shared = [];
  for (const [w, v] of a) if (b.has(w)) shared.push([w, v * b.get(w)]);
  return shared.sort((x, y) => y[1] - x[1]).slice(0, SHARED_TERMS_SHOWN).map(s => s[0]);
}

// Each card's closest others, found through the terms they share.
function similarPairs(vectors) {
  const index = new Map();
  vectors.forEach((v, i) => {
    for (const [w, weight] of v.terms) {
      if (!index.has(w)) index.set(w, []);
      index.get(w).push([i, weight]);
    }
  });
  const best = new Map();
  vectors.forEach((v, i) => {
    const scores = new Map();
    for (const [w, weight] of v.terms) {
      for (const [j, other] of index.get(w)) {
        if (j !== i) scores.set(j, (scores.get(j) || 0) + weight * other);
      }
    }
    [...scores].filter(([, score]) => score >= SIMILAR_MIN)
      .sort((a, b) => b[1] - a[1]).slice(0, SIMILAR_PER_DOC)
      .forEach(([j, score]) => {
        const key = pairKey(v.card.id, vectors[j].card.id);
        if (!best.has(key)) best.set(key, { a: v, b: vectors[j], score });
      });
  });
  return [...best.values()];
}

// ----- Meaning -----
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function unit(v) {
  const norm = Math.sqrt(dot(v, v)) || 1;
  return Float32Array.from(v, x => x / norm);
}

// One entry per distinct text, with what all of them share taken away. Null
// if there are too few to do that, or the vectors aren't there.
function meaningVectors(cards) {
  const seen = new Map();
  for (const card of cards) {
    if (!card.vector) continue;
    const key = textKey(card);
    if (!seen.has(key)) seen.set(key, { card, copies: [] });
    else seen.get(key).copies.push(card);
  }
  const list = [...seen.values()];
  if (list.length < MIN_VECTOR_CARDS) return null;
  const centre = new Float64Array(list[0].card.vector.length);
  for (const { card } of list) card.vector.forEach((x, i) => { centre[i] += x / list.length; });
  return list.map(entry => ({ ...entry, v: unit(entry.card.vector.map((x, i) => x - centre[i])) }));
}

// Each document's closest others. Those with one subject, dates aside, are left
// out: they're almost always one series or thread, which the subject already shows.
function meaningPairs(entries) {
  const usable = entries.filter(e => bodyOf(e.card).length >= MEANING_MIN_CHARS)
    .map(e => ({ ...e, series: seriesOf(e.card.doc) }));
  const best = new Map();
  for (const a of usable) {
    const near = [];
    for (const b of usable) {
      if (a === b || (a.series && a.series === b.series)) continue;
      const score = dot(a.v, b.v);
      if (score >= MEANING_MIN) near.push([b, score]);
    }
    near.sort((x, y) => y[1] - x[1]).slice(0, MEANING_PER_DOC).forEach(([b, score]) => {
      const key = pairKey(a.card.id, b.card.id);
      if (!best.has(key)) best.set(key, { a: a.card, b: b.card, score });
    });
  }
  return [...best.values()];
}

// The passages of two documents closest to each other, to show someone why
// they were matched: [{ vector, text }] each, or null if there's nothing to show.
function closestPassages(aPassages, bPassages) {
  let best = null;
  for (const a of aPassages) {
    for (const b of bPassages) {
      const score = dot(a.vector, b.vector);
      if (!best || score > best.score) best = { a, b, score };
    }
  }
  if (!best) return null;
  const show = p => clip(String(p.text || '').replace(/^Subject:[\s\S]*?Date:[^\n]*/, '').replace(/\s+/g, ' ').trim(), PASSAGE_SHOWN);
  const [x, y] = [show(best.a), show(best.b)];
  return x && y ? `Closest passages: "${x}" and "${y}"` : null;
}

// ----- Connections -----
function suggestConnections({ cards, entities, vectors, meaning, existing, dismissed }) {
  const found = new Map();
  const add = (kind, from, to, reason, score) => {
    const key = pairKey(from, to);
    if (from === to || existing.has(key) || dismissed.has(key)) return;
    const had = found.get(key);
    const rank = KIND_ORDER.indexOf(kind);
    if (had && (KIND_ORDER.indexOf(had.kind) < rank || (had.kind === kind && had.score >= score))) return;
    found.set(key, { kind, from, to, reason: clip(reason, MAX_REASON), score });
  };

  // An email and the file it had attached.
  const byName = new Map();
  for (const card of cards) {
    const name = fileName(card.doc);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(card);
  }
  for (const card of cards) {
    for (const attachment of all(card.doc.email_attachments)) {
      for (const match of byName.get(String(attachment).trim().toLowerCase()) || []) {
        add('attachment', card.id, match.id, `"${attachment}" is attached to this email`, 1);
      }
    }
  }

  // The same text in two places, whatever they're called.
  const byText = new Map();
  for (const card of cards) {
    const text = bodyOf(card).replace(/\s+/g, ' ').trim();
    if (text.length < MIN_COPY_CHARS) continue;
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push(card);
  }
  for (const copies of byText.values()) {
    copies.slice(1).forEach(card => add('copy', copies[0].id, card.id, 'The start of their text is identical', 1));
  }

  // Email threads, as chains in date order, rather than every pair in them.
  const { threads: linked, unlinked } = emailThreads(cards);
  for (const thread of linked) {
    thread.slice(1).forEach((card, i) => add('thread', thread[i].id, card.id, 'Their reply headers show one conversation', 1));
  }
  // Without those headers, as in some archives, the subject has to do. A subject
  // like "Meeting" isn't enough: they have to share someone as well.
  const threads = new Map();
  for (const card of unlinked) {
    const subject = threadSubject(card.doc);
    if (!subject) continue;
    if (!threads.has(subject)) threads.set(subject, []);
    threads.get(subject).push(card);
  }
  for (const [subject, thread] of threads) {
    thread.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
    thread.slice(1).forEach((card, i) => {
      if (shareAddress(thread[i].doc, card.doc)) {
        add('thread', thread[i].id, card.id, `Same subject, "${subject}", and someone in common`, 1);
      }
    });
  }

  // A person, place, organisation or event named in a document.
  for (const entity of entities.slice(0, MAX_ENTITIES)) {
    const title = entity.title.trim();
    if (title.length < MIN_ENTITY_CHARS) continue;
    const literal = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, 'iu');
    for (const card of cards) {
      const { doc } = card;
      const where = [first(doc.title), first(doc.email_subject), ...all(doc.email_from), ...all(doc.email_to),
                     ...all(doc.email_cc), ...all(doc.image_location), card.text].filter(Boolean).join('\n');
      if (re.test(where)) add('mention', card.id, entity.id, `Contains "${title}"`, 1);
    }
  }

  // The same name in different folders: often a copy or another version.
  for (const [name, same] of byName) {
    const named = same.filter(card => meaningfulName(card.doc, name));
    named.slice(1).forEach(card => add('name', named[0].id, card.id, `Both are called "${name}"`, 0.9));
  }

  // Copies are already linked as copies, however close they also look.
  const keys = new Map(cards.map(card => [card.id, textKey(card)]));
  const isCopy = (a, b) => keys.get(a) === keys.get(b);
  for (const { a, b, score } of similarPairs(vectors)) {
    if (!isCopy(a.card.id, b.card.id)) add('similar', a.card.id, b.card.id, `Share the words: ${sharedTerms(a.terms, b.terms).join(', ')}`, score);
  }
  if (meaning) {
    for (const { a, b, score } of meaningPairs(meaning)) {
      add('meaning', a.id, b.id, `Close in meaning (${score.toFixed(2)})`, score);
    }
  }

  const ranked = [...found.values()]
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.score - a.score);
  // A turn each, best first, so that plentiful kinds don't crowd out the rest.
  const queues = KIND_ORDER.map(kind => ranked.filter(c => c.kind === kind));
  const chosen = [];
  while (chosen.length < MAX_CONNECTIONS && queues.some(q => q.length)) {
    for (const queue of queues) {
      if (queue.length && chosen.length < MAX_CONNECTIONS) chosen.push(queue.shift());
    }
  }
  const shown = chosen
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.score - a.score)
    .map(c => ({ ...c, score: Math.round(c.score * 100) / 100, label: KINDS[c.kind].label, directed: KINDS[c.kind].directed, sure: KINDS[c.kind].sure }));
  return { shown, total: ranked.length };
}

// ----- Groupings -----
// One way of dividing the cards, if it does divide them: at least two groups
// of at least two. Otherwise it's no use, and isn't offered.
function grouping(key, label, cards, groupOf) {
  const groups = new Map();
  for (const card of cards) {
    const title = groupOf(card);
    if (!title) continue;
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(card.id);
  }
  const list = [...groups].filter(([, members]) => members.length >= 2)
    .map(([title, members]) => ({ title: clip(title, 200), members }))
    .sort((a, b) => b.members.length - a.members.length);
  return list.length >= 2
    ? { key, label, groups: list.slice(0, MAX_GROUPS_OFFERED), left_out: Math.max(0, list.length - MAX_GROUPS_OFFERED) }
    : null;
}

// Each document joins the topic it's closest to, or starts its own, and the
// heaviest terms name it. Biggest documents first would favour long files;
// going in date order keeps the result the same for the same board.
function topicGrouping(vectors) {
  const topics = [];
  for (const v of vectors) {
    let best = null;
    let bestScore = TOPIC_MIN;
    for (const topic of topics) {
      const norm = Math.hypot(...topic.centre.values()) || 1;
      let score = 0;
      for (const [w, weight] of v.terms) score += weight * (topic.centre.get(w) || 0) / norm;
      if (score >= bestScore) {
        best = topic;
        bestScore = score;
      }
    }
    if (!best) {
      best = { centre: new Map(), members: [] };
      topics.push(best);
    }
    for (const [w, weight] of v.terms) best.centre.set(w, (best.centre.get(w) || 0) + weight);
    best.members.push(v.card);
  }
  return namedTopics(topics.map(topic => topic.members), vectors, vectors.map(v => v.card));
}

// Whichever way topics were found, words name them, as a vector can't be read.
// Two can end up with one name, and mustn't merge for it.
function namedTopics(topics, vectors, cards) {
  const termsOf = new Map(vectors.map(v => [v.card.id, v.terms]));
  const titles = new Map();
  const used = new Map();
  for (const members of topics) {
    if (members.length < 2) continue;
    const weights = new Map();
    for (const card of members) {
      for (const [w, weight] of termsOf.get(card.id) || []) weights.set(w, (weights.get(w) || 0) + weight);
    }
    const words = [...weights].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(t => t[0]).join(', ') || 'Untitled topic';
    used.set(words, (used.get(words) || 0) + 1);
    const title = used.get(words) > 1 ? `${words} (${used.get(words)})` : words;
    members.forEach(card => titles.set(card.id, title));
  }
  return grouping('topic', 'Topic', cards, card => titles.get(card.id));
}

// The same one-pass method, by meaning. Only cards not in a group are placed,
// though all of them helped decide what's alike. A copy goes with its original.
function vectorTopicGrouping(entries, vectors) {
  const topics = [];
  const free = entries.map(entry => ({ ...entry, cards: [entry.card, ...entry.copies].filter(c => !c.group) }))
    .filter(entry => entry.cards.length)
    .sort((a, b) => (a.card.time ?? Infinity) - (b.card.time ?? Infinity) || (a.card.id < b.card.id ? -1 : 1));
  for (const entry of free) {
    let best = null;
    let bestScore = VECTOR_TOPIC_MIN;
    for (const topic of topics) {
      const score = dot(entry.v, topic.centre) / (Math.sqrt(dot(topic.centre, topic.centre)) || 1);
      if (score >= bestScore) {
        best = topic;
        bestScore = score;
      }
    }
    if (!best) {
      best = { centre: new Float64Array(entry.v.length), members: [] };
      topics.push(best);
    }
    entry.v.forEach((x, i) => { best.centre[i] += x; });
    best.members.push(...entry.cards);
  }
  return namedTopics(topics.map(topic => topic.members), vectors, free.flatMap(entry => entry.cards));
}

// ----- How alike a topic is -----
// Each distinct text's average closeness to every other in its group. Averaging
// over pairs, rather than comparing with the group's centre, keeps big groups
// from looking more alike just for being big. Vectors are unit length.
function fitsOf(items) {
  const sum = new Float64Array(items[0].v.length);
  for (const { v } of items) v.forEach((x, i) => { sum[i] += x; });
  return items.map(({ v }) => (dot(v, sum) - dot(v, v)) / (items.length - 1));
}

// The share of one half of a group holding words picked from the other.
function heldOutShare(members, termsOf, cardOf) {
  const ids = members.filter(id => termsOf.has(id));
  const [picked, tested] = [ids.filter((_, i) => i % 2 === 0), ids.filter((_, i) => i % 2 === 1)];
  if (!tested.length) return 0;
  const weights = new Map();
  for (const id of picked) for (const [w, weight] of termsOf.get(id)) weights.set(w, (weights.get(w) || 0) + weight);
  const words = [...weights].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, CLARITY_WORDS).map(t => t[0]);
  const holding = tested.filter(id => {
    const body = bodyOf(cardOf.get(id)).toLowerCase();
    return words.filter(w => body.includes(w)).length >= CLARITY_MATCHES;
  });
  return holding.length / tested.length;
}

// The rating of one set of cards. items: [{ v, ids }], one per distinct text.
function rateMembers(members, items, termsOf, cardOf, basis) {
  const fits = items.length > 1 ? fitsOf(items) : [];
  const alike = items.length > 1 ? fits.reduce((a, b) => a + b, 0) / fits.length : 1;
  const spread = Math.sqrt(fits.reduce((a, f) => a + (f - alike) ** 2, 0) / (fits.length || 1));
  const weak = items.length < MIN_DISTINCT_FOR_WEAK_FITS ? []
    : items.filter((_, i) => fits[i] < WEAK_FIT_MAX && fits[i] < alike - WEAK_FIT_SPREAD * spread).flatMap(item => item.ids);
  const share = heldOutShare(members, termsOf, cardOf);
  const rating = alike >= (members.length >= LARGE_GROUP ? NEAR_IDENTICAL_LARGE : NEAR_IDENTICAL) ? 'near_identical'
    : members.length < MIN_TO_RATE ? 'too_few'
    : share >= CLEAR_SHARE ? 'clear' : share < UNCLEAR_SHARE ? 'unclear' : 'some';
  return { rating, basis, alike: Math.round(alike * 100) / 100, shared: Math.round(share * 100) / 100, weak_fits: weak };
}

function rateGrouping(result, itemsOf, vectors, basis) {
  if (!result) return null;
  const termsOf = new Map(vectors.map(v => [v.card.id, v.terms]));
  const cardOf = new Map(vectors.map(v => [v.card.id, v.card]));
  const counts = { near_identical: 0, clear: 0, some: 0, unclear: 0, too_few: 0 };
  let weakFits = 0;
  for (const group of result.groups) {
    group.quality = rateMembers(group.members, itemsOf(group.members), termsOf, cardOf, basis);
    counts[group.quality.rating]++;
    weakFits += group.quality.weak_fits.length;
  }
  result.quality = { ...counts, weak_fits: weakFits };
  return result;
}

// Rates one group's cards as they are now, against the whole board, which is
// what the word weights and the vectors' common part come from.
function rateGroup(cards, memberIds) {
  const vectors = termVectors(cards);
  const meaning = meaningVectors(cards);
  const items = meaning ? meaningItems(meaning)(memberIds) : wordItems(vectors)(memberIds);
  return rateMembers(memberIds, items, new Map(vectors.map(v => [v.card.id, v.terms])),
    new Map(vectors.map(v => [v.card.id, v.card])), meaning ? 'meaning' : 'wording');
}

function meaningItems(entries) {
  const entryOf = new Map();
  for (const entry of entries) [entry.card, ...entry.copies].forEach(card => entryOf.set(card.id, entry));
  return members => {
    const items = new Map();
    for (const id of members) {
      const entry = entryOf.get(id);
      if (!entry) continue;
      if (!items.has(entry)) items.set(entry, { v: entry.v, ids: [] });
      items.get(entry).ids.push(id);
    }
    return [...items.values()];
  };
}

function wordItems(vectors) {
  const byId = new Map(vectors.map(v => [v.card.id, v]));
  return members => {
    const found = members.map(id => byId.get(id)).filter(Boolean);
    const vocabulary = new Map();
    for (const { terms } of found) for (const w of terms.keys()) if (!vocabulary.has(w)) vocabulary.set(w, vocabulary.size);
    const items = new Map();
    for (const { card, terms } of found) {
      const key = textKey(card);
      if (!items.has(key)) {
        const v = new Float64Array(vocabulary.size);
        for (const [w, weight] of terms) v[vocabulary.get(w)] = weight;
        items.set(key, { v, ids: [] });
      }
      items.get(key).ids.push(card.id);
    }
    return [...items.values()];
  };
}

function folderOf(doc) {
  const id = String(doc.id);
  const path = id.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, '');
  if (path === id || !path.includes('/')) return null;
  return path.slice(0, path.lastIndexOf('/'));
}

// One frame per conversation, named by its subject. Only cards with reply
// headers count: subject matches are suggestions to check, not conversations.
function threadGrouping(cards) {
  const emails = cards.filter(c => first(c.doc.email_from) || first(c.doc.email_subject));
  const { threads } = emailThreads(emails);
  const titles = new Map();
  const used = new Map();
  for (const thread of threads) {
    const base = threadSubject(thread[0].doc) || '(no subject)';
    used.set(base, (used.get(base) || 0) + 1);
    const title = used.get(base) > 1 ? `${base} (${used.get(base)})` : base;
    thread.forEach(card => titles.set(card.id, title));
  }
  return grouping('thread', 'Thread', emails, card => titles.get(card.id));
}

function periodGrouping(cards) {
  const times = cards.map(c => c.time).filter(t => t !== null);
  if (times.length < 2) return null;
  const span = (Math.max(...times) - Math.min(...times)) / DAY_MS;
  // Months only make sense over a short stretch; otherwise it's one frame each.
  const length = span > 730 ? 4 : 7;
  return grouping('period', 'Period', cards, card => (card.time === null ? null : new Date(card.time).toISOString().slice(0, length)));
}

function suggestGroupings(cards, vectors, meaning) {
  // A card already in a group was put there on purpose, so it's left alone.
  const free = cards.filter(c => !c.group);
  const freeVectors = vectors.filter(v => !v.card.group)
    .sort((a, b) => (a.card.time ?? Infinity) - (b.card.time ?? Infinity) || (a.card.id < b.card.id ? -1 : 1));
  return [
    meaning ? rateGrouping(vectorTopicGrouping(meaning, vectors), meaningItems(meaning), vectors, 'meaning')
      : rateGrouping(topicGrouping(freeVectors), wordItems(vectors), vectors, 'wording'),
    threadGrouping(free),
    grouping('folder', 'Folder', free, card => folderOf(card.doc)),
    grouping('correspondent', 'Sender', free, card => (first(card.doc.email_from) ? String(first(card.doc.email_from)).trim().toLowerCase() : null)),
    periodGrouping(free),
    grouping('type', 'File type', free, card => (first(card.doc.type) ? String(first(card.doc.type)) : null)),
  ].filter(Boolean);
}

function suggestBoard({ cards, entities = [], connections = [], dismissed = [] }) {
  const vectors = termVectors(cards);
  const existing = new Set(connections.map(c => pairKey(c.from, c.to)));
  const meaning = meaningVectors(cards);
  const { shown, total } = suggestConnections({ cards, entities, vectors, meaning, existing, dismissed: new Set(dismissed) });
  return {
    connections: shown,
    connections_total: total,
    groupings: suggestGroupings(cards, vectors, meaning),
    meaning_used: Boolean(meaning),
    names: Object.fromEntries(cards.map(c => [c.id, cardName(c)])),
  };
}

module.exports = { suggestBoard, rateGroup, closestPassages, pairKey };
