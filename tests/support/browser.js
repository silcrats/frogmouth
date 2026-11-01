// A real browser against the real server and the stand-ins. Set CHROME to choose the
// browser; otherwise this looks for Chromium or Chrome where they usually are.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

function findBrowser() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch { /* try the next */ }
  }
  throw new Error('No browser found: install Chromium or Chrome, or set CHROME');
}

async function launch() {
  const found = findBrowser();
  // A snap's launcher needs running through a script, and its own temporary folder.
  let executablePath = found;
  if (found.startsWith('/snap/')) {
    executablePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frogmouth-chrome-')), 'chrome.sh');
    fs.writeFileSync(executablePath, `#!/bin/sh\nexec ${found} "$@"\n`, { mode: 0o755 });
  }
  return chromium.launch({ executablePath, args: ['--no-sandbox'] });
}

// A page signed in as user. page.errors collects anything thrown in the page.
async function signedInPage(browser, app, username, { width = 1440, height = 1000 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'en-AU' });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(app.url);
  await page.evaluate(async name => {
    await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'x' }) });
  }, username);
  await page.goto(app.url);
  await page.waitForFunction(() => typeof openBoard === 'function');
  await page.waitForTimeout(150);
  return page;
}

// The API as that page's user.
const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);

// A new collection of the given number of documents, oldest included.
async function makeCollection(page, name, count = 30, q = '') {
  const c = (await api(page, 'POST', '/api/collections', { name })).body;
  const ids = (await api(page, 'GET', `/api/search?q=${q}&rows=${count}`)).body.docs.map(d => d.id);
  if (ids.length) await api(page, 'POST', `/api/collections/${c.id}/items/bulk`, { ids });
  return { ...c, ids };
}

async function openCollection(page, name) {
  // Opening the panel reloads its list, which may predate a collection made through the API.
  if (await page.locator('#collectionsPanel').isVisible()) await page.click('#collectionsBtn');
  await page.click('#collectionsBtn');
  await page.locator('.collection-open', { hasText: name }).first().click();
  await page.waitForSelector('#collectionBanner:not([hidden])');
  await page.waitForTimeout(200);
}

async function openTimeline(page, name) {
  await openCollection(page, name);
  await page.click('[data-view=timeline]');
  await page.waitForSelector('.timeline-squares');
  await page.waitForSelector('.result.focused');
  await page.waitForTimeout(150);
}

const saved = page => page.waitForFunction(() => document.querySelector('.board-status span').textContent === 'Saved', null, { timeout: 8000 });

module.exports = { launch, signedInPage, api, makeCollection, openCollection, openTimeline, saved };
