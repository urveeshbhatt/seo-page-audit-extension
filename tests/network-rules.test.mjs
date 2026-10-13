import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateNetwork, parseRobots, isAllowed, cacheLayers, cacheStatus, vendorsByPurpose } from '../modules/phase2-rules.js';
import { buildTestUrls, originsFor, isInternalHop } from '../modules/phase2-redirects.js';
import { buildSummary } from '../modules/summary.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const byId = (result) => Object.fromEntries(result.groups.flatMap((g) => g.findings).map((f) => [f.id, f]));
const clone = (o) => JSON.parse(JSON.stringify(o));

const BV = { pageType: 'product', status: 'prelaunch', model: 'd2c' };
const REGUS = { pageType: 'location', status: 'live', model: 'b2b' };

// ---------------- real captures ----------------

test('Buranshvalley: two cache layers read separately, WP REST link header ignored', () => {
  const r = evaluateNetwork(load('buranshvalley-product-network'), BV, { head: load('buranshvalley-product-head') });
  const f = byId(r);
  assert.equal(r.counts.critical, 0);
  assert.match(f['net-cdn'].value, /Hostinger CDN, LiteSpeed/);
  assert.match(f['net-cache-hit'].value, /CDN BYPASS \+ LiteSpeed HIT/);
  assert.equal(f['net-cache-hit'].label, 'Check by hand');
  assert.match(f['net-cache-hit'].why, /_lscache_vary/);
  assert.match(f['net-cache-hit'].why, /server cache still answered/);
  assert.equal(f['net-link-header'].label, 'Ignored'); // api.w.org is not a canonical
  assert.equal(f['net-link-canonical'], undefined);
  assert.equal(f['net-ttfb-cold'].flag, 'good'); // 704 ms median
  assert.equal(f['net-files'].flag, 'warning'); // 35 own CSS files (LiteSpeed CSS combine off)
  assert.match(f['net-files'].value, /35 CSS files/);
  assert.equal(f['net-sitemap-noindex'].label, 'Launch blocker');
  assert.equal(f['net-robots'].flag, 'good');
  assert.equal(f['net-encoding'].flag, 'good');
  assert.equal(f['net-protocol'].value, 'H3');
});

test('Buranshvalley: noindex sitemap URLs become a real warning once live', () => {
  const r = evaluateNetwork(load('buranshvalley-product-network'), { ...BV, status: 'live' });
  const f = byId(r);
  assert.equal(f['net-sitemap-noindex'].label, 'Check');
  assert.equal(f['net-sitemap-noindex'].items.length, 10);
});

test('Regus: Imperva challenge detected, uncached TTFB not reported, sitemap wall flagged', () => {
  const r = evaluateNetwork(load('regus-mumbai-network'), REGUS, { head: load('regus-mumbai-head') });
  const f = byId(r);
  assert.equal(f['net-cdn'].value, 'Imperva');
  assert.equal(f['net-guest-blocked'].flag, 'warning');
  assert.match(f['net-guest-blocked'].value, /3 of 3 .*212 bytes/);
  assert.equal(f['net-ttfb-cold'], undefined); // 49 ms of a challenge page is not server speed
  assert.equal(f['net-ttfb-warm'].flag, 'warning'); // 853 ms, HTML is private/no-store
  assert.equal(f['net-cache-control'].flag, 'info');
  assert.equal(f['net-sitemap-wall'].label, 'Check by hand');
  assert.match(f['net-robots-signal'].value, /ai-train=no/);
  assert.equal(f['net-robots-dupe'].value, '*');
  assert.equal(f['net-thirdparty'].flag, 'warning'); // 38 domains
  assert.equal(f['net-weight'].flag, 'info'); // 37 files hide their size
  assert.equal(f['net-llms'].value, 'HTTP 404');
  assert.equal(f['net-link-header'], undefined); // rel=sitemap + preload, not WordPress
});

test('Network section flows into the summary', () => {
  const network = evaluateNetwork(load('regus-mumbai-network'), REGUS);
  const s = buildSummary({ head: { groups: [], counts: { critical: 0, warning: 0, good: 0, info: 0 } }, network }, REGUS);
  assert.ok(s.sections.some((x) => x.key === 'network' && x.name === 'Network'));
  assert.ok(s.fixes.some((x) => x.key === 'network:net-guest-blocked'));
});

// ---------------- main document ----------------

test('Link header canonical that disagrees with the HTML is flagged', () => {
  const d = clone(load('buranshvalley-product-network'));
  d.doc.headers.link = '<https://buranshvalley.com/shop/other/>; rel="canonical"';
  const f = byId(evaluateNetwork(d, BV, { head: { canonicals: ['https://buranshvalley.com/shop/a2-desi-cow-bilona-ghee/'] } }));
  assert.equal(f['net-link-canonical'].flag, 'warning');
});

test('Uncompressed HTML, HTTP/1.1, Vary: Cookie and 5xx are flagged', () => {
  const d = clone(load('buranshvalley-product-network'));
  delete d.doc.headers['content-encoding'];
  d.doc.headers.vary = 'Accept-Encoding, Cookie';
  d.nav.protocol = 'http/1.1';
  d.doc.status = 503;
  const f = byId(evaluateNetwork(d, { ...BV, status: 'live' }));
  assert.equal(f['net-encoding'].flag, 'warning');
  assert.equal(f['net-vary'].flag, 'warning');
  assert.equal(f['net-protocol'].flag, 'warning');
  assert.equal(f['net-status'].flag, 'critical');
});

// ---------------- cache ----------------

test('cacheLayers reads each vendor header and keeps layers apart', () => {
  assert.deepEqual(cacheLayers({ 'x-hcdn-cache-status': 'BYPASS', 'x-litespeed-cache': 'hit' }), { CDN: 'BYPASS', LiteSpeed: 'HIT' });
  assert.equal(cacheStatus({ 'cf-cache-status': 'DYNAMIC' }), 'DYNAMIC');
  assert.equal(cacheStatus({ 'x-cache': 'Hit from cloudfront' }), 'HIT');
  assert.equal(cacheStatus({ 'x-vercel-cache': 'STALE' }), 'STALE');
  assert.equal(cacheStatus({ 'cache-control': 'no-store' }), '');
});

test('Guest requests that always BYPASS the CDN are a warning', () => {
  const d = clone(load('buranshvalley-product-network'));
  d.cold.forEach((x) => { x.cache['x-hcdn-cache-status'] = 'BYPASS'; });
  const f = byId(evaluateNetwork(d, BV));
  assert.equal(f['net-cache-hit'].flag, 'warning');
});

test('Slow uncached TTFB is reported with the right threshold', () => {
  const d = clone(load('buranshvalley-product-network'));
  d.cold.forEach((x, i) => { x.ttfb = [1900, 2100, 3400][i]; });
  const f = byId(evaluateNetwork(d, BV));
  assert.equal(f['net-ttfb-cold'].label, 'Fix');
  assert.match(f['net-ttfb-cold'].why, /1\.8 s/);
  assert.equal(f['net-ttfb-spread'].flag, 'info');
});

// ---------------- resources ----------------

test('vendorsByPurpose spots two chat widgets', () => {
  const v = vendorsByPurpose(['embed.tawk.to', 'widget.intercom.io', 'www.google-analytics.com']);
  assert.equal(v['live chat'].length, 2);
  assert.equal(v.analytics.length, 1);
});

// ---------------- robots.txt ----------------

test('robots parser: groups, longest match, Allow wins ties, $ anchors', () => {
  const p = parseRobots('User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nDisallow: /*?add-to-cart=\nDisallow: /*.pdf$\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\nSitemap: https://x.com/s.xml');
  assert.equal(p.groups.length, 2);
  assert.deepEqual(p.groups[1].agents, ['gptbot', 'ccbot']);
  const rules = p.groups[0].rules;
  assert.equal(isAllowed(rules, '/').allowed, true);
  assert.equal(isAllowed(rules, '/wp-admin/edit.php').allowed, false);
  assert.equal(isAllowed(rules, '/wp-admin/admin-ajax.php').allowed, true);
  assert.equal(isAllowed(rules, '/shop/?add-to-cart=12').allowed, false);
  assert.equal(isAllowed(rules, '/a.pdf').allowed, false);
  assert.equal(isAllowed(rules, '/a.pdf?x=1').allowed, true);
  assert.equal(isAllowed([{ type: 'disallow', path: '' }], '/x').allowed, true); // empty Disallow = allow all
});

function withRobots(text, status = 200, contentType = 'text/plain') {
  const d = clone(load('buranshvalley-product-network'));
  d.robots = { status, contentType, text };
  return d;
}

test('robots.txt: whole-site block is a launch blocker before launch, critical after', () => {
  const pre = byId(evaluateNetwork(withRobots('User-agent: *\nDisallow: /'), BV));
  assert.equal(pre['net-robots'].label, 'Launch blocker');
  const live = byId(evaluateNetwork(withRobots('User-agent: *\nDisallow: /'), { ...BV, status: 'live' }));
  assert.equal(live['net-robots'].flag, 'critical');
});

test('robots.txt: page blocked, CSS/JS folders blocked, 5xx, HTML instead of text', () => {
  const page = byId(evaluateNetwork(withRobots('User-agent: *\nDisallow: /shop/'), { ...BV, status: 'live' }));
  assert.equal(page['net-robots'].flag, 'critical'); // live product page
  const assets = byId(evaluateNetwork(withRobots('User-agent: *\nDisallow: /wp-includes/\nDisallow: /wp-content/plugins/'), BV));
  assert.equal(assets['net-robots-assets'].flag, 'warning');
  assert.equal(assets['net-robots-sitemap'].flag, 'info');
  assert.equal(byId(evaluateNetwork(withRobots('', 503), BV))['net-robots'].flag, 'critical');
  assert.equal(byId(evaluateNetwork(withRobots('<!doctype html><html>', 200, 'text/html'), BV))['net-robots'].flag, 'warning');
  assert.equal(byId(evaluateNetwork(withRobots('', 404), BV))['net-robots'].flag, 'info');
});

test('robots.txt: AI search bots blocked is a warning, training bots only is info', () => {
  const search = byId(evaluateNetwork(withRobots('User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /'), BV));
  assert.equal(search['net-robots-ai'].flag, 'warning');
  const train = byId(evaluateNetwork(withRobots('User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nUser-agent: Google-Extended\nDisallow: /'), BV));
  assert.equal(train['net-robots-ai'].flag, 'info');
});

// ---------------- sitemap ----------------

test('sitemap: missing, redirecting URLs, and lastmod all set to today', () => {
  const d = clone(load('buranshvalley-product-network'));
  d.sitemap.samples[1] = { ...d.sitemap.samples[1], status: 301, redirected: true };
  d.sitemap.lastmod = { withDate: 49, distinct: 1, today: 49 };
  const f = byId(evaluateNetwork(d, BV));
  assert.equal(f['net-sitemap-status'].flag, 'warning');
  assert.equal(f['net-sitemap-lastmod'].flag, 'warning');
  d.sitemap = { declared: [], declaredOffsite: 0, url: '', status: 404, samples: [] };
  assert.equal(byId(evaluateNetwork(d, BV))['net-sitemap'].flag, 'warning');
});

// ---------------- redirect tests ----------------

test('buildTestUrls: http, www toggle, slash toggle, combo and fake URL', () => {
  const { canonical, tests } = buildTestUrls('https://buranshvalley.com/shop/a2-desi-cow-bilona-ghee/#reviews', 'abc123');
  assert.equal(canonical, 'https://buranshvalley.com/shop/a2-desi-cow-bilona-ghee/');
  const ids = Object.fromEntries(tests.map((t) => [t.id, t.url]));
  assert.equal(ids.http, 'http://buranshvalley.com/shop/a2-desi-cow-bilona-ghee/');
  assert.equal(ids.www, 'https://www.buranshvalley.com/shop/a2-desi-cow-bilona-ghee/');
  assert.equal(ids.slash, 'https://buranshvalley.com/shop/a2-desi-cow-bilona-ghee');
  assert.equal(ids.combo, 'http://www.buranshvalley.com/shop/a2-desi-cow-bilona-ghee/');
  assert.equal(ids.fake, 'https://buranshvalley.com/pal-test-abc123-404/');
  // homepage: no slash test; www site: toggles to bare
  const home = buildTestUrls('https://www.regus.com/', 'x').tests;
  assert.ok(!home.some((t) => t.id === 'slash'));
  assert.equal(home.find((t) => t.id === 'www').url, 'https://regus.com/');
  // file URLs are not slash-tested
  assert.ok(!buildTestUrls('https://x.com/a/file.pdf', 'x').tests.some((t) => t.id === 'slash'));
});

test('originsFor asks for bare + www on both schemes only', () => {
  assert.deepEqual(originsFor('https://www.regus.com/en/in/mumbai'), ['https://www.regus.com/*', 'http://www.regus.com/*', 'https://regus.com/*', 'http://regus.com/*']);
});

const PAGE = 'https://buranshvalley.com/shop/ghee/';
const hop = (status, from, to, extra = {}) => ({ status, from, to, statusLine: `HTTP/1.1 ${status} X`, nonAuthReason: '', ...extra });
const run = (results) => byId(evaluateNetwork(load('buranshvalley-product-network'), BV, { redirects: { canonical: PAGE, webRequest: true, results } }));
const t = (id, url, hops, finalStatus, finalUrl, extra = {}) => ({ id, label: id, url, hops, finalStatus, finalUrl, error: '', observed: true, ...extra });

test('redirects: one 301 is good, 302 and 3+ hops are flagged', () => {
  const f = run([
    t('http', 'http://buranshvalley.com/shop/ghee/', [hop(301, 'http://buranshvalley.com/shop/ghee/', PAGE)], 200, PAGE),
    t('www', 'https://www.buranshvalley.com/shop/ghee/', [hop(302, 'https://www.buranshvalley.com/shop/ghee/', PAGE)], 200, PAGE),
    t('combo', 'http://www.buranshvalley.com/shop/ghee/', [
      hop(301, 'http://www.buranshvalley.com/shop/ghee/', 'https://www.buranshvalley.com/shop/ghee/'),
      hop(301, 'https://www.buranshvalley.com/shop/ghee/', 'https://buranshvalley.com/shop/ghee'),
      hop(301, 'https://buranshvalley.com/shop/ghee', PAGE)], 200, PAGE),
  ]);
  assert.equal(f['net-redir-http'].flag, 'good');
  assert.equal(f['net-redir-www'].flag, 'warning');
  assert.match(f['net-redir-www'].why, /temporary/);
  assert.equal(f['net-redir-combo'].flag, 'warning');
  assert.match(f['net-redir-combo'].why, /3 hops/);
  assert.equal(f['net-redir-combo'].items.length, 3);
});

test('redirects: HSTS internal hop is not counted as a server redirect', () => {
  const h = hop(307, 'http://buranshvalley.com/shop/ghee/', PAGE, { statusLine: 'HTTP/1.1 307 Internal Redirect', nonAuthReason: 'HSTS' });
  assert.equal(isInternalHop(h), true);
  const f = run([t('http', 'http://buranshvalley.com/shop/ghee/', [h], 200, PAGE)]);
  assert.equal(f['net-redir-http'].label, 'Check by hand');
  assert.match(f['net-redir-http'].value, /HSTS → 200/);
});

test('redirects: loop, DNS failure, duplicate slash and http serving content', () => {
  const f = run([
    t('www', 'https://www.buranshvalley.com/shop/ghee/', [], 0, '', { error: 'net::ERR_NAME_NOT_RESOLVED' }),
    t('combo', 'http://www.buranshvalley.com/shop/ghee/', [hop(301, 'a', 'b'), hop(301, 'b', 'a')], 0, '', { error: 'net::ERR_TOO_MANY_REDIRECTS', hopCount: 20 }),
    t('slash', 'https://buranshvalley.com/shop/ghee', [], 200, 'https://buranshvalley.com/shop/ghee'),
    t('http', 'http://buranshvalley.com/shop/ghee/', [], 200, 'http://buranshvalley.com/shop/ghee/'),
  ]);
  assert.equal(f['net-redir-www'].flag, 'warning');
  assert.match(f['net-redir-www'].value, /does not resolve/);
  assert.equal(f['net-redir-combo'].flag, 'critical');
  assert.match(f['net-redir-combo'].value, /20\+ hops/);
  assert.equal(f['net-redir-slash'].flag, 'warning');
  assert.equal(f['net-redir-http'].flag, 'critical');
});

test('redirects: fake URL 404 good, 200 soft 404, redirect to homepage', () => {
  const fake = 'https://buranshvalley.com/pal-test-x-404/';
  assert.equal(run([t('fake', fake, [], 404, fake)])['net-redir-fake'].flag, 'good');
  const soft = run([t('fake', fake, [], 200, fake)])['net-redir-fake'];
  assert.equal(soft.flag, 'warning');
  assert.match(soft.why, /soft 404/);
  const home = run([t('fake', fake, [hop(301, fake, 'https://buranshvalley.com/')], 200, 'https://buranshvalley.com/')])['net-redir-fake'];
  assert.equal(home.flag, 'warning');
  assert.match(home.why, /homepage/);
});

test('redirects: without webRequest the panel says hops are not visible', () => {
  const f = byId(evaluateNetwork(load('buranshvalley-product-network'), BV, { redirects: { canonical: PAGE, webRequest: false, results: [
    t('http', 'http://buranshvalley.com/shop/ghee/', [], 200, PAGE, { observed: false, fetchRedirected: true }),
  ] } }));
  assert.equal(f['net-redir-http'].label, 'Check by hand');
  assert.equal(f['net-redir-mode'].flag, 'info');
});
