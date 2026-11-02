// Phase 5 Site scan rules. Cases come from the hillshoporganics.com audit
// (30 Oct 2026): demo collections in the sitemap, products with no
// description, a copied product with the same meta, policy pages not linked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSite, linksToCheck, normalizeUrl, duplicates, siteToMarkdown } from '../modules/phase5-rules.js';

const O = 'https://shop.example';
const byId = (r) => Object.fromEntries(r.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));
const LIVE = { pageType: 'home', status: 'live', model: 'd2c' };
const words300 = 300;
const page = (path, o = {}) => ({
  url: `${O}${path}`, status: 200, finalUrl: `${O}${path}`, redirected: false, type: 'text/html; charset=utf-8',
  title: `Page ${path}`, description: `About ${path}`, robots: '', xRobots: '', canonical: `${O}${path}`,
  h1Count: 1, h1: [`H ${path}`], words: words300, links: [`${O}/`], ...o,
});
const site = (pages, o = {}) => ({
  origin: O, host: 'shop.example', startUrl: `${O}/`, source: 'sitemap', robotsSitemaps: 1,
  sitemaps: [{ url: `${O}/sitemap.xml`, status: 200, kind: 'urlset', count: pages.length }],
  urls: pages.map((p) => p.url), totalListed: pages.length, offSite: 0, offSiteSamples: [], limit: 100, pages, linkChecks: [], ...o,
});

test('a clean site: every check passes', () => {
  const home = page('/', { links: [`${O}/a`, `${O}/b`] });
  const r = evaluateSite(site([home, page('/a'), page('/b')]), LIVE);
  assert.equal(r.counts.warning, 0, JSON.stringify(r.groups.flatMap((g) => g.findings).filter((f) => f.flag !== 'good').map((f) => f.id)));
  const f = byId(r);
  ['site-sitemap', 'site-status-error', 'site-canonical-other', 'site-title-dup', 'site-desc-missing', 'site-thin', 'site-broken-links'].forEach((id) => assert.equal(f[id].flag, 'good', id));
});

test('hillshoporganics patterns: demo collection, empty product, copied product', () => {
  const home = page('/', { links: [`${O}/products/ghee`, `${O}/products/ghee-copy`, `${O}/products/jamun-honey`] });
  const pages = [
    home,
    page('/products/ghee', { title: 'A2 Pahadi Cow Ghee', description: 'Buy Pahadi Cow Bilona Ghee online.' }),
    page('/products/ghee-copy', { title: 'Pahadi Cow Ghee Dolchi', description: 'Buy Pahadi Cow Bilona Ghee online.' }),
    page('/products/jamun-honey', { description: null, words: 40 }),
    page('/collections/asset-pack-1-example-products', { title: 'Default example products', description: null, words: 12 }),
  ];
  const f = byId(evaluateSite(site(pages), LIVE));
  assert.match(f['site-desc-dup'].items[0], /× 2: \/products\/ghee, \/products\/ghee-copy/);
  assert.equal(f['site-desc-missing'].items.length, 2);
  assert.ok(f['site-thin'].items.some((x) => /12 words · \/collections\/asset-pack-1-example-products · "Default example products"/.test(x)));
  assert.ok(f['site-orphans'].items.includes('/collections/asset-pack-1-example-products'));
});

test('status: 404 in the sitemap, a redirecting URL, a non-HTML URL', () => {
  const pages = [
    page('/', { links: [`${O}/new`] }),
    page('/gone', { status: 404, type: 'text/html' }),
    page('/old', { redirected: true, finalUrl: `${O}/new` }),
    page('/file', { type: 'application/pdf' }),
  ];
  const f = byId(evaluateSite(site(pages), LIVE));
  assert.deepEqual(f['site-status-error'].items, ['404 · /gone']);
  assert.deepEqual(f['site-redirected'].items, ['/old → /new']);
  assert.match(f['site-not-html'].items[0], /application\/pdf · \/file/);
});

test('indexing: noindex in the sitemap (info before launch), canonical to another page', () => {
  const pages = [page('/', { links: [`${O}/thanks`, `${O}/ship`] }), page('/thanks', { robots: 'noindex, follow' }), page('/ship', { canonical: `${O}/` })];
  const live = byId(evaluateSite(site(pages), LIVE));
  assert.equal(live['site-noindex'].flag, 'warning');
  assert.deepEqual(live['site-canonical-other'].items, ['/ship → /']);
  const pre = byId(evaluateSite(site(pages), { ...LIVE, status: 'prelaunch' }));
  assert.equal(pre['site-noindex'].flag, 'info');
  // X-Robots-Tag header counts too
  const hdr = byId(evaluateSite(site([page('/', { links: [`${O}/x`] }), page('/x', { xRobots: 'noindex' })]), LIVE));
  assert.match(hdr['site-noindex'].items[0], /X-Robots-Tag: noindex/);
});

test('noindex pages are left out of title, description, thin and orphan checks', () => {
  const pages = [page('/'), page('/account', { robots: 'noindex', description: null, words: 3, title: '' })];
  const f = byId(evaluateSite(site(pages), LIVE));
  assert.equal(f['site-desc-missing'].flag, 'good');
  assert.equal(f['site-thin'].flag, 'good');
  assert.equal(f['site-title-missing'], undefined);
  assert.equal(f['site-orphans'], undefined);
});

test('a listed URL that redirects is not counted again as a duplicate or thin page of its target', () => {
  const pages = [page('/', { links: [`${O}/new`] }), page('/new', { title: 'Same' }), page('/old', { title: 'Same', redirected: true, finalUrl: `${O}/new`, words: 10 })];
  const f = byId(evaluateSite(site(pages), LIVE));
  assert.equal(f['site-title-dup'].flag, 'good');
  assert.equal(f['site-thin'].flag, 'good');
  assert.deepEqual(f['site-redirected'].items, ['/old → /new']);
});

test('headings: missing and several H1s', () => {
  const pages = [page('/', { links: [`${O}/c`, `${O}/a`] }), page('/c', { h1Count: 0, h1: [] }), page('/a', { h1Count: 2, h1: ['About', 'Farms'] })];
  const f = byId(evaluateSite(site(pages), LIVE));
  assert.deepEqual(f['site-h1-missing'].items, ['/c']);
  assert.match(f['site-h1-multi'].items[0], /About \| Farms/);
});

test('long descriptions (Shopify fills 320 characters) are info', () => {
  const f = byId(evaluateSite(site([page('/', { description: 'x'.repeat(320) })]), LIVE));
  assert.equal(f['site-desc-long'].flag, 'info');
  assert.match(f['site-desc-long'].items[0], /^320 chars/);
});

test('broken internal links come from link checks, with the pages that link to them', () => {
  const pages = [page('/', { links: [`${O}/a`, `${O}/old-offer`] }), page('/a', { links: [`${O}/old-offer`] })];
  const d = site(pages, { linkChecks: [{ url: `${O}/old-offer`, status: 404, type: 'text/html', redirected: false }] });
  const f = byId(evaluateSite(d, LIVE));
  assert.equal(f['site-broken-links'].flag, 'warning');
  assert.equal(f['site-broken-links'].items[0], '404 · /old-offer ← /, /a');
});

test('orphans: warning on a full scan, info when only part was scanned; the start page is never an orphan', () => {
  const pages = [page('/'), page('/lonely')];
  assert.equal(byId(evaluateSite(site(pages), LIVE))['site-orphans'].flag, 'warning');
  assert.equal(byId(evaluateSite(site(pages, { totalListed: 500 }), LIVE))['site-orphans'].flag, 'info');
  const fromLinks = byId(evaluateSite(site(pages, { source: 'links' }), LIVE));
  assert.equal(fromLinks['site-orphans'], undefined, 'no sitemap: orphans cannot be judged');
  assert.equal(fromLinks['site-sitemap'].flag, 'warning');
});

test('linked pages missing from the sitemap (not filters)', () => {
  const pages = [page('/', { links: [`${O}/hidden-product`, `${O}/collections/all?sort=price`] })];
  const d = site(pages, { linkChecks: [
    { url: `${O}/hidden-product`, status: 200, type: 'text/html', redirected: false },
    { url: `${O}/collections/all?sort=price`, status: 200, type: 'text/html', redirected: false },
  ] });
  assert.deepEqual(byId(evaluateSite(d, LIVE))['site-not-in-sitemap'].items, ['/hidden-product']);
});

test('sitemap problems: broken sitemap file, off-site URLs, partial scan', () => {
  const d = site([page('/')], {
    sitemaps: [{ url: `${O}/sitemap.xml`, status: 404, kind: '', count: 0 }, { url: `${O}/s2.xml`, status: 200, kind: 'urlset', count: 900 }],
    offSite: 2, offSiteSamples: ['https://staging.example/a'], totalListed: 900,
  });
  const f = byId(evaluateSite(d, LIVE));
  assert.match(f['site-sitemap-broken'].items[0], /\/sitemap\.xml · 404/);
  assert.equal(f['site-offsite'].flag, 'warning');
  assert.match(f['site-scope'].value, /1 of 900 URLs scanned/);
});

test('linksToCheck lists unscanned internal links once, skipping files', () => {
  const d = site([page('/', { links: [`${O}/a`, `${O}/a#x`, `${O}/img.png`, `${O}/`] }), page('/b', { links: [`${O}/a`, `${O}/c`] })]);
  assert.deepEqual(linksToCheck(d, 10), [`${O}/a`, `${O}/c`]);
  assert.deepEqual(linksToCheck(d, 1), [`${O}/a`]);
});

test('helpers: normalizeUrl drops the fragment; duplicates ignores empty values and case', () => {
  assert.equal(normalizeUrl(`${O}/a#top`), `${O}/a`);
  assert.equal(normalizeUrl('not a url'), 'not a url');
  const g = duplicates([{ t: 'A' }, { t: 'a ' }, { t: '' }, { t: '' }, { t: 'B' }], 't');
  assert.equal(g.length, 1);
  assert.equal(g[0].length, 2);
});

test('markdown export escapes page text', () => {
  const r = evaluateSite(site([page('/', { title: '<script>x</script> *A*', links: [] }), page('/b', { title: '<script>x</script> *A*' })]), LIVE);
  const md = siteToMarkdown(r, { title: 'Site scan', url: O, date: '2026-11-02', version: '1.6.0' });
  assert.match(md, /Duplicate titles/);
  assert.ok(!md.includes('<script>'), 'HTML escaped');
});

test('junk input never crashes', () => {
  for (const junk of [null, 5, 'x', [], { pages: 'x' }, { pages: [null, 5, {}, { url: 7 }] }, { pages: [{ url: `${O}/`, links: 'x', h1: 5, status: '200' }], sitemaps: [null, 3], linkChecks: [null, { url: 5 }] }]) {
    assert.doesNotThrow(() => evaluateSite(junk, LIVE));
    assert.doesNotThrow(() => linksToCheck(junk, 5));
    assert.doesNotThrow(() => siteToMarkdown(evaluateSite(junk)));
  }
});

test('fuzz: 1,500 damaged scans never crash and always return well-formed groups', () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const JUNK = [null, undefined, 0, -1, NaN, '', 'x', [], {}, [null], { url: 5 }, true, 'https://other.example/', `${O}/#`];
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const mutate = (v, depth) => {
    if (depth > 4) return v;
    if (Array.isArray(v)) return rnd() < 0.15 ? pick(JUNK) : v.map((x) => mutate(x, depth + 1));
    if (v && typeof v === 'object') {
      const o = {};
      Object.entries(v).forEach(([k, x]) => { if (rnd() < 0.1) return; o[k] = rnd() < 0.15 ? pick(JUNK) : mutate(x, depth + 1); });
      return o;
    }
    return rnd() < 0.1 ? pick(JUNK) : v;
  };
  const good = site([page('/', { links: [`${O}/a`, `${O}/b`, `${O}/old`] }), page('/a', { title: 'Same' }), page('/b', { title: 'Same', words: 20, description: null }), page('/old', { redirected: true, finalUrl: `${O}/a` })],
    { linkChecks: [{ url: `${O}/gone`, status: 404, type: 'text/html' }] });
  for (let i = 0; i < 1500; i += 1) {
    const r = evaluateSite(mutate(good, 0), pick([LIVE, {}, null, { status: 'prelaunch' }]));
    assert.ok(Array.isArray(r.groups));
    assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), r.groups.flatMap((g) => g.findings).length);
  }
});

// ---------------- live test round, 2 Nov 2026 ----------------

test('a link with ?variant= reaches the product page: it is not an orphan (Shopify product cards)', () => {
  const home = page('/', { links: [`${O}/products/neem-honey?variant=518144`, `${O}/a`] });
  const f = byId(evaluateSite(site([home, page('/products/neem-honey'), page('/a')]), LIVE));
  assert.ok(!f['site-orphans'], JSON.stringify(f['site-orphans'] && f['site-orphans'].items));
  // and the same product with a query is not queued again for a link check
  assert.deepEqual(linksToCheck(site([home, page('/products/neem-honey'), page('/a')])), []);
});

test('a login link that redirects to another site is not a broken link (Shopify /account)', () => {
  const home = page('/', { links: [`${O}/account`, `${O}/customer_authentication/redirect?locale=en`] });
  const checks = [
    { url: `${O}/account`, status: 0, finalUrl: '', redirected: true, offsite: true, type: '', error: '' },
    { url: `${O}/customer_authentication/redirect?locale=en`, status: 0, finalUrl: '', redirected: true, offsite: true, type: '', error: '' },
  ];
  const f = byId(evaluateSite(site([home], { linkChecks: checks }), LIVE));
  assert.equal(f['site-broken-links'].flag, 'good');
});

test('a sitemap URL that redirects to another site is listed as a redirect, not an error', () => {
  const pages = [page('/'), page('/login', { status: 0, finalUrl: '', redirected: true, offsite: true, type: '' })];
  const f = byId(evaluateSite(site(pages), LIVE));
  assert.equal(f['site-status-error'].flag, 'good');
  assert.deepEqual(f['site-redirected'].items, ['/login → another site']);
});

test('before launch every page is noindex on purpose: titles, descriptions, H1 and thin pages are still checked (Buranshvalley)', () => {
  const NI = { robots: 'noindex, nofollow' };
  const home = page('/', { ...NI, links: [`${O}/a`, `${O}/b`] });
  const pages = [home, page('/a', { ...NI, title: 'Same', description: null }), page('/b', { ...NI, title: 'Same', words: 20, h1Count: 0 })];
  const f = byId(evaluateSite(site(pages), { ...LIVE, status: 'prelaunch' }));
  assert.equal(f['site-noindex'].flag, 'info');
  assert.equal(f['site-title-dup'].flag, 'warning');
  assert.ok(f['site-desc-missing'].items.some((x) => /\/a/.test(x)));
  assert.ok(f['site-thin'].items.some((x) => /\/b/.test(x)));
  assert.ok(f['site-h1-missing'].items.includes('/b'));
  // live site: the same noindex pages stay out of those checks
  const live = byId(evaluateSite(site(pages), LIVE));
  assert.equal(live['site-title-dup'].flag, 'good');
});

test('a sitemap URL that redirects is not listed as a second source of a broken link', () => {
  const pages = [
    page('/', { links: [`${O}/new`] }),
    page('/new', { links: [`${O}/missing`] }),
    page('/old', { redirected: true, finalUrl: `${O}/new`, links: [`${O}/missing`] }),
  ];
  const f = byId(evaluateSite(site(pages, { linkChecks: [{ url: `${O}/missing`, status: 404, finalUrl: `${O}/missing`, redirected: false, type: 'text/html', error: '' }] }), LIVE));
  assert.deepEqual(f['site-broken-links'].items, ['404 · /missing ← /new']);
});

test('linksToCheck skips search result links (Pantry Shop /search?q= never answered)', () => {
  const home = page('/', { links: [`${O}/search?q=Olive+oil&type=product`, `${O}/search`, `${O}/pages/faq`] });
  assert.deepEqual(linksToCheck(site([home])), [`${O}/pages/faq`]);
});
