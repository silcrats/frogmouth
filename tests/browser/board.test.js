const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');
const { launch, signedInPage, api, makeCollection, openCollection, saved } = require('../support/browser');

test('the board', async t => {
  const app = await startApp();
  const browser = await launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await signedInPage(browser, app, 'alice', { height: 900 });
  const cards = page.locator('.board-card');
  const tray = page.locator('.board-tray-item');
  const inspector = page.locator('.board-inspector');
  const bar = page.locator('.board-bar');
  const emptySpot = { position: { x: 20, y: 20 } };
  const clickEmpty = () => page.locator('.board-canvas').click(emptySpot);
  const c = await makeCollection(page, 'Case');
  await openCollection(page, 'Case');
  await page.click('.banner-board');
  await page.waitForSelector('.board-tray-item');
  const box = await page.locator('.board-canvas').boundingBox();
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  const trayDrag = async (x, y) => {
    const from = await tray.first().boundingBox();
    await page.mouse.move(from.x + 20, from.y + 10);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 5 });
    await page.mouse.up();
  };

  await t.test('documents drag from the tray', async () => {
    const before = await tray.count();
    await trayDrag(cx - 200, cy - 100);
    assert.equal(await cards.count(), 1);
    assert.equal(await tray.count(), before - 1);
  });

  await t.test('markup in a title stays text', async () => {
    await page.fill('.board-tray input[type=text]', 'img');
    assert.equal(await tray.count(), 1);
    await trayDrag(cx + 200, cy - 100);
    await page.fill('.board-tray input[type=text]', '');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('.board-card img').count(), 0);
  });

  await t.test('notes, typing and saving', async () => {
    await page.click('text=+ Note');
    await page.keyboard.type('Key lead');
    await clickEmpty();
    assert.equal(await page.locator('.board-card', { hasText: 'Key lead' }).count(), 1);
    await saved(page);
  });

  await t.test('connections by dragging and by Connect', async () => {
    const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
    await page.mouse.move(a.x + 50, a.y + 20);
    await page.mouse.move(a.x + a.width + 1, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 50, b.y + 20, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.locator('.board-link').count(), 1);
    await page.fill('.board-inspector input[type=text]', 'references');
    await page.check('.board-inspector input[type=checkbox]');
    assert.equal(await page.locator('.board-link-label').textContent(), 'references');
    assert.equal(await page.locator('.board-link polygon').count(), 1);
    await clickEmpty();
    await bar.getByRole('button', { name: 'Connect' }).click();
    await cards.nth(0).click();
    await cards.nth(2).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.board-link').count(), 2);
    await clickEmpty();
  });

  const positions = () => page.evaluate(() => [...document.querySelectorAll('.board-card')].map(e => e.style.transform));

  await t.test('groups carry their cards, and collapse without losing links', async () => {
    await cards.nth(0).click();
    await cards.nth(1).click({ modifiers: ['Shift'] });
    await bar.getByRole('button', { name: 'Group selected' }).click();
    await page.keyboard.type('Suspects');
    await clickEmpty();
    assert.equal(await page.locator('.board-group-count').textContent(), '2');
    const before = await positions();
    const head = await page.locator('.board-group-title').boundingBox();
    await page.mouse.move(head.x + 5, head.y + 5);
    await page.mouse.down();
    await page.mouse.move(head.x + 45, head.y + 65, { steps: 4 });
    await page.mouse.up();
    const after = await positions();
    assert.notEqual(before[0], after[0]);
    assert.notEqual(before[1], after[1]);
    assert.equal(before[2], after[2], 'the note stays');
    await page.click('.board-group-toggle');
    assert.equal(await cards.count(), 1);
    assert.equal(await page.locator('.board-link').count(), 1);
    await page.click('.board-group-toggle');
    assert.equal(await cards.count(), 3);
  });

  await t.test('dragging out of a group, undo and redo', async () => {
    const from = await cards.nth(0).boundingBox();
    await page.mouse.move(from.x + 60, from.y + 15);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 420, { steps: 6 });
    await page.mouse.up();
    assert.equal(await page.locator('.board-group-count').textContent(), '1');
    await clickEmpty();
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('.board-group-count').textContent(), '2');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.locator('.board-group-count').textContent(), '1');
    await page.keyboard.press('Control+z');
  });

  await t.test('dragging across the canvas selects; only Space or the middle button pans', async () => {
    await bar.getByRole('button', { name: 'Fit' }).click();
    const world = () => page.evaluate(() => document.querySelector('.board-world').style.transform);
    assert.equal(await page.locator('.board-canvas').evaluate(e => getComputedStyle(e).cursor), 'default');
    const w0 = await world();
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 4 });
    await page.mouse.up();
    assert.equal(await page.locator('.board-card.selected').count(), 3);
    assert.equal(await world(), w0, 'a drag must not pan');
    await clickEmpty();
    assert.equal(await page.locator('.board-card.selected').count(), 0);
    const before = await positions();
    await page.keyboard.down('Space');
    const over = await cards.nth(1).boundingBox();
    await page.mouse.move(over.x + 30, over.y + 20);
    await page.mouse.down();
    await page.mouse.move(over.x + 90, over.y + 50, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    assert.notEqual(await world(), w0, 'Space pans');
    assert.deepEqual(await positions(), before, 'without moving cards');
    const w1 = await world();
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(box.x + 70, box.y + 60, { steps: 3 });
    await page.mouse.up({ button: 'middle' });
    assert.notEqual(await world(), w1, 'the middle button pans');
  });

  await t.test('Place all, and a document\'s details', async () => {
    await page.click('text=Place all');
    assert.equal(await tray.count(), 0);
    await saved(page);
    await page.locator('.board-card', { hasText: 'Report 7' }).first().click();
    await page.click('text=Show text');
    await page.waitForSelector('.board-text:has-text("Identical memo")');
    const date = inspector.locator('date-select');
    await date.locator('select[aria-label=Day]').selectOption('04');
    await date.locator('select[aria-label=Month]').selectOption('03');
    await date.locator('input[aria-label=Year]').fill('1999');
    await date.locator('input[aria-label=Year]').blur();
    assert.match(await page.locator('.board-card', { hasText: 'Report 7' }).first().textContent(), /Event: /);
    assert.match(await page.locator('.board-time-label').textContent(), /1999/);
    await saved(page);
  });

  await t.test('the timeline slider fades what\'s outside, and undated items stay', async () => {
    const setEnd = fraction => page.evaluate(f => {
      const i = document.querySelectorAll('.board-time-track input')[1];
      i.value = +i.min + (+i.max - +i.min) * f;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, fraction);
    await setEnd(0.93);
    assert.ok(await page.locator('.board-card.out-of-range').count() > 0);
    assert.equal(await page.locator('.board-card', { hasText: 'Key lead' }).evaluate(e => e.classList.contains('out-of-range')), false);
    await page.locator('.board-time').getByRole('button', { name: 'All dates' }).click();
    assert.equal(await page.locator('.out-of-range').count(), 0);
  });

  await t.test('removing a card returns it to the tray; undo brings it back', async () => {
    await page.locator('.board-card', { hasText: 'Report 7' }).first().click();
    await page.keyboard.press('Delete');
    assert.equal(await tray.count(), 1);
    await page.keyboard.press('Control+z');
    assert.equal(await tray.count(), 0);
    await saved(page);
  });

  await t.test('it reopens as it was left', async () => {
    const n = await cards.count();
    const world = () => page.evaluate(() => document.querySelector('.board-world').style.transform);
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, 300);
    const w = await world();
    await bar.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
    await page.click('.banner-board');
    await page.waitForSelector('.board-card');
    assert.equal(await cards.count(), n);
    assert.ok(await page.locator('.board-link').count() >= 2);
    assert.equal(await page.locator('.board-group-title', { hasText: 'Suspects' }).count(), 1);
    assert.equal(await world(), w);
  });

  await t.test('moving around doesn\'t warn about leaving', async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, 200);
    assert.equal(await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }), false);
    await page.keyboard.press('Control+s');
    await saved(page);
  });

  await t.test('a change in another window is noticed, not overwritten', async () => {
    const r = (await api(page, 'GET', `/api/collections/${c.id}/board`)).body;
    await api(page, 'PUT', `/api/collections/${c.id}/board`, { revision: r.board.revision, board: r.board });
    await page.click('text=+ Note');
    await page.keyboard.type('x');
    await clickEmpty();
    await page.waitForFunction(() => document.querySelector('.board-status span').textContent.includes('another window'));
    await page.locator('.board-status button').click();
    await saved(page);
  });

  await t.test('suggestions change nothing until accepted, and undo in one step', async () => {
    const links = () => page.locator('.board-link').count();
    const before = await links();
    await bar.getByRole('button', { name: 'Suggest' }).click();
    await page.waitForSelector('.board-suggest-row');
    assert.equal(await links(), before);
    assert.equal(await page.locator('.board-suggest-row img').count(), 0);
    await page.locator('.board-suggest-row').first().hover();
    assert.equal(await page.locator('.board-link-suggested').count(), 1);
    const rows = await page.locator('.board-suggest-row').count();
    await page.locator('.board-suggest-dismiss').first().click();
    assert.equal(await page.locator('.board-suggest-row').count(), rows - 1);
    await inspector.getByRole('button', { name: /^Add \d+ connection/ }).click();
    const added = await links();
    assert.ok(added > before);
    await page.keyboard.press('Control+z');
    assert.equal(await links(), before);
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await links(), added);
    await saved(page);
  });

  await t.test('rated groups explain themselves, and weak fits can be handled', async () => {
    const groups = page.locator('.board-group');
    const had = await groups.count();
    await page.locator('.board-suggest-tabs button', { hasText: 'Topic' }).click();
    const boxes = page.locator('.board-suggest-groups input[type=checkbox]');
    const total = await boxes.count();
    assert.equal(await page.locator('.board-suggest-groups input:checked').count(), total, 'all start ticked');
    assert.equal(await page.locator('.board-quality').count(), total, 'all labelled');
    const apply = inspector.getByRole('button', { name: /^Apply/ });
    await page.locator('.board-suggest-groups input:checked').first().uncheck();
    assert.equal(await apply.textContent(), `Apply ${total - 1} group${total - 1 === 1 ? '' : 's'}`);
    await apply.click();
    assert.equal(await groups.count(), had + total - 1);
    await saved(page);
    await inspector.locator('.board-tray-head button').click();
    await page.locator('.board-group-title').last().click();
    assert.equal(await inspector.locator('.board-quality').count(), 1);
    assert.ok((await inspector.locator('.board-field .board-note').first().textContent()).length > 40);
    await inspector.getByRole('button', { name: 'Re-rate' }).click();
    await inspector.locator('.board-note', { hasText: /Was .*, now|Rated/ }).first().waitFor({ timeout: 8000 });
    await saved(page);
    await page.keyboard.press('Control+z');
    await saved(page);
  });

  await t.test('versions, and Reset board asking first', async () => {
    await clickEmpty();
    const n = await cards.count();
    await bar.getByRole('button', { name: 'Versions' }).click();
    await inspector.locator('.board-version-new input').fill('<b>Checkpoint</b>');
    await inspector.locator('.board-version-new button').click();
    await inspector.locator('.board-version').first().waitFor();
    assert.equal(await inspector.locator('.board-version b').count(), 0, 'a name is text');
    await inspector.locator('.board-tray-head button').click();
    await bar.getByRole('button', { name: 'Reset board' }).click();
    await inspector.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await cards.count(), n);
    await bar.getByRole('button', { name: 'Reset board' }).click();
    await inspector.getByRole('button', { name: 'Reset board' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.board-card').length === 0);
    await saved(page);
    const after = (await api(page, 'GET', `/api/collections/${c.id}/board`)).body;
    assert.equal(after.board.objects.length, 0);
    assert.equal(after.items.length, c.ids.length, 'the collection is untouched');
    await bar.getByRole('button', { name: 'Versions' }).click();
    await inspector.locator('.board-version').first().waitFor();
    assert.match(await inspector.locator('.board-version').first().textContent(), /Before reset/);
    await inspector.getByRole('button', { name: 'Restore' }).first().click();
    await page.waitForFunction(count => document.querySelectorAll('.board-card').length === count, n);
    await bar.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
  });

  await t.test('a full board of groups stops at the limit', async () => {
    const d = await makeCollection(page, 'Cap');
    const groups = Array.from({ length: 198 }, (_, i) => ({ id: `g${i}`, x: -5000 - i * 200, y: 0, w: 160, h: 100, title: `G${i}`, collapsed: true }));
    const objects = d.ids.map((id, i) => ({ id: `d${i}`, kind: 'doc', doc_id: id, x: i * 240, y: 0 }));
    await api(page, 'PUT', `/api/collections/${d.id}/board`, { revision: 0, board: { objects, groups } });
    await openCollection(page, 'Cap');
    await page.click('.banner-board');
    await page.waitForSelector('.board-card');
    await bar.getByRole('button', { name: 'Suggest' }).click();
    await page.waitForSelector('.board-suggest-tabs');
    await page.locator('.board-suggest-tabs button', { hasText: 'File type' }).click();
    const apply = inspector.getByRole('button', { name: /^Apply/ });
    assert.equal(await apply.textContent(), 'Apply 2 groups');
    await apply.click();
    await saved(page);
    assert.equal(await page.locator('.board-group').count(), 200);
    await inspector.locator('.board-tray-head button').click();
    await bar.getByRole('button', { name: 'Group' }).first().click();
    assert.equal(await page.locator('.board-group').count(), 200);
    await bar.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
  });

  await t.test('weak fits highlight, move out and re-shuffle', async () => {
    const d = await makeCollection(page, 'Weak', 12);
    const objs = d.ids.map((id, i) => ({ id: `d${i}`, kind: 'doc', doc_id: id, x: (i % 4) * 240, y: Math.floor(i / 4) * 130, group: 'g1' }));
    await api(page, 'PUT', `/api/collections/${d.id}/board`, { revision: 0, board: { objects: objs, groups: [{ id: 'g1', x: -30, y: -50, w: 1040, h: 480, title: 'Topic', quality: { rating: 'some', basis: 'meaning', alike: 0.4, shared: 0.3, members: objs.map(o => o.id), weak_fits: ['d1', 'd5'], left_out: 0 } }] } });
    await openCollection(page, 'Weak');
    await page.click('.banner-board');
    await page.waitForSelector('.board-group');
    await page.locator('.board-group-title').click();
    await inspector.getByRole('button', { name: 'Highlight weak fits' }).click();
    assert.equal(await page.locator('.board-card.weak-highlight').count(), 2);
    await inspector.getByRole('button', { name: 'Clear highlight' }).click();
    assert.equal(await page.locator('.board-card.weak-highlight').count(), 0);
    const count = await cards.count();
    await inspector.getByRole('button', { name: 'Remove weak fits' }).click();
    assert.equal(await cards.count(), count, 'still on the board');
    assert.equal(await page.locator('.board-group-count').textContent(), '10');
    assert.match(await inspector.locator('.board-rating-stale').textContent(), /2 removed/);
    await saved(page);
    const width = await page.locator('.board-group').evaluate(e => e.offsetWidth * e.offsetHeight);
    await inspector.getByRole('button', { name: 'Re-shuffle cards' }).click();
    await saved(page);
    const b = (await api(page, 'GET', `/api/collections/${d.id}/board`)).body.board;
    const g = b.groups[0];
    const members = b.objects.filter(o => o.group === g.id);
    assert.equal(new Set(members.map(o => `${o.x},${o.y}`)).size, 10, 'no two on one spot');
    assert.ok(members.every(o => o.x >= g.x && o.y >= g.y && o.x + 220 <= g.x + g.w));
    assert.ok(await page.locator('.board-group').evaluate(e => e.offsetWidth * e.offsetHeight) < width, 'the frame shrank');
    await bar.getByRole('button', { name: 'Close' }).click();
  });

  await t.test('no errors in the page', () => assert.deepEqual(page.errors, []));
});
