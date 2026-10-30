// Captures what every collector returns on the local integration pages, so the
// rules schemas (modules/schemas.js) are inferred from real collector output on
// many kinds of pages, not just two. Run: node scripts/capture-collector-outputs.mjs
// Needs Playwright + Chromium. Output: tests/fixtures/captured/<page>-<section>.json
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { startServer } from '../tests/integration/server.mjs';
import { collectHead, collectBody, collectHealth, collectSignals } from '../modules/phase1-elements.js';
import { collectNetwork } from '../modules/phase2-network.js';
import { collectRendering } from '../modules/phase3-rendering.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PAGES = ['perf-bad', 'perf-good', 'hostile-markup', 'quirks', 'csp-strict', 'busy', 'shopify-horizon']; // huge-dom left out: 400 KB of body data
const COLLECTORS = { head: collectHead, body: collectBody, health: collectHealth, signals: collectSignals, network: collectNetwork, rendering: collectRendering };

const srv = await startServer();
const browser = await chromium.launch();
for (const name of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${srv.site}/${name}.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  for (const [section, fn] of Object.entries(COLLECTORS)) {
    // eslint-disable-next-line no-await-in-loop
    const data = await page.evaluate(fn);
    // ports change on every run: make captures stable
    const text = JSON.stringify(data, null, 1).replace(/(127\.0\.0\.1|localhost):\d+/g, '$1:8080');
    // eslint-disable-next-line no-await-in-loop
    await writeFile(new URL(`../tests/fixtures/captured/${name}-${section}.json`, import.meta.url), `${text}\n`);
  }
  await page.close();
  console.log(`captured ${name}`);
}
await browser.close();
await srv.close();
