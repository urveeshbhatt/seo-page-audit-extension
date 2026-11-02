// Phase 5: Site scan rules. Pure functions: scan data in, findings out.
// Built from a real audit (hillshoporganics.com, 30 Oct 2026) where the big
// problems were site-wide, not on one page: empty demo collections in the
// sitemap, products with no description, duplicate meta descriptions, and
// policy links only on the home page.

import { finding, plural, isPrelaunch } from './phase1-rules.js';

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Compare URLs the way the scan stored them: no #fragment, otherwise exact.
export function normalizeUrl(u) {
  try { const x = new URL(str(u)); x.hash = ''; return x.href; } catch { return str(u); }
}

// Short label for a URL in a list: path + query on the scanned site.
function short(u, origin) {
  const s = str(u);
  return origin && s.startsWith(origin) ? s.slice(origin.length) || '/' : s;
}

// Groups of pages sharing the same non-empty value.
export function duplicates(pages, key) {
  const by = new Map();
  pages.forEach((p) => {
    const v = str(p[key]).trim().toLowerCase();
    if (!v) return;
    if (!by.has(v)) by.set(v, []);
    by.get(v).push(p);
  });
  return [...by.values()].filter((g) => g.length > 1);
}

const THIN_WORDS = 150;
const isHtml = (p) => /text\/html|application\/xhtml/i.test(str(p.type));
const noindexOf = (p) => /noindex/i.test(`${str(p.robots)} ${str(p.xRobots)}`);
// A listed URL that redirects is reported once (as a redirect), not judged
// again as a copy of the page it lands on.
const landed = (p) => !p.redirected || normalizeUrl(p.finalUrl) === normalizeUrl(p.url);
// The page a link reaches, without the query: Shopify product cards link to
// /products/x?variant=123, which is the /products/x page.
const pathKey = (u) => { try { const x = new URL(str(u)); return `${x.origin}${x.pathname}`; } catch { return str(u); } };
const hasQuery = (u) => { try { return !!new URL(str(u)).search; } catch { return false; } };
// Before launch every page is noindex on purpose: still check its content.
const judged = (ctx) => (p) => isPrelaunch(ctx) || !noindexOf(p);

function sitemapFindings(d, o) {
  const out = [];
  const maps = arr(d.sitemaps).filter((m) => m && typeof m === 'object');
  const bad = maps.filter((m) => num(m.status) !== 200 || m.kind === 'invalid' || m.error);
  if (d.source === 'links') {
    out.push(finding('site-sitemap', 'XML sitemap', 'Not found', 'warning',
      `No sitemap in robots.txt or at /sitemap.xml, so the scan used the links on this page instead. A sitemap tells Google every page you want indexed; most platforms (Shopify, WordPress with an SEO plugin) make one automatically. Add a "Sitemap:" line to robots.txt.`,
      null, maps.map((m) => `${short(m.url, o)} · ${m.status || 'no answer'}`)));
  } else {
    out.push(finding('site-sitemap', 'XML sitemap', `${plural(num(d.totalListed), 'URL')} in ${plural(maps.filter((m) => m.kind === 'urlset').length, 'sitemap')}`, 'good',
      `Found ${num(d.robotsSitemaps) ? 'through robots.txt' : 'at the default address (not listed in robots.txt: add a "Sitemap:" line)'}.`,
      null, maps.map((m) => `${short(m.url, o)} · ${m.kind || '?'} · ${num(m.count)}`)));
  }
  if (bad.length && d.source !== 'links') {
    out.push(finding('site-sitemap-broken', 'Sitemaps that fail', plural(bad.length, 'sitemap'), 'warning',
      'These sitemap files do not open or are not valid XML. Google skips them, so the pages listed only there may not be found.',
      null, bad.map((m) => `${short(m.url, o)} · ${m.status || m.error || 'no answer'}${m.kind === 'invalid' ? ' · invalid XML' : ''}`)));
  }
  if (num(d.offSite)) {
    out.push(finding('site-offsite', 'Sitemap URLs on another domain', plural(num(d.offSite), 'URL'), 'warning',
      'A sitemap may only list URLs of its own site. Google ignores these entries. Usually a staging or old domain left in the sitemap.',
      null, arr(d.offSiteSamples).map(str)));
  }
  if (num(d.totalListed) > arr(d.urls).length) {
    out.push(finding('site-scope', 'Scan size', `${arr(d.urls).length} of ${num(d.totalListed)} URLs scanned`, 'info',
      `The scan stops at ${num(d.limit) || arr(d.urls).length} pages to stay gentle with the server. Duplicates, orphans and broken links are counted within these pages only. Raise the limit for a fuller picture.`));
  }
  return out;
}

function statusFindings(pages, o) {
  const out = [];
  const errors = pages.filter((p) => num(p.status) >= 400 || (!num(p.status) && p.error));
  const moved = pages.filter((p) => num(p.status) < 400 && p.redirected && normalizeUrl(p.finalUrl) !== normalizeUrl(p.url));
  const notHtml = pages.filter((p) => num(p.status) === 200 && !p.redirected && !isHtml(p));
  out.push(errors.length
    ? finding('site-status-error', 'Pages that do not load', plural(errors.length, 'page'), 'warning',
      'Listed URLs that answer with an error (404 not found, 5xx server error) or not at all. Google wastes crawls on them and flags the sitemap. Remove them from the sitemap, or redirect (301) to the closest live page.',
      null, errors.map((p) => `${num(p.status) || p.error} · ${short(p.url, o)}`))
    : finding('site-status-error', 'Pages that do not load', 'None', 'good', 'Every scanned URL answered 200.'));
  if (moved.length) {
    out.push(finding('site-redirected', 'Listed URLs that redirect', plural(moved.length, 'URL'), 'warning',
      'The sitemap lists an old address that redirects. List the final URL instead, so Google does not need an extra hop and trusts the sitemap.',
      null, moved.map((p) => `${short(p.url, o)} → ${p.offsite || !str(p.finalUrl) ? 'another site' : short(p.finalUrl, o)}`)));
  }
  if (notHtml.length) {
    out.push(finding('site-not-html', 'Listed URLs that are not pages', plural(notHtml.length, 'URL'), 'info',
      'These answer with something other than HTML (a file, JSON). Usually fine for PDFs; otherwise they do not belong in a page sitemap.',
      null, notHtml.map((p) => `${str(p.type).split(';')[0]} · ${short(p.url, o)}`)));
  }
  return out;
}

function indexFindings(pages, o, ctx) {
  const out = [];
  const live = pages.filter((p) => num(p.status) === 200 && isHtml(p) && landed(p));
  const noindex = live.filter(noindexOf);
  if (noindex.length) {
    const pre = isPrelaunch(ctx);
    out.push(finding('site-noindex', 'Noindex pages in the sitemap', plural(noindex.length, 'page'), pre ? 'info' : 'warning',
      pre
        ? 'Before launch noindex is expected. Remove it (and keep these pages in the sitemap) on launch day; keep it only on pages like thank-you or account.'
        : 'The sitemap says "index this", the page says "do not index". Conflicting signals: remove these pages from the sitemap, or remove the noindex if they should rank.',
      null, noindex.map((p) => `${short(p.url, o)} · ${str(p.robots) || `X-Robots-Tag: ${str(p.xRobots)}`}`)));
  }
  const elsewhere = live.filter((p) => !noindexOf(p) && p.canonical && normalizeUrl(p.canonical) !== normalizeUrl(p.finalUrl || p.url));
  out.push(elsewhere.length
    ? finding('site-canonical-other', 'Canonical points to another page', plural(elsewhere.length, 'page'), 'warning',
      'These pages tell Google "the real version is another URL", yet the sitemap lists them as pages to index. Either the canonical is a theme mistake (fix it to point to itself) or the page is a duplicate (remove it from the sitemap).',
      null, elsewhere.map((p) => `${short(p.url, o)} → ${short(p.canonical, o)}`))
    : finding('site-canonical-other', 'Canonical points to another page', 'None', 'good', 'Every indexable page names itself as canonical (or has none).'));
  const missing = live.filter((p) => !noindexOf(p) && !p.canonical);
  if (missing.length) {
    out.push(finding('site-canonical-missing', 'Pages without a canonical', plural(missing.length, 'page'), 'info',
      'No canonical tag. Not an error, but with URL parameters (filters, tracking) Google has to guess the main version. A self-referencing canonical is cheap insurance.',
      null, missing.map((p) => short(p.url, o))));
  }
  return out;
}

function metaFindings(pages, o, ctx) {
  const out = [];
  const live = pages.filter((p) => num(p.status) === 200 && isHtml(p) && landed(p)).filter(judged(ctx));
  const noTitle = live.filter((p) => !str(p.title));
  const dupTitle = duplicates(live, 'title');
  const noDesc = live.filter((p) => !str(p.description));
  const dupDesc = duplicates(live, 'description');
  const longDesc = live.filter((p) => str(p.description).length > 160);
  const group = (g, key) => `"${str(g[0][key]).slice(0, 70)}" × ${g.length}: ${g.map((p) => short(p.url, o)).join(', ')}`;
  if (noTitle.length) {
    out.push(finding('site-title-missing', 'Pages without a title', plural(noTitle.length, 'page'), 'warning',
      'The title is the blue link in Google. Without one Google writes its own, usually worse.', null, noTitle.map((p) => short(p.url, o))));
  }
  out.push(dupTitle.length
    ? finding('site-title-dup', 'Duplicate titles', plural(dupTitle.length, 'group'), 'warning',
      'Several pages share one title, so Google and shoppers cannot tell them apart and the pages compete for the same search. Give each page a title that says what is different (product, size, type).',
      null, dupTitle.map((g) => group(g, 'title')))
    : finding('site-title-dup', 'Duplicate titles', 'None', 'good', 'Every scanned page has its own title.'));
  out.push(noDesc.length
    ? finding('site-desc-missing', 'Pages without a meta description', plural(noDesc.length, 'page'), 'warning',
      'Without a meta description Google picks a snippet from the page (often the menu or a policy line). Write 140–155 characters per page: what it is, for whom, one reason to click.',
      null, noDesc.map((p) => `${short(p.url, o)}${num(p.words) < THIN_WORDS ? ` · ${num(p.words)} words on the page` : ''}`))
    : finding('site-desc-missing', 'Pages without a meta description', 'None', 'good', 'Every scanned page has a meta description.'));
  if (dupDesc.length) {
    out.push(finding('site-desc-dup', 'Duplicate meta descriptions', plural(dupDesc.length, 'group'), 'warning',
      'The same description on several pages, usually a copied product or a theme default. Google may ignore all of them.',
      null, dupDesc.map((g) => group(g, 'description'))));
  }
  if (longDesc.length) {
    out.push(finding('site-desc-long', 'Long meta descriptions', plural(longDesc.length, 'page'), 'info',
      'Over 160 characters: Google cuts the snippet, often mid-sentence. Shopify fills empty descriptions with the first 320 characters of the product text, which is usually why.',
      null, longDesc.map((p) => `${str(p.description).length} chars · ${short(p.url, o)}`)));
  }
  return out;
}

function contentFindings(pages, o, ctx) {
  const out = [];
  const live = pages.filter((p) => num(p.status) === 200 && isHtml(p) && landed(p)).filter(judged(ctx));
  const noH1 = live.filter((p) => !num(p.h1Count));
  const multi = live.filter((p) => num(p.h1Count) > 1);
  const thin = live.filter((p) => num(p.words) < THIN_WORDS);
  if (noH1.length) {
    out.push(finding('site-h1-missing', 'Pages without an H1', plural(noH1.length, 'page'), 'warning',
      'No main heading in the HTML the server sends (a heading added later by JavaScript is not seen here). The H1 tells readers and Google what the page is about.', null, noH1.map((p) => short(p.url, o))));
  }
  if (multi.length) {
    out.push(finding('site-h1-multi', 'Pages with several H1s', plural(multi.length, 'page'), 'info',
      'Allowed, but usually a theme using H1 for styling. One clear H1 per page is easier for readers.',
      null, multi.map((p) => `${short(p.url, o)} · ${arr(p.h1).join(' | ')}`)));
  }
  out.push(thin.length
    ? finding('site-thin', 'Thin pages', plural(thin.length, 'page'), 'warning',
      `Fewer than ${THIN_WORDS} words of main content in the HTML the server sends (menus, header and footer not counted; text added later by JavaScript is not counted either). Empty collections, demo pages and products with no description show up here. Write real content, or remove the page and redirect it.`,
      null, thin.map((p) => `${num(p.words)} words · ${short(p.url, o)}${str(p.title) ? ` · "${str(p.title).slice(0, 60)}"` : ''}`))
    : finding('site-thin', 'Thin pages', 'None', 'good', `Every scanned page has at least ${THIN_WORDS} words of main content.`));
  return out;
}

function linkFindings(d, pages, o, ctx) {
  const out = [];
  const status = new Map();
  pages.forEach((p) => status.set(normalizeUrl(p.url), p));
  arr(d.linkChecks).forEach((c) => { if (c && !status.has(normalizeUrl(c.url))) status.set(normalizeUrl(c.url), c); });
  const inbound = new Map();
  // a listed URL that redirects shows its target's links: count them once
  pages.filter(landed).forEach((p) => arr(p.links).forEach((l) => {
    const to = normalizeUrl(l);
    if (to === normalizeUrl(p.url) || to === normalizeUrl(p.finalUrl)) return;
    if (!inbound.has(to)) inbound.set(to, new Set());
    inbound.get(to).add(normalizeUrl(p.url));
  }));
  const broken = [...inbound.entries()].filter(([to]) => { const s = status.get(to); return s && (num(s.status) >= 400 || (!num(s.status) && s.error)); });
  out.push(broken.length
    ? finding('site-broken-links', 'Broken internal links', plural(broken.length, 'URL'), 'warning',
      'Links on your pages that lead to an error page. Visitors hit a dead end and Google wastes crawls. Fix the link or redirect the old URL.',
      null, broken.map(([to, from]) => `${num(status.get(to).status) || 'no answer'} · ${short(to, o)} ← ${[...from].slice(0, 3).map((f) => short(f, o)).join(', ')}${from.size > 3 ? ` (+${from.size - 3})` : ''}`))
    : finding('site-broken-links', 'Broken internal links', arr(d.linkChecks).length || pages.length ? 'None found' : 'Not checked', 'good', 'No link on the scanned pages leads to an error page.'));

  const indexable = pages.filter((p) => num(p.status) === 200 && isHtml(p) && !p.redirected).filter(judged(ctx));
  const start = normalizeUrl(d.startUrl);
  const home = normalizeUrl(`${str(d.origin)}/`);
  const reachedPaths = new Set([...inbound.keys()].map(pathKey));
  const linked = (u) => inbound.has(u) || (!hasQuery(u) && reachedPaths.has(pathKey(u)));
  const orphans = d.source === 'sitemap' ? indexable.filter((p) => { const u = normalizeUrl(p.url); return u !== home && u !== start && !linked(u); }) : [];
  if (orphans.length) {
    const partial = num(d.totalListed) > pages.length;
    out.push(finding('site-orphans', 'Pages no scanned page links to', plural(orphans.length, 'page'), partial ? 'info' : 'warning',
      `In the sitemap, but no scanned page links to them${partial ? ' (only part of the site was scanned, so some may be linked from pages outside the scan)' : ''}. Google finds and ranks pages mostly through links: link them from a menu, a collection or a related article.`,
      null, orphans.map((p) => short(p.url, o))));
  }
  if (d.source === 'sitemap') {
    const listed = new Set(pages.map((p) => normalizeUrl(p.url)));
    const missing = [...inbound.keys()].filter((u) => {
      const s = status.get(u);
      return !listed.has(u) && s && num(s.status) === 200 && !s.redirected && isHtml(s) && !/[?&](page|sort|filter|q|variant)=/i.test(u);
    });
    if (missing.length && num(d.totalListed) <= pages.length) {
      out.push(finding('site-not-in-sitemap', 'Linked pages missing from the sitemap', plural(missing.length, 'page'), 'info',
        'Pages your site links to that the sitemap does not list. Fine for filters and account pages; real pages (products, articles) should be in the sitemap.',
        null, missing.slice(0, 40).map((u) => short(u, o))));
    }
  }
  return out;
}

export function evaluateSite(data, ctx = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const o = str(d.origin);
  const pages = arr(d.pages).filter((p) => p && typeof p === 'object' && typeof p.url === 'string');
  const groups = [
    { id: 'sitemap', title: 'Sitemap', findings: sitemapFindings(d, o) },
    { id: 'status', title: 'Status and redirects', findings: pages.length ? statusFindings(pages, o) : [] },
    { id: 'index', title: 'Indexing signals', findings: pages.length ? indexFindings(pages, o, ctx || {}) : [] },
    { id: 'meta', title: 'Titles and descriptions', findings: pages.length ? metaFindings(pages, o, ctx || {}) : [] },
    { id: 'content', title: 'Content', findings: pages.length ? contentFindings(pages, o, ctx || {}) : [] },
    { id: 'links', title: 'Internal links', findings: pages.length ? linkFindings(d, pages, o, ctx || {}) : [] },
  ].filter((g) => g.findings.length);
  const counts = { critical: 0, warning: 0, good: 0, info: 0 };
  groups.forEach((g) => g.findings.forEach((f) => { counts[f.flag] += 1; }));
  return { groups, counts };
}

// Internal links found on scanned pages that the scan has no status for yet.
export function linksToCheck(data, limit = 100) {
  const d = data && typeof data === 'object' ? data : {};
  const pages = arr(d.pages).filter((p) => p && typeof p.url === 'string');
  const known = new Set(pages.map((p) => normalizeUrl(p.url)));
  const scannedPaths = new Set(pages.filter((p) => num(p.status) === 200).map((p) => pathKey(p.url)));
  arr(d.linkChecks).forEach((c) => c && known.add(normalizeUrl(c.url)));
  const todo = [];
  pages.forEach((p) => arr(p.links).forEach((l) => {
    const u = normalizeUrl(l);
    if (hasQuery(u) && scannedPaths.has(pathKey(u))) return; // ?variant= of a page already scanned
    if (/\/search(\/|\?|$)|[?&]q=/i.test(u)) return; // search results: not pages, and can stall
    if (!known.has(u) && !todo.includes(u) && /^https?:/i.test(u) && !/\.(jpe?g|png|webp|avif|gif|svg|pdf|zip|mp4)(\?|$)/i.test(u)) todo.push(u);
  }));
  return todo.slice(0, Math.max(0, Number(limit) || 0));
}

// Plain Markdown for sharing (no HTML, page text escaped by the report reader).
export function siteToMarkdown(result, meta = {}) {
  const r = result && typeof result === 'object' ? result : { groups: [], counts: {} };
  const esc = (s) => String(s || '').replace(/([\\`*_[\]<>|])/g, '\\$1');
  const lines = [`# ${esc(meta.title || 'Site scan')}`, ''];
  if (meta.url) lines.push(`Site: ${esc(meta.url)}  `);
  if (meta.date) lines.push(`Date: ${esc(meta.date)}  `);
  if (meta.version) lines.push(`Tool: Page Audit Lens ${esc(meta.version)}  `);
  const c = r.counts || {};
  lines.push('', `**${num(c.critical)} critical · ${num(c.warning)} to check · ${num(c.info)} info · ${num(c.good)} passed**`, '');
  arr(r.groups).forEach((g) => {
    const bad = arr(g.findings).filter((f) => f.flag !== 'good');
    if (!bad.length) return;
    lines.push(`## ${esc(g.title)}`, '');
    bad.forEach((f) => {
      lines.push(`### ${esc(f.check)}: ${esc(f.value)} (${esc(f.flag)})`, '', esc(f.why), '');
      arr(f.items).slice(0, 50).forEach((i) => lines.push(`- ${esc(i)}`));
      if (arr(f.items).length) lines.push('');
    });
  });
  return lines.join('\n');
}
