// Integration: "Show on page" (highlight.js) in a real page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './server.mjs';
import { highlightTargets, clearHighlights } from '../../modules/highlight.js';
import { collectPerformance } from '../../modules/phase4-performance.js';
import { evaluatePerformance } from '../../modules/phase4-rules.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

let srv;
let browser;
before(async () => { srv = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

// Run a self-contained module function in the page with arguments (as chrome.scripting does).
const call = (page, fn, ...args) => page.evaluate(({ src, a }) => (0, eval)(`(${src})`)(...a), { src: fn.toString(), a: args });

async function open(path) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${srv.site}${path}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  return page;
}

test('every Performance finding with targets highlights something real on the page', async () => {
  const page = await open('/perf-bad.html');
  const d = await page.evaluate(collectPerformance);
  const findings = evaluatePerformance(d, { pageType: 'product', status: 'live' }).groups.flatMap((g) => g.findings).filter((f) => f.targets);
  assert.ok(findings.length >= 3, 'several findings can be shown on the page');
  for (const f of findings) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call(page, highlightTargets, f.targets, f.check);
    assert.ok(res.found >= 1, `${f.id} found its element(s): ${JSON.stringify(f.targets)}`);
  }
  await page.close();
});

test('hostile or broken targets never throw and never touch page elements', async () => {
  const page = await open('/perf-bad.html');
  const before = await page.evaluate(() => document.body.innerHTML.length);
  const bad = [
    { kind: 'css', value: '}{' },
    { kind: 'css', value: 'a'.repeat(5000) },
    { kind: 'css', value: ':has(' },
    { kind: 'css', value: '' },
    { kind: 'css', value: 42 },
    { kind: 'desc', value: 'div#"><img src=x onerror=alert(1)>' },
    { kind: 'img', value: null },
    { kind: 'nope' },
    null,
    'img',
  ];
  const res = await call(page, highlightTargets, bad, '<b>label</b>');
  assert.equal(res.shown, 0);
  assert.equal((await call(page, highlightTargets, 'not-an-array', 'x')).shown, 0);
  assert.equal(await page.evaluate(() => document.body.innerHTML.length), before, 'page body unchanged');

  // a real target: overlay is added outside <body>, in a closed shadow root, label as text
  const ok = await call(page, highlightTargets, [{ kind: 'css', value: 'img.hero' }], '<img src=x onerror=window.__pwned=1>');
  assert.equal(ok.shown, 1);
  const overlay = await page.evaluate(() => {
    const host = document.getElementById('page-audit-lens-overlay');
    return { exists: !!host, parent: host.parentElement.tagName, shadowVisible: host.shadowRoot !== null };
  });
  assert.deepEqual(overlay, { exists: true, parent: 'HTML', shadowVisible: false });
  assert.equal(await page.evaluate(() => window.__pwned), undefined, 'label is text, never HTML');
  assert.equal(await page.evaluate(() => document.body.innerHTML.length), before, 'page body still unchanged');

  await call(page, clearHighlights);
  assert.equal(await page.evaluate(() => !!document.getElementById('page-audit-lens-overlay')), false);
  await page.close();
});
