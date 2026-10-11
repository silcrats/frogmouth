const fs = require('fs');
const http = require('http');
const https = require('https');

const TIMEOUT_MS = 30000;

// A minimal OpenSearch client: JSON over HTTP(S), with optional basic auth
// and a private CA (e.g. ca.pem from Pelican's certs volume). Built on
// http/https rather than fetch, which can't be given a CA per connection.
function createOpenSearchClient({ host, username, password, ca_certs }) {
  const base = host.replace(/\/+$/, '');
  const isHttps = new URL(base).protocol === 'https:';
  if (ca_certs && !isHttps) throw new Error('config: opensearch.ca_certs is set but opensearch.host is not https://');

  const agent = isHttps
    ? new https.Agent({ keepAlive: true, ...(ca_certs && { ca: fs.readFileSync(ca_certs) }) })
    : new http.Agent({ keepAlive: true });
  const authHeader = username
    ? { Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') }
    : {};

  // Resolves { status, ok, text } for any HTTP response; rejects only on
  // connection, TLS or timeout errors.
  function request(method, path, body) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { ...authHeader, Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    return new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request(`${base}${path}`, { method, headers, agent }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
        res.on('error', reject);
      });
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`OpenSearch request timed out after ${TIMEOUT_MS / 1000}s`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    request,
    describe: () => `${base}${username ? ` as ${username}` : ''}${ca_certs ? `, trusting ${ca_certs}` : ''}`,
  };
}

module.exports = { createOpenSearchClient };
