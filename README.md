# Frogmouth

A small, permission-aware search UI for an OpenSearch index. Users sign in
with their Active Directory account and see only documents whose access roles
match their own user and group memberships. Files on SMB shares download
straight from the share; mail and SharePoint results open in Outlook or
SharePoint.

Built to sit in front of an index fed by Pelican, but everything tied to an
index layout (field names, role encoding, sources, filters) is configuration,
so it can front any index that carries per-document roles.

## Features

- LDAP / Active Directory sign-in; roles built server-side from `memberOf`
  and applied as a filter on every query and every download.
- Full-text search with highlighting and `"exact phrase"` queries, or browse
  by filters alone.
- One-click scopes per source (e.g. files, mail, SharePoint), and filters for
  file type (with groups such as Images or Documents), source, sender,
  recipient, attachment name and date range, combined with AND or OR.
- Expanded results with full text, email headers, and image camera and
  location metadata.
- Per-source result actions: download over SMB, or open the item (and its
  folder) by link.

## Quick start

Requires Docker with Compose, a reachable OpenSearch index, and an LDAP
server.

```sh
cp .env.example .env              # LDAP, session secret, SMB credentials
cp /path/to/shares.yaml .         # SMB downloads (optional)
docker compose -f docker-compose.example.yml up -d --build
```

Then open <http://localhost:3000>.

To run without Docker (Node 18+): `npm install`, set the variables from
`.env.example` in your environment, then `npm start`.

## Configuration

Everything lives in [`config.yaml`](config.yaml), whose comments document each
setting. Mount your own copy over `/app/config.yaml` or point `CONFIG_PATH` at
it. Any string value may use `${VAR}` or `${VAR:-fallback}`; secrets should
come from the environment.

| Section | What it controls |
| --- | --- |
| `app` | Title, subtitle, search placeholder, optional logo |
| `opensearch` | Host and index (`OS_HOST`, `SEARCH_INDEX`) |
| `auth.ldap` | LDAP URL, bind template, base DN, username attribute |
| `security` | Role field and how user, group and default roles are encoded. Must match the indexer |
| `fields` | Map of UI field names to index field names |
| `extra_fields`, `search_fields` | Extra fields to display; fields to search, with boosts |
| `sources` | Scope buttons, and what each source's results do (download or link) |
| `filters`, `types` | Filter list; file-type aliases and groups |
| `downloads` | Downloaders by URL scheme (`smb`, using a `shares.yaml`) |

To add a logo, mount a folder at `/app/public/branding` and set
`app.logo: "/branding/logo.png"`.

### SMB downloads

Documents whose id is `smb://server/share/path` are streamed from the share.
The server and share must appear in `shares.yaml` (Pelican's format), which
also names the environment variables holding credentials; set those on the
Frogmouth container. Before serving a file, Frogmouth re-checks that the
signed-in user can see that document.

### Security notes

- Every query and download is filtered on roles computed at sign-in from
  LDAP. Client-supplied roles are never trusted.
- Set a long random `SESSION_SECRET`.
- Put Frogmouth behind HTTPS, then enable `cookie.secure` in `server.js`.
- LDAP binds use the user's own credentials; use `ldaps://` where possible.

## Extending

- **Another sign-in method:** add a module under `lib/auth/` exporting a
  factory that returns `{ authenticate(username, password) -> { username,
  groups } }`, register it in `AUTH_PROVIDERS` in `server.js`, and select it
  with `auth.provider`.
- **Another download source:** add a module under `lib/downloaders/` that
  streams a document id to the response, register it in `DOWNLOADERS` under
  its URL scheme, and configure it under `downloads`.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE)
for attribution.
