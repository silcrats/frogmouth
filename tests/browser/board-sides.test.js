const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');
const { launch, signedInPage, makeCollection, openCollection } = require('../support/browser');

test('the board\'s sidebars', async t => {
  const app = await startApp();
  const browser = await launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await signedInPage(browser, app, 'alice', { width: 1400, height: 900 });
  await makeCollection(page, 'Sides', 6);
  await openCollection(page, 'Sides');
  const open = async () => { await page.click('.banner-board'); await page.waitForSelector('.board-tray-item'); };
  const close = async () => { await page.locator('.board-bar').getByRole('button', { name: 'Close' }).click(); await page.waitForSelector('.board', { state: 'detached' }); };
  const width = sel => page.locator(sel).evaluate(e => Math.round(e.getBoundingClientRect().width));
  const drag = async (sel, dx) => {
    const b = await page.locator(sel).boundingBox();
    const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 5 });
    await page.mouse.up();
  };
  const button = name => page.locator('.board-bar').getByRole('button', { name, exact: true });
  await open();

  await t.test('dragging an inner edge resizes a sidebar, and the canvas makes room', async () => {
    assert.equal(await width('.board-tray'), 250);
    assert.equal(await width('.board-inspector'), 300);
    const canvas = await width('.board-canvas');
    await drag('.board-side-handle-tray', 100);
    assert.equal(await width('.board-tray'), 350);
    await drag('.board-side-handle-inspector', -80);
    assert.equal(await width('.board-inspector'), 380);
    assert.equal(await width('.board-canvas'), canvas - 180);
  });

  await t.test('there are limits, and the arrow keys work too', async () => {
    await drag('.board-side-handle-tray', -400);
    assert.equal(await width('.board-tray'), 180);
    await page.locator('.board-side-handle-tray').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await width('.board-tray'), 200);
    await drag('.board-side-handle-inspector', -2000);
    assert.equal(await width('.board-inspector'), Math.round(1400 * 0.45));
  });

  await t.test('widths are remembered, and a double-click puts one back', async () => {
    await close();
    await open();
    assert.equal(await width('.board-tray'), 200);
    assert.equal(await width('.board-inspector'), 630);
    await page.locator('.board-side-handle-inspector').dblclick();
    assert.equal(await width('.board-inspector'), 300);
  });

  await t.test('the right sidebar hides, stays hidden, and comes back for Suggest and Versions', async () => {
    const canvas = await width('.board-canvas');
    await button('Right panel').click();
    assert.equal(await page.locator('.board-inspector').isVisible(), false);
    assert.equal(await page.locator('.board-side-handle-inspector').isVisible(), false);
    assert.equal(await width('.board-canvas'), canvas + 300);
    await close();
    await open();
    assert.equal(await page.locator('.board-inspector').isVisible(), false, 'remembered');
    await button('Versions').click();
    assert.equal(await page.locator('.board-inspector').isVisible(), true);
    await button('Right panel').click();
    await button('Suggest').click();
    assert.equal(await page.locator('.board-inspector').isVisible(), true);
    await button('Right panel').click();
    await button('Right panel').click();
    assert.equal(await width('.board-inspector'), 300, 'at the width it had');
  });

  await t.test('hiding the left sidebar keeps its width for when it comes back', async () => {
    await button('Left panel').click();
    assert.equal(await page.locator('.board-tray').isVisible(), false);
    assert.equal(await page.locator('.board-side-handle-tray').isVisible(), false);
    await button('Left panel').click();
    assert.equal(await width('.board-tray'), 200);
  });

  await t.test('in a narrow window the sidebars float, without handles', async () => {
    await close();
    await page.setViewportSize({ width: 800, height: 900 });
    await page.click('.banner-board');
    await page.waitForSelector('.board-card, .board-empty');
    assert.equal(await page.locator('.board-side-handle-tray').isVisible(), false);
    assert.equal(await page.locator('.board-side-handle-inspector').isVisible(), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  await t.test('no errors in the page', () => assert.deepEqual(page.errors, []));
});
