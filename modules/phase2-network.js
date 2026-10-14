// Phase 2 module: Network panel checks (collector).
//
// collectNetwork() is injected into the audited page with
// chrome.scripting.executeScript({ func }), like the Phase 1 collectors:
//   - fully self-contained (no imports, no outside variables)
//   - read-only: it never changes the page
//   - returns plain data only
//
// Every request it makes is same-origin (the page's own URL, robots.txt,
// llms.txt, the sitemap and up to 10 URLs listed in it), made from inside the
// page. Responses are read as text and parsed with DOMParser (scripts never run).
// Cross-origin tests (http://, www, redirect hops) live in phase2-redirects.js
// and only run after the user grants access to the site.
//
// Judgement (flags and reasons) lives in phase2-rules.js, not here.

export const MODULE_INFO = {
  id: 'phase2-network',
  name: 'Phase 2: Network',
  version: '1.3.0',
};

export async function collectNetwork() {
  const clip = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
  const r = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);
  const TIMEOUT = 8000;
  const origin = location.origin;
  const out = {
    url: clip(location.href, 2048),
    origin,
    host: location.hostname,
    collectedAt: new Date().toISOString(),
    renderedBytes: document.documentElement ? document.documentElement.outerHTML.length : 0,
    nav: null,
    doc: null,
    warm: [],
    cold: [],
    resources: null,
    robots: null,
    llms: null,
    sitemap: null,
    errors: [],
  };

  const timedFetch = async (url, init = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      return await fetch(url, { cache: 'no-store', redirect: 'follow', ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const allHeaders = (res) => {
    const h = {};
    let n = 0;
    res.headers.forEach((value, name) => {
      if (n < 80) { h[name.toLowerCase()] = clip(value, 400); n += 1; }
    });
    return h;
  };
  const lastEntry = (url) => {
    const list = performance.getEntriesByName(url, 'resource');
    return list.length ? list[list.length - 1] : null;
  };
  // Bot-protection pages (Imperva/Incapsula, Cloudflare challenge) are tiny HTML
  // pages that name their vendor. They answer 200, so status alone is not enough.
  const CHALLENGE = /_Incapsula_Resource|incapsula|_incap_|cf-chl|challenge-platform|captcha|access denied|just a moment/i;
  const isChallenge = (text) => typeof text === 'string' && text.length < 20000 && CHALLENGE.test(text);
  const sameOrigin = (u) => {
    try { return new URL(u, location.href).origin === origin; } catch { return false; }
  };

  // ---------- navigation timing of the page load itself ----------
  try {
    const n = performance.getEntriesByType('navigation')[0];
    if (n) {
      out.nav = {
        type: n.type,
        status: n.responseStatus || 0,
        redirectCount: n.redirectCount,
        protocol: clip(n.nextHopProtocol, 20),
        dns: r(n.domainLookupEnd - n.domainLookupStart),
        connect: r(n.connectEnd - n.connectStart),
        ssl: n.secureConnectionStart ? r(n.connectEnd - n.secureConnectionStart) : 0,
        ttfb: r(n.responseStart - n.requestStart),
        download: r(n.responseEnd - n.responseStart),
        transferSize: n.transferSize,
        encodedBodySize: n.encodedBodySize,
        decodedBodySize: n.decodedBodySize,
        // transferSize 0 with a body means it came from the browser cache (timings are not real)
        fromCache: n.transferSize === 0 && n.decodedBodySize > 0,
        domContentLoaded: r(n.domContentLoadedEventEnd),
        load: r(n.loadEventEnd),
      };
    }
  } catch (e) { out.errors.push(`nav: ${clip(String(e), 120)}`); }

  // ---------- resources loaded by the page ----------
  // Read before this collector makes any request, so its own fetches are not counted.
  try {
    const list = performance.getEntriesByType('resource').slice(0, 600);
    const typeOf = (e) => {
      const p = e.name.split('?')[0].toLowerCase();
      if (/\.css$/.test(p) || e.initiatorType === 'css' && /\.css/.test(p)) return 'css';
      if (/\.m?js$/.test(p)) return 'js';
      if (/\.(woff2?|ttf|otf|eot)$/.test(p)) return 'font';
      if (/\.(jpe?g|png|gif|webp|avif|svg|ico)$/.test(p) || e.initiatorType === 'img') return 'img';
      if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'beacon') return 'fetch';
      if (e.initiatorType === 'script') return 'js';
      if (e.initiatorType === 'link') return 'css';
      return 'other';
    };
    out.resources = {
      count: list.length,
      entries: list.map((e) => {
        let host = '';
        try { host = new URL(e.name).hostname; } catch { /* data: or blob: */ }
        return {
          host,
          name: clip(e.name.split('?')[0].split('/').pop() || e.name, 80),
          type: typeOf(e),
          initiator: e.initiatorType,
          protocol: clip(e.nextHopProtocol, 12),
          encoded: e.encodedBodySize || 0,
          decoded: e.decodedBodySize || 0,
          duration: r(e.duration),
          start: r(e.startTime),
        };
      }).filter((e) => e.host),
    };
  } catch (e) { out.errors.push(`resources: ${clip(String(e), 120)}`); }

  // ---------- one sample request: status, headers, timing ----------
  const CACHE_KEYS = ['cf-cache-status', 'x-hcdn-cache-status', 'x-cache', 'x-cache-status', 'x-vercel-cache', 'x-nextjs-cache',
    'x-litespeed-cache', 'x-proxy-cache', 'x-wp-cache', 'x-rocket-nginx-serving-static', 'age', 'x-hcdn-upstream-rt', 'cache-control'];
  // Fetches made by an injected collector run in the extension's isolated world and
  // do NOT appear in the page's Performance timeline (verified in Chromium). So TTFB
  // is timed directly: fetch() resolves when the response headers arrive. That
  // includes connection setup when no connection is open, like a real first byte.
  const sample = async (url, credentials) => {
    const started = performance.now();
    try {
      const res = await timedFetch(url, { credentials });
      const headersAt = performance.now();
      const body = await res.text();
      const e = lastEntry(res.url) || lastEntry(url);
      const cache = {};
      CACHE_KEYS.forEach((k) => { const v = res.headers.get(k); if (v !== null) cache[k] = clip(v, 120); });
      const length = Number(res.headers.get('content-length')) || 0;
      return {
        status: res.status,
        ttfb: e && e.responseStart ? r(e.responseStart - e.requestStart) : r(headersAt - started),
        ttfbSource: e && e.responseStart ? 'timing' : 'headers',
        total: r(performance.now() - started),
        encoded: e ? e.encodedBodySize : length,
        decoded: e ? e.decodedBodySize : body.length,
        bytes: body.length,
        cache,
        body,
        res,
      };
    } catch (e) {
      return { status: 0, error: clip(String(e && e.name === 'AbortError' ? 'timeout' : e), 120) };
    }
  };

  // ---------- main document: headers as the server sends them ----------
  const first = await sample(location.href, 'include');
  if (first.status) {
    const body = first.body;
    out.doc = {
      status: first.status,
      redirected: first.res.redirected,
      finalUrl: clip(first.res.url, 2048),
      headers: allHeaders(first.res),
      bytes: first.bytes,
      encoded: first.encoded,
      decoded: first.decoded,
      // bot-protection pages are tiny and name their vendor
      challengeHint: isChallenge(body) ? clip((body.match(CHALLENGE) || [''])[0], 40) : '',
    };
  } else {
    out.errors.push(`page fetch: ${first.error || 'failed'}`);
  }

  // ---------- TTFB: 3 warm samples (your cookies) and 3 cold samples (guest, new URL) ----------
  const pick = (s) => (s.status ? { status: s.status, ttfb: s.ttfb, ttfbSource: s.ttfbSource, total: s.total, encoded: s.encoded, decoded: s.decoded, cache: s.cache, challenge: isChallenge(s.body) } : { status: 0, error: s.error });
  for (let i = 0; i < 3; i += 1) out.warm.push(pick(await sample(location.href, 'include')));
  const base = location.href.split('#')[0];
  const sep = base.includes('?') ? '&' : '?';
  for (let i = 0; i < 3; i += 1) out.cold.push(pick(await sample(`${base}${sep}pal-cold=${Date.now()}${i}`, 'omit')));

  // ---------- robots.txt ----------
  try {
    const res = await timedFetch(`${origin}/robots.txt`, { credentials: 'omit' });
    const text = await res.text();
    out.robots = {
      status: res.status,
      contentType: clip(res.headers.get('content-type') || '', 80),
      redirected: res.redirected,
      finalUrl: clip(res.url, 300),
      text: clip(text, 40000),
    };
  } catch (e) { out.robots = { status: 0, error: clip(String(e && e.name === 'AbortError' ? 'timeout' : e), 120) }; }

  // ---------- llms.txt (optional proposal) ----------
  try {
    const res = await timedFetch(`${origin}/llms.txt`, { credentials: 'omit' });
    const text = await res.text();
    out.llms = {
      status: res.status,
      contentType: clip(res.headers.get('content-type') || '', 80),
      start: clip(text.trim(), 160),
      looksLikeHtml: /^\s*<(!doctype|html)/i.test(text),
    };
  } catch (e) { out.llms = { status: 0, error: clip(String(e), 120) }; }

  // ---------- sitemap: find it, read it, test 10 URLs ----------
  const readMaybeGzip = async (res) => {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && typeof DecompressionStream === 'function') {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).text();
    }
    return new TextDecoder().decode(buf);
  };
  // Guest request first; if bot protection answers, retry once with the
  // auditor's cookies (which already passed the challenge) and say so.
  let challenged = 0;
  const fetchXml = async (url) => {
    let res = await timedFetch(url, { credentials: 'omit' });
    let text = res.ok ? await readMaybeGzip(res) : '';
    if (res.ok && !/<(urlset|sitemapindex)\b/i.test(text) && isChallenge(text)) {
      challenged += 1;
      res = await timedFetch(url, { credentials: 'include' });
      text = res.ok ? await readMaybeGzip(res) : '';
    }
    return { res, text };
  };
  const locsOf = (xml, tag) => {
    const found = [];
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    let m;
    while ((m = re.exec(xml)) && found.length < 2000) {
      const block = m[1];
      const loc = (block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1];
      const lastmod = (block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i) || [])[1] || '';
      if (loc) found.push({ loc: loc.replace(/&amp;/g, '&'), lastmod });
    }
    return found;
  };
  try {
    const declared = out.robots && out.robots.text
      ? [...out.robots.text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 10)
      : [];
    const candidates = [...declared.filter(sameOrigin), `${origin}/sitemap_index.xml`, `${origin}/sitemap.xml`]
      .filter((u, i, a) => a.indexOf(u) === i);
    const sm = { declared: declared.map((u) => clip(u, 300)), declaredOffsite: declared.filter((u) => !sameOrigin(u)).length, url: '', status: 0, isIndex: false, children: 0, filesRead: 0, urls: 0, lastmod: null, samples: [] };
    let xml = '';
    for (const u of candidates) {
      try {
        const { res, text } = await fetchXml(u);
        if (!res.ok) { if (!sm.url) sm.status = res.status; continue; }
        if (!/<(urlset|sitemapindex)\b/i.test(text)) continue;
        sm.url = clip(u, 300);
        sm.status = res.status;
        xml = text;
        break;
      } catch { /* try the next candidate */ }
    }
    if (xml) {
      sm.filesRead = 1;
      let urls = [];
      if (/<sitemapindex\b/i.test(xml)) {
        sm.isIndex = true;
        const children = locsOf(xml, 'sitemap').map((c) => c.loc).filter(sameOrigin);
        sm.children = children.length;
        for (const child of children.slice(0, 4)) {
          if (urls.length >= 500) break;
          try {
            const { res, text } = await fetchXml(child);
            if (!res.ok || !/<urlset\b/i.test(text)) continue;
            urls = urls.concat(locsOf(text, 'url'));
            sm.filesRead += 1;
          } catch { /* skip a broken child sitemap */ }
        }
      } else {
        urls = locsOf(xml, 'url');
      }
      sm.urls = urls.length;
      const dates = urls.map((u) => u.lastmod.slice(0, 10)).filter(Boolean);
      const today = new Date().toISOString().slice(0, 10);
      sm.lastmod = { withDate: dates.length, distinct: new Set(dates).size, today: dates.filter((d) => d === today).length };

      const own = urls.filter((u) => sameOrigin(u.loc));
      const step = Math.max(1, Math.floor(own.length / 10));
      const picks = own.filter((_, i) => i % step === 0).slice(0, 10);
      const check = async (u) => {
        try {
          let viaCookies = false;
          let res = await timedFetch(u.loc, { credentials: 'omit' });
          let html = await res.text();
          if (isChallenge(html)) {
            viaCookies = true;
            res = await timedFetch(u.loc, { credentials: 'include' });
            html = await res.text();
          }
          const d = new DOMParser().parseFromString(html.slice(0, 600000), 'text/html');
          const robots = [...d.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i]')].map((m) => m.getAttribute('content') || '').join(', ');
          const canonical = (d.querySelector('link[rel="canonical" i]') || {}).href || '';
          return {
            url: clip(u.loc, 300),
            status: res.status,
            redirected: res.redirected,
            finalUrl: clip(res.url, 300),
            robots: clip(robots, 120),
            xRobots: clip(res.headers.get('x-robots-tag') || '', 120),
            canonical: clip(canonical, 300),
            isHtml: /text\/html/i.test(res.headers.get('content-type') || ''),
            viaCookies,
          };
        } catch (e) {
          return { url: clip(u.loc, 300), status: 0, error: clip(String(e && e.name === 'AbortError' ? 'timeout' : e), 80) };
        }
      };
      for (let i = 0; i < picks.length; i += 4) {
        sm.samples.push(...await Promise.all(picks.slice(i, i + 4).map(check)));
      }
    }
    sm.challenged = challenged;
    out.sitemap = sm;
  } catch (e) { out.errors.push(`sitemap: ${clip(String(e), 120)}`); }

  return out;
}
