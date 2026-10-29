// "Try to break it" regression tests. Each test is a hostile or unusual page
// that broke (or could break) the extension. Runs the real extension end to
// end, plus collectors directly where timing matters.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { startExtension } from './harness.mjs';
import { collectPerformance } from '../../modules/phase4-performance.js';
import { collectBody } from '../../modules/phase1-elements.js';
import { evaluatePerformance } from '../../modules/phase4-rules.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

let h;
before(async () => { h = await startExtension(); });
after(async () => { await h?.stop(); });

// ---------------- found while breaking: extreme pages ----------------

test('40,000 elements and 13,000 running animations: Performance collector stays fast and still finds the layout animation', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${h.srv.site}/huge-dom.html`);
  await page.waitForTimeout(1500);
  const started = Date.now();
  const d = await page.evaluate(collectPerformance);
  const ms = Date.now() - started;
  await browser.close();
  assert.ok(ms < 4000, `collector took ${ms} ms (was 14 s: document.getAnimations() on 13k animations)`);
  assert.equal(d.animationScan, 'keyframes');
  assert.ok(d.animations.some((a) => a.name === 'mv' && a.props.includes('left')), 'layout keyframes still reported');
  const f = Object.fromEntries(evaluatePerformance(d, { pageType: 'product', status: 'live' }).groups.flatMap((g) => g.findings).map((x) => [x.id, x]));
  assert.ok(f['perf-anim-layout'], 'layout animation finding present');
  assert.match(f['perf-anim-layout'].why, /too many elements|CSS/i);
});

for (const [path, type] of [['/not-html.json', 'application/json'], ['/img/hero.png', 'image/png'], ['/missing-page.html', 'text/plain']]) {
  test(`non-HTML document (${type}) is refused with a clear message, not audited`, async () => {
    const { site, panel, problems } = await h.openPanelFor(path);
    const { status } = await h.audit(panel);
    assert.match(status, /not a web page/i);
    assert.match(status, new RegExp(type.replace('/', '\\/')));
    assert.equal(await panel.getAttribute('.tab[data-tab="summary"]', 'disabled'), '', 'no results shown');
    assert.deepEqual(problems, []);
    await site.close();
    await panel.close();
  });
}

// ---------------- hostile pages that must keep working ----------------

test('hostile markup: no script runs, no prototype pollution, exports stay escaped', async () => {
  const { site, panel, problems } = await h.openPanelFor('/hostile-markup.html');
  const { status } = await h.audit(panel);
  assert.match(status, /^Done/);
  assert.equal(await site.evaluate(() => window.__pwned), undefined, 'page text never ran as HTML in the page');
  assert.deepEqual(await panel.evaluate(() => [({}).polluted, ({}).polluted2, Object.prototype.polluted]), [undefined, undefined, undefined]);
  assert.equal(await panel.evaluate(() => document.querySelectorAll('img[src="x"], script:not([src])').length), 0, 'no injected elements in the panel');

  await panel.click('.tab[data-tab="report"]');
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.click('#rep-md')]);
  const md = await readFile(await download.path(), 'utf8');
  assert.doesNotMatch(md, /(^|[^\\])<img src=x/m, 'Markdown escapes page HTML (\\< is safe)');
  assert.doesNotMatch(md, /inline in h1/, 'script text inside <h1> is not heading text');
  const [csvDl] = await Promise.all([panel.waitForEvent('download'), panel.click('#rep-csv')]);
  const csv = await readFile(await csvDl.path(), 'utf8');
  assert.doesNotMatch(csv, /(^|,)"=HYPERLINK/m, 'CSV cells cannot start a formula');
  assert.deepEqual(problems, []);
  await site.close();
  await panel.close();
});

test('page that breaks fetch, JSON, Array, querySelectorAll, PerformanceObserver and timers: audit still completes', async () => {
  const { site, panel, problems } = await h.openPanelFor('/hostile-globals.html');
  const { status, ms } = await h.audit(panel);
  assert.match(status, /^Done/);
  assert.ok(ms < 30000);
  await panel.click('.tab[data-tab="performance"]');
  assert.match(await panel.textContent('#performance-groups'), /Largest Contentful Paint/);
  await panel.click('.tab[data-tab="rendering"]');
  assert.doesNotMatch(await panel.textContent('#rendering-groups'), /Could not fetch raw HTML/, 'isolated world fetch is not the page\'s broken fetch');
  assert.deepEqual(problems, []);
  await site.close();
  await panel.close();
});

test('strict CSP page (connect-src none): raw HTML is still read from the extension world', async () => {
  const { site, panel, problems } = await h.openPanelFor('/csp-strict.html');
  const { status } = await h.audit(panel);
  assert.match(status, /^Done/);
  await panel.click('.tab[data-tab="rendering"]');
  assert.doesNotMatch(await panel.textContent('#rendering-groups'), /Could not fetch raw HTML/);
  assert.deepEqual(problems, []);
  await site.close();
  await panel.close();
});

test('main thread busy 90% of the time: audit finishes and long frames are reported', async () => {
  const { site, panel, problems } = await h.openPanelFor('/busy.html', { settle: 2500 });
  const { status, ms } = await h.audit(panel);
  assert.match(status, /^Done/);
  assert.ok(ms < 30000, `audit took ${ms} ms`);
  await panel.click('.tab[data-tab="performance"]');
  const card = panel.locator('#performance-groups .finding', { hasText: 'Long frames' });
  assert.match(await card.getAttribute('class'), /finding-warning/);
  assert.deepEqual(problems, []);
  await site.close();
  await panel.close();
});

test('quirks-mode page without doctype is audited normally', async () => {
  const { site, panel, problems } = await h.openPanelFor('/quirks.html');
  assert.match((await h.audit(panel)).status, /^Done/);
  assert.deepEqual(problems, []);
  await site.close();
  await panel.close();
});

test('text of <script> inside a heading is not counted as heading text', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${h.srv.site}/hostile-markup.html`);
  const body = await page.evaluate(collectBody);
  await browser.close();
  const all = JSON.stringify(body);
  assert.doesNotMatch(all, /inline in h1/);
  assert.ok(body.headings.some((x) => x.level === 1 && x.text === 'Price ₹999'));
});


test('page navigates away in the middle of the audit: the user is told results may mix two pages', async () => {
  // ?delay makes the raw-HTML fetch slow, so the page leaves while collectors are still running
  const { site, panel, problems } = await h.openPanelFor('/navigates-away.html?delay=1500', { settle: 1800 });
  const { status } = await h.audit(panel);
  assert.match(status, /page changed during the audit/i);
  assert.match(status, /run the audit again/i);
  assert.deepEqual(problems, []);
  await site.close();
  await panel.close();
});
