const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');
const { launch, signedInPage, api, makeCollection, openCollection } = require('../support/browser');

test('zoomed far out, cards are plain boxes', async t => {
  const app = await startApp();
  const browser = await launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await signedInPage(browser, app, 'alice', { width: 1400, height: 900 });
  const c = await makeCollection(page, 'Zoom', 6);
  await api(page, 'PUT', `/api/collections/${c.id}/board`, { revision: 0, board: {
    objects: c.ids.map((d, i) => ({ id: `c${i}`, kind: 'doc', doc_id: d, x: i * 240, y: 0 })),
    view: { x: 100, y: 100, k: 1 },
  } });
  await openCollection(page, 'Zoom');
  await page.click('.banner-board');
  await page.waitForSelector('.board-card');
  const far = () => page.locator('.board').evaluate(e => e.classList.contains('far'));
  const titleShown = () => page.locator('[data-node=c0] .board-card-title').evaluate(e => getComputedStyle(e).visibility === 'visible');
  const size = () => page.locator('[data-node=c0]').evaluate(e => [e.offsetWidth, e.offsetHeight]);
  const zoom = async (times, dy) => {
    await page.mouse.move(700, 450);
    for (let i = 0; i < times; i++) await page.mouse.wheel(0, dy);
    await page.waitForTimeout(150);
  };

  await t.test('close up, cards show their text', async () => {
    assert.equal(await far(), false);
    assert.equal(await titleShown(), true);
  });

  await t.test('far out, the text goes but the size stays', async () => {
    const before = await size();
    await zoom(8, 300);
    assert.equal(await far(), true);
    assert.equal(await titleShown(), false);
    assert.deepEqual(await size(), before, 'so groups and layouts are unchanged');
    assert.equal(await page.locator('[data-node=c0]').evaluate(e => getComputedStyle(e).boxShadow), 'none');
  });

  await t.test('what Find picks out, and what\'s selected, still show', async () => {
    await page.keyboard.press('Control+f');
    await page.fill('.board-find-form input', 'report 0');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const matchShadow = await page.locator('.board-card.find-match').first().evaluate(e => getComputedStyle(e).boxShadow);
    assert.notEqual(matchShadow, 'none');
    await page.click('.board-find-head button');
  });

  await t.test('far out, panning draws the board once and moves it, only while panning', async () => {
    const box = await page.locator('.board-canvas').boundingBox();
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(box.x + 360, box.y + 330, { steps: 3 });
    assert.equal(await page.locator('.board-world').evaluate(e => e.style.willChange), 'transform');
    await page.mouse.up({ button: 'middle' });
    assert.equal(await page.locator('.board-world').evaluate(e => e.style.willChange), '');
  });

  await t.test('back in close, the text returns', async () => {
    await zoom(8, -300);
    assert.equal(await far(), false);
    assert.equal(await titleShown(), true);
  });

  await t.test('close up, panning moves the board as it is', async () => {
    const box = await page.locator('.board-canvas').boundingBox();
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(box.x + 360, box.y + 330, { steps: 3 });
    assert.equal(await page.locator('.board-world').evaluate(e => e.style.willChange), '');
    await page.mouse.up({ button: 'middle' });
  });

  await t.test('no errors in the page', () => assert.deepEqual(page.errors, []));
});
