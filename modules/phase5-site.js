// Phase 5: Site scan (site-level crawl and indexing signals).
// Runs inside the audited tab, so every request is same-origin and needs no new
// permission. Read-only: GET requests only, without cookies (what a guest and a
// crawler get), one page at a time with a short pause, a hard page limit.
// Each function is injected on its own with chrome.scripting, so each one is
// self-contained (no shared helpers outside the function body).

export const MODULE_INFO = {
  id: 'phase5-site',
  name: 'Phase 5: Site scan',
  version: '1.6.0',
};

// 1. Which URLs to scan: robots.txt → Sitemap: lines (sitemap indexes followed,
// .xml.gz unpacked). No sitemap: fall back to this page's internal links.
export async function collectSiteUrls(limit = 100, timeoutMs = 20000) {
  // A request that never answers (Pantry Shop /search?q=) must not stop the scan.
  const LIMIT = Math.max(200, Number(timeoutMs) || 15000);
  const timed = (u, opts) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${LIMIT / 1000} s`)), LIMIT);
    return { ctrl, done: () => clearTimeout(timer), go: fetch(u, { ...opts, signal: ctrl.signal }) };
  };
  const clip = (s, n) => String(s || '').slice(0, n);
  const max = Math.max(1, Math.min(Number(limit) || 100, 500));
  const host = location.hostname.replace(/^www\./, '');
  const out = { origin: location.origin, host: location.hostname, startUrl: clip(location.href, 500), source: 'sitemap', sitemaps: [], robotsSitemaps: 0, urls: [], totalListed: 0, offSite: 0, offSiteSamples: [], limit: max, errors: [] };
  const sameSite = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && x.hostname.replace(/^www\./, '') === host; } catch { return false; } };
  const get = async (u) => {
    const req = timed(u, { credentials: 'omit', cache: 'no-store', redirect: 'follow' });
    try {
      const r = await req.go;
      let text = '';
      if (r.ok) {
        const gz = /\.gz(\?|$)/i.test(u) || /gzip|x-gzip/i.test(r.headers.get('content-type') || '');
        text = gz && typeof DecompressionStream !== 'undefined'
          ? await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text().catch(() => '')
          : await r.text();
      }
      return { status: r.status, ok: r.ok, url: r.url, text };
    } finally { req.done(); }
  };

  let maps = [];
  try {
    const robots = await get(new URL('/robots.txt', location.origin).href);
    if (robots.ok) maps = [...robots.text.matchAll(/^[ \t]*sitemap[ \t]*:[ \t]*(\S+)/gim)].map((m) => { try { return new URL(m[1], location.origin).href; } catch { return ''; } }).filter(Boolean);
  } catch (e) { out.errors.push(clip(`robots.txt: ${e && e.message}`, 160)); }
  out.robotsSitemaps = maps.length;
  if (!maps.length) maps = ['/sitemap.xml', '/sitemap_index.xml'].map((p) => new URL(p, location.origin).href);

  const queue = [...new Set(maps)].slice(0, 20);
  const seenMaps = new Set();
  const seenUrls = new Set();
  while (queue.length && out.sitemaps.length < 60) {
    const sm = queue.shift();
    if (seenMaps.has(sm)) continue;
    seenMaps.add(sm);
    const rec = { url: clip(sm, 400), status: 0, kind: '', count: 0, error: '' };
    out.sitemaps.push(rec);
    try {
      const r = await get(sm);
      rec.status = r.status;
      if (!r.ok) continue;
      const doc = new DOMParser().parseFromString(r.text, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) { rec.kind = 'invalid'; continue; }
      rec.kind = doc.documentElement.localName;
      // only <loc> directly inside <url> or <sitemap> (not image:loc / video:loc)
      const locs = [...doc.getElementsByTagNameNS('*', 'loc')]
        .filter((l) => l.parentElement && l.namespaceURI === l.parentElement.namespaceURI && /^(url|sitemap)$/.test(l.parentElement.localName))
        .map((l) => l.textContent.trim()).filter(Boolean);
      rec.count = locs.length;
      if (rec.kind === 'sitemapindex') { locs.slice(0, 50).forEach((u) => { try { queue.push(new URL(u, sm).href); } catch { /* bad loc */ } }); continue; }
      out.totalListed += locs.length;
      locs.forEach((u) => {
        if (!sameSite(u)) { out.offSite += 1; if (out.offSiteSamples.length < 5) out.offSiteSamples.push(clip(u, 200)); return; }
        if (seenUrls.has(u)) return;
        seenUrls.add(u);
        if (out.urls.length < max) out.urls.push(clip(u, 600));
      });
    } catch (e) { rec.error = clip(e && e.message, 120); }
  }

  if (!out.urls.length) {
    out.source = 'links';
    const links = [location.href.split('#')[0], ...[...document.querySelectorAll('a[href]')].map((a) => { try { const u = new URL(a.getAttribute('href'), location.href); u.hash = ''; return u.href; } catch { return ''; } })];
    [...new Set(links)].filter(sameSite).slice(0, max).forEach((u) => out.urls.push(clip(u, 600)));
  }
  return out;
}

// 2. Fetch a batch of pages and read the SEO basics from their HTML (no
// JavaScript runs: this is what the server sends, like the raw HTML a crawler
// sees first).
export async function scanPages(urls, timeoutMs = 15000) {
  // A request that never answers (Pantry Shop /search?q=) must not stop the scan.
  const LIMIT = Math.max(200, Number(timeoutMs) || 15000);
  const timed = (u, opts) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${LIMIT / 1000} s`)), LIMIT);
    return { ctrl, done: () => clearTimeout(timer), go: fetch(u, { ...opts, signal: ctrl.signal }) };
  };
  const clip = (s, n) => String(s || '').slice(0, n);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const host = location.hostname.replace(/^www\./, '');
  const NOT_MAIN = 'header, nav, footer, aside, script, style, noscript, template, svg, form, [role="navigation"], [role="banner"], [role="contentinfo"]';
  const pages = [];
  for (const url of (Array.isArray(urls) ? urls : []).slice(0, 50)) {
    const rec = { url: clip(url, 600), status: 0, finalUrl: '', redirected: false, offsite: false, type: '', bytes: 0, ms: 0, xRobots: '', title: '', titleCount: 0, description: null, descriptionCount: 0, robots: '', canonical: '', canonicalCount: 0, h1: [], h1Count: 0, words: 0, lang: '', schema: [], links: [], error: '' };
    const t0 = performance.now();
    let req = null;
    try {
      req = timed(url, { credentials: 'omit', cache: 'no-store', redirect: 'follow' });
      const r = await req.go;
      rec.status = r.status;
      rec.finalUrl = clip(r.url, 600);
      rec.redirected = r.redirected;
      rec.type = clip(r.headers.get('content-type') || '', 80);
      rec.xRobots = clip(r.headers.get('x-robots-tag') || '', 160);
      if (/text\/html|application\/xhtml/i.test(rec.type)) {
        const html = await r.text();
        rec.bytes = html.length;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const baseHref = doc.querySelector('base[href]') ? doc.querySelector('base[href]').getAttribute('href') : '';
        let base = r.url;
        try { if (baseHref) base = new URL(baseHref, r.url).href; } catch { /* keep the page URL */ }
        const titles = [...doc.querySelectorAll('head title, title')];
        rec.titleCount = titles.length;
        rec.title = clip(norm(titles[0] ? titles[0].textContent : ''), 300);
        const descs = [...doc.querySelectorAll('meta[name="description" i]')];
        rec.descriptionCount = descs.length;
        rec.description = descs.length ? clip(norm(descs[0].getAttribute('content')), 400) : null;
        rec.robots = clip([...doc.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i]')].map((m) => m.getAttribute('content') || '').join(', '), 160);
        const canons = [...doc.querySelectorAll('link[rel~="canonical" i][href]')];
        rec.canonicalCount = canons.length;
        if (canons.length) { try { rec.canonical = clip(new URL(canons[0].getAttribute('href'), base).href, 600); } catch { rec.canonical = clip(canons[0].getAttribute('href'), 600); } }
        const h1s = [...doc.querySelectorAll('h1')];
        rec.h1Count = h1s.length;
        rec.h1 = h1s.slice(0, 3).map((h) => clip(norm(h.textContent), 120));
        rec.lang = clip(doc.documentElement.getAttribute('lang') || '', 20);
        const main = doc.querySelector('main, [role="main"]') || doc.body;
        if (main) {
          const copy = main.cloneNode(true);
          copy.querySelectorAll(NOT_MAIN).forEach((n) => n.remove());
          const text = norm(copy.textContent);
          rec.words = text ? text.split(' ').length : 0;
        }
        const types = new Set();
        doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
          try {
            const walk = (n, d) => { if (!n || typeof n !== 'object' || d > 6) return; if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return; } [].concat(n['@type'] || []).forEach((t) => types.add(String(t))); Object.values(n).forEach((v) => walk(v, d + 1)); };
            walk(JSON.parse(s.textContent), 0);
          } catch { types.add('(invalid JSON-LD)'); }
        });
        rec.schema = [...types].slice(0, 12).map((t) => clip(t, 40));
        const links = new Set();
        doc.querySelectorAll('a[href]').forEach((a) => {
          if (links.size >= 400) return;
          try {
            const u = new URL(a.getAttribute('href'), base);
            if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== host) return;
            if ((a.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes('nofollow')) return;
            u.hash = '';
            links.add(u.href);
          } catch { /* bad href */ }
        });
        rec.links = [...links].map((u) => clip(u, 600));
      }
    } catch (e) {
      rec.error = clip(e && e.message, 160);
      // A redirect to another site (Shopify /account → shopify.com login) fails
      // the follow-fetch on CORS. Ask again without following: an opaque
      // redirect means "goes elsewhere", which is not a broken link.
      if (!/timed out/.test(rec.error)) {
        const again = timed(url, { credentials: 'omit', cache: 'no-store', redirect: 'manual' });
        try {
          const m = await again.go;
          if (m.type === 'opaqueredirect') { rec.error = ''; rec.redirected = true; rec.offsite = true; }
        } catch { /* keep the first error */ } finally { again.done(); }
      }
    } finally { if (req) req.done(); }
    rec.ms = Math.round(performance.now() - t0);
    pages.push(rec);
    await new Promise((done) => setTimeout(done, 150)); // be gentle with the server
  }
  return pages;
}

// 3. Status of internal links found while scanning that were not in the scan
// (broken links, redirects). Headers only: the body is not downloaded.
export async function checkLinks(urls, timeoutMs = 15000) {
  // A request that never answers (Pantry Shop /search?q=) must not stop the scan.
  const LIMIT = Math.max(200, Number(timeoutMs) || 15000);
  const timed = (u, opts) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${LIMIT / 1000} s`)), LIMIT);
    return { ctrl, done: () => clearTimeout(timer), go: fetch(u, { ...opts, signal: ctrl.signal }) };
  };
  const clip = (s, n) => String(s || '').slice(0, n);
  const out = [];
  for (const url of (Array.isArray(urls) ? urls : []).slice(0, 50)) {
    const rec = { url: clip(url, 600), status: 0, finalUrl: '', redirected: false, offsite: false, type: '', error: '' };
    const req = timed(url, { credentials: 'omit', cache: 'no-store', redirect: 'follow' });
    try {
      const r = await req.go;
      rec.status = r.status;
      rec.finalUrl = clip(r.url, 600);
      rec.redirected = r.redirected;
      rec.type = clip(r.headers.get('content-type') || '', 80);
      req.ctrl.abort(); // headers are enough
    } catch (e) {
      if (!rec.status) {
        rec.error = clip(e && e.message, 160);
        // A redirect to another site (Shopify /account → shopify.com login) fails
        // the follow-fetch on CORS. Ask again without following: an opaque
        // redirect means "goes elsewhere", which is not a broken link.
        if (!/timed out/.test(rec.error)) {
          const again = timed(url, { credentials: 'omit', cache: 'no-store', redirect: 'manual' });
          try {
            const m = await again.go;
            if (m.type === 'opaqueredirect') { rec.error = ''; rec.redirected = true; rec.offsite = true; }
          } catch { /* keep the first error */ } finally { again.done(); }
        }
      }
    } finally { req.done(); }
    out.push(rec);
    await new Promise((done) => setTimeout(done, 100));
  }
  return out;
}
