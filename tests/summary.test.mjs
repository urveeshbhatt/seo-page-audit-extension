import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateHead } from '../modules/phase1-rules.js';
import { evaluateBody } from '../modules/phase1-body-rules.js';
import { evaluateHealth } from '../modules/phase1-health-rules.js';
import { buildSummary, suggestVerdict } from '../modules/summary.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const audit = (site, ctx) => buildSummary({
  head: evaluateHead(load(`${site}-head`), ctx),
  body: evaluateBody(load(`${site}-body`), ctx),
  health: evaluateHealth(load(`${site}-health`), ctx),
}, ctx);

const BV_PRE = { pageType: 'product', status: 'prelaunch', model: 'd2c' };
const BV_LIVE = { ...BV_PRE, status: 'live' };
const REGUS = { pageType: 'location', status: 'live', model: 'b2b' };

test('Verdict mapping', () => {
  assert.equal(suggestVerdict({ flag: 'critical' }), 'fix-now');
  assert.equal(suggestVerdict({ flag: 'warning', label: 'Launch blocker' }), 'fix-launch');
  assert.equal(suggestVerdict({ flag: 'info', label: 'Ignored' }), 'ignore');
  assert.equal(suggestVerdict({ flag: 'info', label: 'Re-check later' }), 'later');
  assert.equal(suggestVerdict({ flag: 'warning', label: 'Check' }), 'fix');
  assert.equal(suggestVerdict({ flag: 'good', label: 'Good' }), 'ok');
});

test('Buranshvalley pre-launch: not ready to launch, phone and noindex lead the list', () => {
  const s = audit('buranshvalley-product', BV_PRE);
  assert.equal(s.overall.tone, 'warning');
  assert.match(s.overall.title, /Not ready to launch/);
  assert.equal(s.totals.fixNow, 0);
  assert.equal(s.top[0].id, 'ph-phone');
  assert.equal(s.top[1].id, 'robots');
  const launchIds = s.launch.map((f) => f.id);
  ['robots', 'og-image', 'ph-text', 'ph-link', 'ph-image'].forEach((id) => assert.ok(launchIds.includes(id), id));
  assert.ok(s.ignored.some((f) => f.id === 'links-ui'));
});

test('Buranshvalley live: same data becomes critical', () => {
  const s = audit('buranshvalley-product', BV_LIVE);
  assert.equal(s.overall.tone, 'critical');
  assert.equal(s.top[0].verdict, 'fix-now');
  assert.ok(s.fixNow.some((f) => f.id === 'robots'));
});

test('Regus: good base with fixes, no blockers', () => {
  const s = audit('regus-mumbai', REGUS);
  assert.equal(s.totals.fixNow, 0);
  assert.equal(s.totals.launch, 0);
  assert.match(s.overall.title, /Good base/);
  const ids = s.fixes.map((f) => f.id);
  ['description', 'links-generic', 'dom-size', 'res-inline'].forEach((id) => assert.ok(ids.includes(id), id));
  assert.ok(s.top.length <= 7);
  assert.deepEqual(s.sections.map((x) => x.key), ['head', 'body', 'health']);
});
