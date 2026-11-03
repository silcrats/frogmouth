const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');
const { launch, signedInPage, api, makeCollection, openCollection, openTimeline } = require('../support/browser');

const YELLOW = 'rgb(255, 224, 138)';
const transparent = /rgba\(0, 0, 0, 0\)/;

test('searching and filtering', async t => {
  const app = await startApp();
  const browser = await launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await signedInPage(browser, app, 'alice');
  const requests = [];
  page.on('request', r => { if (r.url().includes('/api/search')) requests.push(new URL(r.url()).searchParams); });
  const search = async q => { await page.fill('#queryInput', q); await page.click('#searchBtn'); await page.waitForTimeout(300); };
  const results = () => page.locator('.result').count();
  const meta = () => page.locator('#metaRow').textContent();
  const css = (selector, property) => page.locator(selector).first().evaluate((e, p) => getComputedStyle(e)[p], property);

  await t.test('the rows are laid out as asked', async () => {
    await search('report');
    await page.click('#addFilterRow');
    await page.waitForTimeout(80);
    await page.click('#addFilterRow');
    await page.waitForTimeout(80);
    const layout = await page.evaluate(() => {
      const mid = q => { const r = document.querySelector(q).getBoundingClientRect(); return r.top + r.height / 2; };
      const off = (a, b) => Math.abs(mid(a) - mid(b));
      const [add, clear, form] = ['#addFilterRow', '#clearFilters', '.search-form'].map(q => document.querySelector(q).getBoundingClientRect());
      return { add: off('#addFilterRow', '.filter-toggle'), clear: off('#clearFilters', '.filter-toggle'), match: off('#logicToggle', '.filter-toggle'), gap: clear.left - add.right, end: form.right - clear.right, select: off('#selectPage', '#metaRow'), show: off('#pageSizeSelect', '#metaRow') };
    });
    for (const key of ['add', 'clear', 'match', 'select', 'show']) assert.ok(layout[key] < 8, `${key}: ${layout[key]}`);
    assert.ok(layout.gap > 400);
    assert.ok(layout.end < 2);
    assert.equal(await page.locator('.filter-toggle').evaluate(e => e.tagName), 'SPAN', 'a plain label');
    assert.equal(await page.locator('input[type=date]').count(), 0);
  });

  await t.test('the remove button lines up, and hovers readably', async () => {
    const m = await page.evaluate(() => {
      const row = document.querySelector('.filter-row');
      const b = row.querySelector('.remove-row').getBoundingClientRect();
      const f = row.querySelector('.field-select').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(row.querySelector('.remove-row'));
      const x = range.getBoundingClientRect();
      return { height: b.height - f.height, top: b.top - f.top, across: x.left + x.width / 2 - (b.left + b.width / 2) };
    });
    assert.ok(Math.abs(m.height) <= 1 && Math.abs(m.top) <= 1 && Math.abs(m.across) <= 1, JSON.stringify(m));
    for (const q of ['#addFilterRow', '#clearFilters', '.remove-row']) {
      await page.hover(q);
      await page.waitForTimeout(220);
      assert.match(await css(q, 'backgroundColor'), transparent, q);
    }
  });

  await t.test('a date range filters, with is and is not, and a half-entered date isn\'t lost', async () => {
    await page.click('#clearFilters');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.filter-row').count(), 0);
    const all = Number((await meta()).match(/(\d+) result/)[1]);
    await page.click('#addFilterRow');
    await page.waitForTimeout(80);
    const row = page.locator('.filter-row').first();
    await row.locator('.field-select').selectOption('date_range');
    await page.waitForTimeout(80);
    const [from, to] = [row.locator('date-select').first(), row.locator('date-select').last()];
    const before = requests.length;
    await from.locator('select[aria-label=Day]').selectOption('31');
    await from.locator('select[aria-label=Month]').selectOption('12');
    assert.equal(requests.length, before, 'an incomplete date doesn\'t search');
    const year = from.locator('input[aria-label=Year]');
    await year.fill('2016');
    await year.blur();
    await page.waitForTimeout(250);
    assert.equal(requests.length, before + 1);
    assert.equal(JSON.parse(requests.at(-1).get('filters'))[0].value, '2016-12-31..');
    await from.locator('select[aria-label=Month]').focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(80);
    assert.equal(await from.evaluate(e => e.value), '2016-12-31', 'December doesn\'t wrap to January');
    await from.locator('select[aria-label=Month]').selectOption('02');
    await page.waitForTimeout(80);
    assert.equal(await from.evaluate(e => e.value), '2016-02-29', 'fits a leap year');
    await year.fill('2015');
    await year.blur();
    await page.waitForTimeout(150);
    assert.equal(await from.evaluate(e => e.value), '2015-02-28');
    for (const bad of ['0', '10000']) {
      await year.fill(bad);
      await year.blur();
      await page.waitForTimeout(50);
      assert.equal(await from.evaluate(e => e.value), '', bad);
    }
    await year.fill('2015');
    await year.blur();
    await to.locator('select[aria-label=Day]').selectOption('31');
    await to.locator('select[aria-label=Month]').selectOption('12');
    await to.locator('input[aria-label=Year]').fill('2015');
    await to.locator('input[aria-label=Year]').blur();
    await page.waitForTimeout(300);
    const count = async () => Number((await meta()).match(/(\d+) result/)[1]);
    const is = await count();
    await row.locator('.not-select').selectOption('not');
    await page.waitForTimeout(300);
    const isNot = await count();
    assert.ok(is > 0 && isNot > 0);
    assert.equal(is + isNot, all);
    await row.locator('.not-select').selectOption('');
    await page.waitForTimeout(200);
    await page.click('#addFilterRow');
    await page.waitForTimeout(80);
    const second = page.locator('.filter-row').nth(1);
    await second.locator('.field-select').selectOption('date_range');
    await page.waitForTimeout(80);
    await second.locator('select[aria-label=Day]').first().selectOption('05');
    await page.click('#addFilterRow');
    await page.waitForTimeout(80);
    assert.equal(await page.locator('.filter-row').nth(1).locator('select[aria-label=Day]').first().inputValue(), '05');
    await page.click('#clearFilters');
    await page.waitForTimeout(200);
  });

  await t.test('the page keeps one width', async () => {
    await makeCollection(page, 'Wide');
    const same = async (selectors, label) => {
      const edges = await page.evaluate(list => list.map(q => { const r = document.querySelector(q).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }), selectors);
      assert.equal(new Set(edges.map(e => e.join())).size, 1, `${label}: ${JSON.stringify(edges)}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} overflow`);
    };
    await openTimeline(page, 'Wide');
    await same(['#collectionBanner', '#timeline', '.result', '.meta-row', '.search-form'], 'docked');
    for (const width of [1280, 800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      await same(['#timeline', '.result', '#collectionBanner', '.meta-row'], String(width));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(100);
  });

  await t.test('Help, Hints, the focused card and the diamond share one yellow; the dock switch reads', async () => {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300); // let colour transitions finish
    for (const [q, p] of [['.help-btn', 'color'], ['.help-btn', 'borderTopColor'], ['.timeline-hints-btn', 'color'], ['.result.focused', 'borderTopColor'], ['.timeline-diamond', 'backgroundColor']]) {
      assert.equal(await css(q, p), YELLOW, `${q} ${p}`);
    }
    await page.click('#collectionsBtn').catch(() => {});
    if (await page.locator('#collectionsPanel').isHidden()) await page.click('#collectionsBtn');
    const dock = await page.evaluate(() => [...document.querySelectorAll('#dockSwitch button')].map(b => [b.classList.contains('active'), getComputedStyle(b).color, getComputedStyle(b).backgroundColor]));
    assert.equal(dock.filter(d => d[0]).length, 1);
    assert.ok(dock.every(d => transparent.test(d[2])));
    assert.notEqual(dock.find(d => d[0])[1], dock.find(d => !d[0])[1]);
  });

  await t.test('Show goes up to 1,000', async () => {
    assert.deepEqual(await page.locator('#pageSizeSelect option').allTextContents(), ['10', '25', '50', '100', '250', '500', '1000']);
  });

  await t.test('no errors in the page', () => assert.deepEqual(page.errors, []));
});

test('searching inside a collection', async t => {
  const app = await startApp();
  const browser = await launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await signedInPage(browser, app, 'alice');
  const requests = [];
  page.on('request', r => { if (/\/api\/(search|collections\/\d+)/.test(r.url())) requests.push(r.url()); });
  const go = async q => { await page.fill('#queryInput', q); await page.click('#searchBtn'); await page.waitForTimeout(300); };
  const n = () => page.locator('.result').count();
  const meta = () => page.locator('#metaRow').textContent();
  const docs = (await api(page, 'GET', '/api/search?q=&rows=30')).body.docs.filter(d => /Report (0|1|2|4|6)$/.test(d.title));
  const c = (await api(page, 'POST', '/api/collections', { name: 'Scoped' })).body;
  await api(page, 'POST', `/api/collections/${c.id}/items/bulk`, { ids: docs.map(d => d.id) });
  await api(page, 'POST', '/api/collections', { name: 'Scoped three' });

  await go('report');
  const mainCount = await n();
  await page.click('#addFilterRow');
  await page.waitForTimeout(80);

  await t.test('opening one starts clean, in Keyword', async () => {
    await page.click('#modeToggle [data-mode=keyword]').catch(() => {});
    await openCollection(page, 'Scoped');
    assert.equal(await page.inputValue('#queryInput'), '');
    assert.equal(await page.getAttribute('#queryInput', 'placeholder'), 'Search in Scoped…');
    assert.ok(await page.locator('#searchEverything').isVisible());
    assert.equal(await n(), 5);
  });

  await t.test('a search stays in the collection', async () => {
    await go('harbour');
    assert.ok(await page.locator('#collectionBanner').isVisible());
    assert.equal(await n(), 2);
    assert.match(await meta(), /2 matches in this collection/);
    assert.match(requests.at(-1), /collection=.*q=harbour|q=harbour.*collection=/);
    assert.ok(await page.locator('#selectAddAll').isVisible());
    await go('nothinglikethis');
    assert.match(await page.locator('#results').textContent(), /Nothing in this collection matches/);
    await go('');
    assert.equal(await n(), 5);
  });

  await t.test('filters stay in it too', async () => {
    await page.click('#addFilterRow');
    await page.waitForTimeout(80);
    const row = page.locator('.filter-row').last();
    await row.locator('.field-select').selectOption('date_range');
    await page.waitForTimeout(80);
    const to = row.locator('date-select').last();
    await to.locator('select[aria-label=Day]').selectOption('31');
    await to.locator('select[aria-label=Month]').selectOption('03');
    await to.locator('input[aria-label=Year]').fill('2015');
    await to.locator('input[aria-label=Year]').blur();
    await page.waitForTimeout(350);
    assert.ok(await page.locator('#collectionBanner').isVisible());
    const some = await n();
    assert.ok(some >= 1 && some < 5, String(some));
    await row.locator('.not-select').selectOption('not');
    await page.waitForTimeout(350);
    assert.equal(await n() + some, 5, 'is not is the rest');
    await page.click('#clearFilters');
    await page.waitForTimeout(350);
    assert.equal(await n(), 5);
  });

  await t.test('the timeline narrows, and a new search resets its zoom', async () => {
    await page.click('[data-view=timeline]');
    await page.waitForSelector('.timeline-squares');
    await page.waitForTimeout(250);
    const head = () => page.locator('.timeline-head > span').first().textContent();
    const before = await head();
    await go('harbour');
    assert.equal(await page.locator('[data-view=timeline].active').count(), 1);
    assert.equal(await n(), 2);
    assert.notEqual(await head(), before);
    assert.match(await meta(), /oldest first/);
    assert.equal(await page.locator('.timeline-diamond').count(), 1);
    await page.locator('.timeline-square.shade-1, .timeline-square.shade-2, .timeline-square.shade-3, .timeline-square.shade-4').first().click();
    await page.waitForTimeout(350);
    assert.match(requests.at(-1), /q=harbour/, 'zooming keeps the search');
    await go('');
    assert.equal(await page.locator('.timeline-reset').count(), 0);
    assert.equal(await n(), 5);
  });

  await t.test('the board always shows everything', async () => {
    await go('harbour');
    await page.click('[data-view=items]');
    await page.waitForTimeout(300);
    assert.equal(await n(), 2, 'views keep the search');
    await page.click('.banner-board');
    await page.waitForSelector('.board-tray-item');
    assert.equal(await page.locator('.board-tray-item').count(), 5);
    await page.locator('.board-bar').getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
    assert.equal(await page.inputValue('#queryInput'), 'harbour');
  });

  await t.test('another collection starts clean', async () => {
    await page.locator('.collection-open', { hasText: 'Scoped three' }).click();
    await page.waitForTimeout(250);
    assert.equal(await page.inputValue('#queryInput'), '');
    assert.equal(await page.getAttribute('#queryInput', 'placeholder'), 'Search in Scoped three…');
  });

  await t.test('Back to search restores the main search', async () => {
    await page.click('.banner-back');
    await page.waitForTimeout(350);
    assert.equal(await page.inputValue('#queryInput'), 'report');
    assert.equal(await n(), mainCount);
    assert.equal(await page.locator('.filter-row').count(), 1);
    assert.ok(await page.locator('#searchEverything').isHidden());
    assert.ok(!/collection=/.test(requests.at(-1)));
  });

  await t.test('Search everything leaves with what\'s typed', async () => {
    await page.locator('.collection-open', { hasText: 'Scoped' }).first().click();
    await page.waitForTimeout(300);
    await page.fill('#queryInput', 'vaccine');
    await page.click('#searchEverything');
    await page.waitForTimeout(350);
    assert.ok(await page.locator('#collectionBanner').isHidden());
    assert.equal(await page.inputValue('#queryInput'), 'vaccine');
    assert.ok(!/collection=/.test(requests.at(-1)));
  });

  await t.test('only the latest of quick changes shows, and matches can be copied', async () => {
    await page.locator('.collection-open', { hasText: 'Scoped' }).first().click();
    await page.waitForTimeout(300);
    await page.fill('#queryInput', 'report');
    await page.click('#searchBtn');
    await page.fill('#queryInput', 'harbour');
    await page.click('#searchBtn');
    await page.waitForTimeout(450);
    assert.equal(await n(), 2);
    await page.click('#selectAddAll');
    await page.waitForSelector('.collect-menu');
    await page.locator('.collect-menu .bulk-choice', { hasText: 'Scoped three' }).click();
    await page.waitForSelector('#selectMessage:not([hidden])');
    assert.match(await page.locator('#selectMessage').textContent(), /Added 2 documents/);
  });

  await t.test('no errors in the page', () => assert.deepEqual(page.errors, []));
});

test('the default search mode', async t => {
  const app = await startApp({ vector: true });
  const browser = await launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await signedInPage(browser, app, 'alice');
  const active = () => page.locator('#modeToggle button.active').first().textContent();
  await api(page, 'POST', '/api/collections', { name: 'Mode' });

  await t.test('is Keyword, for search and collections, and Back restores the main one', async () => {
    assert.equal((await api(page, 'GET', '/api/config')).body.default_mode, 'keyword');
    assert.equal(await active(), 'Keyword');
    await page.click('#modeToggle [data-mode=hybrid]');
    await openCollection(page, 'Mode');
    assert.equal(await active(), 'Keyword');
    await page.click('#modeToggle [data-mode=semantic]');
    await page.click('[data-view=timeline]');
    await page.waitForTimeout(150);
    assert.equal(await active(), 'Semantic');
    await page.click('.banner-back');
    await page.waitForTimeout(200);
    assert.equal(await active(), 'Hybrid');
  });

  await t.test('no errors in the page', () => assert.deepEqual(page.errors, []));
});

test('with the board turned off', async t => {
  const app = await startApp({ board: false });
  const browser = await launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await signedInPage(browser, app, 'alice');

  await t.test('a collection has no Board button, and its other views work', async () => {
    await makeCollection(page, 'no board', 5);
    await openCollection(page, 'no board');
    assert.equal(await page.locator('.banner-board').count(), 0);
    assert.equal(await page.locator('[data-view=timeline]').count(), 1);
    await page.click('[data-view=timeline]');
    await page.waitForSelector('.timeline-squares');
    assert.deepEqual(page.errors, []);
  });

  await t.test('the user guide leaves the board out', async () => {
    await page.goto(`${app.url}/help`);
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole('heading', { name: 'Working on a board' }).isVisible(), false);
    assert.equal(await page.getByRole('heading', { name: 'Downloading a whole collection' }).isVisible(), true);
  });
});
