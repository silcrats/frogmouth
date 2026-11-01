const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../support/harness');
const { launch, signedInPage, makeCollection, openCollection, openTimeline } = require('../support/browser');

// Whether the diamond sits on the chart period holding the focused card's date.
const diamondIsRight = page => page.evaluate(() => {
  const d = document.querySelector('.timeline-diamond').getBoundingClientRect();
  const [x, y] = [d.left + d.width / 2, d.top + d.height / 2];
  const focused = document.querySelector('.result.focused');
  const period = [...document.querySelectorAll('[data-index]')].find(e => {
    const b = e.getBoundingClientRect();
    return x >= b.left - 1 && x <= b.right + 1 && (e.className.includes('bar') || (y >= b.top - 1 && y <= b.bottom + 1));
  });
  return Boolean(period) && period.dataset.start <= focused.dataset.day && focused.dataset.day < period.dataset.end;
});

test('the timeline', async t => {
  const app = await startApp();
  const browser = await launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await signedInPage(browser, app, 'alice', { height: 1100 });
  await makeCollection(page, 'Tl');
  await openTimeline(page, 'Tl');
  const results = page.locator('#results');
  const line = page.locator('.timeline-focus');
  const left = () => results.evaluate(e => e.scrollLeft);
  const scrollY = () => page.evaluate(() => window.scrollY);
  const title = () => page.locator('.result.focused').evaluate(e => e.dataset.title);
  const setRows = async n => { await page.locator('#pageSizeSelect').selectOption(String(n)); await page.waitForTimeout(350); };
  const cell = i => page.evaluate(n => {
    const c = [...document.querySelectorAll('.timeline-squares [data-index]')].filter(e => !e.className.includes('shade-0'));
    const r = c[n].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, start: c[n].dataset.start, end: c[n].dataset.end, count: c.length };
  }, i);
  const diamond = async () => {
    const b = await page.locator('.timeline-diamond').boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const dragDiamond = async (target, steps = 6) => {
    const p = await diamond();
    await page.mouse.move(p.x, p.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(target.x, target.y, { steps });
    await page.waitForTimeout(120);
  };

  await t.test('the chart is a calendar heatmap, with its hints tucked away', async () => {
    assert.equal(await page.locator('[data-shape=squares]').textContent(), 'Calendar Heatmap');
    assert.equal(await page.locator('.timeline-hint:visible').count(), 0);
    assert.ok(await page.locator('.timeline-legend').isVisible());
    await page.click('.timeline-hints-btn');
    const shown = await page.locator('.timeline-hint:visible').allTextContents();
    assert.match(shown.join(' '), /Click a square/);
    assert.match(shown.join(' '), /UTC/);
    await page.click('[data-shape=bars]');
    await page.waitForTimeout(150);
    assert.match(await page.locator('.timeline-hint:visible').first().textContent(), /Tallest bar/);
    await page.click('[data-shape=squares]');
    await page.click('.timeline-hints-btn');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.timeline-hint:visible').count(), 0);
  });

  await t.test('the diamond tracks the focused card, on squares and bars', async () => {
    assert.equal(await page.locator('.result.focused').count(), 1);
    assert.match(await line.textContent(), /UTC$/);
    assert.ok(await diamondIsRight(page));
    await setRows(25);
    await page.mouse.move(700, 900);
    const before = await line.textContent();
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(350);
    assert.notEqual(await line.textContent(), before, 'focus follows the scroll');
    assert.ok(await page.locator('.timeline').evaluate(e => Math.abs(e.getBoundingClientRect().top) < 5), 'the chart stays in view');
    assert.ok(await diamondIsRight(page));
    await page.click('[data-shape=bars]');
    await page.waitForTimeout(200);
    assert.ok(await diamondIsRight(page), 'on bars');
    await page.click('[data-shape=squares]');
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(200);
  });

  await t.test('horizontal is one row, moved by arrows, with the page buttons above it', async () => {
    await setRows(50);
    await page.click('[data-cards=horizontal]');
    await page.waitForTimeout(200);
    const shape = await page.evaluate(() => ({
      rows: new Set([...document.querySelectorAll('.result')].map(c => Math.round(c.getBoundingClientRect().top))).size,
      scrolls: results.scrollWidth > results.clientWidth,
      page: document.documentElement.scrollWidth <= innerWidth,
      pager: document.getElementById('pager').getBoundingClientRect().bottom <= results.getBoundingClientRect().top + 1,
    }));
    assert.deepEqual(shape, { rows: 1, scrolls: true, page: true, pager: true });
    assert.match(await page.locator('#nextBtn').textContent(), /Next page/);
    await results.evaluate(e => { e.scrollLeft = 0; });
    await page.waitForTimeout(200);
    const first = await title();
    assert.equal(await page.locator('#cardPrev').isDisabled(), true);
    await page.click('#cardNext');
    await page.waitForTimeout(700);
    assert.notEqual(await title(), first);
    assert.ok(await diamondIsRight(page));
    await page.click('#cardPrev');
    await page.waitForTimeout(700);
    assert.equal(await title(), first);
    await results.evaluate(e => { e.scrollLeft = e.scrollWidth; });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#cardNext').isDisabled(), true);
    assert.match(await line.textContent(), /no date/, 'the undated card comes last and says so');
    assert.equal(await page.locator('.timeline-diamond').count(), 0);
    await results.evaluate(e => { e.scrollLeft = 0; });
    await page.waitForTimeout(200);
  });

  await t.test('the wheel scrolls the page, not the row', async () => {
    const b = await results.boundingBox();
    await page.setViewportSize({ width: 1440, height: Math.round(b.y + 90) });
    await page.waitForTimeout(150);
    await page.mouse.move(b.x + b.width / 2, b.y + 40);
    const y0 = await scrollY();
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(150);
    assert.equal(await left(), 0);
    assert.ok(await scrollY() > y0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.waitForTimeout(150);
  });

  await t.test('the middle button grabs the row, faster goes further, and it coasts', async () => {
    const b = await results.boundingBox();
    const [mx, my] = [b.x + b.width / 2, b.y + 40];
    const drag = async (steps, gap) => {
      await results.evaluate(e => { e.scrollLeft = 1000; });
      await page.waitForTimeout(100);
      const start = await left();
      await page.mouse.move(mx + 300, my);
      await page.mouse.down({ button: 'middle' });
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(mx + 300 - (300 * i) / steps, my);
        if (gap) await page.waitForTimeout(gap);
      }
      assert.equal(await page.locator('#results.grabbing').count(), 1);
      return (await left()) - start;
    };
    const slow = await drag(15, 40);
    await page.waitForTimeout(250);
    await page.mouse.up({ button: 'middle' });
    await page.waitForTimeout(120);
    const rest = await left();
    await page.waitForTimeout(600);
    assert.equal(await left(), rest, 'a pause before letting go means no coast');
    const fast = await drag(5, 4);
    await page.mouse.up({ button: 'middle' });
    const released = await left();
    await page.waitForTimeout(2600);
    assert.ok(fast > slow * 1.3, `faster goes further: ${fast} vs ${slow}`);
    assert.ok(await left() > released, 'it coasts');
    assert.ok((await left()) - released < 2400, 'within reason');
    const settled = await left();
    await page.waitForTimeout(250);
    assert.equal(await left(), settled, 'and stops');
    await results.evaluate(e => { e.scrollLeft = 0; });
    await page.waitForTimeout(200);
  });

  await t.test('clicking a neighbour moves to it, and its buttons don\'t', async () => {
    await results.evaluate(e => { e.scrollLeft = 1500; });
    await page.waitForTimeout(250);
    const side = await page.evaluate(() => {
      const next = document.querySelector('.result.focused').nextElementSibling;
      const r = next.getBoundingClientRect();
      const box = document.getElementById('results').getBoundingClientRect();
      const meta = next.querySelector('.result-snippet').getBoundingClientRect();
      return { x: Math.min(r.left + 20, box.right - 70), y: meta.top + meta.height / 2, want: next.dataset.title };
    });
    await page.mouse.click(side.x, side.y);
    await page.waitForTimeout(700);
    assert.equal(await title(), side.want);
    const held = await title();
    await page.evaluate(() => document.querySelector('.result.focused').nextElementSibling.querySelector('.expand-btn').click());
    await page.waitForTimeout(400);
    assert.equal(await title(), held, 'expanding doesn\'t move');
    await page.evaluate(() => document.querySelector('.result.open .expand-btn').click());
    await results.evaluate(e => { e.scrollLeft = 0; });
    await page.waitForTimeout(200);
  });

  const requests = [];
  page.on('request', r => { if (r.url().includes('/api/document')) requests.push(r.url()); });

  await t.test('Expand cards opens all, loading text only as it comes near', async () => {
    await page.click('.timeline-expand');
    await page.waitForTimeout(500);
    const total = await page.locator('.result').count();
    assert.equal(await page.locator('.result.open').count(), total);
    assert.ok(requests.length > 0 && requests.length < total, `${requests.length} of ${total}`);
  });

  await t.test('moving between expanded cards leaves the page where it is', async () => {
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.waitForTimeout(150);
    const top = await results.evaluate(e => e.getBoundingClientRect().top + window.scrollY);
    await page.evaluate(y => scrollTo(0, y), top + 120);
    await page.waitForTimeout(150);
    const y = await scrollY();
    for (const move of [
      () => page.evaluate(() => document.getElementById('cardNext').click()),
      () => page.evaluate(() => document.getElementById('cardPrev').click()),
      () => page.evaluate(() => document.querySelector('.result.focused').nextElementSibling.querySelector('.result-detail').click()),
    ]) {
      const before = await title();
      await move();
      await page.waitForTimeout(750);
      assert.equal(await scrollY(), y);
      assert.notEqual(await title(), before);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.click('.timeline-expand');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.result.open').count(), 0);
    await results.evaluate(e => { e.scrollLeft = 0; });
    await page.waitForTimeout(200);
  });

  await t.test('the diamond drags: cards follow on this page, another opens on letting go', async () => {
    await setRows(10);
    await page.waitForSelector('.result.focused');
    await page.waitForTimeout(200);
    let loads = 0;
    const counter = r => { if (r.url().includes('/timeline')) loads++; };
    page.on('request', counter);
    const away = await cell(6);
    const p = await diamond();
    assert.ok(Math.hypot(away.x - p.x, away.y - p.y) > 18);
    const was = await title();
    await page.mouse.move(away.x, away.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.up({ button: 'middle' });
    assert.equal(await title(), was, 'a press away from it does nothing');
    const near = await cell(3);
    await dragDiamond(near);
    assert.notEqual(await title(), was, 'cards follow during the drag');
    const day = await page.locator('.result.focused').evaluate(e => e.dataset.day);
    assert.ok(day >= near.start && day < near.end);
    await page.mouse.up({ button: 'middle' });
    await page.waitForTimeout(150);
    assert.equal(loads, 0, 'nothing reloaded');
    const far = await cell((await cell(0)).count - 1);
    await dragDiamond(far, 8);
    assert.match(await line.textContent(), /Let go to open page 3/);
    await page.mouse.up({ button: 'middle' });
    await page.waitForFunction(() => currentStart > 0);
    await page.waitForTimeout(250);
    const landed = await page.locator('.result.focused').evaluate(e => e.dataset.day);
    assert.ok(landed >= far.start && landed < far.end, 'lands on that date');
    assert.equal(await page.locator('#pagerInfo').textContent(), 'Page 3 of 3');
    page.off('request', counter);
  });

  await t.test('in vertical too, even as the page scrolls under it', async () => {
    await page.click('[data-cards=vertical]');
    await page.waitForTimeout(200);
    const first = await cell(0);
    await dragDiamond(first, 8);
    await page.mouse.up({ button: 'middle' });
    await page.waitForFunction(() => currentStart === 0);
    await page.waitForTimeout(200);
    const target = await cell(3);
    await dragDiamond(target, 5);
    const day = await page.locator('.result.focused').evaluate(e => e.dataset.day);
    await page.mouse.up({ button: 'middle' });
    assert.ok(day >= target.start && day < target.end, `${day} in ${target.start}..${target.end}`);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(200);
  });

  await t.test('a left click still zooms, and other views are put back', async () => {
    const z = await cell(1);
    await page.mouse.click(z.x, z.y);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.timeline-reset').count(), 1);
    assert.ok(await diamondIsRight(page));
    await page.click('.timeline-reset');
    await page.waitForTimeout(300);
    await page.click('[data-cards=horizontal]');
    await page.waitForTimeout(150);
    await page.click('[data-view=items]');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#results.cards-horizontal').count(), 0);
    assert.equal(await page.locator('.result.focused').count(), 0);
    assert.equal(await page.locator('#cardNext').isVisible(), false);
    assert.ok(await page.evaluate(() => {
      const [p, r] = [document.getElementById('pager'), document.getElementById('results')];
      return Boolean(r.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), 'page buttons below again');
  });

  await t.test('choices are remembered', async () => {
    await page.reload();
    await page.waitForFunction(() => typeof openBoard === 'function');
    await openTimeline(page, 'Tl');
    assert.equal(await page.locator('#results.cards-horizontal').count(), 1);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'fits a phone');
  });

  await t.test('no errors in the page', () => assert.deepEqual(page.errors, []));
});
