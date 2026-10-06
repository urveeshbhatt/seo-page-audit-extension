// Golden tests: real page data from 6 Oct 2026, verdicts from the manual Phase 1 audit.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateHead } from '../modules/phase1-rules.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const byId = (res) => Object.fromEntries(res.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));

test('Buranshvalley product, pre-launch', () => {
  const r = evaluateHead(load('buranshvalley-product-head.json'), { pageType: 'product', status: 'prelaunch', model: 'd2c' });
  const f = byId(r);
  assert.equal(f.robots.label, 'Launch blocker');        // noindex is planned, not critical
  assert.equal(f.canonical.flag, 'info');                // 0 canonical on noindex page: re-check later
  assert.equal(f.title.flag, 'good');                    // 53 chars
  assert.equal(f.description.flag, 'good');              // 146 chars
  assert.equal(f['og-image'].label, 'Launch blocker');   // test image in og:image
  assert.equal(f['schema-name'].flag, 'good');           // fixed via WPCode snippet
  assert.equal(f['schema-brand'].flag, 'good');
  assert.equal(f['schema-rating'].flag, 'info');         // no reviews yet
  assert.equal(r.counts.critical, 0);
});

test('Same Buranshvalley page if it were live', () => {
  const r = evaluateHead(load('buranshvalley-product-head.json'), { pageType: 'product', status: 'live', model: 'd2c' });
  assert.equal(byId(r).robots.flag, 'critical');
});

test('Regus Mumbai city page, live B2B', () => {
  const r = evaluateHead(load('regus-mumbai-head.json'), { pageType: 'location', status: 'live', model: 'b2b' });
  const f = byId(r);
  assert.equal(f.robots.flag, 'good');
  assert.equal(f.canonical.flag, 'good');                // self-referencing
  assert.equal(f.og.flag, 'warning');                    // 0 OG tags
  assert.equal(f.description.flag, 'warning');           // 187 chars
  assert.equal(f.hreflang.flag, 'good');                 // lists itself
  assert.equal(r.counts.critical, 0);
});

test('Canonical pointing to homepage is critical', () => {
  const d = load('regus-mumbai-head.json');
  const r = evaluateHead({ ...d, canonicals: ['https://www.regus.com/'] }, { pageType: 'location', status: 'live', model: 'b2b' });
  assert.equal(byId(r).canonical.flag, 'critical');
});
