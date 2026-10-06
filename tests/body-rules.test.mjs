import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateBody } from '../modules/phase1-body-rules.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const byId = (result) => Object.fromEntries(result.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));

const BV_PRE = { pageType: 'product', status: 'prelaunch', model: 'd2c' };
const BV_LIVE = { pageType: 'product', status: 'live', model: 'd2c' };
const REGUS = { pageType: 'location', status: 'live', model: 'b2b' };

test('Buranshvalley pre-launch: placeholders are launch blockers, not critical', () => {
  const r = evaluateBody(load('buranshvalley-product-body'), BV_PRE);
  const f = byId(r);
  assert.equal(r.counts.critical, 0);
  assert.equal(f['ph-text'].label, 'Launch blocker');
  assert.equal(f['ph-text'].items.length, 5);
  assert.ok(f['ph-text'].items.some((i) => i.includes('[Manju bhatt]')));
  assert.equal(f['ph-phone'].value, '3 links');
  assert.equal(f['ph-link'].value, '1 link');
  assert.equal(f['ph-image'].value, '4 images');
});

test('Buranshvalley pre-launch: traps are ignored, real wins are good', () => {
  const f = byId(evaluateBody(load('buranshvalley-product-body'), BV_PRE));
  assert.equal(f['raw-tests'].flag, 'good');
  assert.equal(f.h1.flag, 'good');
  assert.equal(f['img-hero'].flag, 'good');
  assert.equal(f['img-autoalt'].flag, 'info');
  assert.equal(f['links-ok'].flag, 'good'); // accordion anchors without href are UI controls
  assert.equal(f['links-ui'].label, 'Ignored');
  assert.equal(f['links-phones'].flag, 'warning'); // 91XXXXXXXXXX vs real number
  assert.equal(f['img-noalt'], undefined);
});

test('Buranshvalley live: the same placeholders become critical', () => {
  const f = byId(evaluateBody(load('buranshvalley-product-body'), BV_LIVE));
  assert.equal(f['ph-text'].flag, 'critical');
  assert.equal(f['ph-phone'].flag, 'critical');
  assert.equal(f['ph-image'].flag, 'critical');
});

test('Regus Mumbai: generic anchors and alt flagged, pixels ignored', () => {
  const r = evaluateBody(load('regus-mumbai-body'), REGUS);
  const f = byId(r);
  assert.equal(r.counts.critical, 0);
  assert.equal(f['ph-none'].flag, 'good');
  assert.equal(f['raw-tests'].flag, 'good');
  assert.equal(f['links-generic'].flag, 'warning');
  assert.match(f['links-generic'].value, /6 visible/);
  assert.equal(f['img-genericalt'].flag, 'warning');
  assert.ok(f['img-genericalt'].items.some((i) => i.includes('"Brand"')));
  assert.equal(f['img-trackers'].label, 'Ignored');
  assert.equal(f['img-noalt'], undefined); // pixel without alt is not a finding
  assert.equal(f['links-blankcontact'].flag, 'info'); // hidden "call" button with tel:
  assert.equal(f['h-outline'].flag, 'info'); // 103 headings
});

test('JS-only H1 on a revenue page is critical', () => {
  const d = load('regus-mumbai-body');
  d.raw.tests = d.raw.tests.map((t) => (t.kind === 'H1' ? { ...t, inRaw: false } : t));
  d.raw.h1Count = 0;
  const f = byId(evaluateBody(d, REGUS));
  assert.equal(f['raw-tests'].flag, 'critical');
  assert.equal(f['raw-h1'].flag, 'warning');
});

test('Blocked raw fetch asks for a manual check', () => {
  const d = load('regus-mumbai-body');
  d.raw = { ok: false, reason: 'Very small response (possible bot protection). Check with Ctrl+U.', bytes: 212, words: 0, tests: [], linkCount: 0, h1Count: 0 };
  const f = byId(evaluateBody(d, REGUS));
  assert.equal(f.raw.label, 'Check by hand');
});
