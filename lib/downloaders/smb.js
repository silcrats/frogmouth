const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const yaml = require('js-yaml');
const { interpolate } = require('../config');

// ---------------------------------------------------------------------
// SMB downloader for ids of the form smb://server/share/relative/path.
// Server/share definitions and credential env-var names come from the
// crawler's shares.yaml (Pelican's config/shares.yaml, read with the same
// ${VAR} interpolation), so they live in exactly one place. The id's
// host/share must match a configured share, and ".." segments are
// rejected.
//
// Files are fetched with Samba's smbget: it signs in with NTLMv2 and speaks
// SMB 2/3 with signing and encryption. It takes a percent-encoded URL rather
// than a command string, so a file name can't be taken for a command.
// ---------------------------------------------------------------------
// How long to wait for a file's first bytes before giving up on the server.
const FIRST_BYTE_TIMEOUT_MS = 60000;

// ASCII fallback plus RFC 5987 filename* for the real (UTF-8) name. Header
// values can't carry characters above U+00FF -- Node throws on them -- so a
// raw non-Latin filename here would crash the download.
function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/['()*!~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// An smbget authentication file, in a private directory removed by the
// returned cleanup: on a command line the password would be visible to ps.
function writeAuthFile(creds) {
  if (/[\r\n]/.test(`${creds.user}${creds.password}${creds.domain}`)) {
    throw new Error('SMB credentials cannot contain line breaks');
  }
  // The file format trims it, and the server would just report bad permissions.
  if (/^\s/.test(creds.password)) throw new Error('An SMB password starting with a space is not supported');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frogmouth-smb-'));
  const file = path.join(dir, 'auth');
  const lines = [`username = ${creds.user}`, `password = ${creds.password}`];
  if (creds.domain) lines.push(`domain = ${creds.domain}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function createSmbDownloader(opts) {
  const sharesFile = opts.shares_file;
  let sharesConfig = { shares: [], default_credentials: {} };
  try {
    sharesConfig = interpolate(yaml.load(fs.readFileSync(sharesFile, 'utf8'))) || sharesConfig;
  } catch (err) {
    console.error(`Could not load shares config from ${sharesFile}:`, err.message);
  }

  if (spawnSync('smbget', ['--version']).error) {
    console.error('SMB downloads need smbget (Samba client tools), which was not found on PATH');
  }

  // A share entry's folder as lower-case path segments ("" is the whole share).
  function entrySegments(entry) {
    return String(entry.path || '').toLowerCase().split(/[\\/]/).filter(Boolean);
  }

  // The entry this file was crawled through, as its credentials and settings
  // apply: same server and share, and the deepest folder containing the file.
  function findShareEntry(server, share, relPath) {
    const lowerPath = relPath.map(seg => seg.toLowerCase());
    return (sharesConfig.shares || [])
      .filter(s => s.server.toLowerCase() === server.toLowerCase()
        && s.share.toLowerCase() === share.toLowerCase()
        && entrySegments(s).every((seg, i) => lowerPath[i] === seg))
      .sort((a, b) => entrySegments(b).length - entrySegments(a).length)[0];
  }

  function credentialsFor(shareEntry) {
    const defaults = sharesConfig.default_credentials || {};
    const userEnv = shareEntry.user_env || defaults.user_env;
    const passEnv = shareEntry.pass_env || defaults.pass_env;
    const domainEnv = shareEntry.domain_env || defaults.domain_env;
    return {
      user: process.env[userEnv] || '',
      password: process.env[passEnv] || '',
      domain: domainEnv ? (process.env[domainEnv] || '') : '',
    };
  }

  // Ids are the crawler's plain paths, not encoded URLs: a "%" is a "%".
  function parseSmbUrl(url) {
    const str = String(url || '');
    if (!str.startsWith('smb://')) return null;
    const parts = str.slice('smb://'.length).split(/[\\/]/);
    const server = parts.shift() || '';
    const share = parts.shift() || '';
    return { server, share, relPath: parts };
  }

  function resolve(id) {
    const parsed = parseSmbUrl(id);
    if (!parsed) throw new Error('Unrecognized id format (expected an smb:// URL)');

    if (!parsed.relPath.length || parsed.relPath.some(seg => seg === '.' || seg === '..' || seg === '')) {
      throw new Error('Invalid path segment in id');
    }
    const shareEntry = findShareEntry(parsed.server, parsed.share, parsed.relPath);
    if (!shareEntry) throw new Error('No configured share matches this document');

    return {
      url: `smb://${[parsed.server, parsed.share, ...parsed.relPath].map(encodeSegment).join('/')}`,
      filename: parsed.relPath[parsed.relPath.length - 1],
      encrypt: Boolean(shareEntry.encrypt),
      creds: credentialsFor(shareEntry),
    };
  }

  function startSmbget(target) {
    const auth = writeAuthFile(target.creds);
    const child = spawn('smbget', [
      '--quiet', '--stdout', '--authentication-file', auth.file,
      // As the crawler: always signed, and encrypted if the share asks for it.
      `--client-protection=${target.encrypt ? 'encrypt' : 'sign'}`,
      target.url,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: auth.dir } });
    return { auth, child };
  }

  // The file as a readable stream, for when it isn't going straight to the
  // browser. Throws on a bad id; the stream errors if the fetch fails, and
  // destroying it stops the fetch.
  function open(id) {
    const target = resolve(id);
    const { auth, child } = startSmbget(target);
    const out = new PassThrough();
    let stderr = '';
    const firstByte = setTimeout(() => child.kill(), FIRST_BYTE_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += chunk; });
    child.stdout.once('data', () => clearTimeout(firstByte));
    child.stdout.pipe(out, { end: false });
    out.on('close', () => { if (child.exitCode === null) child.kill(); });
    child.on('error', (err) => {
      clearTimeout(firstByte);
      auth.cleanup();
      out.destroy(err);
    });
    child.on('close', (code) => {
      clearTimeout(firstByte);
      auth.cleanup();
      if (code === 0) out.end();
      else out.destroy(new Error(stderr.trim() || `smbget exited with ${code}`));
    });
    return out;
  }

  // Streams the file to res. Throws synchronously on a bad id (caller maps
  // that to a 400); reports share/IO errors on res itself.
  function download(id, res) {
    const target = resolve(id);
    const { auth, child } = startSmbget(target);

    let stderr = '';
    let started = false;
    let timedOut = false;
    const start = () => {
      if (started) return;
      started = true;
      clearTimeout(firstByte);
      res.setHeader('Content-Disposition', contentDisposition(target.filename));
      res.setHeader('Content-Type', 'application/octet-stream');
    };
    const fail = (status, error, detail) => {
      console.error(`SMB download failed (${error}):`, detail, 'url:', target.url);
      // Once bytes are out, only a dropped connection says the file is incomplete.
      if (res.headersSent) res.destroy();
      else res.status(status).json({ error, detail });
    };
    const firstByte = setTimeout(() => { timedOut = true; child.kill(); }, FIRST_BYTE_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += chunk; });
    child.stdout.once('data', start);
    child.stdout.pipe(res, { end: false });
    // The user cancelling shouldn't leave smbget fetching the rest.
    res.on('close', () => { if (!res.writableFinished) child.kill(); });

    child.on('error', (err) => {
      clearTimeout(firstByte);
      auth.cleanup();
      fail(502, 'Could not reach the file share', err.code === 'ENOENT' ? 'smbget is not installed' : err.message);
    });
    child.on('close', (code) => {
      clearTimeout(firstByte);
      auth.cleanup();
      if (code === 0) {
        start();  // an empty file has no first byte
        res.end();
        return;
      }
      const detail = stderr.trim() || `smbget exited with ${code}`;
      if (timedOut) fail(504, 'The file share did not respond', detail);
      else if (/can't be found/.test(detail)) fail(404, 'File not found on share', detail);
      else fail(502, 'Could not reach the file share', detail);
    });
  }

  return {
    download,
    open,
    describe: () => `SMB, ${(sharesConfig.shares || []).length} share(s) from ${sharesFile}`,
  };
}

module.exports = { createSmbDownloader, contentDisposition };
