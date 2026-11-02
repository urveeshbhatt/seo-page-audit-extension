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

test('Site tab: scan the local site from the side panel, see site-level findings, stop works', async () => {
  const { site, panel, problems } = await openPanelFor('/site/index.html');
  // the Site tab works without running the page audit first
  assert.equal(await panel.getAttribute('.tab[data-tab="site"]', 'disabled'), null);
  await panel.click('.tab[data-tab="site"]');
  await panel.selectOption('#site-limit', '50');
  await panel.click('#site-run');
  await panel.waitForFunction(() => /^(Stopped early\. )?Scanned \d+ of \d+ URLs/.test(document.getElementById('site-status').textContent), null, { timeout: 60000 });
  const status = await panel.textContent('#site-status');
  assert.match(status, /Scanned 12 of 13 URLs/);
  const groups = await panel.textContent('#site-groups');
  for (const check of ['Duplicate titles', 'Thin pages', 'Broken internal links', 'Noindex pages in the sitemap', 'Listed URLs that redirect', 'Pages no scanned page links to']) {
    assert.match(groups, new RegExp(check), check);
  }
  assert.equal(await panel.isVisible('#site-md'), true, 'download button shown after a scan');
  // page text is shown as text, never as HTML
  assert.equal(await panel.locator('#site-groups script').count(), 0);

  // Stop: a second scan stopped right away reports "Stopped early"
  await panel.click('#site-run');
  await panel.click('#site-stop');
  await panel.waitForFunction(() => /Stopped early|Scanned/.test(document.getElementById('site-status').textContent) && !document.getElementById('site-run').disabled, null, { timeout: 60000 });
  assert.match(await panel.textContent('#site-status'), /Stopped early/);

  assert.deepEqual(problems, [], 'no console errors or CSP violations in the side panel');
  await site.close();
  await panel.close();
});
