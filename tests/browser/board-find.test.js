const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');
const { launch, signedInPage, api, makeCollection, openCollection } = require('../support/browser');

test('finding things on the board', async t => {
  const app = await startApp();
  const browser = await launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await signedInPage(browser, app, 'alice', { width: 1400, height: 900 });
  const c = await makeCollection(page, 'Findme', 14);
  const box = (id, title, color, x, y) => ({ id, title, color, x, y, w: 480, h: 360 });
  const [d0, d1, , , , , , , d8] = c.ids;
  assert.equal((await api(page, 'PUT', `/api/collections/${c.id}/board`, { revision: 0, board: {
    groups: [box('g1', 'Payments', 'amber', 0, 0), box('g2', 'Travel', 'blue', 560, 0)],
    objects: [
      ...c.ids.slice(0, 12).map((d, i) => ({ id: `c${i}`, kind: 'doc', doc_id: d, x: (i < 6 ? 0 : 560) + 20 + (i % 2) * 230, y: 40 + Math.floor((i % 6) / 2) * 100,
        group: i < 6 ? 'g1' : 'g2', text: i === 3 ? 'Check the budget figures with finance.' : '' })),
      { id: 'n1', kind: 'note', x: 1150, y: 40, text: 'Budget meeting was moved to Friday.' },
      { id: 'p1', kind: 'person', title: 'Jane Smith', x: 1150, y: 160 },
    ],
  } })).status, 200);
  await openCollection(page, 'Findme');
  await page.click('.banner-board');
  await page.waitForSelector('.board-card');
  const idOf = docId => `c${c.ids.indexOf(docId)}`;
  const matched = () => page.locator('.board-card.find-match').evaluateAll(cards => cards.map(e => e.dataset.node).sort());
  const summary = () => page.locator('.board-find-head .board-note').textContent();
  const search = async q => { await page.fill('.board-find-form input', q); await page.keyboard.press('Enter'); await page.waitForTimeout(400); };

  await t.test('Ctrl+F opens Find, and the tray is a tab away', async () => {
    assert.equal(await page.locator('.board-find').isVisible(), false);
    await page.locator('.board-canvas').click({ position: { x: 600, y: 700 } });
    await page.keyboard.press('Control+f');
    assert.equal(await page.locator('.board-find').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Search the board');
    await page.locator('.board-side-tabs').getByRole('button', { name: 'Not on board' }).click();
    assert.equal(await page.locator('.board-tray-item').count(), 2);
    await page.locator('.board-side-tabs').getByRole('button', { name: 'Find' }).click();
  });

  await t.test('a search finds documents by their text, and cards and notes by what you wrote', async () => {
    await search('budget');
    assert.deepEqual(await matched(), [idOf(d0), idOf(d1), 'c3', idOf(d8), 'n1'].sort());
    assert.match(await summary(), /^5 of 14 items on the board match/);
    assert.equal(await page.locator('.board-find-row').count(), 5);
    assert.equal(await page.locator('.board-card.find-out').count(), 14 - 5);
    assert.match(await page.locator('.board-find-row', { hasText: 'Your note' }).textContent(), /Check the budget figures/);
    assert.equal(await page.locator('.board-group.find-out').count(), 0, 'both groups hold a match');
  });

  await t.test('filters narrow it down', async () => {
    await page.locator('.board-find-filters select').nth(1).selectOption('note');
    assert.deepEqual(await matched(), ['n1']);
    assert.equal(await page.locator('.board-group.find-out').count(), 2);
    await page.locator('.board-find-filters select').nth(1).selectOption('');
    await page.locator('.board-find-filters select').nth(3).selectOption('g2');
    assert.deepEqual(await matched(), [idOf(d8)], 'only Travel\'s match');
    await page.locator('.board-find-filters select').nth(3).selectOption('');
    await search('');
    await page.fill('.board-find-filters input[type=text]', 'carol');
    assert.deepEqual(await matched(), [idOf(d8)]);
    await page.check('.board-find-filters input[type=checkbox]');
    assert.deepEqual(await matched(), [], 'and it has no notes');
    await page.uncheck('.board-find-filters input[type=checkbox]');
    await page.fill('.board-find-filters input[type=text]', '');
  });

  await t.test('a date range keeps what falls in it, days included', async () => {
    const dates = page.locator('.board-find-filters input[type=date]');
    // The made-up documents are 45 days apart from 1 Jan 2015: c2 is 1 Apr 2015, c4 30 June.
    await dates.nth(0).fill('2015-04-01');
    await dates.nth(1).fill('2015-06-30');
    assert.deepEqual(await matched(), ['c2', 'c3', 'c4']);
    assert.equal(await page.locator('.board-node[data-node=n1].find-out').count(), 1, 'an undated note is left out');
    await dates.nth(0).fill('');
    assert.deepEqual(await matched(), ['c0', 'c1', 'c2', 'c3', 'c4']);
    await search('budget');
    assert.deepEqual(await matched(), [idOf(d0), idOf(d1), 'c3'].sort(), 'with a search too');
    await page.click('.board-find-head button');
    assert.equal(await dates.nth(1).inputValue(), '', 'Clear empties them');
    assert.equal(await page.locator('.find-out').count(), 0);
  });

  await t.test('choosing a match selects it and brings it into view', async () => {
    await search('jane');
    assert.deepEqual(await page.locator('.board-node.find-match').evaluateAll(n => n.map(e => e.dataset.node)), ['p1']);
    await page.locator('.board-find-row').first().click();
    assert.equal(await page.locator('.board-node.selected').getAttribute('data-node'), 'p1');
    const [node, canvas] = await Promise.all([page.locator('[data-node=p1]').boundingBox(), page.locator('.board-canvas').boundingBox()]);
    assert.ok(Math.abs(node.x + node.width / 2 - (canvas.x + canvas.width / 2)) < 3, 'in the middle');
  });

  await t.test('the row for what\'s selected is highlighted, whichever way it was chosen', async () => {
    await search('budget');
    const current = () => page.locator('.board-find-row.current').evaluateAll(rows => rows.map(r => r.dataset.id));
    assert.deepEqual(await current(), []);
    await page.locator('.board-find-row').nth(2).click();
    const chosen = await page.locator('.board-find-row').nth(2).getAttribute('data-id');
    assert.deepEqual(await current(), [chosen]);
    assert.equal(await page.locator('.board-find-row').nth(2).getAttribute('aria-current'), 'true');
    const look = id => page.locator(`[data-node="${id}"]`).evaluate(e => ({ border: getComputedStyle(e).borderLeftColor, shadow: getComputedStyle(e).boxShadow, tint: getComputedStyle(e).backgroundImage }));
    await page.waitForFunction(() => !document.querySelector('.find-pulse'));
    const other = await page.locator('.board-card.find-match:not(.selected)').first().getAttribute('data-node');
    const [mine, theirs] = [await look(chosen), await look(other)];
    assert.equal(mine.border, 'rgb(255, 224, 138)', 'the chosen card is edged in yellow, not teal');
    assert.notEqual(mine.tint, 'none', 'and tinted, as its row is');
    assert.equal(theirs.tint, 'none');
    assert.match(mine.shadow, /3px/, 'with a heavier ring than the other matches');
    assert.match(theirs.shadow, /1\.5px/);
    await page.locator('.board-bar').getByRole('button', { name: 'Fit' }).click();
    await page.locator('[data-node=n1]').click();
    assert.deepEqual(await current(), ['n1'], 'clicking a card on the board picks its row');
    await page.locator('[data-node=p1]').click();
    assert.deepEqual(await current(), [], 'one that isn\'t a match has no row');
    await page.keyboard.press('Escape');
  });

  await t.test('a match inside a collapsed group lights up the group', async () => {
    await page.locator('.board-bar').getByRole('button', { name: 'Fit' }).click();
    await page.locator('.board-group', { hasText: 'Payments' }).locator('.board-group-toggle').click();
    await search('budget');
    assert.equal(await page.locator('.board-group.find-match').count(), 1);
    await page.locator('.board-group', { hasText: 'Payments' }).locator('.board-group-toggle').click();
  });

  await t.test('finding changes nothing on the board', async () => {
    await page.waitForFunction(() => document.querySelector('.board-status span').textContent === 'Saved', null, { timeout: 8000 });
    const saved = (await api(page, 'GET', `/api/collections/${c.id}/board`)).body.board;
    assert.equal(saved.objects.length, 14);
  });

  await t.test('no errors in the page', () => assert.deepEqual(page.errors, []));
});
