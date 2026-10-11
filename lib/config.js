const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ${VAR} or ${VAR:-fallback}. The fallback may itself contain one level of
// braces, e.g. ${LDAP_BIND_TEMPLATE:-{username}@corp.local}.
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-((?:[^{}]|\{[^{}]*\})*))?\}/g;

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
  };
}

module.exports = { loadConfig, publicConfig, interpolate };
