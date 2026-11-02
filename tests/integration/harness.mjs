// Shared setup for end-to-end tests: a temporary copy of the extension with
// host access to the local test server, loaded into Chromium.
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const REPO = fileURLToPath(new URL('../../', import.meta.url));

export async function startExtension() {
  const srv = await startServer();
  const extDir = await mkdtemp(join(tmpdir(), 'pal-ext-'));
  const profile = await mkdtemp(join(tmpdir(), 'pal-profile-'));
  for (const item of ['manifest.json', 'background.js', 'modules', 'sidepanel', 'icons']) {
    // eslint-disable-next-line no-await-in-loop
    await cp(join(REPO, item), join(extDir, item), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
  await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;

  async function openPanelFor(path, { settle = 1500 } = {}) {
    const site = await context.newPage();
    await site.setViewportSize({ width: 1280, height: 800 });
    await site.goto(`${srv.site}${path}`, { waitUntil: 'load', timeout: 60000 });
    await site.waitForTimeout(settle);
    const [worker] = context.serviceWorkers();
    const tab = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0], site.url());
    if (!tab || !tab.id) throw new Error(`fixture tab not found for ${site.url()}`);
    const panel = await context.newPage();
    const problems = [];
    panel.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    panel.on('pageerror', (e) => problems.push(String(e)));
    await panel.addInitScript(([id, url]) => { chrome.tabs.query = async () => [{ id, url, active: true }]; }, [tab.id, tab.url]);
    await panel.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    return { site, panel, problems };
  }

  async function audit(panel, timeout = 90000) {
    const started = Date.now();
    await panel.click('#audit-btn');
    await panel.waitForFunction(() => /^(Done|Audit failed|Chrome does not allow|No access|This tab shows|The page changed)/.test(document.getElementById('status').textContent), null, { timeout });
    return { status: await panel.textContent('#status'), ms: Date.now() - started };
  }

  async function stop() {
    await context.close();
    await srv.close();
    await rm(extDir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }

  return { srv, context, extId, openPanelFor, audit, stop };
}
