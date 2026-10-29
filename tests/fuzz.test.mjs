// Fuzz tests: feed every rules module thousands of damaged copies of real
// captures (missing keys, null, wrong types, HTML strings, __proto__).
// Found while trying to break the extension (v1.5.0): older modules crash on
// unexpected shapes, so the side panel judges every section through
// safeEvaluate(), which turns a crash into one "could not judge" finding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateHead } from '../modules/phase1-rules.js';
import { evaluateBody } from '../modules/phase1-body-rules.js';
import { evaluateHealth } from '../modules/phase1-health-rules.js';
import { evaluateBusiness } from '../modules/business-rules.js';
import { evaluateNetwork } from '../modules/phase2-rules.js';
import { evaluateRendering } from '../modules/phase3-rules.js';
import { evaluatePerformance } from '../modules/phase4-rules.js';
import { safeEvaluate } from '../modules/safe-evaluate.js';
import { buildSummary } from '../modules/summary.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));
const CTX = { pageType: 'product', status: 'live', model: 'd2c' };

function rng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}
const JUNK = [null, undefined, '', 'x', 0, -1, NaN, 1e12, [], {}, [null], true, '<img src=x onerror=1>', JSON.parse('{"__proto__":{"polluted":1}}')];
function mutate(o, rnd) {
  if (Array.isArray(o)) return o.map((x) => (rnd() < 0.1 ? JUNK[Math.floor(rnd() * JUNK.length)] : mutate(x, rnd)));
  if (o && typeof o === 'object') {
    const c = {};
    Object.entries(o).forEach(([k, v]) => {
      const r = rnd();
      if (r < 0.08) return;
      c[k] = r < 0.18 ? JUNK[Math.floor(rnd() * JUNK.length)] : mutate(v, rnd);
    });
    return c;
  }
  return o;
}

test('safeEvaluate returns the rules result untouched when nothing goes wrong', () => {
  const d = fx('twobrothers-product-performance');
  assert.deepEqual(safeEvaluate(evaluatePerformance, d, CTX), evaluatePerformance(d, CTX));
});

test('safeEvaluate turns a crash into one "could not judge" finding with correct counts', () => {
  const r = safeEvaluate(() => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); }, {}, CTX);
  assert.equal(r.groups.length, 1);
  const f = r.groups[0].findings[0];
  assert.equal(f.id, 'rules-error');
  assert.equal(f.flag, 'info');
  assert.equal(f.label, 'Check by hand');
  assert.match(f.why, /reading 'x'/);
  assert.deepEqual(r.counts, { critical: 0, warning: 0, good: 0, info: 1 });
  // a rules function that returns garbage is treated the same way
  assert.equal(safeEvaluate(() => null, {}, CTX).groups[0].findings[0].id, 'rules-error');
  assert.equal(safeEvaluate(() => ({ groups: 'x' }), {}, CTX).groups[0].findings[0].id, 'rules-error');
  // and it flows into the summary like any other section
  const s = buildSummary({ head: r }, CTX);
  assert.equal(s.sections[0].key, 'head');
});

test('Performance rules never throw on 2,000 damaged real captures', () => {
  const base = fx('twobrothers-product-performance');
  const rnd = rng(42);
  for (let i = 0; i < 2000; i += 1) {
    const d = mutate(base, rnd);
    const r = evaluatePerformance(d, CTX);
    assert.ok(Array.isArray(r.groups));
    const n = r.groups.flatMap((g) => g.findings).length;
    assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), n);
  }
  assert.equal(({}).polluted, undefined);
});

const CASES = [
  ['head', evaluateHead, ['buranshvalley-product-head', 'regus-mumbai-head'], () => undefined],
  ['body', evaluateBody, ['buranshvalley-product-body', 'regus-mumbai-body'], (f) => fx(f.replace('body', 'head'))],
  ['health', evaluateHealth, ['buranshvalley-product-health', 'regus-mumbai-health'], () => undefined],
  ['business', evaluateBusiness, ['buranshvalley-product-signals', 'regus-mumbai-signals'], () => undefined],
  ['network', evaluateNetwork, ['buranshvalley-product-network', 'regus-mumbai-network'], () => ({ head: null, redirects: null })],
  ['rendering', evaluateRendering, ['buranshvalley-product-rendering', 'regus-mumbai-rendering'], () => ({ network: null })],
];

for (const [name, evaluate, files, extraFor] of CASES) {
  test(`${name}: through safeEvaluate, 800 damaged captures always give a well-formed section`, () => {
    const rnd = rng(7);
    let crashes = 0;
    files.forEach((file) => {
      const base = fx(file);
      for (let i = 0; i < 400; i += 1) {
        const r = safeEvaluate(evaluate, mutate(base, rnd), CTX, extraFor(file));
        assert.ok(Array.isArray(r.groups) && r.groups.length);
        const n = r.groups.flatMap((g) => g.findings).length;
        assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), n);
        if (r.error) crashes += 1;
      }
    });
    // Not a pass/fail target: recorded so the hardening work can be tracked.
    console.log(`# fuzz ${name}: ${crashes}/800 inputs needed the safety net`);
  });
}
