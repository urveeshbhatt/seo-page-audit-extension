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
import { collectSiteUrls, scanPages, checkLinks } from '../../modules/phase5-site.js';
import { evaluateSite, linksToCheck } from '../../modules/phase5-rules.js';
import { toMarkdown, toCsv } from '../../modules/report.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const CTX = { pageType: 'product', status: 'live', model: 'd2c', ymyl: false };
const byId = (result) => Object.fromEntries(result.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));

let srv;
let browser;

before(async () => {
  srv = await startServer();
  // Chrome ships PerformanceResourceTiming.contentType (what the server really
  // sent: WebP for a ".png" URL on Shopify); Playwright's Chromium build has it off.
  browser = await chromium.launch({ args: ['--enable-blink-features=ResourceTimingContentType'] });
});
after(async () => {
  await browser?.close();
  await srv?.close();
});

async function open(path, { settle = 2000, phone = false } = {}) {
  // phone: the PageSpeed Insights mobile screen (412 px wide), at DPR 2
  const page = await browser.newPage(phone ? { viewport: { width: 412, height: 823 }, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } });
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

// ---------------- Phase 4 gaps: image size causes, format, unused fonts and preloads ----------------

test('images and fonts page (phone, DPR 2): why an image is too big or too small, format, unused font and preloads', async () => {
  const { page, errors } = await open('/perf-images-fonts.html', { phone: true });
  const d = await page.evaluate(collectPerformance);
  await page.close();
  assert.deepEqual(errors, []);
  const img = (re) => d.images.find((i) => re.test(i.src));

  // the card: real file width, the slot sizes claims, and the srcset widths
  const card = img(/w=832/);
  assert.ok(card, 'card collected');
  assert.equal(card.shown, 200);
  assert.equal(card.slot, 412, 'sizes resolves to 100vw on a 412 px screen');
  assert.equal(card.file, 1000, 'true file width, not the density-corrected naturalWidth');
  assert.deepEqual(card.widths, [240, 352, 832, 1200]);
  // the slide: srcset has only a 300 px file, sizes says 25vw
  const slide = img(/small\.png\?w=300/);
  assert.equal(slide.shown, 360);
  assert.equal(slide.slot, 103);
  assert.equal(slide.file, 300);
  // the photo is delivered as PNG
  assert.equal(img(/photo-noise/).type, 'image/png');
  // srcset written without spaces after the commas (Groom Shop, Shopify Dawn) is still read
  const tight = img(/t=600/);
  assert.deepEqual(tight.widths, [200, 600]);
  assert.equal(tight.slot, 150);
  // nothing was hidden on this page
  assert.equal(d.imageScan.hidden, 0);
  assert.equal(d.imageScan.pageHidden, '');

  // fonts: the unused face's file was downloaded (preload) but no text uses it
  const unused = d.fonts.faces.find((f) => f.family === 'Unused Face');
  const used = d.fonts.faces.find((f) => f.family === 'Used Face');
  assert.equal(unused.status, 'unloaded');
  assert.equal(used.status, 'loaded');
  assert.ok(unused.urls.some((u) => /pal-test\.ttf\?unused$/.test(u)));
  // preloads with their use
  const pre = Object.fromEntries(d.preloads.map((p) => [p.url.replace(/^.*\//, ''), p]));
  assert.equal(pre['hero.png?lcp'].used, true);
  assert.equal(pre['small.png?preloaded-but-unused'].used, false);
  assert.equal(pre['slow.css?preloaded-but-unused'].used, false);
  assert.equal(pre['slow.css?shadow'].used, true, 'a stylesheet linked inside a shadow root is used');

  const f = byId(evaluatePerformance(d, CTX));
  // too big, with both causes named
  assert.ok(f['perf-img-big'], 'card flagged as too big');
  const bigLine = f['perf-img-big'].items.find((x) => /shown at 200 px/.test(x));
  assert.match(bigLine, /1000 px file/);
  assert.match(bigLine, /sizes says 412 px/);
  assert.match(bigLine, /no file between 352 and 832/);
  // too small (blurry), with the sizes cause
  assert.ok(f['perf-img-blurry'], 'slide flagged as too small');
  assert.match(f['perf-img-blurry'].items[0], /sizes says 103 px/);
  // format
  assert.ok(f['perf-img-format'].items.some((x) => /photo-noise\.png · PNG/.test(x)));
  assert.ok(!f['perf-img-format'].items.some((x) => /hero\.png/.test(x)), 'small PNGs are not worth flagging');
  // unused font file, said once, and unused preloads (font preload not repeated there)
  assert.match(f['perf-font-unused'].value, /Unused Face/);
  assert.doesNotMatch(f['perf-font-unused'].value, /Shared Face/, 'the file also serves the bold weight that is drawn');
  assert.equal(f['perf-img-hidden'], undefined);
  assert.match(f['perf-font-unused'].items.join(' '), /preloaded/);
  assert.equal(f['perf-preload-unused'].items.length, 2);
  assert.ok(!f['perf-preload-unused'].items.some((x) => /pal-test/.test(x)));
});

test('a page hidden behind a pop-up: the images are counted as hidden and the report says so', async () => {
  const { page } = await open('/perf-images-fonts.html', { phone: true });
  await page.evaluate(() => { document.body.style.transition = 'none'; document.body.style.opacity = '0'; });
  const d = await page.evaluate(collectPerformance);
  await page.close();
  assert.equal(d.images.length, 0);
  assert.ok(d.imageScan.hidden >= 5, JSON.stringify(d.imageScan));
  assert.match(d.imageScan.pageHidden, /BODY.*opacity 0/);
  const f = byId(evaluatePerformance(d, CTX));
  assert.ok(f['perf-img-hidden'], 'reported');
});

// ---------------- Phase 5: site scan on a small local site ----------------

test('site scan: sitemap via robots.txt and an index, then every planted site-level problem', async () => {
  const { page, errors } = await open('/site/index.html', { settle: 300 });
  const d = await page.evaluate(collectSiteUrls, 50);
  // robots.txt lists /sitemap.xml (missing) and /site/sitemap-index.xml (works)
  assert.equal(d.source, 'sitemap');
  assert.equal(d.robotsSitemaps, 2);
  assert.ok(d.sitemaps.some((m) => /\/sitemap\.xml$/.test(m.url) && m.status === 404));
  assert.ok(d.sitemaps.some((m) => m.kind === 'sitemapindex'));
  assert.equal(d.totalListed, 13);
  assert.equal(d.offSite, 1);
  assert.equal(d.urls.length, 12);
  assert.ok(!d.urls.some((u) => /hero\.png/.test(u)), 'image:loc is not a page');

  // scan in batches, like the side panel does
  d.pages = [];
  for (let i = 0; i < d.urls.length; i += 5) d.pages.push(...await page.evaluate(scanPages, d.urls.slice(i, i + 5)));
  d.linkChecks = await page.evaluate(checkLinks, linksToCheck(d, 50));
  await page.close();
  assert.deepEqual(errors, []);

  const ghee = d.pages.find((p) => /\/ghee\.html$/.test(p.url));
  assert.equal(ghee.status, 200);
  assert.equal(ghee.title, 'A2 Bilona Ghee – Test Organics');
  assert.ok(ghee.words > 150, `main content words: ${ghee.words}`);
  assert.ok(ghee.links.some((l) => /missing-page\.html$/.test(l)));
  const moved = d.pages.find((p) => /old-ghee/.test(p.url));
  assert.equal(moved.redirected, true);
  assert.match(moved.finalUrl, /\/site\/ghee\.html$/);
  assert.ok(d.linkChecks.some((c) => /missing-page/.test(c.url) && c.status === 404));

  const f = byId(evaluateSite(d, CTX));
  const has = (id, re) => assert.ok(f[id] && f[id].items.some((x) => re.test(x)), `${id}: ${f[id] && JSON.stringify(f[id].items)}`);
  has('site-sitemap-broken', /\/sitemap\.xml · 404/);
  assert.equal(f['site-offsite'].flag, 'warning');
  has('site-status-error', /404 · \/site\/gone\.html/);
  has('site-redirected', /\/site\/old-ghee\.html → \/site\/ghee\.html/);
  has('site-noindex', /\/site\/hidden\.html/);
  has('site-canonical-other', /\/site\/shipping\.html → \/site\/index\.html/);
  has('site-title-dup', /× 2: \/site\/ghee\.html, \/site\/ghee-copy\.html/);
  has('site-desc-dup', /ghee-copy/);
  assert.deepEqual(f['site-desc-missing'].items.map((x) => x.split(' · ')[0]).sort(), ['/site/demo.html', '/site/honey.html']);
  has('site-h1-missing', /\/site\/contact\.html/);
  has('site-h1-multi', /About us \| Our farms/);
  assert.deepEqual(f['site-thin'].items.map((x) => x.split(' · ')[1]).sort(), ['/site/demo.html', '/site/honey.html']);
  has('site-broken-links', /404 · \/site\/missing-page\.html ← \/site\/ghee\.html/);
  assert.deepEqual(f['site-orphans'].items.sort(), ['/site/demo.html', '/site/orphan.html']);
});

test('site scan: a link that redirects to another site (login) is a redirect, not a broken link', async () => {
  const { page } = await open('/site/index.html', { settle: 300 });
  const login = `${srv.site}/site/login`;
  const [check] = await page.evaluate(checkLinks, [login]);
  const [scanned] = await page.evaluate(scanPages, [login]);
  await page.close();
  assert.equal(check.error, '', JSON.stringify(check));
  assert.equal(check.redirected, true);
  assert.equal(check.offsite, true);
  assert.equal(scanned.error, '', JSON.stringify(scanned));
  assert.equal(scanned.offsite, true);
});

test('site scan: a URL that never answers times out instead of stopping the scan', async () => {
  const { page } = await open('/site/index.html', { settle: 300 });
  const hang = `${srv.site}/site/hang`;
  const call = (fn, ms) => page.evaluate(`(${fn})(${JSON.stringify([hang])}, ${ms})`);
  const t0 = Date.now();
  const [check] = await call(checkLinks, 800);
  const [scanned] = await call(scanPages, 800);
  await page.close();
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  assert.match(check.error, /timed out/);
  assert.match(scanned.error, /timed out/);
});

test('site scan without a sitemap falls back to the links on the page', async () => {
  const { page } = await open('/perf-good.html', { settle: 300 });
  // a page whose robots.txt sitemaps all fail is simulated by scanning another origin's links: here
  // the fixture site has a working sitemap, so check the fallback through a stubbed fetch instead
  const d = await page.evaluate(async (fn) => {
    const real = window.fetch;
    window.fetch = (u, o) => (/robots\.txt|sitemap/.test(String(u)) ? Promise.resolve(new Response('', { status: 404 })) : real(u, o));
    try { return await (0, eval)(`(${fn})`)(20); } finally { window.fetch = real; }
  }, collectSiteUrls.toString());
  await page.close();
  assert.equal(d.source, 'links');
  assert.ok(d.urls.length >= 1);
  assert.ok(d.urls.every((u) => u.startsWith(srv.site)));
});
