// Phase 1 module: Elements panel checks (collectors).
//
// IMPORTANT: every collector function here is injected into the audited page
// with chrome.scripting.executeScript({ func }). That means:
//   - it must be fully self-contained (no imports, no outside variables)
//   - it must only READ the page, never change it
//   - it must return plain data (strings, numbers, arrays, objects)
// The side panel renders that data with textContent only, never innerHTML,
// so nothing from the audited page can run inside the extension.
//
// Judgement (flags and reasons) lives in phase1-rules.js, not here.

export const MODULE_INFO = {
  id: 'phase1-elements',
  name: 'Phase 1: Elements',
  version: '0.3.0',
};

/**
 * M1 collector: basic page identity.
 * Runs inside the audited page.
 */
export function collectBasics() {
  const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  return {
    url: clip(location.href, 2048),
    title: clip(document.title, 500),
    titleLength: document.title.length,
    lang: clip(document.documentElement.getAttribute('lang') || '', 35),
    collectedAt: new Date().toISOString(),
  };
}

/**
 * M2 collector: everything Phase 1 Steps 1 and 3 look at in <head>.
 * Runs inside the audited page. Read-only.
 */
export function collectHead() {
  const clip = (value, max = 500) => (typeof value === 'string' ? value.slice(0, max) : '');
  const str = (v) => (v === undefined || v === null || v === false ? '' : String(v));
  const metaByName = (name) =>
    [...document.querySelectorAll('meta[name]')]
      .filter((m) => (m.getAttribute('name') || '').toLowerCase() === name)
      .map((m) => clip(m.getAttribute('content') || '', 1000));

  // ---- JSON-LD ----
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
  const types = new Set();
  const products = [];
  let parseErrors = 0;
  const typeList = (node) => {
    const t = node && node['@type'];
    return Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
  };
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    const t = typeList(node);
    t.forEach((x) => types.add(x));
    if (t.includes('Product') && products.length < 5) {
      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const brand = node.brand;
      products.push({
        name: clip(typeof node.name === 'string' ? node.name : '', 300),
        hasDescription: typeof node.description === 'string' && node.description.trim().length > 0,
        descriptionSample: clip(typeof node.description === 'string' ? node.description : '', 200),
        brand: clip(typeof brand === 'string' ? brand : brand && typeof brand.name === 'string' ? brand.name : '', 120),
        sku: clip(typeof node.sku === 'string' ? node.sku : '', 120),
        hasOffers: !!offers,
        price: clip(str(offers && (offers.price ?? offers.lowPrice)), 40),
        highPrice: clip(str(offers && offers.highPrice), 40),
        currency: clip(str(offers && offers.priceCurrency), 10),
        availability: clip(str(offers && offers.availability), 80),
        hasRating: !!node.aggregateRating,
        hasReviews: !!node.review,
      });
    }
    Object.keys(node).forEach((k) => {
      if (k !== '@context') walk(node[k], depth + 1);
    });
  };
  scripts.forEach((s) => {
    try { walk(JSON.parse(s.textContent || ''), 0); } catch (e) { parseErrors += 1; }
  });

  // ---- Open Graph / Twitter ----
  const og = [...document.querySelectorAll('meta[property^="og:"]')]
    .slice(0, 60)
    .map((m) => ({ property: clip(m.getAttribute('property') || '', 80), content: clip(m.getAttribute('content') || '', 500) }));
  const twitterCount = document.querySelectorAll('meta[name^="twitter:"]').length;

  // ---- Canonical / hreflang ----
  const canonicals = [...document.querySelectorAll('link[rel="canonical"]')]
    .slice(0, 10)
    .map((l) => clip(l.href || l.getAttribute('href') || '', 2048));
  const hreflang = [...document.querySelectorAll('link[rel="alternate"][hreflang]')]
    .slice(0, 100)
    .map((l) => ({ lang: clip(l.getAttribute('hreflang') || '', 20), href: clip(l.href || '', 2048) }));

  // SVG icons can contain their own <title>; only count document titles.
  const titles = [...document.querySelectorAll('title')].filter((t) => !t.closest('svg'));

  return {
    url: clip(location.href, 2048),
    origin: clip(location.origin, 300),
    path: clip(location.pathname, 1000),
    robots: metaByName('robots'),
    googlebot: metaByName('googlebot'),
    canonicals,
    viewport: metaByName('viewport'),
    title: clip(document.title, 500),
    titleCount: titles.length,
    descriptions: metaByName('description'),
    og,
    twitterCount,
    jsonld: {
      scriptCount: scripts.length,
      parseErrors,
      types: [...types].slice(0, 40),
      products,
    },
    lang: clip(document.documentElement.getAttribute('lang') || '', 35),
    hreflang,
    collectedAt: new Date().toISOString(),
  };
}

/**
 * M3 collector: body checks (Phase 1 Steps 2 and 4) + placeholders.
 * Runs inside the audited page. Read-only. Async because it fetches the
 * page's own raw HTML (same origin) to compare with the rendered DOM.
 */
export async function collectBody() {
  const clip = (value, max = 300) => (typeof value === 'string' ? value.slice(0, max) : '');
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  // Text of an element without <noscript>/<script>/<style>/<template> content
  // (lazy-load plugins put an <img> fallback inside <noscript>). Uses textContent
  // semantics, so text inside hidden menus still counts (Google reads it).
  const SKIP_TEXT = new Set(['NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE']);
  const textOf = (root) => {
    let out = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out += child.nodeValue + ' ';
        else if (child.nodeType === 1 && !SKIP_TEXT.has(child.tagName)) walk(child);
        if (out.length > 600) return;
      }
    };
    walk(root);
    return norm(out);
  };
  const viewportH = window.innerHeight;

  // ---------- Step 2: raw vs rendered ----------
  const raw = { ok: false, reason: '', bytes: 0, words: 0, tests: [], linkCount: 0, h1Count: 0 };
  const renderedText = norm(document.body ? document.body.innerText : '');
  const renderedWords = renderedText ? renderedText.split(' ').length : 0;
  const samples = [];
  const addSample = (kind, text) => {
    const t = norm(text);
    if (t.length >= 4 && samples.length < 8 && !samples.some((s) => s.text === t)) samples.push({ kind, text: clip(t, 160) });
  };
  [...document.querySelectorAll('h1')].filter(isVisible).slice(0, 2).forEach((h) => addSample('H1', h.textContent));
  const priceMatch = renderedText.match(/(₹|Rs\.?|INR|\$|€|£)\s?\d[\d,]*(\.\d+)?/);
  if (priceMatch) addSample('Price', priceMatch[0]);
  [...document.querySelectorAll('main p, article p, .entry-content p, p')]
    .filter((p) => isVisible(p) && norm(p.textContent).length > 80 && !p.closest('header, footer, nav, [class*="cookie"], [id*="cookie"], [class*="cky"]'))
    .slice(0, 3)
    .forEach((p) => addSample('Paragraph', norm(p.textContent).slice(0, 120)));
  [...document.querySelectorAll('h2')].filter(isVisible).slice(0, 2).forEach((h) => addSample('H2', h.textContent));

  try {
    const res = await fetch(location.href, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
    const html = await res.text();
    raw.bytes = html.length;
    if (!res.ok) {
      raw.reason = `HTTP ${res.status}`;
    } else if (html.length < 2000 && renderedWords > 200) {
      raw.reason = 'Very small response (possible bot protection). Check with Ctrl+U.';
    } else {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
      const rawText = norm(doc.body ? doc.body.textContent : '');
      raw.ok = true;
      raw.words = rawText ? rawText.split(' ').length : 0;
      raw.linkCount = doc.querySelectorAll('a[href]').length;
      raw.h1Count = doc.querySelectorAll('h1').length;
      const lower = rawText.toLowerCase();
      raw.tests = samples.map((s) => {
        const probe = s.text.toLowerCase().slice(0, 60);
        return { ...s, inRaw: lower.includes(probe) };
      });
    }
  } catch (e) {
    raw.reason = clip(`Could not fetch raw HTML: ${e && e.message ? e.message : e}`, 200);
  }

  // ---------- Step 4A: headings ----------
  const headingEls = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  const headings = headingEls.slice(0, 80).map((h) => ({
    level: Number(h.tagName[1]),
    text: clip(norm(h.textContent), 100),
    visible: isVisible(h),
  }));

  // ---------- Step 4B: images ----------
  const TRACKERS = /(bat\.bing\.com|facebook\.com\/tr|google-analytics\.com|googletagmanager\.com|doubleclick\.net|amazon-adsystem\.com|tvspix\.com|ads\.linkedin\.com|px\.ads|analytics\.twitter\.com|t\.co\/i|ct\.pinterest\.com|clarity\.ms|scorecardresearch\.com|quantserve\.com|pixel\.)/i;
  const images = [...document.querySelectorAll('img')].slice(0, 300).map((img) => {
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
    const rect = img.getBoundingClientRect();
    const shown = Math.round(rect.width);
    return {
      src: clip(src, 400),
      file: clip(src.split('?')[0].split('/').pop() || '', 120),
      hasAltAttr: img.hasAttribute('alt'),
      alt: clip(img.getAttribute('alt') || '', 200),
      tracker: TRACKERS.test(src) || (img.naturalWidth > 0 && img.naturalWidth <= 2 && img.naturalHeight <= 2),
      lazy: (img.getAttribute('loading') || '').toLowerCase() === 'lazy',
      fetchpriority: clip(img.getAttribute('fetchpriority') || '', 10),
      aboveFold: shown > 0 && rect.top < viewportH && rect.bottom > 0,
      visible: isVisible(img),
      shownWidth: shown,
      naturalWidth: img.naturalWidth || 0,
      hasWidthHeight: img.hasAttribute('width') && img.hasAttribute('height'),
      decorativeHint: /icon|logo|divider|separator|spacer|arrow|bg|background|pattern|close|revisit/i.test(src + ' ' + (img.className || '')),
    };
  });

  // ---------- Step 4C: links ----------
  const UI_CONTROL = /accordion|tab-title|toggle|menu-cart|cart__toggle|reset_variations|close|dismiss|hamburger|menu-toggle|dropdown|swiper|slick|carousel|pagination|lightbox|cky|cookie/i;
  const GENERIC = /^(click here|here|read more|more|learn more|details|link)$/i;
  const anchors = [...document.querySelectorAll('a')].slice(0, 1500);
  const links = anchors.map((a) => {
    const hrefAttr = a.getAttribute('href');
    const text = clip(textOf(a), 80);
    const label = clip(a.getAttribute('aria-label') || a.getAttribute('title') || '', 80);
    const imgAlt = clip((a.querySelector('img[alt]') || {}).alt || '', 80);
    let host = '';
    try { host = hrefAttr ? new URL(a.href).hostname : ''; } catch (e) { host = ''; }
    return {
      href: clip(hrefAttr === null ? '' : hrefAttr, 300),
      hasHref: hrefAttr !== null,
      text,
      label,
      imgAlt,
      hasSvg: !!a.querySelector('svg'),
      cls: clip(String(a.className || ''), 120),
      role: clip(a.getAttribute('role') || '', 20),
      expandable: a.hasAttribute('aria-expanded') || a.hasAttribute('aria-controls'),
      uiControl: UI_CONTROL.test(String(a.className || '') + ' ' + (a.id || '')) || a.getAttribute('role') === 'button' || a.hasAttribute('aria-expanded') || a.hasAttribute('aria-controls'),
      rel: clip(a.getAttribute('rel') || '', 60),
      internal: !!host && host.replace(/^www\./, '') === location.hostname.replace(/^www\./, ''),
      external: !!host && host.replace(/^www\./, '') !== location.hostname.replace(/^www\./, ''),
      generic: GENERIC.test(text),
      visible: isVisible(a),
    };
  });

  // ---------- Placeholders ----------
  const PLACEHOLDER = /\[_{2,}\]%?|\[[A-Za-z][A-Za-z0-9_ .]{3,}\]|[Ll]orem ipsum|\{\{\s*[\w.]+\s*\}\}|\+?\b\d{0,3}[ -]?X{6,}\b/g;
  const placeholders = [];
  const visibleText = document.body ? document.body.innerText : '';
  let m;
  while ((m = PLACEHOLDER.exec(visibleText)) && placeholders.length < 30) {
    const start = Math.max(0, m.index - 40);
    placeholders.push({ match: clip(m[0], 60), where: 'text', context: clip(norm(visibleText.slice(start, m.index + m[0].length + 30)), 140) });
  }
  anchors.forEach((a) => {
    const h = a.getAttribute('href') || '';
    if ((/\[[^\]]*\]|PLACEHOLDER|example\.com/i.test(h) || /X{6,}/.test(h)) && placeholders.length < 30) {
      placeholders.push({ match: clip(h, 120), where: 'link', context: clip(textOf(a) || a.getAttribute('aria-label') || '', 100) });
    }
  });
  document.querySelectorAll('img').forEach((img) => {
    const s = img.currentSrc || img.src || '';
    if (/(^|[-_ .])(test|placeholder|dummy|sample)([-_ .\d]|$)/i.test((s.split('/').pop() || '') + ' ' + (img.getAttribute('alt') || '')) && placeholders.length < 30) {
      placeholders.push({ match: clip(s.split('/').pop() || '', 120), where: 'image', context: clip(img.getAttribute('alt') || '', 100) });
    }
  });

  return {
    url: clip(location.href, 2048),
    viewportHeight: viewportH,
    renderedWords,
    raw,
    headings,
    headingTotal: headingEls.length,
    images,
    imageTotal: document.querySelectorAll('img').length,
    links,
    linkTotal: document.querySelectorAll('a').length,
    linkHrefTotal: document.querySelectorAll('a[href]').length,
    placeholders,
    collectedAt: new Date().toISOString(),
  };
}
