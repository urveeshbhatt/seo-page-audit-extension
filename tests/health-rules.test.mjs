import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateHealth } from '../modules/phase1-health-rules.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const byId = (result) => Object.fromEntries(result.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));

const BV = { pageType: 'product', status: 'prelaunch', model: 'd2c' };
const REGUS = { pageType: 'location', status: 'live', model: 'b2b' };

test('Buranshvalley: Elementor traps ignored, CSS blocking flagged with LiteSpeed tip', () => {
  const r = evaluateHealth(load('buranshvalley-product-health'), BV);
  const f = byId(r);
  assert.equal(r.counts.critical, 0);
  assert.equal(f['hidden-unknown'].flag, 'good');
  assert.equal(f['hidden-ignored'].label, 'Ignored');
  assert.equal(f['hidden-ignored'].items.length, 9);
  assert.equal(f['css-text'].flag, 'good'); // elementor-device-mode marker is not content
  assert.equal(f['res-css'].flag, 'warning');
  assert.match(f['res-css'].why, /LiteSpeed/);
  assert.equal(f['iframe-empty'].flag, 'info'); // YouTube waiting for consent / lazy-load
  assert.match(f['stack-core'].value, /WordPress \+ WooCommerce \+ Elementor/);
});

test('Regus: Next.js weight flagged, streaming placeholders and tracking frames ignored', () => {
  const r = evaluateHealth(load('regus-mumbai-health'), REGUS);
  const f = byId(r);
  assert.equal(r.counts.critical, 0);
  assert.equal(f['dom-size'].flag, 'warning');
  assert.equal(f['dom-html'].flag, 'warning');
  assert.equal(f['res-inline'].flag, 'warning');
  assert.equal(f['hidden-expandable'].flag, 'info');
  assert.match(f['hidden-ignored'].value, /framework placeholders/);
  assert.equal(f['iframe-tracking'].label, 'Ignored');
  assert.equal(f['res-css'].flag, 'good');
  assert.match(f['stack-core'].value, /Next\.js/);
});

test('Unexplained hidden text and CSS words are flagged', () => {
  const d = load('buranshvalley-product-health');
  d.hidden.push({ el: 'div.seo-text', reason: 'display:none', chars: 640, category: 'unknown', sample: 'best a2 ghee buy a2 ghee online cheap a2 ghee' });
  d.cssText.push({ el: 'span.price', pseudo: '::before', text: 'Only today' });
  const f = byId(evaluateHealth(d, BV));
  assert.equal(f['hidden-unknown'].flag, 'warning');
  assert.equal(f['css-text'].flag, 'warning');
});

test('No analytics: warning before launch, critical when live', () => {
  const d = load('buranshvalley-product-health');
  d.stack = d.stack.filter((s) => s.group !== 'tracking');
  d.tags = { gtm: [], ga4: [], ua: [], aw: [] };
  assert.equal(byId(evaluateHealth(d, BV))['stack-tracking'].flag, 'warning');
  assert.equal(byId(evaluateHealth(d, { ...BV, status: 'live' }))['stack-tracking'].flag, 'critical');
});
