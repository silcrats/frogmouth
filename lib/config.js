const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ${VAR} or ${VAR:-fallback}. The fallback may itself contain one level of
// braces, e.g. ${LDAP_BIND_TEMPLATE:-{username}@corp.local}.
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-((?:[^{}]|\{[^{}]*\})*))?\}/g;

// keyword is always available; the others need vector.enabled.
const SEARCH_MODES = ['keyword', 'semantic', 'hybrid'];

function interpolate(value) {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (_, name, fallback) => {
      const v = process.env[name];
      return v !== undefined && v !== '' ? v : (fallback ?? '');
    });
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
  }
  return value;
}

function loadConfig() {
  const configPath = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.yaml');
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  const cfg = interpolate(raw);

  cfg.configPath = configPath;
  cfg.app = cfg.app || {};
  cfg.fields = cfg.fields || {};
  cfg.extra_fields = cfg.extra_fields || [];
  cfg.search_fields = cfg.search_fields || [cfg.fields.content || 'content'];
  cfg.sources = cfg.sources || [];
  cfg.filters = cfg.filters || [];
  cfg.types = cfg.types || {};
  cfg.types.aliases = cfg.types.aliases || {};
  cfg.types.groups = cfg.types.groups || [];
  cfg.downloads = cfg.downloads || {};
  cfg.security = cfg.security || {};
  cfg.security.prefixes = cfg.security.prefixes || {};

  for (const key of ['id', 'source', 'share', 'type', 'created', 'content']) {
    if (!cfg.fields[key]) throw new Error(`config: fields.${key} is required`);
  }
  if (!cfg.security.role_field) throw new Error('config: security.role_field is required');

  cfg.opensearch = cfg.opensearch || {};
  if (!cfg.opensearch.host) throw new Error('config: opensearch.host is required');
  if (cfg.opensearch.username && !cfg.opensearch.password) {
    throw new Error('config: opensearch.password (OS_PASSWORD) must be set when opensearch.username is');
  }

  cfg.session = cfg.session || {};
  const secret = cfg.session.secret || '';
  if (secret.length < 32 || secret === 'change-me-in-.env') {
    throw new Error('config: session.secret must be set (SESSION_SECRET) to at least 32 characters, e.g. from `openssl rand -hex 32`');
  }
  cfg.session.secure_cookie = String(cfg.session.secure_cookie).toLowerCase() === 'true';

  const vector = cfg.vector || {};
  cfg.vector = {
    enabled: ['true', '1', 'yes', 'on'].includes(String(vector.enabled).trim().toLowerCase()),
    field: vector.field || 'content_embedding',
    k: parseInt(vector.k, 10) || 100,
    default_mode: vector.default_mode || 'hybrid',
  };
  if (!SEARCH_MODES.includes(cfg.vector.default_mode)) {
    throw new Error(`config: vector.default_mode must be one of ${SEARCH_MODES.join(', ')}`);
  }

  return cfg;
}

// The subset the browser needs to build its scope buttons, filters and
// result actions. Nothing here is secret.
function publicConfig(cfg) {
  return {
    app: cfg.app,
    sources: cfg.sources.map(({ key, label, host, open, link_label, folder_link, layout, share_label }) =>
      ({ key, label, host, open, link_label, folder_link, layout, share_label })),
    filters: cfg.filters.map(({ key, label, placeholder }) => ({ key, label, placeholder })),
    types: {
      groups: cfg.types.groups.map(({ key, label }) => ({ key, label })),
      aliases: cfg.types.aliases,
    },
    // Whether to show the Mode switch, and its starting position.
    search_modes: cfg.vector.enabled ? SEARCH_MODES : ['keyword'],
    default_mode: cfg.vector.enabled ? cfg.vector.default_mode : 'keyword',
  };
}

module.exports = { loadConfig, publicConfig, interpolate, SEARCH_MODES };
