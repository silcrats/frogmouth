const express = require('express');
const session = require('express-session');
const path = require('path');
const { loadConfig, publicConfig } = require('./lib/config');
const { createLdapAuth } = require('./lib/auth/ldap');
const { createSmbDownloader } = require('./lib/downloaders/smb');

const config = loadConfig();
const app = express();
const PORT = process.env.PORT || 3000;

const OS_HOST = config.opensearch.host;
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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
  res.json({ username: req.session.user.username, displayName: req.session.user.displayName || req.session.user.username });
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

// Filter key -> index field. "type" and "share" are built in; every other
// configured filter names its own field.
const FIELD_MAP = { type: F.type, share: F.share };
for (const f of config.filters) {
  if (f.key !== 'type' && f.key !== 'share' && f.field) FIELD_MAP[f.key] = f.field;
}

function toIsoDate(dateStr, endOfDay) {
  if (!dateStr) return null;
  return endOfDay ? `${dateStr}T23:59:59Z` : `${dateStr}T00:00:00Z`;
}

async function osSearch(body) {
  const res = await fetch(`${OS_HOST}/${SEARCH_INDEX}/_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSearch error ${res.status}: ${text}`);
  }
  return res.json();
}

function roleFilter(roles) {
  return { terms: { [ROLE_FIELD]: roles } };
}

// Shared by /api/search and /api/facets, so a facet count is always computed
// against exactly the filters/scope/dates/security a real search would use.
function buildFilterBool(filters, logic, dateFrom, dateTo, scope, roles) {
  const filterClauses = filters
    .filter(f => f && f.field && f.value && FIELD_MAP[f.field])
    .map(f => {
      const field = FIELD_MAP[f.field];
      if (f.field === 'type') {
        // A broad category (types.groups, e.g. "images") matches any of its
        // members; a merged alias (types.aliases, jpg/jpeg) matches each of
        // its values; otherwise it's a plain single value.
        const values = TYPE_GROUPS[f.value] || TYPE_ALIASES[f.value] || [f.value];
        return { terms: { [field]: values } };
      }
      if (f.field === 'share') {
        return { term: { [field]: f.value } };
      }
      // Free-text filters: case-insensitive substring match. Wildcard
      // queries need the exact-value .keyword sub-field, not the analyzed
      // text field.
      return { wildcard: { [`${field}.keyword`]: { value: `*${f.value}*`, case_insensitive: true } } };
    });

  const filterBool = filterClauses.length
    ? [{ bool: logic === 'OR' ? { should: filterClauses, minimum_should_match: 1 } : { must: filterClauses } }]
    : [];

  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.gte = dateFrom;
    if (dateTo) range.lte = dateTo;
    filterBool.push({ range: { [F.created]: range } });
  }

  // Optional source scope (a sources[].key). Anything else, including no
  // value, searches everything.
  const scopeHost = SCOPE_HOSTS[scope];
  if (scopeHost) filterBool.push({ term: { [F.source]: scopeHost } });

  // The security-critical part: every search is constrained to documents
  // whose role field contains at least one role this user actually holds
  // (computed server-side at login -- never trust a client-supplied list).
  filterBool.push(roleFilter(roles));

  return filterBool;
}

function parseFilterParams(req) {
  const filters = JSON.parse(req.query.filters || '[]');
  const logic = (req.query.logic || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';
  const dateFrom = toIsoDate(req.query.dateFrom, false);
  const dateTo = toIsoDate(req.query.dateTo, true);
  return { filters, logic, dateFrom, dateTo };
}

app.get('/api/search', requireAuth, async (req, res) => {
  const qRaw = (req.query.q || '').trim();
  // "quoted" search: require the exact phrase, not just all/any of its
  // words anywhere in the field.
  const phraseSearch = qRaw.length > 2 && qRaw.startsWith('"') && qRaw.endsWith('"');
  const q = phraseSearch ? qRaw.slice(1, -1).trim() : qRaw;
  const start = parseInt(req.query.start, 10) || 0;
  const rows = parseInt(req.query.rows, 10) || 10;

  let params;
  try {
    params = parseFilterParams(req);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid filters parameter' });
  }
  const { filters, logic, dateFrom, dateTo } = params;

  // A blank q is valid: with filters set it browses just what matches them, and
  // with none set it lists everything the signed-in user can see (still capped
  // by role + pagination) -- match_all in place of the text search below.
  const filterBool = buildFilterBool(filters, logic, dateFrom, dateTo, req.query.scope, req.session.user.roles);

  const body = {
    from: start,
    size: rows,
    query: {
      bool: {
        must: [q ? {
          multi_match: {
            query: q,
            type: phraseSearch ? 'phrase' : 'best_fields',
            fields: config.search_fields,
          }
        } : { match_all: {} }],
        filter: filterBool,
      }
    },
    _source: RETURN_FIELDS,
    highlight: {
      fields: { [F.content]: { fragment_size: 200, number_of_fragments: 2 } },
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
    },
  };

  try {
    const data = await osSearch(body);
    const docs = data.hits.hits.map(h => normalizeDoc(h._source));
    const highlighting = {};
    data.hits.hits.forEach((h, i) => {
      if (h.highlight && h.highlight[F.content]) {
        highlighting[docs[i].id] = { content: h.highlight[F.content] };
      }
    });
    res.json({ numFound: data.hits.total.value, start, docs, highlighting });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(502).json({ error: 'Search failed', detail: err.message });
  }
});

app.get('/api/facets', requireAuth, async (req, res) => {
  let params;
  try {
    params = parseFilterParams(req);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid filters parameter' });
  }
  const { filters, logic, dateFrom, dateTo } = params;

  // Type's counts reflect every other currently-active filter (source,
  // scope, free-text, dates) -- but never the Type filter's own value,
  // since picking a type would otherwise narrow the very list it was
  // chosen from. A "filter" aggregation (not the top-level query) scopes
  // this to just the types agg, so Source's counts below stay role-scoped
  // only.
  const typeContextFilters = buildFilterBool(
    filters.filter(f => f.field !== 'type'), logic, dateFrom, dateTo, req.query.scope, req.session.user.roles
  );

  const body = {
    size: 0,
    query: { bool: { filter: [roleFilter(req.session.user.roles)] } },
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
  const id = (req.query.id || '').trim();
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

  const scheme = (/^([a-z][a-z0-9+.-]*):\/\//i.exec(id) || [])[1];
  const downloader = scheme && downloaders[scheme.toLowerCase()];
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

app.get('/api/health', async (req, res) => {
  try {
    const r = await fetch(`${OS_HOST}/_cluster/health`);
    res.status(r.ok ? 200 : 502).json({ opensearch_reachable: r.ok });
  } catch (err) {
    res.status(502).json({ opensearch_reachable: false, error: err.message });
  }
});

// Serve the app shell -- login.html if not authenticated, index.html if so.
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

app.listen(PORT, () => {
  console.log(`Frogmouth Search listening on port ${PORT}`);
  console.log(`Config loaded from ${config.configPath}`);
  console.log(`OpenSearch at ${OS_HOST}, index ${SEARCH_INDEX}`);
  console.log(`Auth: ${auth.describe()}`);
  for (const [scheme, d] of Object.entries(downloaders)) console.log(`Downloads (${scheme}): ${d.describe()}`);
});
