// v1.2: Phase 1 gaps closed (schema vs page, schema per page type, JS-only schema,
// X-Robots-Tag header, MINOR head items, HTML comments, canonical severity by model)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateHead } from '../modules/phase1-rules.js';
import { evaluateBody } from '../modules/phase1-body-rules.js';
import { evaluateHealth } from '../modules/phase1-health-rules.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const byId = (r) => Object.fromEntries(r.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));
const PRE = { pageType: 'product', status: 'prelaunch', model: 'd2c' };
const LIVE = { ...PRE, status: 'live' };

test('Buranshvalley live data: no price in page content (the ₹999 was the shipping bar), schema in server HTML', () => {
  const head = load('buranshvalley-product-head');
  const f = byId(evaluateBody(load('buranshvalley-product-body'), PRE, head));
  assert.equal(f['schema-price-match'].flag, 'warning');
  assert.equal(f['schema-price-match'].label, 'Check by hand');
  assert.match(f['schema-price-match'].value, /no price in page content/);
  assert.equal(f['schema-js'].flag, 'good');
  assert.equal(f['x-robots'].flag, 'good');
  assert.equal(f['schema-rating-visible'], undefined); // no rating in schema
});

test('Variant price inside the schema range is good; outside is a launch blocker / critical', () => {
  const inRange = load('buranshvalley-product-body');
  inRange.visiblePrices = ['349'];
  assert.equal(byId(evaluateBody(inRange, PRE, load('buranshvalley-product-head')))['schema-price-match'].flag, 'good');
});

test('Schema price not on page: launch blocker before launch, critical when live', () => {
  const head = load('buranshvalley-product-head');
  const body = load('buranshvalley-product-body');
  body.visiblePrices = ['2499']; // outside the 349 - 2299 range
  assert.equal(byId(evaluateBody(body, PRE, head))['schema-price-match'].label, 'Launch blocker');
  assert.equal(byId(evaluateBody(body, LIVE, head))['schema-price-match'].flag, 'critical');
  head.jsonld.products[0].highPrice = '';
  head.jsonld.products[0].price = '999.00';
  body.visiblePrices = ['999'];
  assert.equal(byId(evaluateBody(body, LIVE, head))['schema-price-match'].flag, 'good');
});

test('Rating in schema with "Reviews (0)" on the page is the fake-rating case', () => {
  const head = load('buranshvalley-product-head');
  head.jsonld.products[0].hasRating = true;
  const f = byId(evaluateBody(load('buranshvalley-product-body'), LIVE, head));
  assert.equal(f['schema-rating-visible'].flag, 'critical');
  assert.match(f['schema-rating-visible'].value, /0 reviews/);
});

test('Product schema added only by JavaScript is flagged on a product page', () => {
  const body = load('buranshvalley-product-body');
  body.raw.jsonldTypes = ['Organization', 'WebSite'];
  const f = byId(evaluateBody(body, PRE, load('buranshvalley-product-head')));
  assert.equal(f['schema-js'].flag, 'warning');
  assert.match(f['schema-js'].value, /Product/);
});

test('X-Robots-Tag noindex header: launch blocker pre-launch, critical on a live revenue page', () => {
  const body = load('regus-mumbai-body');
  body.raw.xRobots = 'noindex, nofollow';
  assert.equal(byId(evaluateBody(body, { pageType: 'location', status: 'prelaunch', model: 'b2b' }))['x-robots'].label, 'Launch blocker');
  assert.equal(byId(evaluateBody(body, { pageType: 'location', status: 'live', model: 'b2b' }))['x-robots'].flag, 'critical');
});

test('Schema expected per page type', () => {
  const regus = byId(evaluateHead(load('regus-mumbai-head'), { pageType: 'location', status: 'live', model: 'b2b' }));
  assert.equal(regus['schema-type'].flag, 'info');
  assert.equal(regus['schema-breadcrumb'].flag, 'good');
  const home = byId(evaluateHead(load('regus-mumbai-head'), { pageType: 'homepage', status: 'live', model: 'b2b' }));
  assert.match(home['schema-type'].value, /Organization/);
  assert.equal(home['schema-type'].flag, 'warning');
  const blog = byId(evaluateHead(load('regus-mumbai-head'), { pageType: 'article', status: 'live', model: 'content' }));
  assert.equal(blog['schema-type'].flag, 'warning');
});

test('Canonical missing: important for shops, low for small B2B pages', () => {
  const head = load('regus-mumbai-head');
  head.canonicals = [];
  assert.equal(byId(evaluateHead(head, { pageType: 'service', status: 'live', model: 'b2b' })).canonical.flag, 'info');
  assert.equal(byId(evaluateHead(head, { pageType: 'product', status: 'live', model: 'd2c' })).canonical.flag, 'warning');
});

test('MINOR bucket: meta keywords and favicon are notes, never warnings', () => {
  const head = load('regus-mumbai-head');
  head.extras = { metaKeywords: 'office, coworking', favicon: false, preconnect: [] };
  const f = byId(evaluateHead(head, { pageType: 'location', status: 'live', model: 'b2b' }));
  assert.equal(f['meta-keywords'].flag, 'info');
  assert.equal(f.favicon.flag, 'info');
  assert.equal(f.preconnect, undefined);
});

test('HTML comments: stack clues are info, leaked staging URLs are a warning', () => {
  const bv = byId(evaluateHealth(load('buranshvalley-product-health'), PRE));
  assert.equal(bv['html-comments'].flag, 'info');
  assert.equal(bv['html-comments-leak'], undefined);
  const leaky = load('buranshvalley-product-health');
  leaky.comments.push('TODO: remove before launch, staging.buranshvalley.com');
  assert.equal(byId(evaluateHealth(leaky, PRE))['html-comments-leak'].flag, 'warning');
});
