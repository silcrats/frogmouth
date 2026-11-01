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
    const leftUnticked = await inspector.locator('.board-suggest-groups label, .board-suggest-groups > *').evaluateAll(rows => rows.filter(r => /unclear|Short notes/i.test(r.textContent) && r.querySelector('input:checked')).length);
    assert.equal(leftUnticked, 0, 'Short notes and unclear topics start unticked');
    assert.ok(await page.locator('.board-suggest-groups input:checked').count() >= 1);
    assert.equal(await page.locator('.board-quality').count(), total, 'all labelled');
    const apply = inspector.getByRole('button', { name: /^Apply/ });
    const startTicked = await page.locator('.board-suggest-groups input:checked').count();
    await page.locator('.board-suggest-groups input:checked').first().uncheck();
    const applying = startTicked - 1 || 1;
    if (startTicked === 1) await page.locator('.board-suggest-groups input[type=checkbox]').first().check();
    assert.equal(await apply.textContent(), `Apply ${applying} group${applying === 1 ? '' : 's'}`);
    await apply.click();
    assert.equal(await groups.count(), had + applying);
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
    const groups = Array.from({ length: 998 }, (_, i) => ({ id: `g${i}`, x: -5000 - i * 200, y: 0, w: 160, h: 100, title: `G${i}`, collapsed: true }));
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
    assert.equal(await page.locator('.board-group').count(), 1000);
    await inspector.locator('.board-tray-head button').click();
    await bar.getByRole('button', { name: 'Group' }).first().click();
    assert.equal(await page.locator('.board-group').count(), 1000);
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

  await t.test('a group can be arranged in sections, and a section made its own group', async () => {
    const d = await makeCollection(page, 'Sections', 30);
    const objs = d.ids.map((id, i) => ({ id: `d${i}`, kind: 'doc', doc_id: id, x: (i % 6) * 240, y: Math.floor(i / 6) * 130, group: 'g1' }));
    await api(page, 'PUT', `/api/collections/${d.id}/board`, { revision: 0, board: { objects: objs, groups: [{ id: 'g1', x: -30, y: -50, w: 1500, h: 900, title: 'Reports' }] } });
    await openCollection(page, 'Sections');
    await page.click('.banner-board');
    await page.waitForSelector('.board-group');
    const labels = page.locator('.board-section');
    const titles = () => labels.locator('.board-section-title').allTextContents();
    const saved2 = async () => { await saved(page); return (await api(page, 'GET', `/api/collections/${d.id}/board`)).body; };
    await page.locator('.board-group-title').click();
    const arrange = inspector.locator('.board-arrange');
    assert.equal(await arrange.inputValue(), '');
    assert.equal(await labels.count(), 0);

    await arrange.selectOption('date');
    const dates = await titles();
    assert.ok(dates.length >= 2, dates.join());
    assert.equal(dates.at(-1), 'Undated', 'the undated card comes last');
    const years = dates.slice(0, -1);
    assert.ok(years.every(y => /^\d{4}$/.test(y)) || years.every(y => /\d{4}/.test(y)), years.join());
    assert.deepEqual(years, [...years].sort((a, b) => Date.parse(a) - Date.parse(b)), 'oldest first');
    let board = await saved2();
    let group = board.board.groups[0];
    assert.equal(group.arrange, 'date');
    assert.equal(group.sections.flatMap(x => x.members).length, await cards.count(), 'every card in one section');
    assert.equal(new Set(group.sections.flatMap(x => x.members)).size, await cards.count());
    // Labels and cards don't overlap, and everything's inside the frame.
    const overlap = await page.evaluate(() => {
      const ls = [...document.querySelectorAll('.board-section')].map(e => e.getBoundingClientRect());
      const cs = [...document.querySelectorAll('.board-card')].map(e => e.getBoundingClientRect());
      const f = document.querySelector('.board-group').getBoundingClientRect();
      return { hits: ls.reduce((n, l) => n + cs.filter(c => c.left < l.right && c.right > l.left && c.top < l.bottom && c.bottom > l.top).length, 0), out: cs.filter(c => c.top < f.top || c.bottom > f.bottom + 1 || c.left < f.left || c.right > f.right + 1).length };
    });
    assert.deepEqual(overlap, { hits: 0, out: 0 });

    // Moving the frame takes its labels along.
    const label = () => page.locator('.board-section-box').first().evaluate(e => e.style.top);
    const top = await label();
    const head = await page.locator('.board-group-title').boundingBox();
    await page.mouse.move(head.x + 5, head.y + 5);
    await page.mouse.down();
    await page.mouse.move(head.x + 45, head.y + 45, { steps: 3 });
    await page.mouse.up();
    assert.equal(await label(), top);
    await saved(page);

    await arrange.selectOption('subject');
    assert.ok((await titles()).includes('Other subjects') || (await labels.count()) > 0);
    await arrange.selectOption('type');
    assert.ok((await labels.count()) >= 1);
    await arrange.selectOption('sender');
    assert.ok((await titles()).includes('No sender'));
    assert.equal(await page.locator('.board-section b, .board-section img').count(), 0, 'text only');

    // A section becomes a group, beside the original, and undo puts it back.
    await arrange.selectOption('date');
    await saved(page);
    const total = await cards.count();
    const firstTitle = (await titles())[0];
    const firstCount = Number(await labels.first().locator('.board-group-count').textContent());
    await labels.first().getByRole('button', { name: 'Make group' }).click();
    assert.equal(await page.locator('.board-group').count(), 2);
    assert.equal(await cards.count(), total, 'no card lost');
    board = await saved2();
    const made = board.board.groups.find(x => x.id !== 'g1');
    group = board.board.groups.find(x => x.id === 'g1');
    assert.equal(made.title, `Reports: ${firstTitle}`);
    assert.equal(board.board.objects.filter(o => o.group === made.id).length, firstCount);
    assert.equal(board.board.objects.filter(o => o.group === 'g1').length, total - firstCount);
    assert.ok(!(await titles()).includes(firstTitle), 'the section has gone');
    assert.ok(made.x >= group.x + group.w, 'beside the original');
    const inFrame = (o, f) => o.x >= f.x && o.y >= f.y && o.x + 220 <= f.x + f.w && o.y < f.y + f.h;
    assert.ok(board.board.objects.filter(o => o.group === made.id).every(o => inFrame(o, made)));
    assert.ok(board.board.objects.filter(o => o.group === 'g1').every(o => inFrame(o, group)));
    await page.locator('.board-canvas').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('.board-group').count(), 1);
    assert.ok((await titles()).includes(firstTitle), 'undo brings it back');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.locator('.board-group').count(), 2);
    await saved(page);

    // It survives reopening, and No sections clears it.
    await bar.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
    await page.click('.banner-board');
    await page.waitForSelector('.board-section');
    assert.ok((await titles()).length >= 1);
    await page.locator('.board-group-title', { hasText: /^Reports$/ }).click();
    await inspector.locator('.board-section-row').first().waitFor();
    await inspector.locator('.board-arrange').selectOption('');
    assert.equal(await labels.count(), 0);
    board = await saved2();
    assert.equal('arrange' in board.board.groups.find(x => x.id === 'g1'), false);
    await bar.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
  });

  await t.test('sections sit side by side, and what a growing frame lands on moves away', async () => {
    const d = await makeCollection(page, 'Packing', 30);
    const objs = d.ids.map((id, i) => ({ id: `d${i}`, kind: 'doc', doc_id: id, x: 20 + (i % 3) * 30, y: 60 + (i % 2) * 10, group: i < 20 ? 'g1' : 'g2' }));
    objs.slice(20).forEach((o, i) => { o.x = 40 + (i % 3) * 240; o.y = 460 + Math.floor(i / 3) * 130; });
    objs.push({ id: 'n1', kind: 'note', x: 900, y: 100, title: 'Loose', text: 'Loose' });
    const groups = [{ id: 'g1', x: 0, y: 0, w: 300, h: 300, title: 'Small' }, { id: 'g2', x: 0, y: 400, w: 800, h: 500, title: 'Below' }];
    await api(page, 'PUT', `/api/collections/${d.id}/board`, { revision: 0, board: { objects: objs, groups } });
    await openCollection(page, 'Packing');
    await page.click('.banner-board');
    await page.waitForSelector('.board-group');
    await page.locator('.board-group-title', { hasText: 'Small' }).click();
    await inspector.locator('.board-arrange').selectOption('date');
    await saved(page);
    const b = (await api(page, 'GET', `/api/collections/${d.id}/board`)).body.board;
    const [g1, g2] = ['g1', 'g2'].map(id => b.groups.find(g => g.id === id));
    const apart = (p, q) => p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
    assert.ok(apart(g1, g2), 'the frames don\'t overlap');
    const note = b.objects.find(o => o.id === 'n1');
    assert.ok(apart(g1, { x: note.x, y: note.y, w: 220, h: 90 }), 'nor does the loose note');
    assert.ok(apart(g2, { x: note.x, y: note.y, w: 220, h: 90 }));
    // The group below took its cards with it.
    const before = objs.filter(o => o.group === 'g2').map(o => [o.x - 0, o.y - 400]);
    const after = b.objects.filter(o => o.group === 'g2').map(o => [o.x - g2.x, o.y - g2.y]);
    assert.deepEqual(after, before);
    // In the frame, sections and their cards don't overlap, and short ones share a row.
    const onPage = await page.evaluate(() => {
      const box = e => e.getBoundingClientRect();
      const ls = [...document.querySelectorAll('.board-section')].map(box);
      const cs = [...document.querySelectorAll('.board-card')].map(box);
      return {
        rows: new Set(ls.map(l => Math.round(l.top))).size,
        labels: ls.length,
        hits: ls.reduce((n, l) => n + cs.filter(c => c.left < l.right && c.right > l.left && c.top < l.bottom && c.bottom > l.top).length, 0),
        labelHits: ls.reduce((n, l, i) => n + ls.filter((m, j) => j !== i && l.left < m.right && l.right > m.left && l.top < m.bottom && l.bottom > m.top).length, 0),
      };
    });
    assert.equal(onPage.hits, 0);
    assert.equal(onPage.labelHits, 0);
    // Each section has a box round exactly its own cards, and boxes don't touch.
    for (const section of g1.sections) {
      const box = { x: g1.x + section.x, y: g1.y + section.y, w: section.w, h: section.h };
      const mine = new Set(section.members);
      for (const o of b.objects.filter(c => c.group === 'g1')) {
        const inside = o.x >= box.x && o.y >= box.y && o.x + 220 <= box.x + box.w && o.y < box.y + box.h;
        assert.equal(inside, mine.has(o.id), `${o.id} in ${section.title}`);
      }
      assert.ok(box.x + box.w <= g1.x + g1.w && box.y + box.h <= g1.y + g1.h, 'inside the frame');
    }
    assert.equal(await page.locator('.board-section-box').count(), g1.sections.length);
    assert.equal(await page.locator('.board-section-box').first().evaluate(e => getComputedStyle(e).pointerEvents), 'none', 'the canvas still works through it');
    for (let i = 0; i < g1.sections.length; i++) {
      for (let j = i + 1; j < g1.sections.length; j++) {
        assert.ok(apart(g1.sections[i], g1.sections[j]), 'boxes apart');
      }
    }
    assert.ok(onPage.rows < onPage.labels, `${onPage.labels} sections on ${onPage.rows} rows`);
    assert.ok(b.objects.filter(o => o.group === 'g1').every(o => o.x >= g1.x && o.y >= g1.y && o.x + 220 <= g1.x + g1.w && o.y < g1.y + g1.h));
    const cardRects = b.objects.filter(o => o.group === 'g1').map(o => `${o.x},${o.y}`);
    assert.equal(new Set(cardRects).size, cardRects.length, 'no two cards on one spot');
    // Undo puts everything back.
    await page.locator('.board-canvas').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Control+z');
    await saved(page);
    const undone = (await api(page, 'GET', `/api/collections/${d.id}/board`)).body.board;
    assert.equal(undone.groups.find(g => g.id === 'g2').y, 400);
    await bar.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
  });

  await t.test('a document\'s text can show by default', async () => {
    const d = await makeCollection(page, 'Text default', 6);
    await api(page, 'PUT', `/api/collections/${d.id}/board`, { revision: 0, board: { objects: d.ids.map((id, i) => ({ id: `d${i}`, kind: 'doc', doc_id: id, x: i * 240, y: 0 })) } });
    await openCollection(page, 'Text default');
    await page.click('.banner-board');
    await page.waitForSelector('.board-card');
    const text = inspector.locator('.board-text');
    const box = inspector.getByLabel('Show by default');
    const requests = [];
    const watch = r => { if (r.url().includes('/api/document')) requests.push(r.url()); };
    page.on('request', watch);
    await cards.nth(0).click();
    assert.equal(await text.isVisible(), false, 'off to begin with');
    assert.equal(requests.length, 0, 'and nothing fetched');
    await box.check();
    await inspector.locator('.board-text:not(:has-text("Loading"))').waitFor();
    assert.ok(await text.isVisible(), 'shows now');
    assert.equal(await inspector.getByRole('button', { name: 'Hide text' }).count(), 1);
    await cards.nth(1).click();
    await inspector.getByRole('button', { name: 'Hide text' }).waitFor();
    assert.ok(await text.isVisible(), 'and on the next document');
    assert.equal(requests.length, 2);
    await inspector.getByRole('button', { name: 'Hide text' }).click();
    assert.equal(await text.isVisible(), false, 'it can still be hidden');
    // Remembered after reloading.
    page.off('request', watch);
    await bar.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
    await page.click('.banner-board');
    await page.waitForSelector('.board-card');
    await cards.nth(2).click();
    await inspector.getByRole('button', { name: 'Hide text' }).waitFor();
    await inspector.getByLabel('Show by default').uncheck();
    await cards.nth(3).click();
    assert.equal(await inspector.locator('.board-text').isVisible(), false, 'off again');
    await bar.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
  });

  await t.test('the Suggest button leaves the slow comparison for Find similar documents', async () => {
    const d = await makeCollection(page, 'Two steps', 30);
    const objs = d.ids.map((id, i) => ({ id: `d${i}`, kind: 'doc', doc_id: id, x: (i % 6) * 240, y: Math.floor(i / 6) * 130 }));
    await api(page, 'PUT', `/api/collections/${d.id}/board`, { revision: 0, board: { objects: objs } });
    await openCollection(page, 'Two steps');
    await page.click('.banner-board');
    await page.waitForSelector('.board-card');
    const asked = [];
    const watch = r => { if (/\/board\/suggestions(\?|$)/.test(r.url())) asked.push(new URL(r.url()).search); };
    page.on('request', watch);
    await bar.getByRole('button', { name: 'Suggest' }).click();
    const find = inspector.getByRole('button', { name: 'Find similar documents' });
    await find.waitFor();
    assert.deepEqual(asked, [''], 'plain Suggest');
    assert.equal(await inspector.locator('.board-suggest-kind', { hasText: 'similar text' }).count(), 0);
    await find.click();
    await page.waitForFunction(() => document.querySelector('.board-suggest-title')?.textContent.startsWith('Connections') || document.querySelectorAll('.board-suggest-title').length > 0);
    await inspector.locator('.board-suggest-kind', { hasText: 'similar text' }).first().waitFor();
    assert.deepEqual(asked, ['', '?similar=1']);
    assert.equal(await inspector.getByRole('button', { name: 'Find similar documents' }).count(), 0, 'it has been done');
    page.off('request', watch);
    await bar.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
  });

  await t.test('Suggest can apply its groups already arranged in sections', async () => {
    const d = await makeCollection(page, 'From suggest', 30);
    const objs = d.ids.map((id, i) => ({ id: `d${i}`, kind: 'doc', doc_id: id, x: (i % 6) * 240, y: Math.floor(i / 6) * 130 }));
    await api(page, 'PUT', `/api/collections/${d.id}/board`, { revision: 0, board: { objects: objs } });
    await openCollection(page, 'From suggest');
    await page.click('.banner-board');
    await page.waitForSelector('.board-card');
    const run = async by => {
      await bar.getByRole('button', { name: 'Suggest' }).click();
      await page.waitForSelector('.board-suggest-tabs');
      await page.locator('.board-suggest-tabs button', { hasText: 'File type' }).click();
      const choice = inspector.locator('.board-arrange');
      assert.equal(await choice.inputValue(), '', 'off unless chosen');
      if (by) await choice.selectOption(by);
      await page.locator('.board-suggest-tabs button', { hasText: 'Topic' }).click();
      assert.equal(await inspector.locator('.board-arrange').inputValue(), by, 'kept on changing tab');
      await page.locator('.board-suggest-tabs button', { hasText: 'File type' }).click();
      await inspector.getByRole('button', { name: /^Apply/ }).click();
      await saved(page);
      return (await api(page, 'GET', `/api/collections/${d.id}/board`)).body.board;
    };
    const b = await run('date');
    assert.ok(b.groups.length >= 2);
    const apart = (p, q) => p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
    b.groups.forEach((g, i) => {
      assert.equal(g.arrange, 'date');
      assert.ok(g.sections.length >= 1);
      const members = b.objects.filter(o => o.group === g.id);
      assert.deepEqual(g.sections.flatMap(x => x.members).sort(), members.map(o => o.id).sort());
      for (const section of g.sections) {
        for (const id of section.members) {
          const o = members.find(m => m.id === id);
          assert.ok(o.x >= g.x + section.x && o.x + 220 <= g.x + section.x + section.w && o.y >= g.y + section.y && o.y < g.y + section.y + section.h, 'in its box');
        }
      }
      b.groups.slice(i + 1).forEach(q => assert.ok(apart(g, q), 'frames apart'));
    });
    assert.ok(await page.locator('.board-section-box').count() >= b.groups.length);
    // Undo takes it all back in one step, and without a choice there are no sections.
    await page.locator('.board-canvas').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('.board-group').count(), 0);
    await saved(page);
    const plain = await run('');
    assert.ok(plain.groups.length >= 2);
    assert.ok(plain.groups.every(g => !g.arrange && !g.sections));
    await bar.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('.board', { state: 'detached' });
  });

  await t.test('no errors in the page', () => assert.deepEqual(page.errors, []));
});
