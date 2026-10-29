// Packaging checks: things Chrome or the Web Store would reject, and the
// security promises in SECURITY.md that live in manifest.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

test('Web Store limits: name ≤ 75, short_name ≤ 12, description ≤ 132 characters', () => {
  assert.ok(manifest.name.length <= 75);
  assert.ok(manifest.short_name.length <= 12);
  assert.ok(manifest.description.length <= 132, `description is ${manifest.description.length} characters`);
});

test('versions agree: manifest, package.json and the top CHANGELOG entry', () => {
  assert.equal(pkg.version, manifest.version);
  assert.match(changelog, new RegExp(`^## ${manifest.version.replace(/\./g, '\\.')} `, 'm'));
  assert.equal(changelog.indexOf(`## ${manifest.version}`), changelog.indexOf('## '), 'newest version is first');
});

test('security promises: no install-time host access, optional permissions only, strict CSP', () => {
  assert.equal(manifest.host_permissions, undefined, 'no host access at install');
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'scripting', 'sidePanel']);
  assert.deepEqual(manifest.optional_permissions, ['webRequest']);
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline/);
});

test('every file the manifest and side panel point to exists', () => {
  const files = [manifest.background.service_worker, manifest.side_panel.default_path, ...Object.values(manifest.icons)];
  files.forEach((f) => assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f));
  const html = readFileSync(new URL('../sidepanel/sidepanel.html', import.meta.url), 'utf8');
  [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].forEach(([, f]) => assert.ok(existsSync(new URL(`../sidepanel/${f}`, import.meta.url)), f));
});

test('no remote code or eval in shipped code', () => {
  ['background.js', 'sidepanel/sidepanel.js', 'modules/phase4-performance.js', 'modules/phase4-rules.js', 'modules/highlight.js', 'modules/safe-evaluate.js'].forEach((f) => {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\beval\(|new Function\(|innerHTML\s*=|insertAdjacentHTML|document\.write\(/, f);
    assert.doesNotMatch(src, /import\s+[^;]*from\s+['"]https?:/, f);
  });
});
