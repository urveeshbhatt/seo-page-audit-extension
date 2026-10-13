import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateRendering, frameworkOf, jsOnlySchema } from '../modules/phase3-rules.js';
import { buildSummary } from '../modules/summary.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const byId = (result) => Object.fromEntries(result.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));
const clone = (o) => JSON.parse(JSON.stringify(o));

const BV = { pageType: 'product', status: 'prelaunch', model: 'd2c' };
const BV_LIVE = { ...BV, status: 'live' };
const REGUS = { pageType: 'location', status: 'live', model: 'b2b' };

// ---------------- real captures ----------------

test('Buranshvalley: server-rendered WordPress, price only in schema is the headline issue', () => {
  const r = evaluateRendering(load('buranshvalley-product-rendering'), BV, { network: load('buranshvalley-product-network') });
  const f = byId(r);
  assert.equal(f['rend-strategy'].flag, 'good');
  assert.match(f['rend-strategy'].value, /WordPress \+ Elementor .*\(100%\)/);
  assert.equal(f['rend-ai-price'].label, 'Launch blocker');
  assert.match(f['rend-ai-price'].value, /₹349 NOT on page.*₹2,299 NOT on page/);
  assert.match(f['rend-ai-price'].why, /Resoneo/);
  assert.equal(f['rend-ai-content'].flag, 'good');
  assert.equal(f['rend-meta'].flag, 'good');
  assert.equal(f['rend-panels'].flag, 'good'); // FAQ and tabs are in the raw HTML
  assert.match(f['rend-panels'].value, /7 panels.*4 closed/);
  assert.equal(f['rend-loadmore'], undefined); // CookieYes "Show more" is not a load-more button
  assert.equal(f['rend-build'].value, 'Unknown'); // LiteSpeed cache says nothing about build type
  assert.equal(f['rend-gsc'].flag, 'info');
  // live site: same issue becomes critical
  assert.equal(byId(evaluateRendering(load('buranshvalley-product-rendering'), BV_LIVE))['rend-ai-price'].flag, 'critical');
});

test('Regus: Next.js App Router detected without __NEXT_DATA__, dynamic SSR, load more flagged', () => {
  const r = evaluateRendering(load('regus-mumbai-rendering'), REGUS, { network: load('regus-mumbai-network') });
  const f = byId(r);
  assert.equal(r.counts.critical, 0);
  assert.match(f['rend-strategy'].value, /^Next\.js \(App Router\)/);
  assert.equal(f['rend-strategy'].flag, 'good');
  assert.equal(f['rend-build'].value, 'Built on every request'); // private, no-store
  assert.equal(f['rend-loadmore'].flag, 'warning'); // location page = listing
  assert.equal(f['rend-loadmore'].label, 'Check by hand');
  assert.match(f['rend-loadmore'].why, /sitemap/);
  assert.equal(f['rend-panels'].flag, 'good');
  assert.equal(f['rend-ai-price'], undefined); // no Product schema
  assert.equal(f['rend-og'], undefined); // OG missing in both: a Head-tab issue, not a JS issue
});

test('Rendering section flows into the summary with the price issue near the top', () => {
  const rendering = evaluateRendering(load('buranshvalley-product-rendering'), BV_LIVE);
  const s = buildSummary({ head: { groups: [], counts: { critical: 0, warning: 0, good: 0, info: 0 } }, rendering }, BV_LIVE);
  assert.ok(s.sections.some((x) => x.key === 'rendering' && x.name === 'Rendering'));
  assert.equal(s.top[0].key, 'rendering:rend-ai-price');
});

// ---------------- strategy ----------------

test('frameworkOf prefers specific Next.js routers and falls back to platforms', () => {
  assert.equal(frameworkOf({ nextApp: true, nextStatic: true }), 'Next.js (App Router)');
  assert.equal(frameworkOf({ nextPages: true }), 'Next.js (Pages Router)');
  assert.equal(frameworkOf({ nextStatic: true }), 'Next.js');
  assert.equal(frameworkOf({ shopify: true }), 'Shopify');
  assert.equal(frameworkOf({ wordpress: true }), 'WordPress');
  assert.equal(frameworkOf({}), '');
});

test('Empty app shell is client-side rendering: critical on a live revenue page', () => {
  const d = clone(load('regus-mumbai-rendering'));
  d.mount = { selector: '#root', rawWords: 0, renderedWords: 2700 };
  d.words = { raw: 12, rendered: 2751 };
  const f = byId(evaluateRendering(d, REGUS));
  assert.equal(f['rend-strategy'].flag, 'critical');
  assert.match(f['rend-strategy'].why, /empty #root shell/);
  assert.equal(f['rend-ai-content'].flag, 'warning');
  assert.match(f['rend-ai-content'].why, /Vercel/);
  assert.equal(byId(evaluateRendering(d, { pageType: 'article', status: 'live' }))['rend-strategy'].flag, 'warning');
});

test('Hybrid page asks for a hand check', () => {
  const d = clone(load('buranshvalley-product-rendering'));
  d.words = { raw: 500, rendered: 900 };
  const f = byId(evaluateRendering(d, BV));
  assert.equal(f['rend-strategy'].label, 'Check by hand');
});

test('Bot wall or failed fetch stops the comparison with a clear reason', () => {
  const d = clone(load('regus-mumbai-rendering'));
  d.raw = { ok: false, reason: 'Bot protection answered instead of the page', bytes: 958, challenge: true };
  const r = evaluateRendering(d, REGUS);
  const f = byId(r);
  assert.equal(f['rend-raw'].label, 'Check by hand');
  assert.match(f['rend-raw'].why, /URL Inspection/);
  assert.equal(f['rend-meta'], undefined);
});

test('Framework cache headers are read as ISR / prerender, never from TTFB', () => {
  const net = clone(load('regus-mumbai-network'));
  net.doc.headers = { 'x-nextjs-cache': 'HIT', 'cache-control': 's-maxage=3600' };
  assert.match(byId(evaluateRendering(load('regus-mumbai-rendering'), REGUS, { network: net }))['rend-build'].why, /revalidate/);
  net.doc.headers = { 'x-vercel-cache': 'PRERENDER' };
  assert.equal(byId(evaluateRendering(load('regus-mumbai-rendering'), REGUS, { network: net }))['rend-build'].value, 'Prerendered (static / ISR)');
});

// ---------------- meta ----------------

test('noindex in raw HTML removed by JavaScript is the render-skip trap', () => {
  const d = clone(load('buranshvalley-product-rendering'));
  d.meta.rendered = { ...d.meta.rendered, robots: 'index, follow' };
  assert.equal(byId(evaluateRendering(d, BV_LIVE))['rend-robots'].flag, 'critical');
  assert.equal(byId(evaluateRendering(d, BV))['rend-robots'].label, 'Launch blocker');
  const e = clone(load('regus-mumbai-rendering'));
  e.meta.rendered = { ...e.meta.rendered, robots: 'noindex' };
  assert.equal(byId(evaluateRendering(e, REGUS))['rend-robots'].flag, 'warning');
});

test('Canonical, title and Open Graph changed or added by JavaScript', () => {
  const d = clone(load('regus-mumbai-rendering'));
  d.meta.rendered = { ...d.meta.rendered, canonical: 'https://www.regus.com/en/in/mumbai?x=1', title: 'Other title', ogImage: 'https://x/og.jpg', ogTitle: 'X' };
  const f = byId(evaluateRendering(d, REGUS));
  assert.equal(f['rend-canonical'].flag, 'warning');
  assert.match(f['rend-canonical'].check, /changed/);
  assert.equal(f['rend-title'].flag, 'info');
  assert.equal(f['rend-og'].flag, 'warning');
  assert.match(f['rend-og'].value, /og:title, og:image/);
  d.meta.raw = { ...d.meta.raw, canonical: null };
  assert.match(byId(evaluateRendering(d, REGUS))['rend-canonical'].check, /added/);
});

// ---------------- AI readers ----------------

test('Price shown only after JavaScript, and price on page in raw HTML', () => {
  const d = clone(load('buranshvalley-product-rendering'));
  d.facts.prices.forEach((p) => { p.visible = true; });
  assert.equal(byId(evaluateRendering(d, BV))['rend-ai-price'].flag, 'warning');
  d.facts.prices.forEach((p) => { p.inRawText = true; });
  assert.equal(byId(evaluateRendering(d, BV))['rend-ai-price'].flag, 'good');
});

test('Stock only in schema is noted; JS-only schema is listed', () => {
  const d = clone(load('buranshvalley-product-rendering'));
  d.facts.buyButton = false;
  assert.equal(byId(evaluateRendering(d, BV))['rend-ai-stock'].flag, 'info');
  d.schema.rendered = [...d.schema.rendered, 'aggregateRating', 'BreadcrumbList', 'ListItem'];
  assert.deepEqual(jsOnlySchema(d), ['aggregateRating', 'BreadcrumbList']);
  const f = byId(evaluateRendering(d, BV));
  assert.equal(f['rend-ai-content'].flag, 'warning');
  assert.equal(f['rend-ai-content'].items.length, 2);
});

test('Slow first byte is flagged for AI fetchers with the source caveat', () => {
  const net = clone(load('regus-mumbai-network'));
  net.warm.forEach((w, i) => { w.ttfb = [2600, 3100, 2900][i]; });
  const f = byId(evaluateRendering(load('regus-mumbai-rendering'), REGUS, { network: net }));
  assert.equal(f['rend-ai-ttfb'].flag, 'warning');
  assert.match(f['rend-ai-ttfb'].why, /sources disagree/);
});

// ---------------- links, pagination, panels ----------------

test('Links only after JavaScript and fake links', () => {
  const d = clone(load('regus-mumbai-rendering'));
  d.links = { raw: 20, rendered: 60, onlyRendered: 40, samples: ['/en/in/mumbai/centre-a'] };
  d.fakeLinks = [{ tag: 'div', text: 'Duru House', target: '/en/in/mumbai/duru-house' }];
  const f = byId(evaluateRendering(d, REGUS));
  assert.equal(f['rend-links-js'].flag, 'warning');
  assert.equal(f['rend-fake-links'].label, 'Check by hand');
  assert.match(f['rend-fake-links'].items[0], /<div> Duru House → /);
});

test('Load more is info on a product page; raw pagination links pass', () => {
  const d = clone(load('regus-mumbai-rendering'));
  assert.equal(byId(evaluateRendering(d, { ...REGUS, pageType: 'product' }))['rend-loadmore'].flag, 'info');
  d.pagination = { raw: ['?page=2', '?page=3'], rendered: ['?page=2', '?page=3'] };
  assert.equal(byId(evaluateRendering(d, REGUS))['rend-loadmore'].flag, 'good');
  d.pagination = { raw: [], rendered: ['?page=2'] };
  d.loadMore = [];
  assert.match(byId(evaluateRendering(d, REGUS))['rend-loadmore'].value, /Only after JavaScript/);
});

test('Tab content loaded by JavaScript is a warning', () => {
  const d = clone(load('buranshvalley-product-rendering'));
  d.panels[1].inRaw = false;
  const f = byId(evaluateRendering(d, BV));
  assert.equal(f['rend-panels'].flag, 'warning');
  assert.match(f['rend-panels'].items[0], /^tab: Reviews/);
});
