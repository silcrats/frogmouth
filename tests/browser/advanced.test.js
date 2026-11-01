const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');
const { launch, signedInPage, makeCollection, openCollection, openTimeline } = require('../support/browser');

test('advanced search in the page', async t => {
  const app = await startApp();
  const browser = await launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await signedInPage(browser, app, 'alice');
  const go = async q => { await page.locator('#queryInput:visible, #queryArea:visible').fill(q); await page.click('#searchBtn'); await page.waitForTimeout(300); };
  const results = page.locator('#results');
  const meta = page.locator('#metaRow');

  await t.test('the button shows with vector search off, with its hint', async () => {
    assert.ok(await page.locator('#modeToggle').isVisible());
    assert.equal(await page.locator('#modeToggle [data-mode=semantic]').isVisible(), false);
    assert.equal(await page.locator('#advancedHint').isVisible(), false);
    await page.click('#modeToggle [data-mode=advanced]');
    assert.ok(await page.locator('#advancedHint').isVisible());
    assert.equal(await page.locator('#advancedHint a').getAttribute('href'), '/help#advanced');
  });

  await t.test('only Advanced colours the box and button, and the syntax link is a yellow button', async () => {
    const look = () => page.evaluate(() => [getComputedStyle(queryArea).borderTopColor, getComputedStyle(searchBtn).backgroundColor]);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    const violet = 'rgb(182, 156, 255)';
    assert.deepEqual(await look(), [violet, violet]);
    const link = await page.locator('#advancedHint a').evaluate(e => { const c = getComputedStyle(e); return [c.color, c.borderTopColor, c.borderTopStyle]; });
    assert.deepEqual(link, ['rgb(255, 224, 138)', 'rgb(255, 224, 138)', 'solid']);
    const mid = q => page.locator(q).evaluate(e => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
    assert.ok(Math.abs(await mid('#modeToggle') - await mid('#scopeToggle')) < 8, 'Mode stays beside Search in');
    assert.ok(await mid('#advancedHint') > await mid('#modeToggle'), 'the examples go underneath');
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/advanced.png` : undefined, clip: { x: 0, y: 0, width: 1440, height: 340 } });
    await page.click('#modeToggle [data-mode=keyword]');
    await page.waitForTimeout(250);
    const plain = await page.evaluate(() => [getComputedStyle(queryInput).borderTopColor, getComputedStyle(searchBtn).backgroundColor]);
    assert.notEqual(plain[0], violet);
    assert.notEqual(plain[1], violet);
    await page.click('#modeToggle [data-mode=advanced]');
  });

  await t.test('a search runs, and a mistake says what\'s wrong, not that the index is down', async () => {
    await go('title:report');
    assert.ok(await page.locator('.result').count() > 0);
    await go('role:1alice');
    assert.match(await meta.textContent(), /isn't a field you can search/);
    assert.doesNotMatch(await results.textContent(), /Could not reach/);
    await go('(report');
    assert.match(await results.textContent(), /never closed/);
    await go('FORCEPARSEERROR');
    assert.match(await results.textContent(), /couldn't read that search/);
  });

  await t.test('a search can run over several lines', async () => {
    const area = page.locator('#queryArea');
    const single = await area.evaluate(e => e.offsetHeight);
    const urls = [];
    const seen = r => { if (r.url().includes('/api/search')) urls.push(new URL(r.url()).searchParams.get('q')); };
    page.on('request', seen);
    await area.fill('');
    await area.focus();
    await page.keyboard.type('title:report');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('AND NOT');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('nothinglikethis');
    assert.equal(urls.length, 0, 'Shift+Enter doesn\'t search');
    assert.equal(await area.inputValue(), 'title:report\nAND NOT\nnothinglikethis');
    assert.ok(await area.evaluate(e => e.offsetHeight) > single, 'the box grows');
    const button = await page.locator('#searchBtn').evaluate(e => e.offsetHeight);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    assert.equal(urls.at(-1), 'title:report AND NOT nothinglikethis');
    assert.ok(await page.locator('.result').count() > 0);
    assert.equal(await area.inputValue(), 'title:report\nAND NOT\nnothinglikethis', 'it keeps its lines');
    assert.equal(button, 46, 'the button stays one line high');
    page.off('request', seen);
  });

  await t.test('other modes keep their one-line box, and the search moves between them', async () => {
    const box = page.locator('#queryInput');
    await page.click('#modeToggle [data-mode=keyword]');
    await page.waitForTimeout(250);
    assert.ok(await box.isVisible());
    assert.equal(await page.locator('#queryArea').isVisible(), false);
    assert.equal(await box.evaluate(e => e.tagName), 'INPUT');
    assert.equal(await box.inputValue(), 'title:report AND NOT nothinglikethis');
    await page.click('#modeToggle [data-mode=advanced]');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#queryArea').inputValue(), 'title:report\nAND NOT\nnothinglikethis', 'unchanged, so its lines are kept');
    await page.click('#modeToggle [data-mode=keyword]');
    await page.waitForTimeout(250);
    await box.fill('report');
    await box.press('Enter');
    await page.waitForTimeout(300);
    assert.ok(await page.locator('.result').count() > 0, 'Enter still searches');
    await page.click('#modeToggle [data-mode=advanced]');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#queryArea').inputValue(), 'report', 'edited, so it follows');
    assert.ok(await page.locator('#queryArea').evaluate(e => e.offsetHeight) <= 48, 'and shrinks back');
  });

  await t.test('text a query echoes back stays text', async () => {
    await go('<img/src=x onerror=window.__xss=1>:a');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#results img, #metaRow img').count(), 0);
  });

  await t.test('the full text marks the words, not the fields and operators', async () => {
    await go('title:report AND NOT nothinglikethis');
    await page.locator('.expand-btn').first().click();
    await page.waitForSelector('.result.open .result-text, .result.open .full-text').catch(() => {});
    await page.waitForTimeout(300);
    const marked = await page.locator('.result.open mark').allTextContents();
    const lower = marked.map(m => m.toLowerCase());
    assert.ok(!lower.includes('title') && !lower.includes('and') && !lower.includes('not'), lower.join());
    assert.equal((await page.evaluate(() => advancedWords('attachment:true AND budget'))).trim(), 'budget');
    const words = await page.evaluate(() => advancedWords('from:(alice OR "bob smith") AND date:[2001 TO 2002] -draft^2 repor* recieve~1'));
    assert.deepEqual(words.trim().split(/\s+/), ['alice', 'bob', 'smith', 'draft', 'repor', 'recieve']);
  });

  await t.test('works in a collection and its timeline, and shows errors there', async () => {
    await makeCollection(page, 'Adv');
    await openCollection(page, 'Adv');
    await page.click('#modeToggle [data-mode=advanced]');
    await go('title:report');
    assert.match(await meta.textContent(), /in this collection/);
    await go('role:x');
    assert.match(await meta.textContent(), /isn't a field/);
    await go('');
    await openTimeline(page, 'Adv');
    await go('title:report');
    assert.match(await meta.textContent(), /in this collection, oldest first/);
    await go('role:x');
    assert.match(await meta.textContent(), /isn't a field/);
    await go('');
    assert.ok(await page.locator('.result').count() > 0);
  });

  await t.test('the guide covers it', async () => {
    const help = await page.context().newPage();
    await help.goto(`${app.url}/help#advanced`);
    assert.match(await help.locator('#modes').locator('..').textContent(), /date:\[2001-01-01 TO 2001-12-31\]/);
    await help.close();
  });

  await t.test('no errors in the page', () => assert.deepEqual(page.errors, []));
});
