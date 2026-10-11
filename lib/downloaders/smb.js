const fs = require('fs');
const yaml = require('js-yaml');
const SMB2 = require('@marsaud/smb2');
const { interpolate } = require('../config');

// ---------------------------------------------------------------------
// SMB downloader for ids of the form smb://server/share/relative/path.
// Server/share definitions and credential env-var names come from the
// crawler's shares.yaml (Pelican's config/shares.yaml, read with the same
// ${VAR} interpolation), so they live in exactly one place. The id's
// host/share must match a configured share, and ".." segments are
// rejected.
// ---------------------------------------------------------------------
// ASCII fallback plus RFC 5987 filename* for the real (UTF-8) name. Header
// values can't carry characters above U+00FF -- Node throws on them -- so a
// raw non-Latin filename here would crash the download.
function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function createSmbDownloader(opts) {
  const sharesFile = opts.shares_file;
  let sharesConfig = { shares: [], default_credentials: {} };
  try {
    sharesConfig = interpolate(yaml.load(fs.readFileSync(sharesFile, 'utf8'))) || sharesConfig;
  } catch (err) {
    console.error(`Could not load shares config from ${sharesFile}:`, err.message);
  }

  function findShareByServer(server) {
    return (sharesConfig.shares || []).find(
      s => s.server.toLowerCase() === server.toLowerCase()
    );
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

  function parseSmbUrl(url) {
    const str = String(url || '');
    if (!str.startsWith('smb://')) return null;
    const parts = str.slice('smb://'.length).split('/');
    const server = decodeURIComponent(parts.shift() || '');
    const share = decodeURIComponent(parts.shift() || '');
    const relPath = parts
      .map(p => decodeURIComponent(p))
      .flatMap(p => p.split(/[\\/]/));
    return { server, share, relPath };
  }

  function resolve(id) {
    const parsed = parseSmbUrl(id);
    if (!parsed) throw new Error('Unrecognized id format (expected an smb:// URL)');

    const shareEntry = findShareByServer(parsed.server);
    if (!shareEntry) throw new Error('No configured share matches this document\'s server');
    if (shareEntry.share.toLowerCase() !== parsed.share.toLowerCase()) {
      throw new Error('Document share does not match configured share for this server');
    }
    if (parsed.relPath.some(seg => seg === '..' || seg === '')) {
      throw new Error('Invalid path segment in id');
    }

    return {
      server: parsed.server,
      share: parsed.share,
      path: parsed.relPath.join('\\'),
      creds: credentialsFor(shareEntry),
    };
  }

  // Streams the file to res. Throws synchronously on a bad id (caller maps
  // that to a 400); reports share/IO errors on res itself.
  function download(id, res) {
    const target = resolve(id);
    const filename = target.path.split('\\').pop() || 'download';
    const client = new SMB2({
      share: `\\\\${target.server}\\${target.share}`,
      domain: target.creds.domain,
      username: target.creds.user,
      password: target.creds.password,
    });

    client.createReadStream(target.path, (err, readStream) => {
      if (err) {
        console.error('SMB read error:', err.message, 'path:', target.path);
        const notFound = /STATUS_OBJECT_NAME_NOT_FOUND|STATUS_OBJECT_PATH_NOT_FOUND|ENOENT/i.test(err.message || '');
        return res.status(notFound ? 404 : 502).json({
          error: notFound ? 'File not found on share' : 'Could not reach the file share',
          detail: err.message,
        });
      }
      res.setHeader('Content-Disposition', contentDisposition(filename));
      readStream.on('error', (streamErr) => {
        console.error('SMB stream error:', streamErr);
        if (!res.headersSent) res.status(502).json({ error: 'Download interrupted', detail: streamErr.message });
        else res.destroy();
      });
      readStream.pipe(res);
    });
  }

  return {
    download,
    describe: () => `SMB, ${(sharesConfig.shares || []).length} share(s) from ${sharesFile}`,
  };
}

module.exports = { createSmbDownloader };
