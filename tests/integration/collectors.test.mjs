// Integration tests: run the real collectors inside real Chromium pages,
// then feed their output through the rules, summary and report, exactly as
// the side panel does. Needs Playwright + Chromium (npm run test:integration).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './server.mjs';
import { collectBasics, collectHead, collectBody, collectHealth, collectSignals } from '../../modules/phase1-elements.js';
import { evaluateHead } from '../../modules/phase1-rules.js';
import { evaluateBody } from '../../modules/phase1-body-rules.js';
import { evaluateHealth } from '../../modules/phase1-health-rules.js';
import { evaluateBusiness } from '../../modules/business-rules.js';
import { collectNetwork } from '../../modules/phase2-network.js';
import { evaluateNetwork } from '../../modules/phase2-rules.js';
import { collectRendering } from '../../modules/phase3-rendering.js';
import { evaluateRendering } from '../../modules/phase3-rules.js';
import { collectPerformance } from '../../modules/phase4-performance.js';
import { evaluatePerformance } from '../../modules/phase4-rules.js';
import { buildSummary } from '../../modules/summary.js';
import { toMarkdown, toCsv } from '../../modules/report.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const CTX = { pageType: 'product', status: 'live', model: 'd2c', ymyl: false };
const byId = (result) => Object.fromEntries(result.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));

let srv;
let browser;

before(async () => {
  srv = await startServer();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await srv?.close();
});

async function open(path, { settle = 2000 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${srv.site}${path}`, { waitUntil: 'load' });
  await page.waitForTimeout(settle);
  return { page, errors };
}

// ---------------- Performance collector ----------------

test('collectPerformance on a bad page: finds the planted problems', async () => {
  const { page } = await open('/perf-bad.html');
  const d = await page.evaluate(collectPerformance);
  await page.close();

  // shape: plain JSON, nothing that cannot cross the extension boundary
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  assert.equal(d.host, '127.0.0.1');
  assert.ok(d.nav.ttfb >= 0 && d.nav.fcp > 0, 'navigation and paint timings');

  // LCP: the lazy hero image
  assert.equal(d.lcp.tag, 'img');
  assert.match(d.lcp.selector, /img\.hero/);
  assert.equal(d.lcp.img.loading, 'lazy');
  assert.ok(d.lcp.resource && d.lcp.resource.responseEnd > 0);

  // render-blocking: slow CSS (site) and SDK (third party)
  const rb = d.renderBlocking.map((r) => r.url).join(' ');
  assert.match(rb, /slow\.css/);
  assert.match(rb, /localhost.*vendor\.js/);

  // animations: layout (left), paint (box-shadow), composited (transform)
  const anim = Object.fromEntries(d.animations.map((a) => [a.name, a]));
  assert.deepEqual(anim.sweep.props, ['left']);
  assert.equal(anim.sweep.infinite, true);
  assert.match(anim.sweep.target, /::after$/);
  assert.deepEqual(anim.glow.props, ['boxShadow']);
  assert.deepEqual(anim.spin.props, ['transform']);

  // layout shifts happened, with sources
  assert.ok(d.shifts.length > 0, 'layout shifts recorded');
  assert.ok(d.shifts.some((s) => s.sources.length > 0), 'shift sources recorded');

  // long animation frame from the 150 ms busy loop
  if (d.loafSupported) assert.ok(d.frames.some((f) => f.duration >= 140), 'long frame recorded');

  // images, fonts, duplicate scripts
  assert.ok(d.images.some((i) => /small\.png/.test(i.src) && !i.hasSize), 'unsized image');
  assert.ok(d.images.some((i) => /hero\.png/.test(i.src) && i.hasSize === false && i.lazy), 'hero is lazy and unsized');
  assert.ok(d.fonts.faces.some((f) => f.family === 'Fixture Sans' && f.display === 'auto'));
  assert.equal(d.scripts.filter((s) => /\/dup\.js$/.test(s)).length, 2);
  assert.ok(d.scripts.some((s) => /G-AAA111/.test(s)) && d.scripts.some((s) => /G-BBB222/.test(s)));
});

test('bad page end to end: rules flag the real causes and the report carries them', async () => {
  const { page } = await open('/perf-bad.html');
  const d = await page.evaluate(collectPerformance);
  await page.close();
  const r = evaluatePerformance(d, CTX);
  const f = byId(r);
  assert.equal(f['perf-anim-layout'].flag, 'critical');
  assert.equal(f['perf-lcp-lazy'].flag, 'critical');
  assert.equal(f['perf-render-blocking'].flag, 'warning');
  assert.equal(f['perf-dup-tags'].flag, 'warning');
  assert.equal(f['perf-font-display'].flag, 'warning');
  assert.equal(f['perf-anim-paint'].flag, 'info');
  assert.ok(f['perf-img-size']);

  const s = buildSummary({ head: { groups: [], counts: { critical: 0, warning: 0, good: 0, info: 0 } }, performance: r }, CTX);
  assert.ok(s.top.some((x) => x.key === 'performance:perf-anim-layout'));
  const md = toMarkdown(s, { title: 'Fixture audit', auditor: 'Test', url: `${srv.site}/perf-bad.html`, date: '2026-10-29' });
  assert.match(md, /Animations that move layout/);
  assert.match(toCsv(s), /perf-anim-layout|Animations that move layout/);
});

test('good page: no critical or warning performance findings', async () => {
  const { page } = await open('/perf-good.html');
  const d = await page.evaluate(collectPerformance);
  await page.close();
  const r = evaluatePerformance(d, CTX);
  const bad = r.groups.flatMap((g) => g.findings).filter((x) => x.flag === 'critical' || x.flag === 'warning');
  assert.deepEqual(bad.map((x) => `${x.id}: ${x.value}`), []);
  assert.equal(d.lcp.img.preloaded, true);
  assert.equal(d.lcp.img.fetchpriority, 'high');
  assert.ok(!d.animations.some((a) => a.props.includes('left')));
});

test('INP: a real slow click before the audit is measured with its phases', async () => {
  const { page } = await open('/perf-good.html', { settle: 500 });
  await page.evaluate(() => {
    document.querySelector('h1').addEventListener('click', () => { const t = performance.now(); while (performance.now() - t < 250) { /* slow handler */ } });
  });
  await page.click('h1');
  await page.waitForTimeout(500);
  const d = await page.evaluate(collectPerformance);
  await page.close();
  const f = byId(evaluatePerformance(d, CTX));
  assert.ok(d.events.length > 0, 'event timing entries recorded');
  assert.equal(f['perf-inp'].flag, 'warning');
  assert.match(f['perf-inp'].why, /processing/);
});

// ---------------- every collector, one pipeline ----------------

for (const path of ['/perf-bad.html', '/perf-good.html']) {
  test(`all collectors + rules + summary + report run on ${path}`, async () => {
    const { page, errors } = await open(path);
    const basics = await page.evaluate(collectBasics);
    const head = await page.evaluate(collectHead);
    const body = await page.evaluate(collectBody);
    const health = await page.evaluate(collectHealth);
    const signals = await page.evaluate(collectSignals);
    const rendering = await page.evaluate(collectRendering);
    const network = await page.evaluate(collectNetwork);
    const perf = await page.evaluate(collectPerformance);
    await page.close();

    assert.equal(basics.title.startsWith('Perf'), true);
    const results = {
      head: evaluateHead(head, CTX),
      body: evaluateBody(body, CTX, head),
      health: evaluateHealth(health, CTX),
      business: evaluateBusiness(signals, CTX),
      network: evaluateNetwork(network, CTX, { head, redirects: null }),
      rendering: evaluateRendering(rendering, CTX, { network }),
      performance: evaluatePerformance(perf, CTX),
    };
    Object.entries(results).forEach(([k, r]) => {
      assert.ok(Array.isArray(r.groups) && r.groups.length, `${k} has groups`);
      const n = r.groups.flatMap((g) => g.findings).length;
      assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), n, `${k} counts match findings`);
    });
    assert.equal(rendering.raw.ok, true, 'raw HTML fetched same-origin');
    const s = buildSummary(results, CTX);
    assert.equal(s.sections.length, 7);
    const md = toMarkdown(s, { title: 't', auditor: 'a', url: basics.url, date: '2026-10-29' });
    assert.ok(md.length > 500);
    assert.deepEqual(errors, []);
  });
}

// ---------------- false-positive traps (found on live sites, 29 Oct 2026) ----------------

test('trap page: zoom layer, closed menu, off-screen slide, inline icon font and WooCommerce data-src raise nothing', async () => {
  const { page } = await open('/perf-traps.html');
  const d = await page.evaluate(collectPerformance);
  await page.close();
  const img = (re) => d.images.find((i) => re.test(i.src));
  // closed menu (height 0, overflow hidden) and the off-screen slide are not "in the first screen"
  assert.ok(!img(/\?menu$/) || img(/\?menu$/).inViewport === false, 'menu image clipped');
  assert.equal(img(/\?slide$/) && img(/\?slide$/).inViewport, false, 'slide is off screen to the right');
  // zoom layer is invisible: not reported at all
  assert.equal(img(/\?zoom$/), undefined, 'opacity:0 zoom layer skipped');
  // the inline icon font is marked inline
  assert.ok(d.fonts.faces.some((f) => f.family === 'trap-icons' && f.inline === true));

  const f = byId(evaluatePerformance(d, CTX));
  ['perf-img-lazy', 'perf-img-size', 'perf-font-display', 'perf-lcp-discovery'].forEach((id) => assert.equal(f[id], undefined, `${id}: ${f[id] && f[id].value}`));
});

// ---------------- Shopify Horizon patterns (live store, 30 Oct 2026) ----------------

test('Shopify Horizon page: module scripts, transitions, ProductGroup, sticky price, pixels, menu drawer', async () => {
  const { page, errors } = await open('/shopify-horizon.html');
  assert.equal(await page.evaluate(() => window.__dialogModuleRuns), 1, 'browser runs the module once');
  const perf = await page.evaluate(collectPerformance);
  const head = await page.evaluate(collectHead);
  const body = await page.evaluate(collectBody);
  const health = await page.evaluate(collectHealth);
  const rendering = await page.evaluate(collectRendering);
  const network = await page.evaluate(collectNetwork);
  await page.close();
  assert.deepEqual(errors, []);

  // 1. a module script printed twice is loaded once: not a duplicate
  assert.equal(perf.scripts.filter((s) => /mod-dialog\.js/.test(s)).length, 1);
  // 2. the running border transition is recorded as a transition
  const tr = perf.animations.filter((a) => /border/i.test(a.props.join(' ')));
  assert.ok(tr.length > 0, 'transition seen');
  assert.ok(tr.every((a) => a.kind === 'transition'));
  const pf = byId(evaluatePerformance(perf, CTX));
  assert.equal(pf['perf-anim-layout'], undefined, pf['perf-anim-layout'] && pf['perf-anim-layout'].value);
  assert.equal(pf['perf-dup-tags'], undefined, pf['perf-dup-tags'] && pf['perf-dup-tags'].value);

  // 3. ProductGroup: brand from the group, price range from the variants
  assert.equal(head.jsonld.products[0].brand, 'Test Organics');
  assert.equal(byId(evaluateHead(head, CTX))['schema-brand'].flag, 'good');

  // 4. the price inside .sticky-content is page content (".sticky-" is not CookieYes "cky-")
  assert.ok(body.visiblePrices.includes('1799'), `visible prices: ${body.visiblePrices}`);
  const bf = byId(evaluateBody(body, CTX, head));
  assert.equal(bf['schema-price-match'].flag, 'good', bf['schema-price-match'].value);
  // 5. phone and WhatsApp links with two numbers are broken
  assert.equal(bf['links-badcontact'].flag, 'warning');
  assert.equal(bf['links-badcontact'].items.length, 2);

  // 6. tracking runs in Shopify pixels
  assert.deepEqual(health.shopifyPixels.map((p) => p.name), ['Judge.me', 'Custom pixel']);
  // 6b. an image gallery built from custom elements is not "content Google cannot read"
  assert.ok(!health.shadow.emptyCustom.some((x) => /slideshow/.test(x)), JSON.stringify(health.shadow.emptyCustom));
  const hf = byId(evaluateHealth(health, CTX));
  assert.notEqual(hf['stack-tracking'].flag, 'critical');

  // 7. the menu drawer is not a content panel; the buy button is seen
  assert.ok(!rendering.panels.some((p) => /Catalog|Bee Pollen/.test(p.text)), JSON.stringify(rendering.panels));
  assert.equal(rendering.facts.buyButton, true);
  const rf = byId(evaluateRendering(rendering, CTX, { network }));
  assert.equal(rf['rend-ai-stock'], undefined);
  // 8. data-url pointing to a Shopify API endpoint or to this same page is not a fake link
  assert.deepEqual(rendering.fakeLinks, []);
  assert.notEqual(rf['rend-panels'] && rf['rend-panels'].flag, 'warning');
});
