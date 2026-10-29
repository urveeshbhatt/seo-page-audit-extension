// Phase 4 rules: turns collectPerformance() data into findings.
// Runs in the side panel. Pure functions, no DOM.
//
// What this tab can and cannot say:
//   - It measures THIS visit in YOUR browser (lab-like data): device, network
//     and cache change the numbers. Google ranks with field data (CrUX).
//   - It explains WHY a number is high: which element is the LCP, which
//     animation moves layout, which script owns the long frames.
//   - Unused CSS/JS (Coverage) cannot be measured from inside the page.
//
// Thresholds: web.dev/articles/vitals (LCP 2.5 s / 4 s, CLS 0.1 / 0.25,
// INP 200 ms / 500 ms, FCP 1.8 s / 3 s).

import { finding, plural, isPrelaunch, REVENUE_TYPES } from './phase1-rules.js';

const LIMITS = {
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  inp: [200, 500],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
};

const arr = (x) => (Array.isArray(x) ? x : []);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
const kb = (bytes) => Math.round(bytes / 1000).toLocaleString('en-US');
const fileOf = (url) => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || url); } catch { return String(url || '').split('/').pop() || ''; }
};
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const shortUrl = (url) => {
  try { const u = new URL(url); return `${u.hostname}${u.pathname}`.slice(0, 120); } catch { return String(url || '').slice(0, 120); }
};
const stripPseudo = (sel) => String(sel || '').replace(/::?(after|before|marker|placeholder|first-line|first-letter)$/i, '');
// "Show on page" targets (see highlight.js): CSS selectors made by the collector.
const cssT = (sels) => [...new Set(arr(sels).map(stripPseudo).filter((x) => x && x.length <= 300))].slice(0, 10).map((value) => ({ kind: 'css', value }));

/** 'good' | 'ni' (needs improvement) | 'poor' */
export function rating(metric, value) {
  const [good, poor] = LIMITS[metric];
  if (value <= good) return 'good';
  if (value <= poor) return 'ni';
  return 'poor';
}

// ---------------- pure helpers ----------------

/**
 * CLS = the largest "session window" of layout shifts: shifts less than 1 s
 * apart, window at most 5 s long. Shifts right after user input do not count.
 */
export function clsFromShifts(shifts) {
  const valid = arr(shifts).filter((s) => s && num(s.value) !== null && num(s.time) !== null && !s.input);
  let best = 0;
  let current = 0;
  let windowStart = -Infinity;
  let prev = -Infinity;
  valid.slice().sort((a, b) => a.time - b.time).forEach((s) => {
    if (s.time - prev > 1000 || s.time - windowStart > 5000) {
      current = 0;
      windowStart = s.time;
    }
    current += s.value;
    prev = s.time;
    if (current > best) best = current;
  });
  return { value: Math.round(best * 10000) / 10000, count: valid.length };
}

/**
 * INP = the slowest interaction (ignoring 1 outlier per 50 interactions).
 * Event entries of one tap share an interactionId; the longest entry counts.
 */
export function inpFromEvents(events) {
  const groups = new Map();
  arr(events).forEach((e) => {
    if (!e || !(num(e.id) > 0) || num(e.duration) === null) return;
    const start = num(e.start) ?? 0;
    const ps = num(e.processingStart) ?? start;
    const g = groups.get(e.id) || [];
    g.push({ ...e, start, ps, pe: Math.max(ps, num(e.processingEnd) ?? ps), end: start + e.duration });
    groups.set(e.id, g);
  });
  if (!groups.size) return null;
  // One tap = pointerdown + pointerup + click (+ key events). The entries that
  // end on the same paint (durations are rounded to 8 ms) form the slow frame;
  // its phases span all of them, so a slow click handler shows as processing.
  const taps = [...groups.values()].map((list) => {
    const lastEnd = Math.max(...list.map((x) => x.end));
    const frame = list.filter((x) => x.end >= lastEnd - 8);
    const duration = Math.max(...frame.map((x) => x.duration));
    const start = Math.min(...frame.map((x) => x.start));
    const ps = Math.min(...frame.map((x) => x.ps));
    const pe = Math.max(...frame.map((x) => x.pe));
    const main = frame.slice().sort((a, b) => (b.pe - b.ps) - (a.pe - a.ps))[0];
    return { duration, start, ps, pe, name: main.name, target: main.target };
  }).sort((a, b) => b.duration - a.duration);
  const pick = taps[Math.min(Math.floor(taps.length / 50), taps.length - 1)];
  return {
    value: Math.round(pick.duration),
    count: taps.length,
    worst: {
      name: String(pick.name || 'interaction'),
      duration: Math.round(pick.duration),
      inputDelay: Math.max(0, Math.round(pick.ps - pick.start)),
      processing: Math.max(0, Math.round(pick.pe - pick.ps)),
      presentation: Math.max(0, Math.round(pick.start + pick.duration - pick.pe)),
      target: typeof pick.target === 'string' ? pick.target : '',
    },
  };
}

/** LCP = TTFB + resource load delay + resource load duration + element render delay. */
export function lcpSubparts(nav, lcp) {
  const ttfb = Math.max(0, num(nav && nav.ttfb) ?? 0);
  const time = Math.max(0, num(lcp && lcp.time) ?? 0);
  const res = lcp && lcp.resource;
  if (!res) {
    return { ttfb: Math.round(Math.min(ttfb, time) || ttfb), loadDelay: 0, loadDuration: 0, renderDelay: Math.round(Math.max(0, time - ttfb)) };
  }
  const reqStart = num(res.requestStart) > 0 ? res.requestStart : (num(res.startTime) ?? ttfb);
  const end = Math.max(reqStart, num(res.responseEnd) ?? reqStart);
  return {
    ttfb: Math.round(ttfb),
    loadDelay: Math.round(Math.max(0, reqStart - ttfb)),
    loadDuration: Math.round(Math.max(0, end - reqStart)),
    renderDelay: Math.round(Math.max(0, time - Math.max(end, ttfb))),
  };
}

const META_KEYS = new Set(['offset', 'easing', 'composite', 'computedOffset']);
const COMPOSITED = new Set(['transform', 'opacity', 'translate', 'scale', 'rotate']);
// Discrete properties switch in one step (no per-frame work): never a problem.
const DISCRETE = new Set(['zIndex', 'visibility', 'pointerEvents', 'cursor', 'contentVisibility']);
const LAYOUT = /^(left|top|right|bottom|inset.*|width|height|(min|max)(Width|Height)|margin.*|padding.*|border(Top|Right|Bottom|Left)?Width|borderWidth|fontSize|fontWeight|lineHeight|letterSpacing|wordSpacing|flex.*|gap|rowGap|columnGap|grid.*|display|position)$/;

/** 'layout' (worst) | 'paint' | 'composited' */
export function classifyProps(props) {
  const list = arr(props).map(String).filter((p) => !META_KEYS.has(p) && !DISCRETE.has(p));
  if (list.some((p) => LAYOUT.test(p))) return 'layout';
  if (list.some((p) => !COMPOSITED.has(p))) return 'paint';
  return 'composited';
}

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'gen', 'firm', 'ind', 'nic', 'res', 'ltd', 'plc']);

/** Registrable site of a host (approximation without the public suffix list). */
export function siteOf(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || !h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length >= 3 && SECOND_LEVEL.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

const VENDORS = [
  [/(^|\.)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com)$/, 'Google Tag Manager / gtag'],
  [/(^|\.)(doubleclick\.net|googleadservices\.com|googlesyndication\.com)$/, 'Google Ads'],
  [/(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/, 'Google Fonts'],
  [/(^|\.)(youtube\.com|ytimg\.com|youtube-nocookie\.com)$/, 'YouTube'],
  [/(^|\.)(facebook\.net|facebook\.com)$/, 'Meta Pixel'],
  [/(^|\.)clarity\.ms$/, 'Microsoft Clarity'],
  [/(^|\.)(bing\.com|bat\.bing\.com)$/, 'Microsoft Ads'],
  [/(^|\.)hotjar\.(com|io)$/, 'Hotjar'],
  [/(^|\.)(ads-twitter\.com|twitter\.com|t\.co|x\.com)$/, 'X (Twitter) Ads'],
  [/(^|\.)licdn\.com$/, 'LinkedIn Insight'],
  [/(^|\.)quora\.com$/, 'Quora Pixel'],
  [/(^|\.)(tiktok\.com|tiktokcdn\.com)$/, 'TikTok Pixel'],
  [/(^|\.)(pinterest\.com|pinimg\.com)$/, 'Pinterest Tag'],
  [/(^|\.)(snapchat\.com|sc-static\.net)$/, 'Snap Pixel'],
  [/(^|\.)moengage\.com$/, 'MoEngage'],
  [/cookieyes\.com$/, 'CookieYes'],
  [/(^|\.)(klaviyo\.com)$/, 'Klaviyo'],
  [/(^|\.)rebuyengine\.com$/, 'Rebuy'],
  [/(^|\.)(hubspot\.com|hs-scripts\.com|hs-analytics\.net|hsforms\.net)$/, 'HubSpot'],
  [/(^|\.)(intercom\.io|intercomcdn\.com)$/, 'Intercom'],
  [/(^|\.)(tawk\.to)$/, 'Tawk.to chat'],
  [/(^|\.)(cdnjs\.cloudflare\.com|jsdelivr\.net|unpkg\.com|code\.jquery\.com)$/, 'Public CDN library'],
];
// Platform files: part of how the site is built, not an optional third party.
const PLATFORM = /(^|\.)(cdn\.shopify\.com|shopifycloud\.com|shopify\.com|myshopify\.com|wp\.com|squarespace-cdn\.com|wixstatic\.com|webflow\.com)$/;

export function vendorOf(host) {
  const h = String(host || '').toLowerCase();
  const hit = VENDORS.find(([re]) => re.test(h));
  return hit ? hit[1] : h;
}

/** Repeated tracking IDs and scripts loaded twice, from a list of script URLs. */
export function findDuplicateTags(urls) {
  const list = arr(urls).filter((u) => typeof u === 'string' && u);
  const idsOf = (re) => list.map((u) => (u.match(re) || [])[1]).filter(Boolean);
  const uniqSorted = (xs) => [...new Set(xs)].sort();
  const repeated = (xs) => uniqSorted(xs.filter((x, i) => xs.indexOf(x) !== i));
  const ga4All = idsOf(/[?&]id=(G-[A-Z0-9]+)/i);
  const counts = new Map();
  list.forEach((u) => counts.set(u, (counts.get(u) || 0) + 1));
  return {
    ga4: uniqSorted(ga4All),
    ga4Repeated: repeated(ga4All),
    gtm: uniqSorted(idsOf(/[?&]id=(GTM-[A-Z0-9]+)/i)),
    clarity: uniqSorted(idsOf(/clarity\.ms\/tag\/([a-z0-9]+)/i)),
    metaPixel: uniqSorted(idsOf(/signals\/config\/(\d+)/)),
    sameScript: [...counts.entries()].filter(([, n]) => n > 1).map(([u]) => u).sort(),
  };
}

// ---------------- findings ----------------

function severity(r, revenueLive) {
  if (r === 'good') return 'good';
  if (r === 'poor' && revenueLive) return 'critical';
  return 'warning';
}

function vitalsFindings(d, ctx, revenueLive, cls, inp) {
  const out = [];
  const nav = d.nav || {};
  const lcp = d.lcp && num(d.lcp.time) !== null ? d.lcp : null;

  if (!lcp) {
    out.push(finding('perf-lcp', 'Largest Contentful Paint (LCP)', 'Not recorded', 'info',
      `No LCP entry for this visit${d.visibility === 'hidden' ? ' (the tab was hidden)' : ''}. Chrome only records LCP while the tab is in front and before the first tap; it is also missing after back/forward cache. Reload the page with the tab in front, wait, then audit again.`));
  } else {
    const r = rating('lcp', lcp.time);
    const what = lcp.selector || lcp.tag || 'element';
    out.push(finding('perf-lcp', 'Largest Contentful Paint (LCP)', `${sec(lcp.time)} · ${what}`, severity(r, revenueLive),
      r === 'good'
        ? 'The main content painted fast on this visit.'
        : `The largest element painted after ${sec(lcp.time)} on your device and network (good: under 2.5 s). Real phones on mobile data are usually slower. "LCP parts" below says where the time went.`));
  }

  const cr = rating('cls', cls.value);
  out.push(finding('perf-cls', 'Cumulative Layout Shift (CLS)', `${cls.value} · ${plural(cls.count, 'shift')}`, severity(cr, revenueLive),
    cr === 'good'
      ? (cls.count ? 'Small shifts only. Layout is stable.' : 'Nothing moved while the page loaded.')
      : 'Content moved after it was shown (good: 0.1 or less). Shoppers tap the wrong thing. See "What moved" and "Animations" below.'));

  if (!inp) {
    out.push(finding('perf-inp', 'Interaction to Next Paint (INP)', 'No interaction yet', 'info',
      'INP needs a real tap. Click a few things on the page (menu, size, "Read more", add to cart), come back and press Audit again: the slowest tap is shown here with its three parts.'));
  } else {
    const r = rating('inp', inp.value);
    const w = inp.worst;
    const parts = [['inputDelay', w.inputDelay], ['processing', w.processing], ['presentation', w.presentation]].sort((a, b) => b[1] - a[1]);
    const ADVICE = {
      inputDelay: `Most of it was input delay (${fmt(w.inputDelay)} ms): the page was busy with other scripts when you tapped. See "Main thread" below.`,
      processing: `Most of it was processing (${fmt(w.processing)} ms): the click handlers themselves are slow. DevTools → Performance → record the tap → Bottom-up shows which script.`,
      presentation: `Most of it was presentation delay (${fmt(w.presentation)} ms): after the handlers, the screen took long to update. Usually heavy layout/paint: layout animations, a large DOM, or a big re-render.`,
    };
    out.push(finding('perf-inp', 'Interaction to Next Paint (INP)', `${fmt(inp.value)} ms · ${w.name}${w.target ? ` on ${w.target}` : ''} · ${plural(inp.count, 'interaction')}`, severity(r, revenueLive),
      r === 'good' ? 'Taps got a visual response quickly.' : `Slow response to a tap (good: 200 ms or less). ${ADVICE[parts[0][0]]}`));
  }

  if (num(nav.fcp) !== null) {
    const r = rating('fcp', nav.fcp);
    out.push(finding('perf-fcp', 'First Contentful Paint (FCP)', sec(nav.fcp), r === 'good' ? 'good' : 'warning',
      r === 'good' ? 'Something appeared on screen quickly.' : 'The screen stayed blank for a while. Usually render-blocking CSS/JS or a slow server (TTFB). See "Render-blocking" below.'));
  }

  out.push(finding('perf-field', 'Real-user data', 'Lab numbers from this browser', 'info',
    'Google ranks with field data from real Chrome users (CrUX, last 28 days), not with this visit. Before quoting a number to a client, check the top box in PageSpeed Insights (pagespeed.web.dev) for this URL. Numbers here change with your device, network and cache.'));
  return out;
}

function lcpFindings(d, ctx) {
  const lcp = d.lcp && num(d.lcp.time) !== null ? d.lcp : null;
  if (!lcp) return [];
  const out = [];
  const parts = lcpSubparts(d.nav || {}, lcp);
  const targets = cssT([lcp.selector]);
  const names = { ttfb: 'TTFB', loadDelay: 'load delay', loadDuration: 'load time', renderDelay: 'render delay' };
  const biggest = Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0];
  const ADVICE = {
    ttfb: 'Most of the time is the server sending the HTML (TTFB). See the Network tab: cache hit, TTFB cold vs warm.',
    loadDelay: 'Most of the time the browser had not started fetching the LCP image yet. Put it in the HTML as a normal <img src> (not data-src), add fetchpriority="high", or a <link rel="preload" as="image">.',
    loadDuration: 'Most of the time is the LCP file downloading. Compress it, serve WebP/AVIF, and the right size for mobile (srcset/sizes).',
    renderDelay: 'The element was ready but painted late: render-blocking CSS/JS, web fonts, or JavaScript that builds, hides or animates it in. See "Render-blocking" below.',
  };
  const value = Object.entries(parts).map(([k, v]) => `${names[k]} ${fmt(v)} ms`).join(' · ');
  out.push(finding('perf-lcp-parts', 'LCP parts', `${value} (${lcp.tag || 'element'}${lcp.url ? `: ${fileOf(lcp.url)}` : ''})`, 'info',
    rating('lcp', lcp.time) === 'good' ? `For reference. Biggest part: ${names[biggest]}.` : ADVICE[biggest]));
  if (targets.length) out[out.length - 1].targets = targets;

  // A preloader / spinner covering the page becomes the LCP and hides the real content.
  const LOADER = /(^|[#.\s>_-])((pre)?load(ing|er)|spinner|skeleton|splash)([-_.\s]|$)/i;
  if (LOADER.test(lcp.selector || '') || (!lcp.url && lcp.text && lcp.text.length <= 3 && num(lcp.size) > 100000)) {
    const f = finding('perf-lcp-loader', 'LCP is a loading screen', `${lcp.selector || lcp.tag} · ${sec(lcp.time)}${lcp.text ? ` · "${lcp.text}"` : ''}`, 'warning',
      'The largest thing painted is a loading screen or spinner over the page, not the product or title. Shoppers stare at it, and the LCP number describes the overlay instead of the content. Remove the preloader (usually a theme or speed-app setting) so the real content paints first, then re-check LCP.');
    if (targets.length) f.targets = targets;
    out.push(f);
  }

  const img = lcp.img;
  if (img && typeof img === 'object') {
    if (String(img.loading || '').toLowerCase() === 'lazy') {
      const prelaunchRevenue = isPrelaunch(ctx) && REVENUE_TYPES.has(ctx.pageType);
      const live = REVENUE_TYPES.has(ctx.pageType) && !isPrelaunch(ctx);
      const f = finding('perf-lcp-lazy', 'LCP image is lazy-loaded', lcp.selector || fileOf(lcp.url), live ? 'critical' : 'warning',
        'The LCP image has loading="lazy", so the browser waits for layout before it even requests it. Remove loading="lazy" from this one image (in WordPress: exclude the featured/first image from lazy-load in the cache plugin).',
        prelaunchRevenue ? 'Launch blocker' : null);
      if (targets.length) f.targets = targets;
      out.push(f);
    }
    if (img.dataSrc || (parts.loadDelay > 500 && !img.preloaded)) {
      const f = finding('perf-lcp-discovery', 'LCP image found late', `load delay ${fmt(parts.loadDelay)} ms${img.dataSrc ? ' · uses data-src' : ''}`, 'warning',
        `The browser started downloading the LCP image ${fmt(parts.loadDelay)} ms after the HTML arrived.${img.dataSrc ? ' It uses data-src (JavaScript lazy-load), which hides it from the HTML parser.' : ''} Use a normal src in the HTML, or add <link rel="preload" as="image" fetchpriority="high"> in <head>.`);
      if (targets.length) f.targets = targets;
      out.push(f);
    }
    if (String(img.fetchpriority || '').toLowerCase() === 'high') {
      out.push(finding('perf-lcp-priority', 'LCP image priority', 'fetchpriority="high"', 'good', 'The main image is requested before other images.'));
    } else {
      const f = finding('perf-lcp-priority', 'LCP image priority', img.fetchpriority ? `fetchpriority="${img.fetchpriority}"` : 'not set', 'info',
        'Add fetchpriority="high" to the LCP image so the browser fetches it before other images (WordPress 6.3+ does this for the first content image).');
      if (targets.length) f.targets = targets;
      out.push(f);
    }
  }
  return out;
}

function shiftFindings(d, ctx, revenueLive, cls) {
  const out = [];
  const shifts = arr(d.shifts).filter((s) => s && num(s.value) !== null && !s.input);
  if (shifts.length) {
    const bySel = new Map();
    shifts.forEach((s) => arr(s.sources).filter((x) => typeof x === 'string' && x).forEach((sel) => {
      const e = bySel.get(sel) || { n: 0, v: 0 };
      e.n += 1;
      e.v += s.value;
      bySel.set(sel, e);
    }));
    const top = [...bySel.entries()].sort((a, b) => b[1].v - a[1].v);
    if (top.length) {
      const f = finding('perf-cls-sources', 'What moved', top.slice(0, 3).map(([s]) => s).join(', '), 'info',
        'Elements the browser reported as shifted, biggest first. Moving elements are often pushed by something above them (late image, banner, font swap); check what loads just above.',
        null, top.slice(0, 15).map(([s, e]) => `${s} · ${plural(e.n, 'shift')} · ${Math.round(e.v * 1000) / 1000}`));
      f.targets = cssT(top.slice(0, 5).map(([s]) => s));
      out.push(f);
    }
  }

  if (arr(d.shifts).length >= 150) {
    out.push(finding('perf-cls-limit', 'Layout shift list is full', `${arr(d.shifts).length} shifts recorded (Chrome limit)`, 'info',
      'Chrome keeps only the first 150 layout shifts for scripts that read them later, so a page that keeps moving (a looping layout animation, a ticker) can have a higher real CLS than shown here. Confirm in DevTools → Performance → Live metrics while the page sits idle, and in PageSpeed Insights field data.'));
  }

  const anims = arr(d.animations).filter((a) => a && arr(a.props).length);
  const layout = anims.filter((a) => classifyProps(a.props) === 'layout');
  const paint = anims.filter((a) => classifyProps(a.props) === 'paint');
  const line = (a) => `${a.name || '(unnamed)'} ${a.target ? `on ${a.target}` : '(CSS @keyframes)'}: ${arr(a.props).filter((p) => !META_KEYS.has(p)).join(', ')}${a.infinite ? ' · runs forever' : ''}`;
  const fromCss = d.animationScan === 'keyframes'
    ? ' This page has too many elements to list running animations quickly, so these names come from the CSS @keyframes rules: search the name in DevTools → Elements → Styles to see where it is used.'
    : '';
  if (layout.length) {
    const forever = layout.some((a) => a.infinite);
    const f = finding('perf-anim-layout', 'Animations that move layout', `${plural(layout.length, 'animation')}${forever ? ' running forever' : ''}`,
      forever && revenueLive ? 'critical' : 'warning',
      `These CSS animations change left/top/width/height/margin, so the browser recalculates layout on every frame: a layout shift every frame (CLS) and a main thread that is never free (slow taps, INP). Animate transform (translateX/translateY/scale) and opacity instead; the animation looks the same.${fromCss}`,
      null, layout.map(line));
    f.targets = cssT(layout.map((a) => a.target));
    out.push(f);
  }
  if (paint.length) {
    const f = finding('perf-anim-paint', 'Animations that repaint', `${plural(paint.length, 'animation')} repaint every frame`, 'info',
      'box-shadow, background-position and colour animations repaint on the main thread each frame (DevTools calls them "non-composited"). Small cost each; many running forever add up. Where possible animate opacity of a pseudo-element instead.',
      null, paint.map(line));
    f.targets = cssT(paint.map((a) => a.target));
    out.push(f);
  }
  return out;
}

function blockingFindings(d) {
  const pageSite = siteOf(d.host || hostOf(d.url));
  const list = arr(d.renderBlocking).filter((r) => r && typeof r.url === 'string' && r.url);
  if (!list.length) {
    return [finding('perf-render-blocking', 'Render-blocking files', 'None', 'good', 'No file blocked the first paint on this visit.')];
  }
  const rows = list.map((r) => {
    const host = r.host || hostOf(r.url);
    const third = siteOf(host) !== pageSite && !PLATFORM.test(host);
    return { ...r, host, third, duration: Math.max(0, num(r.duration) ?? 0) };
  }).sort((a, b) => b.duration - a.duration);
  const total = rows.reduce((s, r) => s + r.duration, 0);
  const heavy = rows.some((r) => r.third && r.duration > 100) || total > 500;
  // Chrome reports files sent with 103 Early Hints as "early-hints": use the file type instead.
  const kind = (r) => {
    let path = '';
    try { path = new URL(r.url).pathname; } catch { /* keep empty */ }
    if (/\.css$/i.test(path)) return 'CSS';
    if (/\.m?js$/i.test(path)) return 'JS';
    return /link|css/i.test(r.type || '') ? 'CSS' : 'JS';
  };
  return [finding('perf-render-blocking', 'Render-blocking files', `${plural(rows.length, 'file')} · ${fmt(total)} ms total`, heavy ? 'warning' : 'info',
    'The browser downloads these before it paints anything. CSS: inline the critical CSS and load the rest async. Scripts: add defer (own scripts) or async (separate third-party SDKs and analytics), after checking nothing inline depends on them. Times are from your visit; PageSpeed Insights → "Render-blocking requests" shows the slow-network cost.',
    null, rows.map((r) => `${fmt(r.duration)} ms · ${r.third ? vendorOf(r.host) : 'first-party'} · ${kind(r)} · ${shortUrl(r.url)}`))];
}

const EXTENSION_URL = /^(chrome|moz|safari-web)-extension:\/\//i;

function mainThreadFindings(d) {
  // Browser extensions (this audit tool too) run on the page's main thread.
  // Their frames are not the site's fault: drop frames that only ran extension code.
  const frames = arr(d.frames).filter((f) => {
    if (!f || num(f.duration) === null || f.duration < 50) return false;
    const scripts = arr(f.scripts).filter((s) => s && typeof s.url === 'string');
    return !(scripts.length && scripts.every((s) => EXTENSION_URL.test(s.url)));
  }).map((f) => ({ ...f, scripts: arr(f.scripts).filter((s) => !(s && EXTENSION_URL.test(String(s.url || '')))) }));
  if (!frames.length) {
    return [finding('perf-main', 'Long frames (main thread)', 'None recorded', d.loafSupported === false ? 'info' : 'good',
      d.loafSupported === false ? 'This Chrome version does not report long animation frames.' : 'No frame took over 50 ms on this visit.')];
  }
  const pageSite = siteOf(d.host || hostOf(d.url));
  const owners = new Map();
  const add = (name, duration, forced, invoker) => {
    const e = owners.get(name) || { ms: 0, forced: 0, invokers: new Map() };
    e.ms += duration;
    e.forced += forced;
    if (invoker) e.invokers.set(invoker, (e.invokers.get(invoker) || 0) + duration);
    owners.set(name, e);
  };
  frames.forEach((f) => {
    const scripts = arr(f.scripts).filter((s) => s && num(s.duration) !== null);
    if (!scripts.length) { add('No script (browser style, layout, paint)', f.duration, 0, ''); return; }
    scripts.forEach((s) => {
      const host = hostOf(s.url);
      const name = !host ? 'Inline or unknown script' : siteOf(host) === pageSite || PLATFORM.test(host) ? `This site (${host})` : vendorOf(host);
      add(name, s.duration, Math.max(0, num(s.forcedLayout) ?? 0), String(s.invoker || '').slice(0, 60));
    });
  });
  const blocking = frames.reduce((s, f) => s + Math.max(0, num(f.blocking) ?? f.duration - 50), 0);
  const worst = Math.max(...frames.map((f) => f.duration));
  const items = [...owners.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15).map(([name, e]) => {
    const inv = [...e.invokers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k).join(', ');
    return `${name} · ${fmt(e.ms)} ms${e.forced ? ` · forced layout ${fmt(e.forced)} ms` : ''}${inv ? ` · ${inv}` : ''}`;
  });
  return [finding('perf-main', 'Long frames (main thread)', `${plural(frames.length, 'long frame')} · ${fmt(blocking)} ms blocking · worst ${fmt(worst)} ms`,
    blocking > 300 || worst > 200 ? 'warning' : 'info',
    'Frames over 50 ms delay taps (INP). Owners are listed by time. Third-party tags: remove duplicates, or load them later / on interaction. "Forced layout" means a script read sizes right after the page changed. "No script" time is the browser itself: often layout animations or a very large DOM.',
    null, items)];
}

function thirdPartyFindings(d) {
  const out = [];
  const pageSite = siteOf(d.host || hostOf(d.url));
  const vendors = new Map();
  arr(d.resources).forEach((r) => {
    if (!r || typeof r.host !== 'string' || !r.host) return;
    if (siteOf(r.host) === pageSite || PLATFORM.test(r.host)) return;
    const name = vendorOf(r.host);
    const e = vendors.get(name) || { requests: 0, bytes: 0, hidden: 0 };
    e.requests += 1;
    const b = num(r.bytes) ?? 0;
    if (b > 0) e.bytes += b; else e.hidden += 1;
    vendors.set(name, e);
  });
  if (!vendors.size) {
    out.push(finding('perf-3p', 'Third-party files', 'None', 'good', 'Everything loads from this site.'));
  } else {
    const total = [...vendors.values()].reduce((s, e) => s + e.bytes, 0);
    const items = [...vendors.entries()].sort((a, b) => b[1].bytes - a[1].bytes || b[1].requests - a[1].requests).map(([name, e]) => {
      const size = e.bytes ? `${kb(e.bytes)} KB${e.hidden ? ` (+${e.hidden} hidden)` : ''}` : 'size hidden';
      return `${name} · ${plural(e.requests, 'request')} · ${size}`;
    });
    out.push(finding('perf-3p', 'Third-party files', `${vendors.size} third part${vendors.size === 1 ? 'y' : 'ies'} · ${kb(total)} KB seen`,
      total > 1500000 || vendors.size > 15 ? 'warning' : 'info',
      'Files from other companies, heaviest first. "Size hidden" = the vendor does not share sizes with the page (no Timing-Allow-Origin); check DevTools → Network. Ask the client which tools they still use; remove the rest, delay the others.',
      null, items));
  }

  const dup = findDuplicateTags(d.scripts);
  const parts = [];
  const items = [];
  if (dup.ga4.length > 1 || dup.ga4Repeated.length) { parts.push(`${dup.ga4.length} GA4 ID${dup.ga4.length === 1 ? '' : 's'}${dup.ga4Repeated.length ? ' (loaded twice)' : ''}`); items.push(`GA4: ${dup.ga4.join(', ')}`); }
  if (dup.gtm.length > 1) { parts.push(`${dup.gtm.length} GTM containers`); items.push(`GTM: ${dup.gtm.join(', ')}`); }
  if (dup.clarity.length > 1) { parts.push(`${dup.clarity.length} Clarity projects`); items.push(`Clarity: ${dup.clarity.join(', ')}`); }
  if (dup.metaPixel.length > 1) { parts.push(`${dup.metaPixel.length} Meta pixels`); items.push(`Meta Pixel: ${dup.metaPixel.join(', ')}`); }
  if (dup.sameScript.length) { parts.push(`${plural(dup.sameScript.length, 'script')} loaded twice`); dup.sameScript.forEach((u) => items.push(`Loaded twice: ${u}`)); }
  if (parts.length) {
    out.push(finding('perf-dup-tags', 'Duplicate tags', parts.join(' · '), 'warning',
      'The same kind of tag runs more than once: double the main-thread work, and often double-counted data. Sometimes two IDs are on purpose (two GA4 properties, agency + client); confirm with the client, then keep one, ideally inside one GTM container.',
      null, items));
  }
  return out;
}

function imageFindings(d) {
  const out = [];
  const imgs = arr(d.images).filter((i) => i && typeof i.src === 'string');
  const svg = (i) => /\.svg(\?|#|$)/i.test(i.src) || /^data:image\/svg/i.test(i.src);
  const lazyTop = imgs.filter((i) => i.inViewport && i.lazy);
  if (lazyTop.length) {
    const f = finding('perf-img-lazy', 'Lazy images in the first screen', `${plural(lazyTop.length, 'image')} above the fold lazy-loaded`, 'warning',
      'Images visible without scrolling should load right away. loading="lazy" on them delays the first screen. Keep lazy-load for images further down.',
      null, lazyTop.map((i) => `${fileOf(i.src)} · ${i.selector || ''}`));
    f.targets = cssT(lazyTop.map((i) => i.selector));
    out.push(f);
  }
  const unsized = imgs.filter((i) => !i.hasSize && !svg(i));
  if (unsized.length) {
    const f = finding('perf-img-size', 'Images without size', `${plural(unsized.length, 'image')} without width/height`, 'warning',
      'No width and height attributes (and no CSS aspect-ratio), so the browser cannot reserve space and the layout jumps when the image arrives (CLS). Add width/height to the <img> (WordPress does this for media-library images) or aspect-ratio in CSS. Placeholder and theme images are the usual gaps.',
      null, unsized.map((i) => `${fileOf(i.src)} · ${i.selector || ''}`));
    f.targets = cssT(unsized.map((i) => i.selector));
    out.push(f);
  }
  const big = imgs.filter((i) => !svg(i) && num(i.natural) > 0 && num(i.shown) > 0 && i.natural > i.shown * (num(i.dpr) || 1) * 1.5);
  if (big.length) {
    const f = finding('perf-img-big', 'Images larger than shown', plural(big.length, 'image'), 'info',
      'The file is much wider than its display size on this screen, so visitors download pixels they never see. Use srcset/sizes (WordPress adds them for media-library images) or upload a smaller version. Check on mobile width too.',
      null, big.map((i) => `${fileOf(i.src)} · ${Math.round(i.natural)} px file shown at ${Math.round(i.shown)} px${num(i.bytes) > 0 ? ` · ${kb(i.bytes)} KB` : ''}`));
    f.targets = cssT(big.map((i) => i.selector));
    out.push(f);
  }
  return out;
}

function fontFindings(d) {
  const out = [];
  const fonts = d.fonts || {};
  const files = arr(fonts.files).filter((f) => f && typeof f.url === 'string');
  if (files.length) {
    const bytes = files.reduce((s, f) => s + (num(f.bytes) ?? 0), 0);
    const hosts = [...new Set(files.map((f) => f.host || hostOf(f.url)))];
    out.push(finding('perf-fonts', 'Web font files', `${plural(files.length, 'font file')} · ${kb(bytes)} KB${num(fonts.preloaded) ? ` · ${fonts.preloaded} preloaded` : ''}`,
      files.length >= 5 ? 'warning' : 'info',
      'Every weight and style is a separate download that can delay text and shift layout when it swaps in. Keep 2–3 files (regular, bold), self-host them, and preload only the one used in the first screen.',
      null, [...hosts.map((h) => `host: ${h}`), ...files.slice(0, 20).map((f) => fileOf(f.url))]));
  }
  const bad = arr(fonts.faces).filter((f) => f && f.family && (!f.display || /^(auto|block)$/i.test(f.display)));
  if (bad.length) {
    const names = [...new Set(bad.map((f) => `${f.family} (${f.display || 'not set'})`))];
    out.push(finding('perf-font-display', 'font-display', names.slice(0, 5).join(', '), 'warning',
      'With font-display auto/block the text stays invisible until the font file arrives. Add font-display: swap (or optional) to these @font-face rules. Only same-site stylesheets can be read, so third-party font CSS is not checked here.',
      null, names));
  }
  return out;
}

function confirmFindings() {
  return [finding('perf-coverage', 'Unused CSS and JavaScript', 'Check in DevTools', 'info',
    'Unused code cannot be measured from inside the page. DevTools → Ctrl+Shift+P → "Show Coverage" → reload, sort by Unused bytes. Or PageSpeed Insights → "Reduce unused JavaScript / CSS". Never delete a file on Coverage alone: block it (Network → right-click → Block request URL) and test the page first.',
    'Check by hand')];
}

// ---------------- public ----------------

export function evaluatePerformance(data, ctx = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const c = ctx || {};
  const revenueLive = REVENUE_TYPES.has(c.pageType) && !isPrelaunch(c);
  const cls = clsFromShifts(d.shifts);
  const inp = inpFromEvents(d.events);
  const groups = [
    { id: 'vitals', title: 'Core Web Vitals (this visit)', findings: vitalsFindings(d, c, revenueLive, cls, inp) },
    { id: 'lcp', title: 'LCP element', findings: lcpFindings(d, c) },
    { id: 'shifts', title: 'Layout shifts and animations', findings: shiftFindings(d, c, revenueLive, cls) },
    { id: 'blocking', title: 'Render-blocking', findings: blockingFindings(d) },
    { id: 'main', title: 'Main thread', findings: mainThreadFindings(d) },
    { id: 'thirdparty', title: 'Third parties', findings: thirdPartyFindings(d) },
    { id: 'images', title: 'Images', findings: imageFindings(d) },
    { id: 'fonts', title: 'Fonts', findings: fontFindings(d) },
    { id: 'confirm', title: 'Check by hand', findings: confirmFindings() },
  ].filter((g) => g.findings.length);
  const counts = { critical: 0, warning: 0, good: 0, info: 0 };
  groups.forEach((g) => g.findings.forEach((f) => { counts[f.flag] += 1; }));
  return { groups, counts };
}
