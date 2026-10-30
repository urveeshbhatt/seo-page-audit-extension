// False positives found by auditing a live Shopify (Horizon theme) store on
// 30 Oct 2026, written as tests before the fixes. Each test names what the
// extension said and what was true on the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluatePerformance } from '../modules/phase4-rules.js';
import { evaluateHealth } from '../modules/phase1-health-rules.js';
import { evaluateNetwork } from '../modules/phase2-rules.js';
import { evaluateBody } from '../modules/phase1-body-rules.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const byId = (result) => Object.fromEntries(result.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const LIVE = { pageType: 'product', status: 'live', model: 'd2c' };

// ---------------- 1. CSS transitions are not looping layout animations ----------------

const perfBase = () => {
  const d = load('twobrothers-product-performance');
  d.animations = [];
  return d;
};

test('a one-time CSS transition on border width is not a layout animation', () => {
  const d = perfBase();
  d.animations = ['borderBottomWidth', 'borderLeftWidth', 'borderRightWidth', 'borderTopWidth'].map((p) => ({
    name: p, target: 'div.ai-category-icon-wrapper', props: [p], infinite: false, kind: 'transition',
  }));
  const f = byId(evaluatePerformance(d, LIVE));
  assert.equal(f['perf-anim-layout'], undefined, f['perf-anim-layout'] && f['perf-anim-layout'].value);
});

test('a real CSS animation on left is still flagged, and old captures without kind still count', () => {
  const d = perfBase();
  d.animations = [
    { name: 'sweep', target: 'div.a::after', props: ['left'], infinite: true, kind: 'animation' },
    { name: 'old', target: 'div.b', props: ['top'], infinite: false },
  ];
  const f = byId(evaluatePerformance(d, LIVE));
  assert.equal(f['perf-anim-layout'].flag, 'critical');
  assert.match(f['perf-anim-layout'].value, /2 animations/);
});

// ---------------- 2. Shopify tracking runs in sandboxed pixels ----------------

const shopifyHealth = () => {
  const d = clone(load('buranshvalley-product-health'));
  d.stack = [{ name: 'Shopify', group: 'platform' }];
  d.tags = { gtm: [], ga4: [], ua: [], aw: [] };
  return d;
};

test('Shopify with only app/custom pixels: not "none detected", check Customer events', () => {
  const d = shopifyHealth();
  d.shopifyPixels = [{ name: 'Judge.me', type: 'APP', ids: [] }, { name: 'Custom pixel', type: 'CUSTOM', ids: [] }];
  const f = byId(evaluateHealth(d, LIVE))['stack-tracking'];
  assert.notEqual(f.flag, 'critical');
  assert.equal(f.label, 'Check by hand');
  assert.match(f.why, /Customer events/);
  assert.ok(f.items.some((x) => /Judge\.me/.test(x)));
  assert.ok(f.items.some((x) => /Custom pixel/.test(x)));
});

test('repeated Shopify pixels are listed once with a count', () => {
  const d = shopifyHealth();
  d.shopifyPixels = [...Array(10)].map(() => ({ name: 'Custom pixel', type: 'CUSTOM', ids: [] })).concat([{ name: 'Judge.me', type: 'APP', ids: [] }]);
  const f = byId(evaluateHealth(d, LIVE))['stack-tracking'];
  assert.deepEqual(f.items, ['Shopify pixel: Custom pixel ×10', 'Shopify pixel: Judge.me']);
  assert.match(f.value, /11 Shopify pixels/);
});

test('Shopify Google app pixel with a G- ID counts as tracking', () => {
  const d = shopifyHealth();
  d.shopifyPixels = [{ name: 'Google & YouTube', type: 'APP', ids: ['G-ABC123XYZ', 'AW-1234567890'] }];
  const f = byId(evaluateHealth(d, LIVE))['stack-tracking'];
  assert.equal(f.flag, 'info');
  assert.ok(f.items.some((x) => /G-ABC123XYZ/.test(x)));
});

test('a live non-Shopify site with no analytics is still critical, without "before launch"', () => {
  const d = clone(load('buranshvalley-product-health'));
  d.stack = d.stack.filter((s) => s.group !== 'tracking');
  d.tags = { gtm: [], ga4: [], ua: [], aw: [] };
  const f = byId(evaluateHealth(d, LIVE))['stack-tracking'];
  assert.equal(f.flag, 'critical');
  assert.doesNotMatch(f.why, /before launch/);
});

// ---------------- 3. Shopify: no WordPress / Cloudflare advice ----------------

const shopifyNetwork = () => {
  const d = clone(load('buranshvalley-product-network'));
  d.doc.headers = { ...d.doc.headers, 'powered-by': 'Shopify', 'x-shopid': '91234567' };
  [...d.warm, ...d.cold].forEach((x) => { x.cache = { 'cf-cache-status': 'DYNAMIC', 'cache-control': 'private, max-age=0' }; });
  return d;
};

test('Shopify HTML that the CDN never caches: info, no Cloudflare cache rule advice', () => {
  const f = byId(evaluateNetwork(shopifyNetwork(), LIVE))['net-cache-hit'];
  assert.equal(f.flag, 'info');
  assert.match(f.why, /Shopify/);
  assert.doesNotMatch(f.why, /Cache Rules/);
});

test('Shopify with many own files: info, no cache-plugin advice', () => {
  const f = byId(evaluateNetwork(shopifyNetwork(), LIVE))['net-files'];
  assert.equal(f.flag, 'info');
  assert.match(f.why, /Shopify/);
  assert.doesNotMatch(f.why, /plugin/);
});

test('non-Shopify sites keep the cache advice', () => {
  const d = clone(load('buranshvalley-product-network'));
  d.cold.forEach((x) => { x.cache['x-hcdn-cache-status'] = 'BYPASS'; });
  assert.equal(byId(evaluateNetwork(d, LIVE))['net-cache-hit'].flag, 'warning');
});

// ---------------- 4. Broken phone / WhatsApp links (missed before) ----------------

const link = (href, text) => ({ href, hasHref: true, text, label: '', imgAlt: '', hasSvg: false, cls: '', role: '', expandable: false, uiControl: false, rel: '', internal: false, external: true, generic: false, visible: true });

test('two numbers in one tel: or wa.me link, and wa.me without country code, are broken links', () => {
  const d = clone(load('buranshvalley-product-body'));
  d.links = [
    link('tel:6398918467,9389524019', '6398918467, 9389524019'),
    link('https://wa.me/9389524019,6398918467', '9389524019, 6398918467'),
    link('https://wa.me/9389524019', 'WhatsApp'),
    link('https://wa.me/919389524019?text=Hi', 'Order'),
    link('tel:+916398918467', 'Call'),
  ];
  const f = byId(evaluateBody(d, LIVE))['links-badcontact'];
  assert.equal(f.flag, 'warning');
  assert.equal(f.items.length, 3);
  assert.ok(f.items.some((x) => /two numbers/i.test(x) && /tel:6398918467,9389524019/.test(x)));
  assert.ok(f.items.some((x) => /country code/i.test(x) && /wa\.me\/9389524019$/.test(x)));
});

test('placeholder WhatsApp numbers are left to the placeholder check', () => {
  const d = clone(load('buranshvalley-product-body'));
  d.links = [link('https://wa.me/91XXXXXXXXXX?text=Hi', 'Order'), link('https://wa.me/919876543210', 'Chat')];
  assert.equal(byId(evaluateBody(d, LIVE))['links-badcontact'], undefined);
});
