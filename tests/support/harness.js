// Starts the real server against the stand-ins, with its own temporary database.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

async function startApp({ vector = false, docVectors = false } = {}) {
  const [port, osPort] = [await freePort(), await freePort()];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frogmouth-test-'));
  const dbPath = path.join(dir, 'collections.db');
  const child = spawn(process.execPath, ['-r', path.join(__dirname, 'stand-ins.js'), 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_NO_WARNINGS: '1', PORT: String(port), STUB_OS_PORT: String(osPort), CONFIG_PATH: path.join(ROOT, 'config.yaml'),
      COLLECTIONS_DB: dbPath, SESSION_SECRET: 'x'.repeat(40), OS_HOST: `http://127.0.0.1:${osPort}`, LDAP_URL: 'ldap://stand-in:389',
      VECTOR_ENABLED: vector ? 'true' : 'false', ...(docVectors && { STUB_DOC_VECTORS: '1' }), OS_USERNAME: '', OS_PASSWORD: '', OS_CA_CERTS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/api/config`)).ok) break;
    } catch { /* not up yet */ }
    if (i > 100 || child.exitCode !== null) throw new Error(`server didn't start:\n${log}`);
    await new Promise(r => setTimeout(r, 50));
  }
  const control = async name => (await fetch(`http://127.0.0.1:${osPort}/__${name}`)).json();
  return {
    url, dbPath, control,
    log: () => log,
    login: name => login(url, name),
    stop: async () => {
      child.kill();
      await new Promise(r => child.once('exit', r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A signed-in user: call(method, path, body) gives { status, body }.
async function login(url, username, password = 'x') {
  const res = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!res.ok) throw new Error(`login failed for ${username}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, target, body) => {
    const r = await fetch(url + target, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: r.status, body: parsed, text: raw };
  };
  return { call, cookie, username };
}

module.exports = { startApp, login };
