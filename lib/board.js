// ---------------------------------------------------------------------
// A collection's evidence board: where things sit and what the user wrote,
// checked on every save. As with collections, a document appears only by id,
// never with its title or text: those are looked up again with the viewer's
// roles whenever the board is opened.
// ---------------------------------------------------------------------
const MAX_OBJECTS = 1500;  // a full collection's documents, and room for notes
const MAX_GROUPS = 200;
const MAX_CONNECTIONS = 3000;
const MAX_DISMISSED = 5000;
const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const MAX_LABEL = 100;
const MAX_DOC_ID = 2048;
const MAX_COORD = 1000000;
const MIN_GROUP_W = 160;
const MIN_GROUP_H = 100;
const MAX_GROUP_SIZE = 50000;

const RATINGS = ['near_identical', 'clear', 'some', 'unclear', 'too_few'];
const KINDS = ['doc', 'note', 'person', 'place', 'org', 'event'];
const COLORS = ['default', 'teal', 'amber', 'red', 'violet', 'blue'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAIR_RE = /^[A-Za-z0-9_-]{1,40}\|[A-Za-z0-9_-]{1,40}$/;

class BoardError extends Error {
  constructor(message) { super(message); this.status = 400; this.expose = true; }
}

function isDay(value) {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  // Rolled-over dates such as 02-31 don't come back the same.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function cleanId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new BoardError('Invalid id on the board');
  return value;
}

function cleanString(value, max, what) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new BoardError(`${what} can be up to ${max} characters`);
  return value;
}

function cleanCoord(value) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORD) throw new BoardError('Invalid position on the board');
  return Math.round(value);
}

function cleanColor(value) {
  if (value === undefined || value === null) return 'default';
  if (!COLORS.includes(value)) throw new BoardError('Invalid colour on the board');
  return value;
}

function list(value, max, what) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BoardError(`Invalid list of ${what}`);
  if (value.length > max) throw new BoardError(`A board can hold up to ${max} ${what}`);
  return value;
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardError('Invalid item on the board');
  return value;
}

// Where the board was left, so that it reopens there.
function cleanView(value) {
  if (value === undefined || value === null) return undefined;
  const v = record(value);
  const limit = MAX_COORD * 10;
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || Math.abs(v.x) > limit || Math.abs(v.y) > limit
      || !Number.isFinite(v.k) || v.k < 0.01 || v.k > 5) {
    throw new BoardError('Invalid view of the board');
  }
  return { x: v.x, y: v.y, k: v.k };
}

// A topic group's rating when it was made: figures and object ids, nothing from
// the documents, and how it compares with the group now is worked out on display.
function cleanQuality(value) {
  if (value === undefined || value === null) return undefined;
  const q = record(value);
  const ratio = n => {
    if (!Number.isFinite(n) || Math.abs(n) > 1.01) throw new BoardError('Invalid group rating');
    return Math.round(n * 100) / 100;
  };
  const ids = v => list(v, MAX_OBJECTS, 'objects').map(cleanId);
  if (!RATINGS.includes(q.rating) || !['meaning', 'wording'].includes(q.basis)) throw new BoardError('Invalid group rating');
  if (!Number.isInteger(q.left_out) || q.left_out < 0 || q.left_out > MAX_OBJECTS) throw new BoardError('Invalid group rating');
  return { rating: q.rating, basis: q.basis, alike: ratio(q.alike), shared: ratio(q.shared), members: ids(q.members), weak_fits: ids(q.weak_fits), left_out: q.left_out };
}

// Only the known fields of what's sent are kept. Anything that doesn't fit
// is an error, not a quiet repair, so a bad save can't damage a saved board.
function cleanBoard(input) {
  const board = record(input);
  const ids = new Set();
  const uniqueId = value => {
    const id = cleanId(value);
    if (ids.has(id)) throw new BoardError('A board can\'t use the same id twice');
    ids.add(id);
    return id;
  };

  const groups = list(board.groups, MAX_GROUPS, 'groups').map(raw => {
    const g = record(raw);
    if (!Number.isFinite(g.w) || !Number.isFinite(g.h)) throw new BoardError('Invalid group size');
    const quality = cleanQuality(g.quality);
    return {
      ...(quality && { quality }),
      id: uniqueId(g.id),
      title: cleanString(g.title, MAX_TITLE, 'A group\'s title'),
      x: cleanCoord(g.x),
      y: cleanCoord(g.y),
      w: Math.round(Math.min(MAX_GROUP_SIZE, Math.max(MIN_GROUP_W, g.w))),
      h: Math.round(Math.min(MAX_GROUP_SIZE, Math.max(MIN_GROUP_H, g.h))),
      color: cleanColor(g.color),
      collapsed: g.collapsed === true,
    };
  });
  const groupIds = new Set(groups.map(g => g.id));

  const docIds = new Set();
  const objects = list(board.objects, MAX_OBJECTS, 'objects').map(raw => {
    const o = record(raw);
    if (!KINDS.includes(o.kind)) throw new BoardError('Invalid kind of object on the board');
    const date = cleanString(o.date, 10, 'A date');
    if (date && !isDay(date)) throw new BoardError('Invalid date on the board');
    const group = o.group === undefined || o.group === null ? null : cleanId(o.group);
    if (group && !groupIds.has(group)) throw new BoardError('An object is in a group that doesn\'t exist');
    const clean = {
      id: uniqueId(o.id),
      kind: o.kind,
      x: cleanCoord(o.x),
      y: cleanCoord(o.y),
      color: cleanColor(o.color),
      group,
      date,
      text: cleanString(o.text, MAX_TEXT, 'A note'),
    };
    if (o.kind !== 'doc') return { ...clean, title: cleanString(o.title, MAX_TITLE, 'A title') };
    if (typeof o.doc_id !== 'string' || !o.doc_id.trim() || o.doc_id.length > MAX_DOC_ID) {
      throw new BoardError('Invalid document id');
    }
    if (docIds.has(o.doc_id)) throw new BoardError('A document can only be on a board once');
    docIds.add(o.doc_id);
    return { ...clean, doc_id: o.doc_id };
  });

  const connections = list(board.connections, MAX_CONNECTIONS, 'connections').map(raw => {
    const c = record(raw);
    const [from, to] = [cleanId(c.from), cleanId(c.to)];
    if (from === to || !ids.has(from) || !ids.has(to)) throw new BoardError('A connection needs two different items on the board');
    return {
      id: cleanId(c.id),
      from,
      to,
      label: cleanString(c.label, MAX_LABEL, 'A connection\'s label'),
      color: cleanColor(c.color),
      directed: c.directed === true,
    };
  });
  if (new Set(connections.map(c => c.id)).size !== connections.length) {
    throw new BoardError('A board can\'t use the same id twice');
  }

  // Pairs of ids whose suggested connection was turned down. Ids only, and they
  // needn't still exist: an undo can bring a card back.
  const dismissed = list(board.dismissed, MAX_DISMISSED, 'dismissed suggestions').map(pair => {
    if (typeof pair !== 'string' || !PAIR_RE.test(pair)) throw new BoardError('Invalid dismissed suggestion');
    return pair;
  });

  const view = cleanView(board.view);
  return { objects, groups, connections, dismissed, ...(view && { view }) };
}

const emptyBoard = () => ({ objects: [], groups: [], connections: [], dismissed: [] });
const boardDocIds = board => board.objects.filter(o => o.kind === 'doc').map(o => o.doc_id);

module.exports = { cleanBoard, emptyBoard, boardDocIds, BoardError };
