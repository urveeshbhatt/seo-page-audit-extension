// End-to-end: load the unpacked extension in Chromium, open the side panel UI,
// run a full audit on a local fixture page and check every tab.
//
// Two test-only changes, made on a temporary copy (the real files are untouched):
//   1. host_permissions for the local test server. In real use Chrome grants
//      access when the user clicks the toolbar icon (activeTab), which a test
//      cannot click.
//   2. The side panel runs here as a normal extension page, so chrome.tabs.query
//      is pointed at the fixture tab (in real use it returns the tab beside the panel).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startExtension } from './harness.mjs';

let h;
before(async () => { h = await startExtension(); });
after(async () => { await h?.stop(); });

const openPanelFor = (path) => h.openPanelFor(path);
async function audit(panel) {
  const { status } = await h.audit(panel);
  return status;
}

test('full audit from the side panel on a bad page: every tab works, Performance finds the planted bugs', async () => {
  const { site, panel, problems } = await openPanelFor('/perf-bad.html');
  const status = await audit(panel);
  assert.match(status, /^Done\. \d+ critical/);

  for (const tab of ['summary', 'head', 'body', 'health', 'business', 'network', 'rendering', 'performance', 'report']) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await panel.getAttribute(`.tab[data-tab="${tab}"]`, 'disabled'), null, `${tab} tab enabled`);
  }
  await panel.click('.tab[data-tab="performance"]');
  const perf = await panel.textContent('#performance-groups');
  assert.match(perf, /Animations that move layout/);
  assert.match(perf, /LCP image is lazy-loaded/);
  assert.match(perf, /Render-blocking files/);
  assert.match(perf, /Duplicate tags/);
  assert.match(await panel.textContent('#sum-sections'), /Performance/);

  // "Show on page" from a Performance finding draws the overlay on the audited tab
  const btn = panel.locator('#performance-groups .finding', { hasText: 'Animations that move layout' }).locator('.show-btn');
  await btn.click();
  await site.waitForFunction(() => !!document.getElementById('page-audit-lens-overlay'), null, { timeout: 5000 });

  // Report tab lists performance findings
  await panel.click('.tab[data-tab="report"]');
  assert.match(await panel.textContent('#rep-list'), /Animations that move layout/);

  assert.deepEqual(problems, [], 'no console errors or CSP violations in the side panel');
  await site.close();
  await panel.close();
});

test('context change re-judges Performance without touching the page again', async () => {
  const { site, panel, problems } = await openPanelFor('/perf-bad.html');
  await audit(panel);
  await panel.click('.tab[data-tab="setup"]');
  await panel.selectOption('select[name="pageType"]', 'article').catch(async () => {
    await panel.check('input[name="pageType"][value="article"]');
  });
  await panel.waitForFunction(() => /Re-judged/.test(document.getElementById('status').textContent));
  await panel.click('.tab[data-tab="performance"]');
  // Blog page: a layout animation is a warning, not critical
  const card = panel.locator('#performance-groups .finding', { hasText: 'Animations that move layout' });
  assert.match(await card.getAttribute('class'), /finding-warning/);
  assert.deepEqual(problems, []);
  await site.close();
  await panel.close();
});

test('good page: Performance tab has no critical findings', async () => {
  const { site, panel, problems } = await openPanelFor('/perf-good.html');
  await audit(panel);
  await panel.click('.tab[data-tab="performance"]');
  assert.equal(await panel.locator('#performance-groups .finding-critical').count(), 0);
  assert.deepEqual(problems, []);
  await site.close();
  await panel.close();
});
