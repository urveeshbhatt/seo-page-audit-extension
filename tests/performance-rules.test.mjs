import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePerformance, clsFromShifts, inpFromEvents, lcpSubparts, classifyProps,
  siteOf, vendorOf, findDuplicateTags, rating,
} from '../modules/phase4-rules.js';
import { buildSummary } from '../modules/summary.js';

const byId = (result) => Object.fromEntries(result.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));
const clone = (o) => JSON.parse(JSON.stringify(o));

const LIVE_PRODUCT = { pageType: 'product', status: 'live', model: 'd2c' };
const PRELAUNCH = { pageType: 'product', status: 'prelaunch', model: 'd2c' };
const BLOG = { pageType: 'blog', status: 'live', model: 'content' };

// A healthy page: every vital good, nothing blocking, no third parties.
function base() {
  return {
    url: 'https://shop.example.com/products/ghee',
    host: 'shop.example.com',
    collectedAt: '2026-10-29T10:00:00.000Z',
    visibility: 'visible',
    nav: { ttfb: 300, fcp: 900, dcl: 1100, load: 1800, type: 'navigate' },
    lcp: {
      time: 1400, tag: 'img', selector: 'img.wp-post-image', url: 'https://shop.example.com/ghee-600.jpg', size: 360000, text: '',
      resource: { startTime: 400, requestStart: 420, responseEnd: 1100 },
      img: { loading: 'eager', fetchpriority: 'high', hasWidth: true, hasHeight: true, dataSrc: false, preloaded: true },
    },
    shifts: [],
    events: [],
    frames: [],
    renderBlocking: [],
    animations: [],
    resources: [
      { host: 'shop.example.com', type: 'script', bytes: 40000, duration: 120 },
      { host: 'shop.example.com', type: 'link', bytes: 20000, duration: 90 },
    ],
    scripts: ['https://shop.example.com/app.js'],
    images: [],
    fonts: { files: [], preloaded: 0, faces: [] },
    errors: [],
  };
}

// ---------------- pure helpers ----------------

test('rating uses the web.dev thresholds (good / needs improvement / poor)', () => {
  assert.equal(rating('lcp', 2500), 'good');
  assert.equal(rating('lcp', 2501), 'ni');
  assert.equal(rating('lcp', 4001), 'poor');
  assert.equal(rating('cls', 0.1), 'good');
  assert.equal(rating('cls', 0.26), 'poor');
  assert.equal(rating('inp', 200), 'good');
  assert.equal(rating('inp', 201), 'ni');
  assert.equal(rating('inp', 501), 'poor');
  assert.equal(rating('fcp', 1800), 'good');
  assert.equal(rating('fcp', 3001), 'poor');
});

test('clsFromShifts: largest session window, input shifts ignored, 1 s gap and 5 s cap split windows', () => {
  assert.equal(clsFromShifts([]).value, 0);
  // two shifts close together = one window
  assert.equal(clsFromShifts([{ value: 0.05, time: 1000 }, { value: 0.04, time: 1500 }]).value, 0.09);
  // gap > 1 s starts a new window: largest window wins, not the sum
  assert.equal(clsFromShifts([{ value: 0.05, time: 1000 }, { value: 0.07, time: 2600 }]).value, 0.07);
  // shifts right after user input do not count
  assert.equal(clsFromShifts([{ value: 0.5, time: 1000, input: true }, { value: 0.02, time: 1100 }]).value, 0.02);
  // a window is capped at 5 s even with no gaps: 11 shifts 0.6 s apart
  const steady = Array.from({ length: 11 }, (_, i) => ({ value: 0.01, time: 1000 + i * 600 }));
  assert.equal(clsFromShifts(steady).value, 0.09); // 9 shifts fit in 5 s
  assert.equal(clsFromShifts(steady).count, 11);
  // bad input never throws
  assert.equal(clsFromShifts(undefined).value, 0);
  assert.equal(clsFromShifts([{ value: 'x', time: null }]).value, 0);
});

test('inpFromEvents: worst interaction by id, phases from processing times, high percentile above 50 interactions', () => {
  assert.equal(inpFromEvents([]), null);
  const one = inpFromEvents([
    { id: 7, name: 'pointerdown', duration: 40, start: 1000, processingStart: 1005, processingEnd: 1010 },
    { id: 7, name: 'click', duration: 184, start: 1000, processingStart: 1019, processingEnd: 1019 },
  ]);
  assert.equal(one.value, 184);
  assert.equal(one.count, 1);
  assert.equal(one.worst.name, 'click');
  assert.equal(one.worst.inputDelay, 19);
  assert.equal(one.worst.processing, 0);
  assert.equal(one.worst.presentation, 165);
  // 60 interactions: ignore the single worst outlier (1 per 50)
  const many = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, name: 'click', duration: i === 0 ? 900 : 100, start: i * 2000, processingStart: i * 2000 + 5, processingEnd: i * 2000 + 10 }));
  assert.equal(inpFromEvents(many).value, 100);
  // real Chrome tap: pointerdown, pointerup and click end on the same paint.
  // The click handler's 250 ms must show as processing, not presentation
  // (bug found by the integration test).
  const tap = inpFromEvents([
    { id: 9, name: 'pointerdown', duration: 264, start: 1000, processingStart: 1002, processingEnd: 1003 },
    { id: 9, name: 'pointerup', duration: 256, start: 1010, processingStart: 1012, processingEnd: 1013 },
    { id: 9, name: 'click', duration: 256, start: 1010, processingStart: 1013, processingEnd: 1263 },
  ]);
  assert.equal(tap.value, 264);
  assert.equal(tap.worst.name, 'click'); // the entry that did the work
  assert.equal(tap.worst.inputDelay, 2);
  assert.equal(tap.worst.processing, 261);
  assert.equal(tap.worst.presentation, 1);
  // entries without an interaction id are not interactions
  assert.equal(inpFromEvents([{ id: 0, name: 'mousemove', duration: 300 }]), null);
});

test('lcpSubparts: TTFB, load delay, load duration, render delay add up to LCP', () => {
  const d = base();
  const s = lcpSubparts(d.nav, d.lcp);
  assert.deepEqual(s, { ttfb: 300, loadDelay: 120, loadDuration: 680, renderDelay: 300 });
  assert.equal(s.ttfb + s.loadDelay + s.loadDuration + s.renderDelay, d.lcp.time);
  // text LCP: no resource, everything after TTFB is render delay
  const text = lcpSubparts({ ttfb: 28 }, { time: 3200, tag: 'p' });
  assert.deepEqual(text, { ttfb: 28, loadDelay: 0, loadDuration: 0, renderDelay: 3172 });
  // cross-origin image without Timing-Allow-Origin: requestStart is 0, fall back to startTime
  const xo = lcpSubparts({ ttfb: 200 }, { time: 2000, resource: { startTime: 600, requestStart: 0, responseEnd: 1500 } });
  assert.equal(xo.loadDelay, 400);
  assert.equal(xo.loadDuration, 900);
  // never negative, even with odd timings
  const odd = lcpSubparts({ ttfb: 900 }, { time: 800, resource: { startTime: 100, requestStart: 100, responseEnd: 50 } });
  Object.values(odd).forEach((v) => assert.ok(v >= 0));
});

test('classifyProps: layout vs paint vs composited properties', () => {
  assert.equal(classifyProps(['left']), 'layout');
  assert.equal(classifyProps(['transform', 'opacity']), 'composited');
  assert.equal(classifyProps(['boxShadow']), 'paint');
  assert.equal(classifyProps(['backgroundPositionX', 'backgroundPositionY']), 'paint');
  assert.equal(classifyProps(['transform', 'width']), 'layout'); // worst one wins
  assert.equal(classifyProps(['marginTop']), 'layout');
  assert.equal(classifyProps(['borderTopColor', 'boxShadow']), 'paint');
  assert.equal(classifyProps([]), 'composited');
  assert.equal(classifyProps(['zIndex']), 'composited'); // discrete, switches once (real Two Brothers flip clock)
});

test('siteOf groups subdomains and handles two-part country suffixes', () => {
  assert.equal(siteOf('www.buranshvalley.com'), 'buranshvalley.com');
  assert.equal(siteOf('cdn.buranshvalley.com'), 'buranshvalley.com');
  assert.equal(siteOf('shop.example.co.in'), 'example.co.in');
  assert.equal(siteOf('www.example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('127.0.0.1'), '127.0.0.1');
  assert.equal(siteOf('localhost'), 'localhost');
  assert.equal(siteOf(''), '');
});

test('vendorOf names common third parties', () => {
  assert.equal(vendorOf('www.googletagmanager.com'), 'Google Tag Manager / gtag');
  assert.equal(vendorOf('connect.facebook.net'), 'Meta Pixel');
  assert.equal(vendorOf('scripts.clarity.ms'), 'Microsoft Clarity');
  assert.equal(vendorOf('static.ads-twitter.com'), 'X (Twitter) Ads');
  assert.equal(vendorOf('cdn.moengage.com'), 'MoEngage');
  assert.equal(vendorOf('cdn-cookieyes.com'), 'CookieYes');
  assert.equal(vendorOf('unknown.example.org'), 'unknown.example.org');
});

test('findDuplicateTags: repeated GA4 / Clarity / pixel IDs and the same script loaded twice', () => {
  const dup = findDuplicateTags([
    'https://www.googletagmanager.com/gtag/js?id=G-W0EL8WFB2S',
    'https://www.googletagmanager.com/gtag/js?id=G-FLY0M4ZV19',
    'https://www.googletagmanager.com/gtag/js?id=G-W0EL8WFB2S&l=dataLayer',
    'https://www.clarity.ms/tag/iuizs43cb0',
    'https://www.clarity.ms/tag/iz2mqoh54i',
    'https://superfiliate-cdn.com/storefront.js?shop=x.myshopify.com',
    'https://superfiliate-cdn.com/storefront.js?shop=x.myshopify.com',
    'https://shop.example.com/app.js',
  ]);
  assert.deepEqual(dup.ga4, ['G-FLY0M4ZV19', 'G-W0EL8WFB2S']);
  assert.deepEqual(dup.ga4Repeated, ['G-W0EL8WFB2S']);
  assert.deepEqual(dup.clarity, ['iuizs43cb0', 'iz2mqoh54i']);
  assert.deepEqual(dup.sameScript, ['https://superfiliate-cdn.com/storefront.js?shop=x.myshopify.com']);
  assert.deepEqual(findDuplicateTags([]).sameScript, []);
  assert.deepEqual(findDuplicateTags(undefined).ga4, []);
});

// ---------------- evaluatePerformance ----------------

test('healthy page: all vitals good, no critical or warning findings', () => {
  const r = evaluatePerformance(base(), LIVE_PRODUCT);
  const f = byId(r);
  assert.equal(r.counts.critical, 0);
  assert.equal(r.counts.warning, 0);
  assert.equal(f['perf-lcp'].flag, 'good');
  assert.match(f['perf-lcp'].value, /1\.4 s/);
  assert.equal(f['perf-cls'].flag, 'good');
  assert.equal(f['perf-inp'].flag, 'info'); // no interaction yet
  assert.match(f['perf-inp'].why, /tap|click/i);
  assert.equal(f['perf-field'].flag, 'info'); // always remind: Google ranks by field data
  assert.match(f['perf-field'].why, /PageSpeed Insights|CrUX/);
});

test('Two Brothers pattern: infinite left-animation, 147 shifts, CLS poor is critical on a live product page', () => {
  const d = base();
  d.shifts = Array.from({ length: 147 }, (_, i) => ({ value: 0.006, time: 2000 + i * 40, sources: ['div.ri-pdp__member'] }));
  d.animations = [
    { name: 'ri-mem-sweep', target: 'div.ri-pdp__member::after', props: ['left'], infinite: true },
    { name: 'ri-promo-sweep', target: 'div.ri-pdp__promo::after', props: ['left'], infinite: true },
    { name: 'ri-mem-glow', target: 'div.ri-pdp__member', props: ['boxShadow'], infinite: true },
    { name: 'ri-marq', target: 'div.ri-pdp__marquee-track', props: ['transform'], infinite: true },
  ];
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-cls'].flag, 'critical');
  assert.equal(f['perf-anim-layout'].flag, 'critical');
  assert.match(f['perf-anim-layout'].value, /2 animations/);
  assert.match(f['perf-anim-layout'].why, /transform/);
  assert.ok(f['perf-anim-layout'].items.some((x) => /ri-mem-sweep.*left/.test(x)));
  assert.equal(f['perf-anim-paint'].flag, 'info');
  assert.match(f['perf-anim-paint'].value, /1 animation/);
  assert.match(f['perf-cls-sources'].value, /ri-pdp__member/);
  // composited animation is not reported as a problem anywhere
  assert.ok(!JSON.stringify(f).includes('ri-marq'));
  // same data on a blog page: still a warning, not critical
  assert.equal(byId(evaluatePerformance(d, BLOG))['perf-cls'].flag, 'warning');
});

test('a finite layout animation is a warning, not critical', () => {
  const d = base();
  d.animations = [{ name: 'slide-in', target: 'div.hero', props: ['top'], infinite: false }];
  assert.equal(byId(evaluatePerformance(d, LIVE_PRODUCT))['perf-anim-layout'].flag, 'warning');
});

test('lazy-loaded LCP image is critical on a live revenue page and names the fix', () => {
  const d = base();
  d.lcp.time = 4200;
  d.lcp.img.loading = 'lazy';
  d.lcp.img.preloaded = false;
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-lcp'].flag, 'critical');
  assert.equal(f['perf-lcp-lazy'].flag, 'critical');
  assert.match(f['perf-lcp-lazy'].why, /loading="lazy"/);
  assert.deepEqual(f['perf-lcp-lazy'].targets, [{ kind: 'css', value: 'img.wp-post-image' }]);
  // pre-launch: same issue is a launch blocker
  assert.equal(byId(evaluatePerformance(d, PRELAUNCH))['perf-lcp-lazy'].label, 'Launch blocker');
});

test('LCP image hidden behind data-src (JS lazy-load) is flagged as late discovery', () => {
  const d = base();
  d.lcp.img.dataSrc = true;
  d.lcp.img.preloaded = false;
  d.lcp.resource.startTime = 1500;
  d.lcp.resource.requestStart = 1510;
  d.lcp.resource.responseEnd = 2100;
  d.lcp.time = 2300;
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-lcp-discovery'].flag, 'warning');
  assert.match(f['perf-lcp-discovery'].why, /preload|src/);
});

test('LCP subparts: the biggest part gets the advice', () => {
  const d = base();
  d.lcp = { time: 3200, tag: 'p', selector: 'p.ri-hero-text', text: 'A2 Desi Cow Ghee', size: 40000 };
  d.nav.ttfb = 28;
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-lcp'].flag, 'warning'); // 3.2 s = needs improvement
  assert.match(f['perf-lcp-parts'].value, /render delay 3,172 ms/i);
  assert.match(f['perf-lcp-parts'].why, /render-blocking|font|JavaScript/i);
  assert.equal(f['perf-lcp-lazy'], undefined); // text LCP has no image checks
});

test('LCP image without fetchpriority is an info nudge, with it is good', () => {
  const d = base();
  d.lcp.img.fetchpriority = '';
  assert.equal(byId(evaluatePerformance(d, LIVE_PRODUCT))['perf-lcp-priority'].flag, 'info');
  assert.equal(byId(evaluatePerformance(base(), LIVE_PRODUCT))['perf-lcp-priority'].flag, 'good');
});

test('no LCP entry (background tab, nothing painted) is reported, not crashed', () => {
  const d = base();
  d.lcp = null;
  d.visibility = 'hidden';
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-lcp'].flag, 'info');
  assert.match(f['perf-lcp'].why, /background|hidden|reload/i);
});

test('render-blocking: MoEngage SDK in head blocks ~1 s and is named', () => {
  const d = base();
  d.renderBlocking = [
    { url: 'https://cdn.moengage.com/release/dc_3/moe_webSdk_webp.min.latest.js', host: 'cdn.moengage.com', type: 'script', duration: 1052, bytes: 49000 },
    { url: 'https://shop.example.com/preload_asset.js', host: 'shop.example.com', type: 'script', duration: 12, bytes: 2000 },
  ];
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-render-blocking'].flag, 'warning');
  assert.match(f['perf-render-blocking'].value, /2 files/);
  assert.ok(f['perf-render-blocking'].items[0].startsWith('1,052 ms'));
  assert.match(f['perf-render-blocking'].items[0], /MoEngage/);
  assert.match(f['perf-render-blocking'].why, /async|defer/);
});

test('render-blocking: only one small first-party file is fine', () => {
  const d = base();
  d.renderBlocking = [{ url: 'https://shop.example.com/wp-includes/js/jquery/jquery.min.js', host: 'shop.example.com', type: 'script', duration: 60, bytes: 30000 }];
  assert.equal(byId(evaluatePerformance(d, LIVE_PRODUCT))['perf-render-blocking'].flag, 'info');
  assert.equal(byId(evaluatePerformance(base(), LIVE_PRODUCT))['perf-render-blocking'].flag, 'good');
});

test('main thread: long frames grouped by vendor, Clarity on top', () => {
  const d = base();
  d.frames = [
    { start: 3000, duration: 228, blocking: 178, scripts: [
      { url: 'https://connect.facebook.net/en_US/fbevents.js', invoker: '#document.onclick', duration: 129, forcedLayout: 0 },
      { url: 'https://www.googletagmanager.com/gtag/js?id=G-1', invoker: '#document.onclick', duration: 16, forcedLayout: 0 },
    ] },
    { start: 4000, duration: 141, blocking: 91, scripts: [{ url: 'https://scripts.clarity.ms/0.8.77/clarity.js', invoker: 'TimerHandler:setTimeout', duration: 118, forcedLayout: 118 }] },
    { start: 5000, duration: 600, blocking: 550, scripts: [{ url: 'https://scripts.clarity.ms/0.8.77/clarity.js', invoker: 'TimerHandler:setTimeout', duration: 500, forcedLayout: 0 }] },
  ];
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-main'].flag, 'warning');
  assert.match(f['perf-main'].value, /3 long frames/);
  assert.match(f['perf-main'].items[0], /^Microsoft Clarity · 618 ms/);
  assert.match(f['perf-main'].items[0], /forced layout 118 ms/);
  assert.match(f['perf-main'].items[1], /^Meta Pixel · 129 ms/);
});

test('main thread: frames caused by browser extensions (including this one) are not blamed on the site', () => {
  const d = base();
  d.frames = [
    { start: 100, duration: 300, blocking: 250, scripts: [{ url: 'chrome-extension://abcdefgh/modules/phase1-elements.js', invoker: 'ScriptRunner', duration: 280, forcedLayout: 40 }] },
    { start: 900, duration: 80, blocking: 30, scripts: [{ url: 'https://shop.example.com/app.js', invoker: 'DOMWindow.onload', duration: 70, forcedLayout: 0 }] },
  ];
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.match(f['perf-main'].value, /^1 long frame/);
  assert.ok(!f['perf-main'].items.some((x) => /chrome-extension|abcdefgh/.test(x)));
  assert.match(f['perf-main'].items[0], /^This site \(shop\.example\.com\) · 70 ms/);
});

test('slow interaction recorded before the audit becomes the INP finding with its biggest phase', () => {
  const d = base();
  d.events = [{ id: 3, name: 'pointerup', duration: 408, start: 9000, processingStart: 9064, processingEnd: 9064, target: 'button.ri-pdp__bundle' }];
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-inp'].flag, 'warning');
  assert.match(f['perf-inp'].value, /408 ms/);
  assert.match(f['perf-inp'].why, /presentation/i);
  const slow = clone(d);
  slow.events[0].duration = 700;
  assert.equal(byId(evaluatePerformance(slow, LIVE_PRODUCT))['perf-inp'].flag, 'critical');
});

test('third parties: weight by vendor, platform CDN and own subdomains are first-party', () => {
  const d = base();
  d.resources.push(
    { host: 'www.googletagmanager.com', type: 'script', bytes: 541000, duration: 300 },
    { host: 'www.googletagmanager.com', type: 'script', bytes: 160000, duration: 200 },
    { host: 'connect.facebook.net', type: 'script', bytes: 112000, duration: 150 },
    { host: 'cdn.shop.example.com', type: 'img', bytes: 220000, duration: 400 },
    { host: 'cdn.shopify.com', type: 'script', bytes: 30000, duration: 80 },
    { host: 'scripts.clarity.ms', type: 'script', bytes: 0, duration: 90 },
  );
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-3p'].flag, 'info');
  assert.match(f['perf-3p'].value, /3 third parties/);
  assert.match(f['perf-3p'].items[0], /^Google Tag Manager \/ gtag · 2 requests · 701 KB/);
  assert.ok(f['perf-3p'].items.some((x) => /Microsoft Clarity · 1 request · size hidden/.test(x)));
  assert.ok(!f['perf-3p'].items.some((x) => /shopify|cdn\.shop\.example/.test(x)));
});

test('duplicate tags are a warning with the IDs listed', () => {
  const d = base();
  d.scripts = [
    'https://www.googletagmanager.com/gtag/js?id=G-W0EL8WFB2S',
    'https://www.googletagmanager.com/gtag/js?id=G-FLY0M4ZV19',
    'https://www.clarity.ms/tag/iuizs43cb0',
    'https://www.clarity.ms/tag/iz2mqoh54i',
  ];
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-dup-tags'].flag, 'warning');
  assert.match(f['perf-dup-tags'].value, /2 GA4 IDs.*2 Clarity projects/);
  assert.ok(f['perf-dup-tags'].items.includes('GA4: G-FLY0M4ZV19, G-W0EL8WFB2S'));
  assert.equal(byId(evaluatePerformance(base(), LIVE_PRODUCT))['perf-dup-tags'], undefined);
});

test('images: lazy above the fold, missing size, oversized files', () => {
  const d = base();
  d.images = [
    { src: 'https://shop.example.com/banner.jpg', selector: 'img.banner', inViewport: true, lazy: true, hasSize: true, natural: 1200, shown: 400, dpr: 1, bytes: 300000 },
    { src: 'https://shop.example.com/woocommerce-placeholder.png', selector: 'img.wc-placeholder', inViewport: false, lazy: true, hasSize: false, natural: 600, shown: 600, dpr: 1, bytes: 0 },
    { src: 'https://shop.example.com/icon.svg', selector: 'img.icon', inViewport: true, lazy: false, hasSize: false, natural: 0, shown: 24, dpr: 2, bytes: 0 },
    { src: 'https://shop.example.com/hero.webp', selector: 'img.hero', inViewport: true, lazy: false, hasSize: true, natural: 800, shown: 400, dpr: 2, bytes: 50000 },
  ];
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-img-lazy'].flag, 'warning');
  assert.match(f['perf-img-lazy'].value, /1 image/);
  assert.equal(f['perf-img-size'].flag, 'warning');
  assert.match(f['perf-img-size'].value, /1 image/); // SVG icons are exempt
  assert.match(f['perf-img-size'].why, /width.*height|aspect-ratio/);
  assert.equal(f['perf-img-big'].flag, 'info');
  assert.match(f['perf-img-big'].items[0], /banner\.jpg · 1200 px file shown at 400 px/);
  assert.ok(!f['perf-img-big'].items.some((x) => /hero\.webp/.test(x))); // 800 px for 400 px at 2x is right
});

test('fonts: many files and missing font-display are reported', () => {
  const d = base();
  d.fonts = {
    files: [
      { url: 'https://shop.example.com/fonts/a.woff2', host: 'shop.example.com', bytes: 30000 },
      { url: 'https://fonts.gstatic.com/s/x.woff2', host: 'fonts.gstatic.com', bytes: 20000 },
      { url: 'https://fonts.gstatic.com/s/y.woff2', host: 'fonts.gstatic.com', bytes: 20000 },
      { url: 'https://fonts.gstatic.com/s/z.woff2', host: 'fonts.gstatic.com', bytes: 20000 },
      { url: 'https://fonts.gstatic.com/s/w.woff2', host: 'fonts.gstatic.com', bytes: 20000 },
      { url: 'https://fonts.gstatic.com/s/v.woff2', host: 'fonts.gstatic.com', bytes: 20000 },
    ],
    preloaded: 0,
    faces: [{ family: 'Hanken Grotesk', display: 'swap' }, { family: 'Gotham', display: 'auto' }],
  };
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-fonts'].flag, 'warning');
  assert.match(f['perf-fonts'].value, /6 font files/);
  assert.equal(f['perf-font-display'].flag, 'warning');
  assert.match(f['perf-font-display'].value, /Gotham/);
});

test('counts always match the findings, and every finding has the standard shape', () => {
  const d = base();
  d.animations = [{ name: 'a', target: 'div', props: ['left'], infinite: true }];
  d.renderBlocking = [{ url: 'https://x.example.org/a.css', host: 'x.example.org', type: 'link', duration: 900, bytes: 1 }];
  const r = evaluatePerformance(d, LIVE_PRODUCT);
  const all = r.groups.flatMap((g) => g.findings);
  const counts = { critical: 0, warning: 0, good: 0, info: 0 };
  all.forEach((f) => {
    counts[f.flag] += 1;
    ['id', 'check', 'value', 'flag', 'label', 'why'].forEach((k) => assert.ok(typeof f[k] === 'string' && f[k].length, `${f.id} ${k}`));
  });
  assert.deepEqual(r.counts, counts);
  assert.equal(new Set(all.map((f) => f.id)).size, all.length, 'finding ids are unique');
  // "Show on page" only understands {kind, value} targets (bug found while wiring the tab)
  all.filter((f) => f.targets).forEach((f) => f.targets.forEach((t) => {
    assert.equal(t.kind, 'css', f.id);
    assert.equal(typeof t.value, 'string');
    assert.ok(!/::/.test(t.value), 'pseudo-elements cannot be selected');
  }));
});

test('broken or empty collector data never throws', () => {
  assert.doesNotThrow(() => evaluatePerformance({}, LIVE_PRODUCT));
  assert.doesNotThrow(() => evaluatePerformance({ nav: null, lcp: {}, shifts: null, events: 'x', frames: [{}], images: [null], fonts: null, animations: [{}], renderBlocking: [{}], resources: [{}], scripts: [null, 42] }, {}));
  const r = evaluatePerformance({}, {});
  assert.ok(Array.isArray(r.groups));
});

test('Performance section flows into the summary; layout animation ranks near the top', () => {
  const d = base();
  d.shifts = Array.from({ length: 40 }, (_, i) => ({ value: 0.01, time: 2000 + i * 50, sources: ['div.x'] }));
  d.animations = [{ name: 'sweep', target: 'div.x::after', props: ['left'], infinite: true }];
  const performance = evaluatePerformance(d, LIVE_PRODUCT);
  const s = buildSummary({ head: { groups: [], counts: { critical: 0, warning: 0, good: 0, info: 0 } }, performance }, LIVE_PRODUCT);
  assert.ok(s.sections.some((x) => x.key === 'performance' && x.name === 'Performance'));
  assert.ok(s.top.slice(0, 2).some((x) => x.key === 'performance:perf-anim-layout'));
});

// ---------------- real capture: Two Brothers product page (29 Oct 2026) ----------------

import { readFileSync } from 'node:fs';

const loadFx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));

test('Two Brothers real capture: the known causes come out on top', () => {
  const d = loadFx('twobrothers-product-performance');
  const r = evaluatePerformance(d, LIVE_PRODUCT);
  const f = byId(r);
  // the left-animated shine, found again from live data
  assert.equal(f['perf-anim-layout'].flag, 'critical');
  assert.ok(f['perf-anim-layout'].items.some((x) => /ri-mem-sweep.*left.*runs forever/.test(x)));
  assert.match(f['perf-anim-paint'].value, /^7 animations/); // glow + 6 reel shimmers
  // two GA4 properties (each loaded twice) and two Clarity projects
  assert.match(f['perf-dup-tags'].value, /2 GA4 IDs \(loaded twice\).*2 Clarity projects/);
  // the "Read more" tap: 232 ms, mostly the click handler + analytics listeners
  assert.equal(f['perf-inp'].flag, 'warning');
  assert.match(f['perf-inp'].value, /^232 ms · click on button\.ri-pdp__short-toggle/);
  assert.match(f['perf-inp'].why, /processing/);
  // long frames: Google tags first, then the site's own Shopify scripts, then Meta
  assert.match(f['perf-main'].items[0], /^Google Tag Manager \/ gtag · 870 ms/);
  assert.match(f['perf-main'].items[1], /^This site \(twobrothersindiashop\.com\) · 427 ms/);
  assert.match(f['perf-main'].items[2], /^Meta Pixel · 369 ms/);
  // fonts without font-display
  assert.match(f['perf-font-display'].value, /Gotham Book \(not set\)/);
});

test('Two Brothers real capture: LCP is a full-screen loading icon, not the product', () => {
  const f = byId(evaluatePerformance(loadFx('twobrothers-product-performance'), LIVE_PRODUCT));
  assert.equal(f['perf-lcp-loader'].flag, 'warning');
  assert.match(f['perf-lcp-loader'].value, /div#fv-loading-icon/);
  assert.match(f['perf-lcp-loader'].why, /loading screen|preloader/i);
  assert.deepEqual(f['perf-lcp-loader'].targets, [{ kind: 'css', value: 'div#fv-loading-icon' }]);
  // a normal element is not called a loader
  const d = base();
  d.lcp = { time: 1200, tag: 'h1', selector: 'h1.product-title', text: 'A2 Ghee', size: 30000 };
  assert.equal(byId(evaluatePerformance(d, LIVE_PRODUCT))['perf-lcp-loader'], undefined);
});

test('Two Brothers real capture: render-blocking rows say CSS for .css files even when Chrome reports early-hints', () => {
  const f = byId(evaluatePerformance(loadFx('twobrothers-product-performance'), LIVE_PRODUCT));
  const rb = f['perf-render-blocking'];
  assert.equal(rb.flag, 'warning');
  assert.ok(rb.items.some((x) => /first-party · CSS · twobrothersindiashop\.com\/cdn\/shop\/t\/815\/assets\/theme\.css/.test(x)));
  assert.ok(rb.items.some((x) => /^214 ms · MoEngage · JS/.test(x)));
});

test('Chrome keeps only 150 layout shifts: the tab says CLS may be higher', () => {
  const f = byId(evaluatePerformance(loadFx('twobrothers-product-performance'), LIVE_PRODUCT));
  assert.equal(f['perf-cls-limit'].flag, 'info');
  assert.match(f['perf-cls-limit'].why, /150/);
  assert.equal(byId(evaluatePerformance(base(), LIVE_PRODUCT))['perf-cls-limit'], undefined);
});

// ---------------- false positives found by verifying on live sites (29 Oct 2026) ----------------

test('WooCommerce data-src (zoom image) on an LCP image that loaded fast is not "found late"', () => {
  // Buranshvalley: data-src holds the full-size zoom image; src loads 75 ms after TTFB
  const d = base();
  d.lcp.img.dataSrc = true;
  d.lcp.img.preloaded = false;
  d.lcp.resource = { startTime: 440, requestStart: 459, responseEnd: 545 };
  d.nav.ttfb = 384;
  assert.equal(byId(evaluatePerformance(d, LIVE_PRODUCT))['perf-lcp-discovery'], undefined);
});

test('icon fonts inlined as data: URIs are not asked for font-display (never downloaded)', () => {
  const d = base();
  d.fonts = { files: [], preloaded: 0, faces: [{ family: 'swiper-icons', display: '', inline: true }, { family: 'Gotham Book', display: '' }] };
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.match(f['perf-font-display'].value, /Gotham Book/);
  assert.doesNotMatch(f['perf-font-display'].value, /swiper-icons/);
  d.fonts.faces = [{ family: 'swiper-icons', display: '', inline: true }];
  assert.equal(byId(evaluatePerformance(d, LIVE_PRODUCT))['perf-font-display'], undefined);
});

test('absolutely positioned or fixed images without size are not a CLS risk', () => {
  const d = base();
  d.images = [{ src: 'https://shop.example.com/zoom.jpg', selector: 'img.zoomImg', inViewport: true, lazy: false, hasSize: false, positioned: true, natural: 1200, shown: 1200, dpr: 1, bytes: 0 }];
  assert.equal(byId(evaluatePerformance(d, LIVE_PRODUCT))['perf-img-size'], undefined);
});

test('"larger than shown" needs at least 2x the pixels and 200 px extra (no noise from small thumbnails)', () => {
  const d = base();
  d.images = [
    { src: 'https://x.example.com/thumb.jpg', selector: 'img.t', inViewport: false, lazy: true, hasSize: true, natural: 120, shown: 50, dpr: 1.25, bytes: 11000 },
    { src: 'https://x.example.com/big.jpg', selector: 'img.b', inViewport: false, lazy: true, hasSize: true, natural: 2500, shown: 100, dpr: 1.25, bytes: 33000 },
  ];
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.equal(f['perf-img-big'].items.length, 1);
  assert.match(f['perf-img-big'].items[0], /^big\.jpg/);
});

test('any Google tag ID loaded twice is reported (Graza: Google Ads AW- tag)', () => {
  const dup = findDuplicateTags([
    'https://www.googletagmanager.com/gtag/js?id=G-7KEN5CH0ML',
    'https://www.googletagmanager.com/gtag/js?id=AW-11067507227',
    'https://www.googletagmanager.com/gtag/js?id=AW-11067507227&l=dataLayer',
    'https://www.googletagmanager.com/gtag/js?id=GT-TBZ6CX7',
  ]);
  assert.deepEqual(dup.gtagRepeated, ['AW-11067507227']);
  const d = base();
  d.scripts = ['https://www.googletagmanager.com/gtag/js?id=G-7KEN5CH0ML', 'https://www.googletagmanager.com/gtag/js?id=AW-11067507227', 'https://www.googletagmanager.com/gtag/js?id=AW-11067507227&cx=c'];
  const f = byId(evaluatePerformance(d, LIVE_PRODUCT));
  assert.match(f['perf-dup-tags'].value, /Google tag loaded twice/);
  assert.ok(f['perf-dup-tags'].items.includes('Loaded twice: AW-11067507227'));
});
