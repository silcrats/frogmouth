const express = require('express');
const session = require('express-session');
const path = require('path');
const { loadConfig, publicConfig, SEARCH_MODES } = require('./lib/config');
const { createLdapAuth } = require('./lib/auth/ldap');
const { createSmbDownloader, contentDisposition } = require('./lib/downloaders/smb');
const { createOpenSearchClient } = require('./lib/opensearch');
const { openCollections, MAX_ITEMS } = require('./lib/collections');
const { parseDocDate, timelineBuckets, timelineDays } = require('./lib/timeline');
const { suggestBoard, rateGroup, closestPassages } = require('./lib/board-suggest');
const { streamCollectionZip, safeEntryName } = require('./lib/collection-zip');

const config = loadConfig();
const app = express();
const { version: VERSION } = require('./package.json');
const PORT = process.env.PORT || 3000;

const opensearch = createOpenSearchClient(config.opensearch);
const collections = openCollections(config.collections.db_path);
const SEARCH_INDEX = config.opensearch.index;
const F = config.fields;
const ROLE_FIELD = config.security.role_field;

// ---------------------------------------------------------------------
// Pluggable pieces: auth provider by name, downloaders by URL scheme.
// ---------------------------------------------------------------------
const AUTH_PROVIDERS = { ldap: createLdapAuth };
const DOWNLOADERS = { smb: createSmbDownloader };

const authFactory = AUTH_PROVIDERS[config.auth.provider];
if (!authFactory) throw new Error(`config: unknown auth.provider "${config.auth.provider}"`);
const auth = authFactory(config.auth[config.auth.provider] || {});

const downloaders = {};
for (const [scheme, opts] of Object.entries(config.downloads)) {
  if (!DOWNLOADERS[scheme]) throw new Error(`config: no downloader for scheme "${scheme}"`);
  downloaders[scheme] = DOWNLOADERS[scheme](opts || {});
}

// ---------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------
// Secure cookies are only issued on HTTPS requests; behind a reverse proxy
// that terminates TLS, trust its X-Forwarded-Proto so they still are.
if (config.session.secure_cookie) app.set('trust proxy', 1);

app.use(session({
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8h -- re-login once per working day
    secure: config.session.secure_cookie,
  }
}));
// A long selection of results can far exceed the default limit below (1,000
// ids of up to 2,048 characters), but only from someone signed in.
app.post(['/api/collections/:id/items/bulk', '/api/collections/:id/items/bulk-remove'], requireAuth, express.json({ limit: '3mb' }));
// A full board is a large single save: every document's id, and every note.
app.put('/api/collections/:id/board', requireAuth, express.json({ limit: '12mb' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Thrown for malformed client input; the error handler at the bottom turns
// it into a 400 with this message.
class BadRequest extends Error {
  constructor(message) { super(message); this.status = 400; this.expose = true; }
}

// A single query-string value, or '' if absent. A repeated or bracketed
// parameter (?q=a&q=b) arrives as an array or object -- reject it rather
// than let a string method throw on it.
function queryParam(req, name) {
  const v = req.query[name];
  if (v === undefined) return '';
  if (typeof v !== 'string') throw new BadRequest(`Invalid ${name} parameter`);
  return v;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

// Every authenticated user gets the configured default roles, plus their
// own user role and one entry per group they belong to, each encoded with
// the prefixes the indexer uses (see security in config.yaml).
// The user role is lower-cased by default: the role field is a
// case-sensitive keyword, while LDAP accepts any casing at login
// ("JSmith" and "jsmith" are the same account).
function computeRoles(username, groups) {
  const { prefixes, default_roles: defaults = [], lowercase_username: lower } = config.security;
  const user = lower ? String(username).toLowerCase() : String(username);
  return [
    ...defaults.map(r => `${prefixes.role || ''}${r}`),
    `${prefixes.user || ''}${user}`,
    ...groups.map(g => `${prefixes.group || ''}${g}`),
  ];
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const { groups, displayName } = await auth.authenticate(username, password);
    req.session.user = { username, displayName: displayName || username, roles: computeRoles(username, groups) };
    res.json({ ok: true, username, displayName: req.session.user.displayName });
  } catch (err) {
    console.error('Auth failed for', username, '-', err.message);
    res.status(401).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/whoami', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  // The version is shown only once signed in, so the sign-in page doesn't
  // advertise it.
  res.json({ username: req.session.user.username, displayName: req.session.user.displayName || req.session.user.username, version: VERSION });
});

// Branding, sources, filters and type groups for the browser. Public so
// the login page can show the configured title too.
app.get('/api/config', (req, res) => {
  res.json(publicConfig(config));
});

// ---------------------------------------------------------------------
// OpenSearch query building
// ---------------------------------------------------------------------
const RETURN_FIELDS = [...new Set([...Object.values(F), ...config.extra_fields])];

// Index doc -> the UI's own field names (config.fields keys), plus the
// extra display fields under their index names.
function normalizeDoc(src) {
  const doc = {};
  for (const [name, field] of Object.entries(F)) {
    if (src[field] !== undefined) doc[name] = src[field];
  }
  for (const field of config.extra_fields) {
    if (src[field] !== undefined) doc[field] = src[field];
  }
  doc.id = Array.isArray(doc.id) ? doc.id[0] : doc.id;
  return doc;
}

const TYPE_ALIASES = config.types.aliases;
const TYPE_GROUPS = Object.fromEntries(config.types.groups.map(g => [g.key, g.members || []]));
const SCOPE_HOSTS = Object.fromEntries(config.sources.map(s => [s.key, s.host]));

const DATE_RANGE = 'date_range';  // value: "from..to", either end optional

// Filter key -> index field. "type" and "share" are built in; every other
// configured filter names its own field.
const FIELD_MAP = { type: F.type, share: F.share, [DATE_RANGE]: F.created };
for (const f of config.filters) {
  if (f.key !== 'type' && f.key !== 'share' && f.field) FIELD_MAP[f.key] = f.field;
}

function toIsoDate(dateStr, endOfDay) {
  if (!dateStr) return null;
  return endOfDay ? `${dateStr}T23:59:59Z` : `${dateStr}T00:00:00Z`;
}

async function osSearch(body) {
  const res = await opensearch.request('POST', `/${encodeURIComponent(SEARCH_INDEX)}/_search`, body);
  if (!res.ok) throw new Error(`OpenSearch error ${res.status}: ${res.text}`);
  const data = JSON.parse(res.text);
  // A shard that fails still leaves a 200 with the full hit count, just
  // without that shard's documents -- log why, rather than lose them quietly.
  const shards = data._shards || {};
  if (shards.failed) {
    const reasons = [...new Set((shards.failures || []).map(f => f.reason && f.reason.reason))].filter(Boolean);
    console.warn(`OpenSearch: ${shards.failed} of ${shards.total} shard(s) failed:`, reasons.join('; ') || 'no reason given');
  }
  return data;
}

// Highlighting re-analyzes each hit's text, and OpenSearch fails a hit
// whose text is longer than index.highlight.max_analyzed_offset (default
// 1,000,000 characters) -- dropping it from the results. Highlight within
// that many characters instead. Must not exceed the index's own setting.
const HIGHLIGHT_MAX_CHARS = 1000000;
// Search results carry a preview of each document, not its text, which can
// run to millions of characters: the matching snippets, or failing that
// this many characters from the start. The expanded view fetches the text
// (/api/document), up to FULL_TEXT_MAX_CHARS.
const PREVIEW_CHARS = 240;
const FULL_TEXT_MAX_CHARS = 1000000;
const SEARCH_FIELDS = RETURN_FIELDS.filter(f => f !== F.content);

function roleFilter(roles) {
  return { terms: { [ROLE_FIELD]: roles } };
}

// Shared by /api/search and /api/facets, so a facet count is always computed
// against exactly the filters/scope/dates/security a real search would use.
function buildFilterBool(filters, logic, dateFrom, dateTo, scope, roles) {
  const active = filters.filter(f => f.value && Object.hasOwn(FIELD_MAP, f.field));
  const toClause = f => {
    const field = FIELD_MAP[f.field];
    if (f.field === DATE_RANGE) {
      const ends = f.value.split('..');
      // Either way round: someone filling in the second date first means the same.
      const [from, to] = ends[0] && ends[1] ? [...ends].sort() : ends;
      return { range: { [field]: { ...(from && { gte: toIsoDate(from, false) }), ...(to && { lte: toIsoDate(to, true) }) } } };
    }
    if (f.field === 'type') {
      // A broad category (types.groups, e.g. "images") matches any of its
      // members; a merged alias (types.aliases, jpg/jpeg) matches each of
      // its values; otherwise it's a plain single value.
      const values = Object.hasOwn(TYPE_GROUPS, f.value) ? TYPE_GROUPS[f.value]
        : Object.hasOwn(TYPE_ALIASES, f.value) ? TYPE_ALIASES[f.value]
        : [f.value];
      return { terms: { [field]: values } };
    }
    if (f.field === 'share') {
      return { term: { [field]: f.value } };
    }
    // Free-text filters: case-insensitive substring match. Wildcard
    // queries need the exact-value .keyword sub-field, not the analyzed
    // text field.
    return { wildcard: { [`${field}.keyword`]: { value: `*${f.value}*`, case_insensitive: true } } };
  };
  // "is" rows combine with ALL (AND) or ANY (OR); "is not" rows always
  // apply, so "any of these, but never that" works with either.
  const includes = active.filter(f => !f.not).map(toClause);
  const excludes = active.filter(f => f.not).map(toClause);

  const filterBool = includes.length
    ? [{ bool: logic === 'OR' ? { should: includes, minimum_should_match: 1 } : { must: includes } }]
    : [];
  if (excludes.length) filterBool.push({ bool: { must_not: excludes } });

  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.gte = dateFrom;
    if (dateTo) range.lte = dateTo;
    filterBool.push({ range: { [F.created]: range } });
  }

  // Optional source scope (a sources[].key). Anything else, including no
  // value, searches everything.
  const scopeHost = Object.hasOwn(SCOPE_HOSTS, scope) ? SCOPE_HOSTS[scope] : null;
  if (scopeHost) filterBool.push({ term: { [F.source]: scopeHost } });

  // The security-critical part: every search is constrained to documents
  // whose role field contains at least one role this user actually holds
  // (computed server-side at login -- never trust a client-supplied list).
  filterBool.push(roleFilter(roles));

  return filterBool;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(value) {
  const d = new Date(`${value}T00:00:00Z`);
  return DATE_RE.test(value) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// A row with neither end filled in is one nobody has finished, and is ignored.
function isDateRange(value) {
  const ends = value.split('..');
  if (value === '') return true;
  return ends.length === 2 && ends.some(Boolean) && ends.every(end => !end || isRealDay(end));
}

// filters is a JSON array of { field, value } string pairs, each with an
// optional boolean `not` (exclude matches); dates are
// YYYY-MM-DD. Anything else is a 400, not a malformed OpenSearch query.
function parseFilterParams(req) {
  let filters;
  try {
    filters = JSON.parse(queryParam(req, 'filters') || '[]');
  } catch {
    throw new BadRequest('Invalid filters parameter');
  }
  if (!Array.isArray(filters) || !filters.every(f =>
    f && typeof f === 'object' && typeof f.field === 'string' && typeof f.value === 'string'
    && (f.not === undefined || typeof f.not === 'boolean'))) {
    throw new BadRequest('Invalid filters parameter');
  }
  if (!filters.every(f => f.field !== DATE_RANGE || isDateRange(f.value))) throw new BadRequest('Invalid date range');
  const logic = queryParam(req, 'logic').toUpperCase() === 'OR' ? 'OR' : 'AND';
  const from = queryParam(req, 'dateFrom');
  const to = queryParam(req, 'dateTo');
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    throw new BadRequest('Invalid date parameter');
  }
  return { filters, logic, dateFrom: toIsoDate(from, false), dateTo: toIsoDate(to, true) };
}

// Search modes (vector: in config.yaml). keyword is the full-text query;
// semantic finds the documents with passages closest in meaning to q; hybrid
// runs both and the index's search pipeline blends their scores.
function searchMode(req, q) {
  const mode = queryParam(req, 'mode') || 'keyword';
  if (!SEARCH_MODES.includes(mode)) throw new BadRequest('Invalid mode parameter');
  if (mode !== 'keyword' && !config.vector.enabled) throw new BadRequest('Vector search is not enabled');
  // A blank q has no meaning to compare against: browse as keyword does.
  return q ? mode : 'keyword';
}

function semanticQuery(text, filterBool) {
  const { field, k } = config.vector;
  return {
    bool: {
      must: [{
        nested: {
          path: field,
          score_mode: 'max',
          query: {
            neural: {
              [`${field}.knn`]: {
                query_text: text,
                k,
                // Applied during the nearest-neighbour search, not after it:
                // otherwise the closest passages could all belong to documents
                // this user can't see, leaving too few results or none.
                filter: { bool: { filter: filterBool } },
              },
            },
          },
        },
      }],
      // And on the matching documents themselves.
      filter: filterBool,
    },
  };
}

// Highlights mark matches with these rather than <mark>: a snippet is
// document text, so it's HTML-escaped first and only then are the markers
// turned into tags. Otherwise HTML in an indexed file or email would run in
// the browser of whoever's results it appears in.
const HL_PRE = '\uE000';
const HL_POST = '\uE001';
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function highlightToHtml(fragment) {
  return String(fragment).replace(/[&<>"']/g, c => HTML_ESCAPES[c])
    .replaceAll(HL_PRE, '<mark>').replaceAll(HL_POST, '</mark>');
}

// The preview for each result: matching snippets, or the start of the text
// when nothing matches (a blank q, or a semantic match without the words
// searched for). highlightQuery: what to highlight, if not the query itself.
function previewHighlight(highlightQuery) {
  return {
    max_analyzer_offset: HIGHLIGHT_MAX_CHARS,
    fields: { [F.content]: { fragment_size: 200, number_of_fragments: 2, no_match_size: PREVIEW_CHARS } },
    pre_tags: [HL_PRE],
    post_tags: [HL_POST],
    ...(highlightQuery && { highlight_query: highlightQuery }),
  };
}

// Hits -> the results page the browser renders (docs plus escaped previews).
function resultPage(hits, start, numFound) {
  const docs = hits.map(h => normalizeDoc(h._source));
  const highlighting = {};
  hits.forEach((h, i) => {
    if (h.highlight && h.highlight[F.content]) {
      highlighting[docs[i].id] = { content: h.highlight[F.content].map(highlightToHtml) };
    }
  });
  return { numFound, start, docs, highlighting };
}

// Limits a search to one of the user's collections, for ?collection=<id>. Inside
// the same filter as the roles, so it applies to the nearest-neighbour search too.
function collectionFilter(req, id = queryParam(req, 'collection')) {
  return id ? [{ terms: { [F.id]: collections.items(collectionOwner(req), id) } }] : [];
}

// The query for the search described by the request's parameters, shared by
// /api/search and "add all results to a collection" so that they always
// match the same documents. depth: how far down the results it'll be read,
// which hybrid search has to be told.
function buildSearchQuery(req, depth = config.vector.k, collectionId) {
  const qRaw = queryParam(req, 'q').trim();
  // "quoted" search: require the exact phrase, not just all/any of its
  // words anywhere in the field.
  const phraseSearch = qRaw.length > 2 && qRaw.startsWith('"') && qRaw.endsWith('"');
  const q = phraseSearch ? qRaw.slice(1, -1).trim() : qRaw;
  const { filters, logic, dateFrom, dateTo } = parseFilterParams(req);

  // A blank q is valid: with filters set it browses just what matches them, and
  // with none set it lists everything the signed-in user can see (still capped
  // by role + pagination) -- match_all in place of the text search below.
  const filterBool = buildFilterBool(filters, logic, dateFrom, dateTo, queryParam(req, 'scope'), req.session.user.roles);
  filterBool.push(...collectionFilter(req, collectionId));
  const mode = searchMode(req, q);

  const textMatch = q ? {
    multi_match: {
      query: q,
      type: phraseSearch ? 'phrase' : 'best_fields',
      fields: config.search_fields,
    }
  } : { match_all: {} };
  const keyword = { bool: { must: [textMatch], filter: filterBool } };
  const query = mode === 'semantic' ? semanticQuery(q, filterBool)
    : mode === 'hybrid' ? { hybrid: { queries: [keyword, semanticQuery(q, filterBool)], pagination_depth: depth } }
    : keyword;
  return { query, mode, textMatch };
}

app.get('/api/search', requireAuth, async (req, res) => {
  const { start, rows } = pageParams(req);
  // Hybrid search only ranks this far down, so it has to reach the page asked for.
  const { query, mode, textMatch } = buildSearchQuery(req, Math.max(config.vector.k, start + rows));

  const body = {
    from: start,
    size: rows,
    query,
    _source: SEARCH_FIELDS,
    // Semantic matches needn't contain the words searched for, but highlight
    // them where they do.
    highlight: previewHighlight(mode !== 'keyword' ? textMatch : undefined),
  };

  try {
    const data = await osSearch(body);
    const partial = Boolean(data._shards && data._shards.failed);
    res.json({ ...resultPage(data.hits.hits, start, data.hits.total.value), partial, mode });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(502).json({ error: 'Search failed', detail: err.message });
  }
});

// A result's text for the expanded view. Re-checked against the user's
// roles like a download: an id could be guessed or pasted.
app.get('/api/document', requireAuth, async (req, res) => {
  const id = queryParam(req, 'id').trim();
  if (!id) return res.status(400).json({ error: 'Missing id parameter' });
  try {
    const data = await osSearch({
      size: 1,
      _source: [F.content],
      query: { bool: { must: [{ term: { [F.id]: id } }], filter: [roleFilter(req.session.user.roles)] } },
    });
    const hit = data.hits.hits[0];
    // Missing and not permitted look the same, as for downloads.
    if (!hit) return res.status(403).json({ error: 'Not permitted' });
    const value = hit._source[F.content];
    const text = String((Array.isArray(value) ? value[0] : value) || '');
    res.json({ content: text.slice(0, FULL_TEXT_MAX_CHARS), length: text.length });
  } catch (err) {
    console.error('Document text error:', err.message);
    res.status(502).json({ error: 'Could not load the document', detail: err.message });
  }
});

// ---------------------------------------------------------------------
// Collections: each user's private lists of results (lib/collections.js),
// and "more like these" searches seeded from them. Only document ids are
// stored, so everything shown is looked up again with the viewer's roles:
// an item they've lost access to drops out of view, and is never used as
// an example either.
// ---------------------------------------------------------------------
const SIMILAR_SEEDS = 20;     // most recently added visible items used as examples
const SIMILAR_PER_SEED = 50;  // semantic: nearest documents taken for each example
const SIMILAR_MAX = 200;      // results a "more like these" search pages through
// Text taken from each example for keyword "more like these".
const MLT_TEXT_CHARS = 20000;
// more_like_this takes plain field names, not search_fields' ^boosts.
const MLT_FIELDS = config.search_fields.map(f => f.split('^')[0]);

function collectionOwner(req) {
  return String(req.session.user.username).toLowerCase();
}

const MAX_PAGE_ROWS = 1000;
// Previews re-read each document's text, which a single large query does badly.
const PREVIEW_BATCH = 100;

function pageParams(req) {
  const start = Math.max(0, parseInt(queryParam(req, 'start'), 10) || 0);
  const rows = Math.min(MAX_PAGE_ROWS, Math.max(1, parseInt(queryParam(req, 'rows'), 10) || 10));
  return { start, rows };
}

function docIdParam(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new BadRequest('Invalid document id');
  return value.trim();
}

// Hits for the documents among ids (F.id values) that this user can see now,
// in the order given. Unknown and forbidden ids are left out alike.
async function visibleHits(req, ids, { source = [F.id], preview = false, highlightQuery } = {}) {
  if (!ids.length) return [];
  const data = await osSearch({
    size: ids.length,
    _source: source,
    query: { bool: { filter: [{ terms: { [F.id]: ids } }, roleFilter(req.session.user.roles)] } },
    ...(preview && { highlight: previewHighlight(highlightQuery) }),
  });
  const byId = new Map(data.hits.hits.map(h => [h._source[F.id], h]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

// A page of documents by id, in that order, with previews.
async function pageOfIds(req, ids, start, rows, total, highlightQuery) {
  const page = ids.slice(start, start + rows);
  const batches = [];
  for (let i = 0; i < page.length; i += PREVIEW_BATCH) {
    batches.push(await visibleHits(req, page.slice(i, i + PREVIEW_BATCH), { source: SEARCH_FIELDS, preview: true, highlightQuery }));
  }
  return resultPage(batches.flat(), start, total);
}

app.get('/api/collections', requireAuth, (req, res) => {
  const doc = queryParam(req, 'doc');
  res.json({ collections: collections.list(collectionOwner(req), doc || undefined), max_items: MAX_ITEMS });
});

app.post('/api/collections', requireAuth, (req, res) => {
  const { name, description } = req.body || {};
  res.status(201).json(collections.create(collectionOwner(req), name, description));
});

app.patch('/api/collections/:id', requireAuth, (req, res) => {
  const { name, description } = req.body || {};
  res.json(collections.update(collectionOwner(req), req.params.id, { name, description }));
});

app.delete('/api/collections/:id', requireAuth, (req, res) => {
  collections.remove(collectionOwner(req), req.params.id);
  res.json({ ok: true });
});

// The collection's documents the user can see, most recently added first.
app.get('/api/collections/:id', requireAuth, async (req, res) => {
  const owner = collectionOwner(req);
  const { id, name, description } = collections.get(owner, req.params.id);
  const ids = collections.items(owner, id);
  const { start, rows } = pageParams(req);
  try {
    const visible = (await visibleHits(req, ids)).map(h => h._source[F.id]);
    const page = await pageOfIds(req, visible, start, rows, visible.length);
    res.json({ ...page, collection: { id, name, description }, hidden: ids.length - visible.length });
  } catch (err) {
    console.error('Collection error:', err.message);
    res.status(502).json({ error: 'Could not load the collection', detail: err.message });
  }
});

// Ids from a request body: a non-empty list, without repeats.
function docIdList(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ITEMS) throw new BadRequest('Invalid list of documents');
  return [...new Set(value.map(docIdParam))];
}

// Adding several documents at once, in the order given. Only what the user
// can see now is added; the rest count as unavailable, whatever the reason.
app.post('/api/collections/:id/items/bulk', requireAuth, async (req, res) => {
  const owner = collectionOwner(req);
  collections.get(owner, req.params.id);
  const ids = docIdList((req.body || {}).ids);
  try {
    const visible = (await visibleHits(req, ids)).map(h => h._source[F.id]);
    res.status(201).json({ ...collections.addItems(owner, req.params.id, visible), unavailable: ids.length - visible.length });
  } catch (err) {
    console.error('Add to collection error:', err.message);
    res.status(502).json({ error: 'Could not add the documents', detail: err.message });
  }
});

app.post('/api/collections/:id/items/bulk-remove', requireAuth, (req, res) => {
  collections.removeItems(collectionOwner(req), req.params.id, docIdList((req.body || {}).ids));
  res.json({ ok: true });
});

// Adding a whole search's results, best first, as far as one collection can
// hold. Takes the same parameters as /api/search.
app.post('/api/collections/:id/items/from-search', requireAuth, async (req, res) => {
  const owner = collectionOwner(req);
  collections.get(owner, req.params.id);
  const { query } = buildSearchQuery(req, MAX_ITEMS);
  try {
    const data = await osSearch({ size: MAX_ITEMS, _source: [F.id], query });
    const ids = [...new Set(data.hits.hits.map(h => h._source[F.id]))];
    const result = collections.addItems(owner, req.params.id, ids);
    res.status(201).json({ ...result, more: data.hits.total.value > data.hits.hits.length });
  } catch (err) {
    console.error('Add search results error:', err.message);
    res.status(502).json({ error: 'Could not add the results', detail: err.message });
  }
});

// A YYYY-MM-DD query parameter as epoch milliseconds, or null if absent.
function dayParam(req, name) {
  const value = queryParam(req, name);
  if (!value) return null;
  const ms = DATE_RE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms)) throw new BadRequest('Invalid date parameter');
  return ms;
}

// The collection's documents the user can see in date order, oldest first,
// with counts per period and per day for the charts. from (inclusive) and to (exclusive)
// zoom in: both the chart and the list cover just that range. Undated
// documents are listed last, and only when not zoomed in.
app.get('/api/collections/:id/timeline', requireAuth, async (req, res) => {
  const owner = collectionOwner(req);
  const { id, name, description } = collections.get(owner, req.params.id);
  const allIds = collections.items(owner, id);
  const { start, rows } = pageParams(req);
  // Given a search, the chart and the list cover what it finds in the collection.
  const searching = ['q', 'filters', 'dateFrom', 'dateTo', 'scope'].some(name => queryParam(req, name));
  // Limited to this collection within the query itself: a hybrid query can't be
  // wrapped in another, and semantic matches have to be drawn from these documents.
  const { query, textMatch } = searching ? buildSearchQuery(req, MAX_ITEMS, id) : {};
  const from = dayParam(req, 'from');
  const to = dayParam(req, 'to');
  const zoomed = from !== null || to !== null;
  try {
    const matched = searching
      ? new Set((await osSearch({ size: MAX_ITEMS, _source: [F.id], query })).hits.hits.map(h => h._source[F.id]))
      : null;
    const ids = matched ? allIds.filter(docId => matched.has(docId)) : allIds;
    const hits = await visibleHits(req, ids, { source: [F.id, F.created] });
    const entries = hits.map(h => ({ id: h._source[F.id], time: parseDocDate(h._source[F.created]) }));
    const undated = entries.filter(e => e.time === null).map(e => e.id);
    const allDated = entries.filter(e => e.time !== null);
    const dated = allDated
      .filter(e => (from === null || e.time >= from) && (to === null || e.time < to))
      .sort((a, b) => a.time - b.time);
    const ordered = [...dated.map(e => e.id), ...(zoomed ? [] : undated)];
    const page = await pageOfIds(req, ordered, start, rows, ordered.length, textMatch);
    res.json({
      ...page,
      ...timelineBuckets(dated.map(e => e.time)),
      days: timelineDays(dated.map(e => e.time)),
      // Every day with a document, zoomed in or not, for moving between periods.
      all_days: timelineDays(allDated.map(e => e.time)).map(d => d.date),
      collection: { id, name, description },
      hidden: ids.length - hits.length,
      undated: undated.length,
    });
  } catch (err) {
    console.error('Timeline error:', err.message);
    res.status(502).json({ error: 'Could not load the timeline', detail: err.message });
  }
});

// The collection's evidence board, with what the user can see now of every
// document in the collection or on the board. Text isn't included: a board can
// hold every document, and the inspector asks for one's text (/api/document)
// when it's wanted. A document missing from docs is one they can't see, and its
// card says only that.
app.get('/api/collections/:id/board', requireAuth, async (req, res) => {
  const owner = collectionOwner(req);
  const { id, name, description } = collections.get(owner, req.params.id);
  const ids = collections.items(owner, id);
  const board = collections.board(owner, id);
  const onBoard = board.objects.filter(o => o.kind === 'doc').map(o => o.doc_id);
  try {
    const hits = await visibleHits(req, [...new Set([...ids, ...onBoard])], { source: SEARCH_FIELDS });
    const docs = {};
    for (const hit of hits) {
      const doc = normalizeDoc(hit._source);
      docs[doc.id] = { ...doc, time: parseDocDate(hit._source[F.created]) };
    }
    const items = ids.filter(docId => Object.hasOwn(docs, docId));
    res.json({ collection: { id, name, description }, board, docs, items, hidden: ids.length - items.length });
  } catch (err) {
    console.error('Board error:', err.message);
    res.status(502).json({ error: 'Could not load the board', detail: err.message });
  }
});

app.put('/api/collections/:id/board', requireAuth, (req, res) => {
  const { revision, board } = req.body || {};
  if (!Number.isInteger(revision)) throw new BadRequest('Invalid revision');
  res.json(collections.saveBoard(collectionOwner(req), req.params.id, revision, board));
});

// Named versions of a board, to go back to. They hold what the board does: ids,
// positions and what the user typed, so nothing from a document they can't see.
function versionParam(req) {
  const id = Number(req.params.versionId);
  if (!Number.isInteger(id) || id < 1) throw new BadRequest('Invalid version');
  return id;
}

app.get('/api/collections/:id/board/versions', requireAuth, (req, res) => {
  res.json({ versions: collections.boardVersions(collectionOwner(req), req.params.id) });
});

app.post('/api/collections/:id/board/versions', requireAuth, (req, res) => {
  const { name, auto } = req.body || {};
  res.status(201).json(collections.saveBoardVersion(collectionOwner(req), req.params.id, name, auto));
});

app.post('/api/collections/:id/board/versions/:versionId/restore', requireAuth, (req, res) => {
  const { revision } = req.body || {};
  if (!Number.isInteger(revision)) throw new BadRequest('Invalid revision');
  res.json(collections.restoreBoardVersion(collectionOwner(req), req.params.id, versionParam(req), revision));
});

app.delete('/api/collections/:id/board/versions/:versionId', requireAuth, (req, res) => {
  collections.removeBoardVersion(collectionOwner(req), req.params.id, versionParam(req));
  res.json({ ok: true });
});

// Suggested connections and groupings for the board as last saved, from the
// documents on it that the user can see now. The text is read here and not
// kept. A big board means a lot of text, so one at a time per user.
const SUGGEST_BATCH = 100;
// A document can have 100 passages of vectors, so these go a few at a time.
const VECTOR_BATCH = 25;
const boardSuggestions = new Set();  // owners with one running

// Calls use(id, source) for each document among ids this user can see, with
// its vectors and any extra fields, a batch at a time so that only what use
// keeps stays in memory.
async function forEachVectors(req, ids, extra, use) {
  const field = config.vector.field;
  for (let i = 0; i < ids.length; i += VECTOR_BATCH) {
    const data = await osSearch({
      size: VECTOR_BATCH,
      _source: [F.id, `${field}.knn`, ...extra],
      query: { bool: { filter: [{ terms: { [F.id]: ids.slice(i, i + VECTOR_BATCH) } }, roleFilter(req.session.user.roles)] } },
    });
    for (const hit of data.hits.hits) use(firstValue(hit._source[F.id]), hit._source);
  }
}

// What's shown for each "similar meaning" suggestion: the passages that matched.
async function addPassageEvidence(req, cards, connections) {
  const { field, chunk_field: chunkField } = config.vector;
  const meaning = connections.filter(c => c.kind === 'meaning');
  const docOf = new Map(cards.map(card => [card.id, card.doc.id]));
  const ids = [...new Set(meaning.flatMap(c => [docOf.get(c.from), docOf.get(c.to)]))];
  const passages = new Map();
  await forEachVectors(req, ids, [chunkField], (id, source) => {
    const texts = source[chunkField] || [];
    passages.set(id, (source[field] || []).map((p, i) => ({ vector: Float32Array.from(unitVector(p.knn)), text: texts[i] })).filter(p => p.text));
  });
  for (const c of meaning) {
    c.reason = closestPassages(passages.get(docOf.get(c.from)) || [], passages.get(docOf.get(c.to)) || []) || c.reason;
  }
}

// The documents on a board that the user can see now, as cards to analyse. Vectors
// only improve the results, so without them it carries on.
async function boardCards(req, onBoard) {
  const ids = onBoard.map(o => o.doc_id);
  const found = new Map();
  for (let i = 0; i < ids.length; i += SUGGEST_BATCH) {
    const data = await osSearch({
      size: SUGGEST_BATCH,
      _source: SEARCH_FIELDS,
      query: { bool: { filter: [{ terms: { [F.id]: ids.slice(i, i + SUGGEST_BATCH) } }, roleFilter(req.session.user.roles)] } },
      script_fields: START_OF_TEXT,
    });
    for (const hit of data.hits.hits) {
      const doc = normalizeDoc(hit._source);
      found.set(doc.id, { doc, text: String(((hit.fields || {}).like_text || [])[0] || ''), time: parseDocDate(hit._source[F.created]) });
    }
  }
  const cards = onBoard.filter(o => found.has(o.doc_id)).map(o => {
    const { doc, text, time } = found.get(o.doc_id);
    return { id: o.id, doc, text, group: o.group, time: o.date ? Date.parse(`${o.date}T00:00:00Z`) : time };
  });
  let vectorsFailed = false;
  if (config.vector.enabled) {
    try {
      const means = new Map();
      await forEachVectors(req, cards.map(c => c.doc.id), [], (id, source) => {
        const vector = meanVector((source[config.vector.field] || []).map(p => p.knn));
        if (vector) means.set(id, Float32Array.from(vector));
      });
      for (const card of cards) card.vector = means.get(card.doc.id);
    } catch (err) {
      vectorsFailed = true;
      console.warn('Board suggestions without vectors:', err.message);
    }
  }
  return { cards, vectorsFailed };
}

const unitVector = v => {
  const norm = Math.hypot(...v) || 1;
  return v.map(x => x / norm);
};

app.get('/api/collections/:id/board/suggestions', requireAuth, async (req, res) => {
  const owner = collectionOwner(req);
  const { id } = collections.get(owner, req.params.id);
  const board = collections.board(owner, id);
  if (boardSuggestions.has(owner)) return res.status(429).json({ error: 'Already working on suggestions. Try again when they have finished' });
  boardSuggestions.add(owner);
  try {
    const onBoard = board.objects.filter(o => o.kind === 'doc');
    const { cards, vectorsFailed } = await boardCards(req, onBoard);
    const suggestions = suggestBoard({
      cards,
      entities: board.objects.filter(o => ['person', 'place', 'org', 'event'].includes(o.kind) && o.title),
      connections: board.connections,
      dismissed: board.dismissed,
    });
    if (suggestions.meaning_used) {
      await addPassageEvidence(req, cards, suggestions.connections).catch(err => {
        console.warn('Board suggestions without passages:', err.message);
      });
    }
    res.json({
      revision: board.revision,
      analysed: cards.length,
      unavailable: onBoard.length - cards.length,
      vectors_failed: vectorsFailed,
      ...suggestions,
    });
  } catch (err) {
    console.error('Board suggestions error:', err.message);
    res.status(502).json({ error: 'Could not work out suggestions', detail: err.message });
  } finally {
    boardSuggestions.delete(owner);
  }
});

// A group's rating for its cards as last saved. It takes reading the whole board,
// so it shares the limit on suggestions. Only figures and card ids come back.
app.post('/api/collections/:id/board/groups/:groupId/rate', requireAuth, async (req, res) => {
  const owner = collectionOwner(req);
  const { id } = collections.get(owner, req.params.id);
  const board = collections.board(owner, id);
  const group = board.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const members = board.objects.filter(o => o.group === group.id);
  if (boardSuggestions.has(owner)) return res.status(429).json({ error: 'Already reading this board. Try again when that has finished' });
  boardSuggestions.add(owner);
  try {
    const { cards, vectorsFailed } = await boardCards(req, board.objects.filter(o => o.kind === 'doc'));
    const inGroup = new Set(cards.filter(c => c.group === group.id).map(c => c.id));
    if (inGroup.size < 2) return res.status(400).json({ error: 'A group needs at least two documents you can see to be rated' });
    res.json({
      quality: { ...rateGroup(cards, [...inGroup]), members: members.map(o => o.id), left_out: 0 },
      rated: inGroup.size,
      vectors_failed: vectorsFailed,
    });
  } catch (err) {
    console.error('Group rating error:', err.message);
    res.status(502).json({ error: 'Could not rate the group', detail: err.message });
  } finally {
    boardSuggestions.delete(owner);
  }
});

app.post('/api/collections/:id/items', requireAuth, async (req, res) => {
  const owner = collectionOwner(req);
  collections.get(owner, req.params.id);
  const docId = docIdParam((req.body || {}).id);
  // Only something the user can see now can be added.
  if (!(await visibleHits(req, [docId])).length) return res.status(403).json({ error: 'Not permitted' });
  collections.addItem(owner, req.params.id, docId);
  res.status(201).json({ ok: true });
});

app.delete('/api/collections/:id/items', requireAuth, (req, res) => {
  collections.removeItem(collectionOwner(req), req.params.id, docIdParam(queryParam(req, 'id')));
  res.json({ ok: true });
});

// Downloading a whole collection as a zip. Each document is fetched in turn,
// so the zip's total size isn't known up front and it can run for a while:
// one at a time per user, and a few at a time overall, to go easy on the
// file server and this server's temporary disk space.
const MAX_ZIP_DOWNLOADS = 3;
const MAX_ZIP_BYTES = config.collections.max_download_mb * 1024 * 1024;
const zipDownloads = new Set();  // owners with one running

function docDownloader(id) {
  const scheme = (/^([a-z][a-z0-9+.-]*):\/\//i.exec(id) || [])[1];
  return scheme && downloaders[scheme.toLowerCase()];
}

const firstValue = v => (Array.isArray(v) ? v[0] : v);

// Zip timestamps run from 1980 to 2107; otherwise leave it to the zip library.
function zipDate(value) {
  const ms = parseDocDate(value);
  if (ms === null) return undefined;
  const year = new Date(ms).getUTCFullYear();
  return year >= 1980 && year <= 2107 ? new Date(ms) : undefined;
}

// What a download of this collection would hold, among the documents this
// user can see now. Throws if it couldn't go ahead.
async function zipPlan(req) {
  const owner = collectionOwner(req);
  const collection = collections.get(owner, req.params.id);
  const ids = collections.items(owner, collection.id);
  const source = [F.id, F.filename, F.title, F.size, F.modified].filter(Boolean);
  const hits = await visibleHits(req, ids, { source });
  const files = [];
  const linked = [];
  let bytes = 0;
  for (const { _source: doc } of hits) {
    const id = doc[F.id];
    const name = firstValue(doc[F.filename]) || id.split(/[\\/]/).pop() || firstValue(doc[F.title]);
    if (docDownloader(id) && docDownloader(id).open) {
      files.push({ id, name, mtime: F.modified ? zipDate(doc[F.modified]) : undefined });
      bytes += Number(firstValue(doc[F.size])) || 0;
    } else {
      linked.push(`${firstValue(doc[F.title]) || name}: ${id}`);
    }
  }
  const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });
  if (!files.length) {
    throw httpError(400, hits.length ? 'None of the documents in this collection can be downloaded as files' : 'This collection has no documents to download');
  }
  if (bytes > MAX_ZIP_BYTES) {
    throw httpError(413, `This collection is about ${Math.ceil(bytes / 1024 / 1024).toLocaleString('en')} MB, over the ${config.collections.max_download_mb.toLocaleString('en')} MB limit for one download`);
  }
  if (zipDownloads.has(owner)) throw httpError(429, 'You already have a collection downloading. Try again when it has finished');
  if (zipDownloads.size >= MAX_ZIP_DOWNLOADS) throw httpError(429, 'Too many collections are downloading right now. Try again shortly');
  return { owner, collection, files, linked, bytes };
}

// Asked first, as a browser can't show a download link's error message.
app.get('/api/collections/:id/download/summary', requireAuth, async (req, res) => {
  const { files, linked, bytes } = await zipPlan(req);
  res.json({ files: files.length, linked: linked.length, bytes });
});

app.get('/api/collections/:id/download', requireAuth, async (req, res) => {
  const { owner, collection, files, linked } = await zipPlan(req);
  zipDownloads.add(owner);
  console.log(`Collection download: ${owner}, collection ${collection.id}, ${files.length} file(s)`);
  try {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(`${safeEntryName(collection.name)}.zip`));
    res.flushHeaders();
    await streamCollectionZip({ files, linked, open: id => docDownloader(id).open(id), maxBytes: MAX_ZIP_BYTES, res });
  } finally {
    zipDownloads.delete(owner);
  }
});

// "More like these": documents like the collection's, excluding its own.
//   keyword   more_like_this on the examples' distinctive terms
//   semantic  each example's passage vectors averaged into one; the nearest
//             documents to each, merged by reciprocal rank (needs vector search)
// Both search only what the user can see, as every search does.
app.get('/api/collections/:id/similar', requireAuth, async (req, res) => {
  const owner = collectionOwner(req);
  const { id, name, description } = collections.get(owner, req.params.id);
  const mode = queryParam(req, 'mode') || 'keyword';
  if (!['keyword', 'semantic'].includes(mode)) throw new BadRequest('Invalid mode parameter');
  if (mode === 'semantic' && !config.vector.enabled) throw new BadRequest('Vector search is not enabled');
  const { start, rows } = pageParams(req);
  const ids = collections.items(owner, id);
  const roles = roleFilter(req.session.user.roles);
  const notInCollection = { terms: { [F.id]: ids } };

  try {
    // The examples: the most recently added items the user can see now.
    const examples = (await visibleHits(req, ids)).slice(0, SIMILAR_SEEDS);
    // Semantic also searches with the description, so it can run from that alone.
    const useDescription = mode === 'semantic' && Boolean(description);
    const meta = { collection: { id, name, description }, mode, examples: examples.length, description_used: useDescription };
    if (!examples.length && !useDescription) return res.json({ ...resultPage([], start, 0), ...meta });

    if (mode === 'keyword') {
      const like = await exampleTexts(req, examples.map(h => h._source[F.id]));
      if (!like.length) return res.json({ ...resultPage([], start, 0), ...meta });
      const data = await osSearch({
        from: start,
        size: rows,
        _source: SEARCH_FIELDS,
        query: {
          bool: {
            must: [{
              more_like_this: {
                fields: MLT_FIELDS,
                like,
                max_query_terms: 50,
              },
            }],
            filter: [roles],
            must_not: [notInCollection],
          },
        },
        highlight: previewHighlight(),
      });
      const total = Math.min(data.hits.total.value, SIMILAR_MAX);
      return res.json({ ...resultPage(start < SIMILAR_MAX ? data.hits.hits : [], start, total), ...meta });
    }

    // Semantic: one averaged vector per example (examples without passages,
    // e.g. no text, are skipped), searched in parallel and merged. Naming
    // the vector leaf: a _source list with just the nested field returns
    // each knn as a number on OpenSearch 3.x.
    const field = config.vector.field;
    const withVectors = await visibleHits(req, examples.map(h => h._source[F.id]), { source: [F.id, `${field}.knn`] });
    const vectors = withVectors.map(h => meanVector((h._source[field] || []).map(p => p.knn))).filter(Boolean);
    // The nearest documents to one query vector (knn) or text (neural, which
    // OpenSearch embeds with the index's model), as a ranked list of ids.
    const nearest = async (kind, query) => {
      const data = await osSearch({
        size: SIMILAR_PER_SEED,
        _source: [F.id],
        query: {
          nested: {
            path: field,
            score_mode: 'max',
            query: {
              [kind]: {
                [`${field}.knn`]: {
                  ...query,
                  k: SIMILAR_PER_SEED,
                  // Inside the search, so the nearest are drawn only from
                  // documents the user can see and that aren't examples.
                  filter: { bool: { filter: [roles], must_not: [notInCollection] } },
                },
              },
            },
          },
        },
      });
      return data.hits.hits.map(h => h._source[F.id]);
    };
    // The description counts as one more example: a plain statement of what
    // the collection is about, which helps most when it holds few documents.
    const lists = await Promise.all([
      ...vectors.map(vector => nearest('knn', { vector })),
      ...(useDescription ? [nearest('neural', { query_text: description })] : []),
    ]);
    const scores = new Map();
    for (const list of lists) {
      list.forEach((docId, rank) => scores.set(docId, (scores.get(docId) || 0) + 1 / (60 + rank)));
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, SIMILAR_MAX).map(([docId]) => docId);
    res.json({ ...(await pageOfIds(req, ranked, start, rows, ranked.length)), ...meta });
  } catch (err) {
    console.error('Similar search error:', err.message);
    res.status(502).json({ error: 'Search failed', detail: err.message });
  }
});

// The first MLT_TEXT_CHARS of a document, cut down in OpenSearch.
const START_OF_TEXT = {
  like_text: {
    script: {
      source: 'def c = params._source[params.field]; if (c == null) { return ""; } '
        + 'String s = c instanceof List ? (c.isEmpty() ? "" : c[0].toString()) : c.toString(); '
        + 'return s.length() > params.max ? s.substring(0, params.max) : s;',
      params: { field: F.content, max: MLT_TEXT_CHARS },
    },
  },
};

// more_like_this examples as text: each document's title and the start of
// its text, cut down in OpenSearch so a huge file isn't sent here and back.
// (Liking documents by id would need the multi-term-vectors permission,
// which a read-only account like pelican-reader doesn't have.)
async function exampleTexts(req, ids) {
  const data = await osSearch({
    size: ids.length,
    _source: [F.title],
    query: { bool: { filter: [{ terms: { [F.id]: ids } }, roleFilter(req.session.user.roles)] } },
    script_fields: START_OF_TEXT,
  });
  return data.hits.hits
    .map(h => [h._source[F.title], ((h.fields || {}).like_text || [])[0]].filter(Boolean).join('\n'))
    .filter(Boolean);
}

// The normalised mean of a document's passage vectors, or null if it has none.
function meanVector(passages) {
  const valid = passages.filter(v => Array.isArray(v) && v.length);
  if (!valid.length) return null;
  const mean = new Array(valid[0].length).fill(0);
  for (const v of valid) v.forEach((x, i) => { mean[i] += x; });
  const norm = Math.hypot(...mean) || 1;
  return mean.map(x => x / norm);
}

app.get('/api/facets', requireAuth, async (req, res) => {
  const { filters, logic, dateFrom, dateTo } = parseFilterParams(req);

  // Type's counts reflect every other currently-active filter (source,
  // scope, free-text, dates) -- but never the Type filter's own value,
  // since picking a type would otherwise narrow the very list it was
  // chosen from. A "filter" aggregation (not the top-level query) scopes
  // this to just the types agg, so Source's counts below stay role-scoped
  // only.
  const typeContextFilters = buildFilterBool(
    filters.filter(f => f.field !== 'type'), logic, dateFrom, dateTo, queryParam(req, 'scope'), req.session.user.roles
  );
  const inCollection = collectionFilter(req);
  typeContextFilters.push(...inCollection);

  const body = {
    size: 0,
    query: { bool: { filter: [roleFilter(req.session.user.roles), ...inCollection] } },
    aggs: {
      types: {
        filter: { bool: { filter: typeContextFilters } },
        aggs: { by_type: { terms: { field: F.type, size: 50 } } },
      },
      shares: {
        terms: { field: F.share, size: 50 },
        // A share/mailbox/site name only ever belongs to one source, so one
        // source per bucket -- lets the client hide Source options that
        // don't belong to the currently selected scope.
        aggs: { source: { terms: { field: F.source, size: 1 } } },
      },
    },
  };
  try {
    const data = await osSearch(body);
    const typeBuckets = (data.aggregations && data.aggregations.types.by_type.buckets) || [];
    const shareBuckets = (data.aggregations && data.aggregations.shares.buckets) || [];
    // Merge aliased types (jpg/jpeg) into one option with a combined count,
    // keyed by the alias name.
    const aliasOf = {};
    Object.entries(TYPE_ALIASES).forEach(([canonical, values]) => values.forEach(v => { aliasOf[v] = canonical; }));
    const mergedTypes = {};
    typeBuckets.forEach(b => {
      const key = aliasOf[b.key] || b.key;
      mergedTypes[key] = (mergedTypes[key] || 0) + b.doc_count;
    });
    // Group counts are a sum over whichever member types actually exist,
    // with the same context filtering as the individual counts above.
    // Omitted entirely if none of a group's members have any matches.
    const groupCounts = {};
    Object.entries(TYPE_GROUPS).forEach(([group, members]) => {
      const count = members.reduce((sum, m) => sum + (mergedTypes[m] || 0), 0);
      if (count > 0) groupCounts[group] = count;
    });
    res.json({
      types: [
        ...Object.entries(groupCounts).map(([value, count]) => ({ value, count })),
        ...Object.entries(mergedTypes).map(([value, count]) => ({ value, count })),
      ],
      shares: shareBuckets.map(b => {
        const sourceBuckets = (b.source && b.source.buckets) || [];
        return { value: b.key, count: b.doc_count, source: sourceBuckets[0] ? sourceBuckets[0].key : null };
      }),
    });
  } catch (err) {
    res.status(502).json({ error: 'Facet query failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------
// Download -- handed to the downloader registered for the id's URL scheme.
// ---------------------------------------------------------------------
app.get('/api/download', requireAuth, async (req, res) => {
  const id = queryParam(req, 'id').trim();
  if (!id) return res.status(400).json({ error: 'Missing id parameter' });

  // Re-check this specific document is actually visible to this user's
  // roles before serving it -- the search results already filtered by
  // role, but a doc id could otherwise be guessed/pasted directly.
  try {
    const check = await osSearch({
      size: 1,
      query: { bool: { must: [{ term: { [F.id]: id } }], filter: [roleFilter(req.session.user.roles)] } },
    });
    if (check.hits.total.value === 0) {
      return res.status(403).json({ error: 'Not permitted' });
    }
  } catch (err) {
    return res.status(502).json({ error: 'Permission check failed', detail: err.message });
  }

  const downloader = docDownloader(id);
  if (!downloader) {
    return res.status(400).json({ error: `Downloads are not configured for this document type` });
  }

  try {
    downloader.download(id, res);
  } catch (err) {
    console.error('Download path error:', err.message, 'id:', id);
    res.status(400).json({ error: err.message });
  }
});

// Checks the index rather than the cluster: a read-only account (such as
// Pelican's pelican-reader) has no cluster permissions.
app.get('/api/health', async (req, res) => {
  try {
    const r = await opensearch.request('GET', `/${encodeURIComponent(SEARCH_INDEX)}/_count`);
    res.status(r.ok ? 200 : 502).json({ opensearch_reachable: r.ok });
  } catch (err) {
    res.status(502).json({ opensearch_reachable: false, error: err.message });
  }
});

// Serve the app shell -- login.html if not authenticated, index.html if so.
// The user guide; readable before signing in.
app.get('/help', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'help.html'));
});

app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

// Unknown API routes get JSON like every other API response.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Last-resort error handler: bad input (BadRequest, or a malformed JSON
// body from express.json) gets its message; anything else is logged and
// answered without internals.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('Unhandled error on', req.method, req.path, '-', err.stack || err);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: status < 500 && err.expose ? err.message : 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Frogmouth Search ${VERSION} listening on port ${PORT}`);
  console.log(`Config loaded from ${config.configPath}`);
  console.log(`OpenSearch at ${opensearch.describe()}, index ${SEARCH_INDEX}`);
  console.log(`Auth: ${auth.describe()}`);
  console.log(`Collections: ${collections.describe()}`);
  for (const [scheme, d] of Object.entries(downloaders)) console.log(`Downloads (${scheme}): ${d.describe()}`);
});
