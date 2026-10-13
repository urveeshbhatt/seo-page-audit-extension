// Phase 2 rules: turns collectNetwork() data (and the optional redirect tests)
// into findings. Runs in the side panel. Pure functions, no DOM.

import { finding, plural, isPrelaunch, REVENUE_TYPES } from './phase1-rules.js';
import { isInternalHop } from './phase2-redirects.js';

const kb = (bytes) => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes < 1024) return `${bytes} bytes`;
  return `${Math.round(bytes / 1024)} KB`;
};
const ms = (n) => (n == null ? '?' : `${n} ms`);
const median = (list) => {
  const v = list.filter((n) => typeof n === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};
const noHash = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u || ''; } };
const siteOf = (host) => host.replace(/^www\./, '').split('.').slice(-2).join('.');

// ======================= Main document =======================

function documentFindings(d, head) {
  const out = [];
  const doc = d.doc;
  const nav = d.nav || {};
  if (!doc) {
    out.push(finding('net-doc', 'Page response', 'Could not re-fetch the page', 'info', 'The page could not be requested again from inside the tab (timeout or blocked). Use DevTools → Network for this page.', 'Check by hand'));
    return out;
  }
  const h = doc.headers || {};

  // Bot protection served instead of the page
  if (doc.challengeHint) {
    out.push(finding('net-challenge', 'Bot protection', `"${doc.challengeHint}" page, ${kb(doc.bytes)}`, 'warning',
      'A bot-protection page (challenge / captcha) answered instead of the real HTML. If Googlebot or AI crawlers get the same, they index nothing. Check URL Inspection → View crawled page in Search Console.', 'Check by hand'));
  }

  const status = doc.status;
  if (status >= 500) out.push(finding('net-status', 'HTTP status', status, 'critical', 'Server error. Google retries, then drops the page if it keeps failing.'));
  else if (status >= 400) out.push(finding('net-status', 'HTTP status', status, 'critical', 'The page returns an error code. Google will not index it even though it shows in the browser.'));
  else out.push(finding('net-status', 'HTTP status', status, 'good', 'Page returns 200 OK.'));
  if (nav.redirectCount > 0) {
    out.push(finding('net-arrived', 'Arrived by redirect', plural(nav.redirectCount, 'redirect'), 'info', 'You reached this page through a redirect. Fine if you typed an old URL; internal links should point straight at the final URL.'));
  }

  // Protocol
  const proto = (nav.protocol || '').toLowerCase();
  if (proto === 'h2' || proto === 'h3') out.push(finding('net-protocol', 'HTTP version', proto.toUpperCase(), 'good', 'Modern protocol: many files load over one connection.'));
  else if (proto) out.push(finding('net-protocol', 'HTTP version', proto, 'warning', 'HTTP/1.1 loads files a few at a time. Turn on HTTP/2 or HTTP/3 at the host or CDN (usually one switch).'));

  // Compression
  const enc = (h['content-encoding'] || '').toLowerCase();
  const decoded = nav.decodedBodySize || doc.decoded || doc.bytes;
  const encoded = nav.encodedBodySize || doc.encoded;
  const sizes = encoded && decoded ? `${kb(encoded)} sent, ${kb(decoded)} unpacked` : kb(decoded);
  if (/br|zstd|gzip|deflate/.test(enc)) out.push(finding('net-encoding', 'Compression', `${enc} · ${sizes}`, 'good', 'HTML is compressed on the wire.'));
  else if (decoded > 20 * 1024) out.push(finding('net-encoding', 'Compression', `none · ${sizes}`, 'warning', 'HTML is sent uncompressed. Turn on Brotli or Gzip at the server or CDN: usually 70–80% smaller.'));

  const ct = h['content-type'] || '';
  if (/text\/html/i.test(ct) && !/charset/i.test(ct)) {
    out.push(finding('net-charset', 'Charset header', ct, 'info', 'No charset in Content-Type. Fine if the HTML has <meta charset="utf-8"> in the first 1024 bytes.'));
  }

  // Caching headers on HTML
  const cc = h['cache-control'] || '';
  if (/no-store|private/i.test(cc)) {
    out.push(finding('net-cache-control', 'Cache-Control', cc, 'info', 'HTML is marked not cacheable. Normal for carts and logged-in pages; on public pages it means every visit is built fresh by the server.'));
  } else if (cc) {
    out.push(finding('net-cache-control', 'Cache-Control', cc, 'good', 'HTML can be cached.'));
  }
  const vary = (h.vary || '').toLowerCase();
  if (/cookie|user-agent/.test(vary)) {
    out.push(finding('net-vary', 'Vary', h.vary, 'warning', 'The cache keeps a separate copy per cookie or browser. Hit rate drops and some visitors always get the slow, uncached page.'));
  }

  // HSTS
  if (d.url && d.url.startsWith('https:')) {
    const hsts = h['strict-transport-security'] || '';
    const age = Number((hsts.match(/max-age=(\d+)/i) || [])[1] || 0);
    if (!hsts) out.push(finding('net-hsts', 'HSTS', 'Not set', 'info', 'Without HSTS the first http:// visit is not forced to https by the browser. Add it once https works everywhere (start with a short max-age).'));
    else if (age < 15552000) out.push(finding('net-hsts', 'HSTS', hsts, 'info', 'HSTS is on with a short max-age (under 6 months). Fine while testing; raise it once you are sure.'));
    else out.push(finding('net-hsts', 'HSTS', hsts, 'good', 'Browsers always use https for this site.'));
  }

  // Version leaks
  const leaks = ['server', 'x-powered-by', 'x-aspnet-version'].filter((k) => /\d+\.\d+/.test(h[k] || '')).map((k) => `${k}: ${h[k]}`);
  if (leaks.length) out.push(finding('net-server', 'Version in headers', leaks.join(' · '), 'info', 'Software versions are visible to anyone. Not an SEO issue; hiding them makes automated attacks a little harder.'));

  // Link header vs canonical
  const link = h.link || '';
  if (link) {
    const canonHeader = (link.match(/<([^>]+)>\s*;\s*rel="?canonical"?/i) || [])[1];
    const headCanon = head && head.canonicals && head.canonicals[0];
    const headHref = typeof headCanon === 'string' ? headCanon : headCanon && headCanon.href;
    if (canonHeader) {
      if (headHref && noHash(headHref) !== noHash(new URL(canonHeader, d.url).href)) {
        out.push(finding('net-link-canonical', 'Canonical in Link header', canonHeader, 'warning', `The HTTP header says one canonical, the HTML says another (${headHref}). With conflicting signals Google may ignore both. Keep one.`));
      } else {
        out.push(finding('net-link-canonical', 'Canonical in Link header', canonHeader, 'good', 'Canonical sent as an HTTP header and it agrees with the HTML.'));
      }
    } else if (/api\.w\.org|wp-json|rel="?shortlink/i.test(link)) {
      out.push(finding('net-link-header', 'Link header', link.slice(0, 120), 'info', 'WordPress REST API / shortlink header. This is not a canonical and does not affect indexing.', 'Ignored'));
    }
  }
  return out;
}

// ======================= Caching and TTFB =======================

const CDN_TESTS = [
  ['Cloudflare', (h) => h['cf-ray'] || h['cf-cache-status'] || /cloudflare/i.test(h.server || '')],
  ['Hostinger CDN', (h) => Object.keys(h).some((k) => k.startsWith('x-hcdn'))],
  ['CloudFront', (h) => h['x-amz-cf-id'] || /cloudfront/i.test(h.via || '') || /cloudfront/i.test(h['x-cache'] || '')],
  ['Fastly', (h) => h['x-served-by'] && /cache-/i.test(h['x-served-by']) || h['fastly-debug-digest']],
  ['Akamai', (h) => h['x-akamai-transformed'] || /akamai/i.test(h.server || '')],
  ['Vercel', (h) => h['x-vercel-cache'] || h['x-vercel-id']],
  ['Netlify', (h) => h['x-nf-request-id']],
  ['Imperva', (h) => h['x-iinfo'] || /incapsula|imperva/i.test(h['x-cdn'] || '')],
  ['Sucuri', (h) => h['x-sucuri-id']],
  ['Bunny CDN', (h) => /bunnycdn/i.test(h.server || '') || h['cdn-requestid']],
];

const LAYERS = [
  ['CDN', ['cf-cache-status', 'x-hcdn-cache-status', 'x-vercel-cache', 'x-cache-status', 'x-proxy-cache', 'x-cache']],
  ['Next.js', ['x-nextjs-cache']],
  ['LiteSpeed', ['x-litespeed-cache']],
  ['WP cache', ['x-wp-cache', 'x-rocket-nginx-serving-static']],
];

function normalise(raw) {
  const v = String(raw || '').toUpperCase();
  if (!v) return '';
  if (/HIT/.test(v)) return 'HIT';
  if (/BYPASS/.test(v)) return 'BYPASS';
  if (/DYNAMIC/.test(v)) return 'DYNAMIC';
  if (/EXPIRED|STALE|REVALIDATED|UPDATING/.test(v)) return 'STALE';
  if (/MISS/.test(v)) return 'MISS';
  return v.split(/[\s,]/)[0];
}

/**
 * Cache status per layer. Sites often stack an edge CDN on top of a server
 * cache (Hostinger CDN + LiteSpeed): "CDN BYPASS" with "LiteSpeed HIT" means
 * the edge skipped but the server still answered from its cache.
 */
export function cacheLayers(cache = {}) {
  const out = {};
  LAYERS.forEach(([layer, keys]) => {
    const k = keys.find((key) => cache[key]);
    if (k) out[layer] = normalise(cache[k]);
  });
  return out;
}

/** The outermost layer's status (what decides whether the server is reached at all). */
export function cacheStatus(cache = {}) {
  const l = cacheLayers(cache);
  return l.CDN || l['Next.js'] || l.LiteSpeed || l['WP cache'] || '';
}

const layerText = (list) => {
  const seen = {};
  list.forEach((s) => Object.entries(cacheLayers(s.cache)).forEach(([layer, st]) => { (seen[layer] = seen[layer] || []).push(st); }));
  return Object.entries(seen).map(([layer, sts]) => `${layer} ${[...new Set(sts)].join('/')}`).join(' + ') || '?';
};

function ttfbFinding(id, check, list, who, goodWhy) {
  const m = median(list.map((s) => s.ttfb));
  if (m == null) return null;
  const range = list.map((s) => s.ttfb).filter((n) => n != null).join(' / ');
  const value = `${ms(m)} median (${range})`;
  if (m <= 800) return finding(id, check, value, 'good', `${who} Within Google's 800 ms guide. ${goodWhy}`);
  if (m <= 1800) return finding(id, check, value, 'warning', `${who} Above the 800 ms guide. Every paint metric starts late. Usually uncached PHP / database work.`);
  return finding(id, check, value, 'warning', `${who} Above 1.8 s: Google calls this poor. Cache the HTML or fix slow server code first; nothing on the page can make up for it.`, 'Fix');
}

function cachingFindings(d) {
  const out = [];
  const h = (d.doc && d.doc.headers) || {};
  const cdns = CDN_TESTS.filter(([, t]) => t(h)).map(([n]) => n);
  if (h['x-litespeed-cache'] || /litespeed/i.test(h.server || '')) cdns.push('LiteSpeed server cache');
  out.push(cdns.length
    ? finding('net-cdn', 'CDN / cache layer', cdns.join(', '), 'good', 'Detected from response headers. Each vendor uses its own header names.')
    : finding('net-cdn', 'CDN / cache layer', 'None detected', 'info', 'No known CDN headers. Visitors far from the server wait longer; a CDN with HTML caching is the biggest TTFB win for most sites.'));

  const warm = (d.warm || []).filter((x) => x.status);
  const cold = (d.cold || []).filter((x) => x.status);
  const edge = (list) => list.map((x) => cacheStatus(x.cache)).filter(Boolean);
  const inner = (list) => list.map((x) => { const l = cacheLayers(x.cache); return l.LiteSpeed || l['WP cache'] || l['Next.js'] || ''; }).filter(Boolean);
  const warmStates = edge(warm);
  const coldStates = edge(cold);
  if (warmStates.length || coldStates.length) {
    const value = `With your cookies: ${layerText(warm)} · Guest, new URL: ${layerText(cold)}`;
    const skips = (st) => st.length && st.every((x) => x === 'BYPASS' || x === 'DYNAMIC');
    const innerHit = inner(warm).length && inner(warm).every((x) => x === 'HIT');
    if (skips(coldStates)) {
      out.push(finding('net-cache-hit', 'HTML cache', value, 'warning', 'The edge cache never stores this HTML, even for a guest. Every visitor and crawler waits for the server. Add a cache rule for HTML (Cloudflare: Cache Rules → Eligible for cache).'));
    } else if (warmStates.length && warmStates.every((x) => x === 'HIT')) {
      out.push(finding('net-cache-hit', 'HTML cache', value, 'good', 'Repeat requests come from the edge cache. Guest requests to a brand-new URL miss by design; they show the origin speed below.'));
    } else if (skips(warmStates)) {
      out.push(finding('net-cache-hit', 'HTML cache', value, 'info', `The edge cache skips your requests but not a guest's. A cookie in your browser (login, cart, or a cache "vary" cookie such as _lscache_vary) is the usual reason.${innerHit ? ' The server cache still answered (HIT), so you get a fast page anyway.' : ''} Re-test in an incognito window.`, 'Check by hand'));
    } else {
      out.push(finding('net-cache-hit', 'HTML cache', value, 'info', 'Cache status varies between requests. Pages can be cached per variant (device, cookie, currency); warm the important ones after each purge.'));
    }
  }

  const blockedCold = cold.filter((x) => x.challenge);
  if (blockedCold.length) {
    out.push(finding('net-guest-blocked', 'Guest requests', `${blockedCold.length} of ${cold.length} got a bot-protection page (${kb(Math.max(...blockedCold.map((x) => x.decoded || 0)))})`, 'warning',
      'Requests without your cookies got a challenge page instead of the HTML, so the uncached speed could not be measured. Imperva and Cloudflare usually let verified Googlebot through, but Bing, AI crawlers and SEO tools may see only this page. Check URL Inspection in Search Console and Bing Webmaster Tools.', 'Check by hand'));
  }
  const w = ttfbFinding('net-ttfb-warm', 'TTFB (repeat visit)', warm.filter((s) => s.status), 'What a returning visitor gets (your cookies, cache warm).', 'A low number here means the HTML came from a cache; it does not tell you how the page was built (SSR, SSG or PHP).');
  const c = ttfbFinding('net-ttfb-cold', 'TTFB (uncached)', cold.filter((s) => s.status && !s.challenge), 'Server speed when the cache misses: what Googlebot and first visitors to a page often get.', 'The server builds the page fast enough even without cache.');
  if (w) out.push(w);
  if (c) out.push(c);
  const coldT = cold.filter((s) => !s.challenge).map((s) => s.ttfb).filter((n) => n != null);
  if (coldT.length >= 2 && Math.max(...coldT) - Math.min(...coldT) > 1000) {
    out.push(finding('net-ttfb-spread', 'TTFB stability', `${Math.min(...coldT)}–${Math.max(...coldT)} ms`, 'info', 'Uncached response time jumps by more than a second between tries. Busy shared hosting or a slow plugin on some requests. Re-test at another time of day.'));
  }
  if (out.some((f) => f.id.startsWith('net-ttfb'))) {
    out.push(finding('net-ttfb-note', 'About these timings', 'Measured from your browser', 'info', 'Times include your own network and distance to the server. Compare with PageSpeed Insights (field data) before reporting numbers to a client.'));
  }
  return out;
}

// ======================= Timing =======================

function timingFindings(d) {
  const n = d.nav;
  if (!n) return [];
  const out = [];
  if (n.fromCache) {
    out.push(finding('net-timing', 'Page load timing', 'Loaded from browser cache', 'info', 'This load came from the browser cache, so connection times are zero. Tick "Disable cache" in DevTools and reload for real numbers.', 'Re-check later'));
    return out;
  }
  const value = `DNS ${ms(n.dns)} · connect ${ms(n.connect)} · TLS ${ms(n.ssl)} · TTFB ${ms(n.ttfb)} · download ${ms(n.download)}`;
  const slow = [];
  if (n.dns > 200) slow.push('DNS lookup is slow (try a faster DNS provider such as Cloudflare)');
  if (n.connect > 400) slow.push('connecting takes long (server far away or overloaded; a CDN helps)');
  if (n.download > 1000) slow.push('the HTML takes over a second to download (heavy HTML or slow link)');
  out.push(finding('net-timing', 'Page load timing', value, slow.length ? 'warning' : 'good',
    slow.length ? `${slow.join('; ')}.` : 'No slow step in getting the HTML. A first visit pays DNS, connect and TLS once; later pages reuse the connection.'));
  if (n.domContentLoaded && n.load) {
    out.push(finding('net-events', 'Page events', `DOMContentLoaded ${ms(n.domContentLoaded)} · load ${ms(n.load)}`, n.load > 6000 ? 'info' : 'good',
      n.load > 6000 ? 'The page keeps loading for a long time, usually trackers, chat widgets and lazy images. Not a ranking factor on its own; check LCP in PageSpeed Insights.' : 'For reference.'));
  }
  return out;
}

// ======================= Resources =======================

const PURPOSES = {
  'analytics': [/google-analytics|googletagmanager\.com\/gtag|analytics\.google/, /mixpanel/, /segment\.(io|com)/, /plausible/, /matomo/, /amplitude/, /posthog/, /heap(analytics)?\./],
  'heatmaps / session replay': [/hotjar/, /clarity\.ms/, /mouseflow/, /crazyegg/, /luckyorange/, /fullstory/, /smartlook/],
  'live chat': [/tawk\.to/, /intercom/, /crisp\.chat/, /zendesk|zdassets/, /freshchat|freshworks/, /wati\.io/, /interakt/, /tidio/, /livechatinc/, /drift/],
  'web fonts': [/fonts\.(googleapis|gstatic)/, /typekit|use\.adobe/, /fonts\.bunny/, /fontawesome/],
  'A/B testing': [/optimizely/, /vwo|visualwebsiteoptimizer/, /abtasty/, /convert\.com/],
};

export function vendorsByPurpose(hosts) {
  const out = {};
  Object.entries(PURPOSES).forEach(([purpose, tests]) => {
    const hit = tests.filter((re) => hosts.some((h) => re.test(h))).map((re) => hosts.find((h) => re.test(h)));
    if (hit.length) out[purpose] = hit;
  });
  return out;
}

function resourceFindings(d) {
  const r = d.resources;
  if (!r || !r.entries) return [];
  const out = [];
  const site = siteOf(d.host || '');
  const own = r.entries.filter((e) => siteOf(e.host) === site);
  const third = r.entries.filter((e) => siteOf(e.host) !== site);

  const html = (d.nav && d.nav.encodedBodySize) || (d.doc && d.doc.encoded) || 0;
  const total = html + r.entries.reduce((s, e) => s + (e.encoded || 0), 0);
  const hidden = third.filter((e) => !e.encoded).length;
  const value = `${kb(total)} (HTML + ${plural(r.entries.length, 'file')})${hidden ? ` +${hidden} third-party files with hidden size` : ''}`;
  const hiddenNote = hidden ? ` ${hidden} third-party files hide their size (no Timing-Allow-Origin header), so the real total is higher. DevTools → Network shows the full number.` : '';
  if (total > 3 * 1024 * 1024) out.push(finding('net-weight', 'Page weight', value, 'warning', `Heavy page for mobile data. Start with the largest images and scripts.${hiddenNote}`));
  else if (total > 1.5 * 1024 * 1024 || hidden > 10) out.push(finding('net-weight', 'Page weight', value, 'info', `${total > 1.5 * 1024 * 1024 ? 'Moderate weight' : 'Known part is light'}. Check that images are WebP/AVIF and sized for the screen.${hiddenNote}`));
  else out.push(finding('net-weight', 'Page weight', value, 'good', `Light page.${hiddenNote}`));

  const css = own.filter((e) => e.type === 'css').length;
  const js = own.filter((e) => e.type === 'js').length;
  out.push(finding('net-files', 'Own CSS and JS files', `${plural(css, 'CSS file')} · ${plural(js, 'JS file')}`, css > 20 || js > 40 ? 'warning' : 'good',
    css > 20 || js > 40 ? 'Many separate files from your own site. Each one is a request; combine and defer them with your cache / optimisation plugin, then re-test.' : 'File count from your own site is reasonable.'));

  const ownH1 = own.filter((e) => e.protocol === 'http/1.1').length;
  if (ownH1 > 5) out.push(finding('net-res-protocol', 'Files over HTTP/1.1', `${ownH1} of your own files`, 'warning', 'Your own files load over HTTP/1.1 (a few at a time). Turn on HTTP/2 at the host or CDN.'));

  const hosts = [...new Set(third.map((e) => e.host))];
  if (hosts.length) {
    out.push(finding('net-thirdparty', 'Third-party domains', plural(hosts.length, 'domain'), hosts.length > 15 ? 'warning' : 'info',
      hosts.length > 15 ? 'Many outside services. Each one adds DNS + connection time and code you do not control. Remove what nobody uses.' : 'Outside services this page loads. Check each one is still needed.', null, hosts));
  }
  const dupes = Object.entries(vendorsByPurpose(hosts)).filter(([p, v]) => v.length > 1 && p !== 'web fonts');
  dupes.forEach(([purpose, v]) => {
    const clear = purpose === 'live chat' || purpose === 'heatmaps / session replay';
    out.push(finding(`net-dupe-${purpose.split(/\W/)[0]}`, `Two tools for ${purpose}`, v.join(' + '), clear ? 'warning' : 'info',
      clear ? `More than one ${purpose} tool loads on every page. Pick one; the other costs speed and adds no value.`
        : `More than one ${purpose} tool loads. Sometimes on purpose (marketing vs product analytics); confirm each one has an owner who uses it.`, null, v));
  });
  return out;
}

// ======================= robots.txt =======================

/** Parse robots.txt into groups: [{agents: [], rules: [{type, path}]}], plus sitemaps and other lines. */
export function parseRobots(text = '') {
  const groups = [];
  const sitemaps = [];
  const other = [];
  let current = null;
  let lastWasAgent = false;
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) return;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (key === 'sitemap') sitemaps.push(val);
    else if ((key === 'allow' || key === 'disallow') && current) current.rules.push({ type: key, path: val });
    else other.push({ key, val });
  });
  return { groups, sitemaps, other };
}

function ruleMatches(pattern, path) {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}

/** Google's rule: the longest matching path wins; Allow wins a tie. Empty Disallow means nothing. */
export function isAllowed(rules, path) {
  let best = null;
  rules.forEach((r) => {
    if (!ruleMatches(r.path, path)) return;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.type === 'allow')) best = { len, type: r.type, path: r.path };
  });
  return { allowed: !best || best.type === 'allow', rule: best };
}

function rulesFor(parsed, agent) {
  const exact = parsed.groups.filter((g) => g.agents.includes(agent));
  const groups = exact.length ? exact : parsed.groups.filter((g) => g.agents.includes('*'));
  return { rules: groups.flatMap((g) => g.rules), named: exact.length > 0 };
}

const AI_BOTS = [
  ['oai-searchbot', 'search'], ['chatgpt-user', 'user'], ['gptbot', 'training'],
  ['claude-searchbot', 'search'], ['claude-user', 'user'], ['claudebot', 'training'],
  ['perplexitybot', 'search'], ['perplexity-user', 'user'],
  ['google-extended', 'training'], ['applebot-extended', 'training'], ['ccbot', 'training'],
  ['bytespider', 'training'], ['meta-externalagent', 'training'],
];

function robotsFindings(d, ctx) {
  const out = [];
  const r = d.robots;
  if (!r) return out;
  if (!r.status) { out.push(finding('net-robots', 'robots.txt', r.error || 'Not reachable', 'info', 'Could not read robots.txt from the page. Open /robots.txt in a tab to check.', 'Check by hand')); return out; }
  if (r.status >= 500) {
    out.push(finding('net-robots', 'robots.txt', `HTTP ${r.status}`, 'critical', 'robots.txt returns a server error. Google stops crawling the whole site while this lasts. Fix the server or serve a plain 200 file.'));
    return out;
  }
  if (r.status >= 400) {
    out.push(finding('net-robots', 'robots.txt', `HTTP ${r.status}`, 'info', 'No robots.txt. Google treats this as "crawl everything", which is fine for small sites. Add one to point to your sitemap.'));
    return out;
  }
  if (/text\/html/i.test(r.contentType) || /^\s*<(!doctype|html)/i.test(r.text || '')) {
    out.push(finding('net-robots', 'robots.txt', `HTML page (${r.contentType})`, 'warning', 'robots.txt returns a web page instead of plain text. Crawlers find no rules in it. Usually a theme or 404 page catching the URL.'));
    return out;
  }

  const parsed = parseRobots(r.text || '');
  let path = '/';
  try { const u = new URL(d.url); path = u.pathname + u.search; } catch { /* keep / */ }
  const g = rulesFor(parsed, 'googlebot');
  const root = isAllowed(g.rules, '/');
  const page = isAllowed(g.rules, path);
  if (!root.allowed && parsed.groups.length) {
    out.push(isPrelaunch(ctx)
      ? finding('net-robots', 'robots.txt', `Disallow: ${root.rule.path} (whole site)`, 'warning', 'The whole site is blocked from Google. Expected while building; remove it on launch day.', 'Launch blocker')
      : finding('net-robots', 'robots.txt', `Disallow: ${root.rule.path} (whole site)`, 'critical', 'The whole site is blocked from Google crawling. Pages drop out of search over time.'));
  } else if (!page.allowed) {
    const sev = REVENUE_TYPES.has(ctx && ctx.pageType) && !isPrelaunch(ctx) ? 'critical' : 'warning';
    out.push(finding('net-robots', 'robots.txt', `This page matches Disallow: ${page.rule.path}`, sev, 'Google may not crawl this page. A noindex on it will never be seen either; blocked URLs can still show in results without a description.'));
  } else {
    out.push(finding('net-robots', 'robots.txt', `${plural(parsed.groups.length, 'group')}, ${plural(parsed.sitemaps.length, 'sitemap line')}`, 'good', `This page is allowed for Googlebot${g.named ? ' (it has its own group)' : ''}.`));
  }

  const assets = ['/wp-content/themes/x/style.css', '/wp-includes/js/jquery/jquery.min.js', '/wp-content/plugins/x/app.js', '/assets/app.js', '/static/app.css', '/_next/static/x.js'];
  const blocked = assets.filter((p) => !isAllowed(g.rules, p).allowed).map((p) => `${p} ← ${isAllowed(g.rules, p).rule.path}`);
  if (blocked.length && root.allowed) {
    out.push(finding('net-robots-assets', 'CSS / JS blocked', plural(blocked.length, 'typical path'), 'warning', 'robots.txt blocks folders that hold CSS or JS. Google cannot render the page properly without them. Remove these Disallow lines.', null, blocked));
  }

  if (!parsed.sitemaps.length) out.push(finding('net-robots-sitemap', 'Sitemap line', 'Missing', 'info', 'Add "Sitemap: https://…/sitemap.xml" to robots.txt so every crawler (not only Google) finds it.'));

  const agentCount = {};
  parsed.groups.forEach((gr) => gr.agents.forEach((a) => { agentCount[a] = (agentCount[a] || 0) + 1; }));
  const dup = Object.entries(agentCount).filter(([, n]) => n > 1).map(([a]) => a);
  if (dup.length) out.push(finding('net-robots-dupe', 'Repeated user-agent', dup.join(', '), 'info', 'The same bot is named in more than one group. Google merges them; some other crawlers only read the first. Merge into one group.'));

  const blockedAi = AI_BOTS.filter(([bot]) => { const x = rulesFor(parsed, bot); return x.named && !isAllowed(x.rules, '/').allowed; });
  if (blockedAi.length) {
    const search = blockedAi.filter(([, k]) => k !== 'training').map(([b]) => b);
    out.push(finding('net-robots-ai', 'AI crawlers blocked', blockedAi.map(([b]) => b).join(', '), search.length ? 'warning' : 'info',
      search.length
        ? `Search / user bots blocked (${search.join(', ')}): the site cannot be cited in ChatGPT, Claude or Perplexity answers. Make sure this is a business decision.`
        : 'Only AI training bots are blocked. This does not affect Google Search or AI search citations.', 'Check by hand'));
  }
  const signal = parsed.other.filter((o) => o.key === 'content-signal');
  if (signal.length) out.push(finding('net-robots-signal', 'Content-Signal', signal.map((s) => s.val).join(' | '), 'info', 'Cloudflare\'s content-use preference (search / ai-input / ai-train). A statement of preference, not a block: bots are not forced to follow it.'));
  return out;
}

// ======================= Sitemap and llms.txt =======================

function sitemapFindings(d, ctx) {
  const out = [];
  const s = d.sitemap;
  if (!s) return out;
  if (!s.url) {
    out.push(finding('net-sitemap', 'XML sitemap', s.declaredOffsite ? 'Only on another domain' : 'Not found', s.declaredOffsite ? 'info' : 'warning',
      s.declaredOffsite ? 'robots.txt points to a sitemap on another host, which this check cannot read. Open it by hand.' : 'No sitemap at robots.txt, /sitemap_index.xml or /sitemap.xml. Turn it on in your SEO plugin and submit it in Search Console.'));
    return out;
  }
  out.push(finding('net-sitemap', 'XML sitemap', `${s.url} · ${s.isIndex ? `index of ${plural(s.children, 'sitemap')}, ` : ''}${plural(s.urls, 'URL')} read`, 'good',
    `Found and readable${s.isIndex && s.children > s.filesRead - 1 ? ` (read the first ${s.filesRead - 1} child sitemaps)` : ''}.`));

  if (s.challenged) {
    out.push(finding('net-sitemap-wall', 'Sitemap behind bot protection', plural(s.challenged, 'file'), 'warning',
      'Sitemap files answered a guest request with a challenge page; they were read here with your cookies instead. Crawlers that are not on the allow list cannot read them. Check the sitemap report in Search Console (status "Success") and in Bing.', 'Check by hand'));
  }
  if (s.isIndex && !s.urls) {
    out.push(finding('net-sitemap-empty', 'Sitemap URLs', 'None read', 'info', 'The sitemap index was found but no page URLs could be read from its child files. Open one child sitemap by hand.', 'Check by hand'));
  }
  const samples = s.samples || [];
  if (samples.length) {
    const bad = samples.filter((x) => x.status !== 200 || x.redirected);
    const noindex = samples.filter((x) => /noindex/i.test(`${x.robots} ${x.xRobots}`));
    const otherCanon = samples.filter((x) => x.canonical && x.status === 200 && noHash(x.canonical) !== noHash(x.finalUrl));
    if (bad.length) out.push(finding('net-sitemap-status', 'Sitemap URLs that redirect or fail', `${bad.length} of ${samples.length} sampled`, 'warning', 'A sitemap should list only final 200 URLs. Redirects and errors waste crawl and make Google trust the sitemap less.', null, bad.map((x) => `${x.status}${x.redirected ? ' (redirected)' : ''} ${x.url}`)));
    if (noindex.length) {
      out.push(isPrelaunch(ctx) && noindex.length === samples.length
        ? finding('net-sitemap-noindex', 'Noindex URLs in sitemap', `${noindex.length} of ${samples.length} sampled`, 'warning', 'Expected before launch (the whole site is noindex). Re-check after launch.', 'Launch blocker')
        : finding('net-sitemap-noindex', 'Noindex URLs in sitemap', `${noindex.length} of ${samples.length} sampled`, 'warning', 'The sitemap asks Google to index pages that say noindex. Mixed signal: remove them from the sitemap or drop the noindex.', null, noindex.map((x) => x.url)));
    }
    if (otherCanon.length) out.push(finding('net-sitemap-canonical', 'Sitemap URLs canonical elsewhere', `${otherCanon.length} of ${samples.length} sampled`, 'warning', 'These URLs point their canonical to a different URL. List the canonical URL in the sitemap instead.', null, otherCanon.map((x) => `${x.url} → ${x.canonical}`)));
    const walled = samples.filter((x) => x.viaCookies);
    if (walled.length) out.push(finding('net-sitemap-samples-wall', 'Sitemap pages behind bot protection', `${walled.length} of ${samples.length} sampled`, 'info', 'These pages showed a challenge page to a guest and were checked with your cookies instead.', 'Check by hand', walled.map((x) => x.url)));
    if (!bad.length && !noindex.length && !otherCanon.length) out.push(finding('net-sitemap-samples', 'Sitemap sample', `${samples.length} URLs checked`, 'good', 'Every sampled URL returns 200, is indexable and canonical to itself.'));
  }

  const lm = s.lastmod;
  if (lm && s.urls) {
    if (!lm.withDate) out.push(finding('net-sitemap-lastmod', 'lastmod dates', 'None', 'info', 'No lastmod. Optional, but accurate dates help Google re-crawl changed pages sooner.'));
    else if (lm.withDate > 5 && (lm.distinct === 1 || lm.today === lm.withDate)) out.push(finding('net-sitemap-lastmod', 'lastmod dates', lm.today === lm.withDate ? 'All set to today' : 'All the same date', 'warning', 'Every URL has the same lastmod. Google only uses lastmod when it is consistently accurate, so it will learn to ignore it. Use the real last-edit date.'));
    else out.push(finding('net-sitemap-lastmod', 'lastmod dates', `${lm.withDate} dated, ${lm.distinct} distinct days`, 'good', 'Dates vary, which looks like real edit dates.'));
  }
  return out;
}

function llmsFindings(d) {
  const l = d.llms;
  if (!l || !l.status) return [];
  if (l.status === 200 && l.looksLikeHtml) return [finding('net-llms', 'llms.txt', 'Returns an HTML page', 'info', 'The URL answers with a web page (soft 404), not a text file. Harmless; it only matters if you meant to publish one.')];
  if (l.status === 200) return [finding('net-llms', 'llms.txt', 'Present', 'info', 'Optional proposal for AI tools. Google has said it does not use it for Search. Harmless to keep; do not expect ranking or citation gains from it.')];
  return [finding('net-llms', 'llms.txt', `HTTP ${l.status}`, 'info', 'Not present. Optional: no search engine requires it.')];
}

// ======================= Redirect tests =======================

const chainOf = (t) => [...t.hops.map((h) => (isInternalHop(h) ? 'HSTS' : h.status)), t.finalStatus || t.error || '?'].join(' → ');

function redirectFindings(rd) {
  if (!rd || !rd.results) return [];
  const out = [];
  const canonical = noHash(rd.canonical);
  rd.results.forEach((t) => {
    const id = `net-redir-${t.id}`;
    const server = (t.hops || []).filter((h) => !isInternalHop(h));
    const internal = (t.hops || []).length - server.length;
    const temp = server.filter((h) => h.status === 302 || h.status === 307);
    const value = `${t.url} → ${chainOf(t)}`;
    const landed = noHash(t.finalUrl);
    const items = (t.hops || []).map((h) => `${isInternalHop(h) ? 'HSTS (browser)' : h.status} ${h.from} → ${h.to}`);

    if (t.error) {
      if (/TOO_MANY_REDIRECTS/i.test(t.error)) out.push(finding(id, t.label, `Redirect loop (${t.hopCount || t.hops.length}+ hops)`, 'critical', 'This URL redirects in a circle. Visitors see an error and Google drops it. Usually two rules (plugin + server) fighting over www or the slash.', null, items));
      else if (/NAME_NOT_RESOLVED/i.test(t.error)) out.push(finding(id, t.label, 'Domain does not resolve', 'warning', 'This hostname has no DNS record, so people who type it get an error page. Add a DNS record and redirect it to the main version.'));
      else if (!t.observed && t.id === 'www') out.push(finding(id, t.label, t.error, 'info', 'Could not reach this version (no DNS, no certificate, or access not granted). Open it in a tab to see what visitors get.', 'Check by hand'));
      else out.push(finding(id, t.label, t.error, 'info', 'The test request failed. Open the URL in a tab to see what visitors get.', 'Check by hand'));
      return;
    }

    if (t.id === 'fake') {
      if (t.finalStatus === 404 || t.finalStatus === 410) out.push(finding(id, t.label, value, 'good', 'Missing pages return a real 404. Correct.'));
      else if ((server.length || t.fetchRedirected) && /^https?:\/\/[^/]+\/?$/.test(landed)) out.push(finding(id, t.label, value, 'warning', 'Missing URLs redirect to the homepage. Google treats this as a soft 404, and users lose the context. Return a 404 page with search and links instead.', null, items));
      else if (t.finalStatus === 200) out.push(finding(id, t.label, value, 'warning', 'A URL that does not exist returns 200 (soft 404). Every typo and broken link becomes an "indexable" page. Make the 404 template send a 404 status.'));
      else if (t.finalStatus >= 500) out.push(finding(id, t.label, value, 'warning', 'A missing URL causes a server error. Make the 404 template work.'));
      else out.push(finding(id, t.label, value, 'info', 'Unusual answer for a missing page. Check by hand.', 'Check by hand', items));
      return;
    }

    if (!server.length && internal && landed === canonical) {
      out.push(finding(id, t.label, value, 'info', 'Chrome switched to https by itself (HSTS), so the server\'s own http redirect was not tested. Good for visitors; test the server with a redirect checker or curl -I.', 'Check by hand', items));
      return;
    }
    if (!server.length && !t.observed && t.fetchRedirected && landed === canonical) {
      out.push(finding(id, t.label, `${t.url} → ${t.finalStatus} (hops not visible)`, 'info', 'Redirects to the right page, but the hops could not be read. Check the status codes with a redirect checker.', 'Check by hand'));
      return;
    }
    if (!server.length && t.finalStatus === 200 && landed !== canonical) {
      const fix = t.id === 'slash' ? 'Both versions of the URL load as separate pages. The canonical tag softens this, but pick one and 301 the other.'
        : t.id === 'http' || t.id === 'combo' ? 'The http:// version loads without going to https. Visitors and Google can see an insecure duplicate. Add a 301 to https.'
          : 'This version loads as its own page instead of redirecting. Duplicate site: add a 301 to the main version.';
      out.push(finding(id, t.label, value, t.id === 'slash' ? 'warning' : 'critical', fix));
      return;
    }
    if (t.finalStatus >= 400) {
      out.push(finding(id, t.label, value, t.id === 'slash' ? 'info' : 'warning', t.id === 'slash' ? 'The other slash version returns an error. Better than a duplicate; a 301 would keep links that use it.' : 'This version of the address ends in an error. Redirect it to the main version.', null, items));
      return;
    }
    if (landed !== canonical) {
      out.push(finding(id, t.label, value, 'warning', `Redirects, but lands on ${t.finalUrl} instead of this page. Each old URL should redirect to its own new URL.`, null, items));
      return;
    }
    const problems = [];
    if (temp.length) problems.push(`uses a temporary redirect (${temp.map((h) => h.status).join(', ')}); use 301 or 308 so Google moves the signals for sure`);
    if (server.length >= 3) problems.push(`takes ${server.length} hops; make it a single redirect straight to the final URL`);
    if (problems.length) out.push(finding(id, t.label, value, server.length >= 5 ? 'critical' : 'warning', `Reaches the right page but ${problems.join(', and ')}.`, null, items));
    else out.push(finding(id, t.label, value, 'good', server.length === 1 ? 'One permanent redirect to the right page.' : 'Two permanent hops to the right page. Fine; one is ideal.', null, items));
  });
  if (rd.results.length && !rd.webRequest) {
    out.push(finding('net-redir-mode', 'Redirect detail', 'Hops not visible', 'info', 'Access was not granted, so only the final page is known. Click "Run redirect tests" and allow access to see each hop.'));
  }
  return out;
}

// ======================= public =======================

export function evaluateNetwork(d, ctx = {}, extra = {}) {
  const groups = [
    { id: 'document', title: 'Main document', findings: documentFindings(d, extra.head) },
    { id: 'caching', title: 'Caching and server speed', findings: cachingFindings(d) },
    { id: 'redirects', title: 'Redirects', findings: redirectFindings(extra.redirects) },
    { id: 'timing', title: 'Timing', findings: timingFindings(d) },
    { id: 'resources', title: 'Files and third parties', findings: resourceFindings(d) },
    { id: 'files', title: 'robots.txt, sitemap, llms.txt', findings: [...robotsFindings(d, ctx), ...sitemapFindings(d, ctx), ...llmsFindings(d)] },
  ].filter((g) => g.findings.length);
  const counts = { critical: 0, warning: 0, good: 0, info: 0 };
  groups.forEach((g) => g.findings.forEach((f) => { counts[f.flag] += 1; }));
  return { groups, counts };
}
