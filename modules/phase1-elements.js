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
  version: '1.2.0',
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
    contentType: clip(document.contentType || '', 80),
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
    // MINOR bucket (Step 3): note, never top of the report
    extras: {
      metaKeywords: clip(metaByName('keywords')[0] || '', 200),
      favicon: !!document.querySelector('link[rel~="icon" i], link[rel="shortcut icon" i], link[rel="apple-touch-icon" i]'),
      preconnect: [...new Set([...document.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]')].slice(0, 30).map((l) => {
        try { return clip(new URL(l.href).hostname, 80); } catch (e) { return ''; }
      }).filter(Boolean))].slice(0, 15),
    },
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
  const raw = { ok: false, reason: '', bytes: 0, words: 0, tests: [], linkCount: 0, h1Count: 0, xRobots: '', jsonldCount: 0, jsonldTypes: [] };
  const renderedText = norm(document.body ? document.body.innerText : '');
  // Prices are read from page content only. Header bars ("Free shipping over ₹999"),
  // the mini-cart (₹0.00), menus, footer and cookie banners are not the product price.
  const NOT_CONTENT = [
    'header', 'nav', 'footer', '[role="banner"]', '[role="navigation"]', '[role="contentinfo"]',
    '[data-elementor-type="header"]', '[data-elementor-type="footer"]',
    '[class*="announcement"]', '[class*="topbar"]', '[class*="top-bar"]', '[class*="promo-bar"]', '[class*="marquee"]',
    '[class*="mini-cart"]', '[class*="minicart"]', '[class*="cart-drawer"]', '[class*="side-cart"]', '[id*="cart"]', '.widget_shopping_cart',
    '[class*="cookie"]', '[id*="cookie"]', '[class*="cky-"]',
  ].join(',');
  const contentText = (() => {
    let t = renderedText;
    if (!document.body) return t;
    document.body.querySelectorAll(NOT_CONTENT).forEach((el) => {
      if (el.parentElement && el.parentElement.closest(NOT_CONTENT)) return; // outermost zones only
      const z = norm(el.innerText);
      if (z) t = t.replace(z, ' ');
    });
    return norm(t);
  })();
  const renderedWords = renderedText ? renderedText.split(' ').length : 0;
  const samples = [];
  const addSample = (kind, text) => {
    const t = norm(text);
    if (t.length >= 4 && samples.length < 8 && !samples.some((s) => s.text === t)) samples.push({ kind, text: clip(t, 160) });
  };
  // Text a reader sees: drop <script>/<style> inside the element (their source is textContent too).
  const ownText = (el) => { const c = el.cloneNode(true); c.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove()); return c.textContent; };
  [...document.querySelectorAll('h1')].filter(isVisible).slice(0, 2).forEach((h) => addSample('H1', ownText(h)));
  const priceMatch = contentText.match(/(₹|Rs\.?|INR|\$|€|£)\s?\d[\d,]*(\.\d+)?/);
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
    raw.xRobots = clip(res.headers.get('x-robots-tag') || '', 200); // same-origin: header is readable
    if (!res.ok) {
      raw.reason = `HTTP ${res.status}`;
    } else if (html.length < 2000 && renderedWords > 200) {
      raw.reason = 'Very small response (possible bot protection). Check with Ctrl+U.';
    } else {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // Schema present in the server HTML (before scripts are stripped)
      const rawLd = [...doc.querySelectorAll('script[type="application/ld+json"]')];
      raw.jsonldCount = rawLd.length;
      const rawTypes = new Set();
      const walkT = (n, depth) => {
        if (!n || typeof n !== 'object' || depth > 8) return;
        if (Array.isArray(n)) { n.forEach((x) => walkT(x, depth + 1)); return; }
        [].concat(n['@type'] || []).forEach((t) => rawTypes.add(String(t)));
        Object.values(n).forEach((v) => { if (v && typeof v === 'object') walkT(v, depth + 1); });
      };
      rawLd.forEach((sc) => { try { walkT(JSON.parse(sc.textContent), 0); } catch (e) { /* parse errors reported by head checks */ } });
      raw.jsonldTypes = [...rawTypes].slice(0, 40).map((t) => clip(t, 60));
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
    text: clip(norm(ownText(h)), 100),
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

  // ---------- Visible prices and review signals (schema vs page) ----------
  const visiblePrices = [...new Set((contentText.match(/(₹|Rs\.?|INR|\$|€|£)\s?\d[\d,]*(\.\d+)?/g) || [])
    .map((m) => m.replace(/^[^\d]+/, '').replace(/,/g, '')).map((n) => String(Number(n))))].slice(0, 30);
  const reviewCountMatch = renderedText.match(/reviews?\s*\((\d+)\)|(\d+)\s+(customer\s+)?reviews?\b|(\d+)\s+ratings?\b/i);
  const reviewSignals = {
    ratingText: /\b[1-5](\.\d)?\s?(\/|out of)\s?5\b|★|⭐/.test(renderedText),
    reviewCount: reviewCountMatch ? Number(reviewCountMatch[1] || reviewCountMatch[2] || reviewCountMatch[4]) : null,
  };
  const renderedJsonld = document.querySelectorAll('script[type="application/ld+json"]').length;

  return {
    url: clip(location.href, 2048),
    viewportHeight: viewportH,
    renderedWords,
    visiblePrices,
    reviewSignals,
    renderedJsonld,
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

/**
 * M4 collector: page health (Phase 1 Step 5).
 * DOM size, hidden content, CSS-generated text, shadow DOM, iframes,
 * render-blocking resources and tech stack. Runs inside the audited page.
 * Read-only. Uses DOM only (extension scripts cannot see page JS globals).
 */
export function collectHealth() {
  const clip = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'LINK', 'META', 'BR', 'IFRAME']);
  const textLen = (root) => {
    let n = 0;
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) n += c.nodeValue.replace(/\s+/g, ' ').trim().length;
        else if (c.nodeType === 1 && !SKIP.has(c.tagName.toUpperCase())) walk(c);
        if (n > 20000) return;
      }
    };
    walk(root);
    return n;
  };
  const sampleText = (root) => {
    let out = '';
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (out.length > 140) return;
        if (c.nodeType === 3) out += `${c.nodeValue} `;
        else if (c.nodeType === 1 && !SKIP.has(c.tagName.toUpperCase())) walk(c);
      }
    };
    walk(root);
    return clip(norm(out), 120);
  };
  const desc = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
    return clip(`${el.tagName.toLowerCase()}${id}${cls}`, 120);
  };

  // ---------- DOM size ----------
  const all = document.getElementsByTagName('*');
  let maxDepth = 0;
  let maxChildren = 0;
  let maxChildrenAt = '';
  const depthOf = (el) => { let d = 0; for (let n = el; n.parentElement; n = n.parentElement) d += 1; return d; };
  const limit = Math.min(all.length, 15000);
  for (let i = 0; i < limit; i += 1) {
    const el = all[i];
    if (el.tagName !== 'HEAD' && el.childElementCount > maxChildren) { maxChildren = el.childElementCount; maxChildrenAt = desc(el); }
    if (!el.firstElementChild) { const d = depthOf(el); if (d > maxDepth) maxDepth = d; }
  }
  const dom = { nodes: all.length, maxDepth, maxChildren, maxChildrenAt, htmlBytes: document.documentElement.outerHTML.length };

  // ---------- Hidden content ----------
  const UI_HIDDEN = /menu|nav|dropdown|submenu|mega|offcanvas|off-canvas|drawer|modal|popup|dialog|cart|minicart|search|cookie|cky|consent|tab-content|tabpanel|accordion|toggle|collapse|tooltip|lightbox|slider|swiper|slick|carousel|variation|woocommerce-tabs|panel|faq/i;
  const BREAKPOINT = /elementor-hidden-(mobile|tablet|desktop|widescreen|laptop|mobile_extra|tablet_extra)|hidden-(xs|sm|md|lg|xl)|d-none|d-(sm|md|lg|xl)-none|max-md:hidden|md:hidden|lg:hidden|hide-(on-)?(mobile|desktop|tablet)|visible-(mobile|desktop)/i;
  const hidden = [];
  let hiddenChars = 0;
  const bodyEls = document.body ? document.body.getElementsByTagName('*') : [];
  const scanLimit = Math.min(bodyEls.length, 8000);
  let skipUntil = null;
  for (let i = 0; i < scanLimit; i += 1) {
    const el = bodyEls[i];
    if (skipUntil && skipUntil.contains(el)) continue;
    skipUntil = null;
    if (SKIP.has(el.tagName.toUpperCase())) continue;
    const cs = getComputedStyle(el);
    let reason = '';
    if (cs.display === 'none') reason = 'display:none';
    else if (cs.visibility === 'hidden') reason = 'visibility:hidden';
    else if (cs.position === 'absolute' || cs.position === 'fixed') {
      const r = el.getBoundingClientRect();
      if (r.right < -500 || r.left > window.innerWidth + 2000 || r.bottom < -2000) reason = 'off-screen';
      else if (r.width <= 1 && r.height <= 1 && cs.overflow === 'hidden') reason = 'clipped to 1px';
    }
    if (!reason && cs.opacity === '0') reason = 'opacity:0';
    if (!reason) continue;
    skipUntil = el; // children inherit, report the top-most hidden block only
    const chars = textLen(el);
    if (chars < 40) continue;
    hiddenChars += chars;
    // Look at the element and up to 4 ancestors for a known UI pattern
    let ctxStr = '';
    for (let n = el, k = 0; n && k < 5; n = n.parentElement, k += 1) {
      ctxStr += ` ${n.id || ''} ${typeof n.className === 'string' ? n.className : ''} ${n.getAttribute('role') || ''} ${n.tagName}`;
      if (n.hasAttribute('aria-hidden') || n.hasAttribute('hidden')) ctxStr += ' aria-hidden';
    }
    let category = 'unknown';
    if (/^[SB]:\d+$/.test(el.id) || el.closest('template, [data-nextjs-scroll-focus-boundary]')) category = 'framework'; // React streaming placeholders
    else if (BREAKPOINT.test(ctxStr)) category = 'breakpoint';
    else if (UI_HIDDEN.test(ctxStr) || /\b(NAV|HEADER|FOOTER|DIALOG|DETAILS|ASIDE)\b/.test(ctxStr) || el.closest('nav, header, footer, dialog, details, [role="dialog"], [role="tabpanel"], [role="menu"]')) category = 'ui';
    else if (reason === 'clipped to 1px' && /sr-only|screen-reader|visually-hidden|skip/i.test(ctxStr)) category = 'a11y';
    else if (/hidden|collapsed|show-?more|read-?more|load-?more|expand|truncat/i.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`)) category = 'expandable';
    if (hidden.length < 60) hidden.push({ el: desc(el), reason, chars, category, sample: sampleText(el) });
  }
  const visibleChars = norm(document.body ? document.body.innerText : '').length;

  // ---------- CSS generated text (::before / ::after) ----------
  const cssText = [];
  const cssLimit = Math.min(bodyEls.length, 4000);
  for (let i = 0; i < cssLimit && cssText.length < 30; i += 1) {
    const el = bodyEls[i];
    for (const pseudo of ['::before', '::after']) {
      const c = getComputedStyle(el, pseudo).content;
      if (!c || c === 'none' || c === 'normal' || c === '""' || c === "''") continue;
      const text = c.replace(/^["']|["']$/g, '').replace(/\\[0-9a-f]{1,6}\s?/gi, '').trim();
      // Real words only: skip icon fonts (private use area), counters, quotes, single symbols
      if (/[-]/.test(c) || /^(counter|attr|url|open-quote|close-quote)/.test(c)) continue;
      const words = text.match(/[A-Za-zऀ-ॿ]{2,}/g) || [];
      if (words.length >= 2 || (words.length === 1 && words[0].length >= 5)) {
        cssText.push({ el: desc(el), pseudo, text: clip(text, 100) });
      }
    }
  }

  // ---------- Shadow DOM and custom elements ----------
  const shadow = { open: 0, openWithText: 0, customElements: 0, emptyCustom: [] };
  for (let i = 0; i < limit; i += 1) {
    const el = all[i];
    if (el.shadowRoot) {
      shadow.open += 1;
      if (textLen(el.shadowRoot) > 40) shadow.openWithText += 1;
    }
    if (el.tagName.includes('-')) {
      shadow.customElements += 1;
      const r = el.getBoundingClientRect();
      if (!el.shadowRoot && textLen(el) < 5 && r.width * r.height > 40000 && shadow.emptyCustom.length < 10) shadow.emptyCustom.push(desc(el));
    }
  }

  // ---------- iframes ----------
  const iframes = [...document.querySelectorAll('iframe')].slice(0, 30).map((f) => {
    const src = f.getAttribute('src') || f.getAttribute('data-src') || f.getAttribute('data-lazy-src') || f.getAttribute('data-litespeed-src') || '';
    let host = '';
    try { host = src && !/^about:/.test(src) ? new URL(src, location.href).hostname : (f.hasAttribute('srcdoc') ? '(srcdoc)' : '(no src yet)'); } catch (e) { host = '(invalid)'; }
    const r = f.getBoundingClientRect();
    return { host: clip(host, 80), visible: r.width > 2 && r.height > 2, lazy: (f.getAttribute('loading') || '') === 'lazy', title: clip(f.getAttribute('title') || '', 60) };
  });

  // ---------- Render-blocking resources in <head> ----------
  const headScripts = [...document.head.querySelectorAll('script[src]')];
  const blockingScripts = headScripts.filter((s) => !s.async && !s.defer && !s.noModule && s.type !== 'module' && !/^(text\/template|application\/ld\+json)$/i.test(s.type || ''))
    .map((s) => clip(s.getAttribute('src').split('?')[0].split('/').slice(-2).join('/'), 80));
  const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')];
  const blockingCss = stylesheets.filter((l) => !l.media || l.media === 'all' || l.media === 'screen').filter((l) => document.head.contains(l)).length;
  const scripts = [...document.scripts];
  const inlineBytes = scripts.filter((s) => !s.src).reduce((n, s) => n + s.textContent.length, 0);
  const resources = {
    scripts: scripts.length,
    externalScripts: scripts.filter((s) => s.src).length,
    inlineScriptKB: Math.round(inlineBytes / 1024),
    stylesheets: stylesheets.length,
    blockingCss,
    blockingScripts: blockingScripts.slice(0, 20),
    blockingScriptCount: blockingScripts.length,
  };

  // ---------- Tech stack (from DOM signals only) ----------
  const srcs = `${scripts.map((s) => s.src).join(' ')} ${stylesheets.map((l) => l.href).join(' ')}`;
  const inline = scripts.filter((s) => !s.src).map((s) => s.textContent.slice(0, 20000)).join('\n');
  const html = document.documentElement.outerHTML.slice(0, 600000);
  const generator = [...document.querySelectorAll('meta[name="generator" i]')].map((m) => clip(m.content, 80));
  const has = (re) => re.test(srcs) || re.test(html);
  const stack = [];
  const add = (cond, name, group) => { if (cond) stack.push({ name, group }); };
  add(has(/\/wp-content\/|\/wp-includes\//) || generator.some((g) => /wordpress/i.test(g)), 'WordPress', 'platform');
  add(has(/woocommerce/i), 'WooCommerce', 'platform');
  add(has(/elementor/i), 'Elementor', 'builder');
  add(!!document.getElementById('__NEXT_DATA__') || /\/_next\/static\//.test(srcs), 'Next.js', 'framework');
  add(!!document.getElementById('__NUXT__') || /\/_nuxt\//.test(srcs), 'Nuxt', 'framework');
  add(/cdn\.shopify\.com|Shopify\.theme/.test(srcs + inline), 'Shopify', 'platform');
  add(/static\.wixstatic\.com|wix\.com/.test(srcs), 'Wix', 'platform');
  add(/squarespace/.test(srcs), 'Squarespace', 'platform');
  add(/webflow/.test(srcs) || !!document.documentElement.getAttribute('data-wf-site'), 'Webflow', 'platform');
  add(!!document.querySelector('[data-reactroot], #root, #__next'), 'React', 'framework');
  add(!!document.querySelector('[data-v-app], [data-server-rendered]') || /\bdata-v-[0-9a-f]{6,}/.test(html.slice(0, 200000)), 'Vue', 'framework');
  add(/gatsby/.test(srcs) || !!document.getElementById('___gatsby'), 'Gatsby', 'framework');
  add(/rank-math|rankmath/i.test(html), 'Rank Math', 'seo');
  add(generator.some((g) => /site kit/i.test(g)), 'Site Kit by Google', 'tracking');
  add(/yoast/i.test(html), 'Yoast SEO', 'seo');
  add(/wp-rocket|wpr-/i.test(html), 'WP Rocket', 'performance');
  add(/litespeed/i.test(html), 'LiteSpeed Cache', 'performance');
  add(/autoptimize/i.test(srcs), 'Autoptimize', 'performance');
  add(/\/cdn-cgi\//.test(html), 'Cloudflare', 'cdn');
  add(/cookieyes|cky-consent/i.test(html), 'CookieYes', 'consent');
  add(/onetrust|optanon/i.test(html), 'OneTrust', 'consent');
  add(/cookiebot/i.test(html), 'Cookiebot', 'consent');
  add(/googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/.test(srcs + inline), 'Google Tag Manager', 'tracking');
  add(/gtag\/js\?id=G-|['"]G-[A-Z0-9]{6,}['"]/.test(srcs + inline), 'Google Analytics 4', 'tracking');
  add(/connect\.facebook\.net|fbq\(/.test(srcs + inline), 'Meta Pixel', 'tracking');
  add(/clarity\.ms/.test(srcs + inline), 'Microsoft Clarity', 'tracking');
  add(/hotjar/.test(srcs + inline), 'Hotjar', 'tracking');
  add(/bat\.bing\.com/.test(srcs + inline), 'Microsoft Ads (UET)', 'tracking');
  add(/snap\.licdn\.com|linkedin\.com\/px/.test(srcs + inline), 'LinkedIn Insight', 'tracking');
  add(/optimizely/.test(srcs + html.slice(0, 300000)), 'Optimizely', 'testing');
  add(/adsrvr\.org/.test(srcs + html.slice(0, 300000)), 'The Trade Desk', 'tracking');
  add(/vwo\.com|visualwebsiteoptimizer/.test(srcs + inline), 'VWO', 'testing');
  const ids = (re) => [...new Set((srcs + inline).match(re) || [])].slice(0, 10);
  const tags = { gtm: ids(/GTM-[A-Z0-9]{4,9}/g), ga4: ids(/\bG-[A-Z0-9]{6,12}\b/g), ua: ids(/\bUA-\d{4,10}-\d{1,4}\b/g), aw: ids(/\bAW-\d{6,12}\b/g) };

  // ---------- HTML comments (Step 5E: plugin and version clues, leaks) ----------
  const comments = [];
  const cw = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  for (let n = cw.nextNode(); n && comments.length < 40; n = cw.nextNode()) {
    const t = norm(n.nodeValue);
    if (t.length > 3) comments.push(clip(t, 120));
  }

  return {
    url: clip(location.href, 2048),
    dom,
    comments,
    hidden,
    hiddenChars,
    visibleChars,
    cssText,
    shadow,
    iframes,
    resources,
    generator,
    stack,
    tags,
    collectedAt: new Date().toISOString(),
  };
}

/**
 * v1.1 collector: business signals (used by the business-model rules).
 * Contact paths, calls to action, address and opening hours, policies,
 * trust signals, pricing/signup, pagination, affiliate links, authorship and
 * dates, and the business-related parts of JSON-LD. Read-only.
 */
export function collectSignals() {
  const clip = (value, max = 120) => (typeof value === 'string' ? value.slice(0, max) : '');
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const above = (el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; };
  const bodyText = norm(document.body ? document.body.innerText : '');
  const lower = bodyText.toLowerCase();
  const anchors = [...document.querySelectorAll('a[href]')].slice(0, 2000);
  const host = location.hostname.replace(/^www\./, '');
  const hrefOf = (a) => a.getAttribute('href') || '';

  // ---------- JSON-LD (flattened) ----------
  const nodes = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object' || nodes.length > 300) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    nodes.push(n);
    Object.values(n).forEach((v) => { if (v && typeof v === 'object') walk(v); });
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { walk(JSON.parse(s.textContent)); } catch (e) { /* parse errors are reported by the head checks */ } });
  const typesOf = (n) => [].concat(n['@type'] || []).map(String);
  const LOCAL = /LocalBusiness|Store|Restaurant|Dentist|Physician|MedicalClinic|Hospital|Hotel|LodgingBusiness|Attorney|LegalService|AutoRepair|BeautySalon|HealthAndBeautyBusiness|RealEstateAgent|FoodEstablishment|ProfessionalService|HomeAndConstructionBusiness|SportsActivityLocation|TravelAgency|Plumber|Electrician|Locksmith|ChildCare|School|Library|GymOrFitness|ExerciseGym|Bakery|CafeOrCoffeeShop|DaySpa|VeterinaryCare|Optician|Pharmacy/;
  const allTypes = [...new Set(nodes.flatMap(typesOf))];
  const localNode = nodes.find((n) => typesOf(n).some((t) => LOCAL.test(t)));
  const schema = {
    types: allTypes.slice(0, 40).map((t) => clip(t, 60)),
    localBusiness: localNode ? clip(typesOf(localNode).join(', '), 80) : '',
    hasAddress: nodes.some((n) => n.address && (typeof n.address === 'string' || n.address.streetAddress || n.address.addressLocality || n.address.postalCode)),
    telephone: clip(String((nodes.find((n) => n.telephone) || {}).telephone || ''), 40),
    openingHours: nodes.some((n) => n.openingHours || n.openingHoursSpecification),
    geo: nodes.some((n) => n.geo),
    author: nodes.some((n) => n.author),
    authorName: clip(String(((nodes.find((n) => n.author) || {}).author || {}).name || ''), 60),
    reviewedBy: nodes.some((n) => n.reviewedBy || n.medicalReviewer || n.lastReviewed),
    datePublished: clip(String((nodes.find((n) => n.datePublished) || {}).datePublished || ''), 30),
    dateModified: clip(String((nodes.find((n) => n.dateModified) || {}).dateModified || ''), 30),
    itemList: allTypes.includes('ItemList') || allTypes.includes('OfferCatalog'),
    software: allTypes.some((t) => /SoftwareApplication|WebApplication|MobileApplication/.test(t)),
    article: allTypes.some((t) => /Article|BlogPosting|NewsArticle|MedicalWebPage/.test(t)),
    offers: nodes.some((n) => n.offers),
    rating: nodes.some((n) => n.aggregateRating || n.review),
    faq: allTypes.includes('FAQPage'),
  };

  // ---------- Contact paths ----------
  const tel = anchors.filter((a) => /^tel:\s*\+?[\d(]/i.test(hrefOf(a)));
  const mail = anchors.filter((a) => /^mailto:.+@/i.test(hrefOf(a)));
  const whatsapp = anchors.filter((a) => /wa\.me\/\d|api\.whatsapp\.com\/send\?phone=\d/i.test(hrefOf(a)));
  const contactLinks = anchors.filter((a) => /contact|get-in-touch|enquir|inquir|support/i.test(hrefOf(a)));
  const forms = [...document.querySelectorAll('form')].filter((f) => !f.closest('header [role="search"]') && !/search/i.test(`${f.getAttribute('role') || ''} ${f.className} ${f.id} ${f.action}`));
  const leadForms = forms.filter((f) => f.querySelector('input[type="email"], input[type="tel"], input[name*="email" i], input[name*="phone" i], textarea'));
  const phoneText = bodyText.match(/(?:\+91[\s-]?|\b0)?[6-9]\d{4}[\s-]?\d{5}\b|\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b0\d{2,4}[\s-]\d{3,4}[\s-]\d{4}\b/);

  // ---------- Calls to action (visible buttons and links) ----------
  const CTA = {
    buy: /add to cart|add to bag|buy now|order now|shop now|checkout|order on whatsapp/i,
    lead: /get a quote|request a quote|get quote|contact us|contact sales|talk to (sales|an expert|us)|book a (call|consultation|tour|visit|demo|meeting|appointment)|enquire|enquiry|inquire|schedule|get in touch|request a callback|call us/i,
    trial: /start (your )?free trial|free trial|sign ?up|get started|try (it )?(for )?free|create (an )?account|start for free/i,
    demo: /book a demo|request a demo|get a demo|watch demo|schedule a demo/i,
    appointment: /book (an )?appointment|book now|reserve|book a (table|visit|slot)|call now|directions/i,
  };
  const clickables = [...document.querySelectorAll('a, button, input[type="submit"], [role="button"]')].slice(0, 3000);
  const ctas = {};
  Object.keys(CTA).forEach((k) => { ctas[k] = { count: 0, visible: 0, aboveFold: 0, sample: '' }; });
  clickables.forEach((el) => {
    const text = norm(el.innerText || el.value || el.getAttribute('aria-label') || '');
    if (!text || text.length > 60) return;
    Object.entries(CTA).forEach(([k, re]) => {
      if (!re.test(text)) return;
      const c = ctas[k];
      c.count += 1;
      if (visible(el)) { c.visible += 1; if (above(el)) c.aboveFold += 1; if (!c.sample) c.sample = clip(text, 40); }
    });
  });

  // ---------- Address, map, hours ----------
  const addressEl = document.querySelector('address, [itemprop="address"], .address, [class*="address" i]');
  const pin = /\b\d{3}\s?\d{3}\b/.test(bodyText) && /(road|rd\.?|nagar|marg|street|st\.|sector|colony|floor|building|plot|near|opp\.?|lane|chowk|bazaar|mumbai|delhi|indore|bangalore|bengaluru|pune|india)/i.test(bodyText);
  const zip = /\b[A-Z]{2}\s\d{5}(-\d{4})?\b/.test(bodyText);
  const mapEmbed = [...document.querySelectorAll('iframe')].some((f) => /google\.[a-z.]+\/maps|maps\.google|openstreetmap|mapbox/i.test(f.getAttribute('src') || f.getAttribute('data-src') || ''));
  const mapLink = anchors.some((a) => /maps\.app\.goo\.gl|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.apple\.com/i.test(hrefOf(a)));
  const hoursText = /(opening hours|business hours|working hours|open (today|now|daily)|mon(day)?\s?[-–to]+\s?(fri|sat|sun)|\b\d{1,2}(:\d{2})?\s?(am|pm)\s?[-–to]+\s?\d{1,2}(:\d{2})?\s?(am|pm))/i.test(bodyText);

  // ---------- Policies and trust ----------
  const linkMatch = (re) => anchors.some((a) => re.test(`${hrefOf(a)} ${norm(a.textContent)}`));
  const policies = {
    refund: linkMatch(/refund|return|cancellation|exchange/i),
    shipping: linkMatch(/shipping|delivery/i),
    privacy: linkMatch(/privacy/i),
    terms: linkMatch(/terms|conditions/i),
  };
  const trust = {
    testimonials: /testimonial|what (our )?(clients|customers) say|reviews?\b|rated \d|★|⭐/i.test(bodyText),
    caseStudies: linkMatch(/case-stud|case stud|success-stor|customer-stor/i) || /case stud/i.test(lower),
    clients: /trusted by|our clients|clients include|companies (use|trust)|as seen in|featured in/i.test(bodyText),
    certifications: /certified|certificate|iso \d|fssai|accredit|licen[cs]e no|registered with|award/i.test(bodyText),
  };

  // ---------- SaaS ----------
  const pricingLink = anchors.some((a) => /\/pricing|\/plans|pricing|plans? (&|and) pricing/i.test(`${hrefOf(a)} ${norm(a.textContent)}`));

  // ---------- Listings / pagination ----------
  const relNext = !!document.querySelector('link[rel="next"], a[rel="next"]');
  const pageLinks = anchors.filter((a) => /[?&](page|p|pg)=\d+|\/page\/\d+/i.test(hrefOf(a))).length;
  const paramLinks = anchors.filter((a) => {
    const h = hrefOf(a);
    if (!/\?/.test(h)) return false;
    try { const u = new URL(h, location.href); return u.hostname.replace(/^www\./, '') === host && /[?&](sort|order|filter|color|colour|size|price|min|max|brand|f|q|view|limit)=/i.test(u.search); } catch (e) { return false; }
  }).length;

  // ---------- Affiliate / outbound ----------
  const AFF = /amzn\.to|amazon\.[a-z.]+\/.*[?&]tag=|[?&](tag|ref|aff|affiliate|affid|aff_id|partner|utm_medium=affiliate)=|\/go\/|\/recommends\/|\/out\/|clickbank|shareasale|awin1|impact\.com|partnerize|cj\.com|anrdoezrs|dpbolvw|tkqlhce|jdoqocy|kqzyfj|flipkart\.com\/.*affid|earnkaro|bitli|linksredirect/i;
  const outbound = anchors.filter((a) => { try { const u = new URL(hrefOf(a), location.href); return /^https?:$/.test(u.protocol) && u.hostname.replace(/^www\./, '') !== host; } catch (e) { return false; } });
  // Not affiliate: "powered by" links from cookie-consent and widget vendors use ?ref= too
  const VENDOR = /cookieyes|onetrust|cookiebot|termly|iubenda|elfsight|trustindex|tawk\.to|wordpress\.org|elementor\.com|wix\.com|shopify\.com/i;
  const affiliate = anchors.filter((a) => AFF.test(hrefOf(a)) && !VENDOR.test(hrefOf(a)) && !a.closest('[class*="cky" i], [class*="cookie" i], [id*="cookie" i], [class*="consent" i]'));
  const affNoRel = affiliate.filter((a) => !/sponsored|nofollow/i.test(a.getAttribute('rel') || ''));
  const citations = outbound.filter((a) => /\.gov\b|\.gov\.|\.edu\b|\.ac\.in|nih\.gov|pubmed|ncbi|who\.int|cdc\.gov|nhs\.uk|mayoclinic|rbi\.org|sebi\.gov|indiacode|legislation|doi\.org|sciencedirect|springer|wiley|nature\.com|thelancet|bmj\.com/i.test(hrefOf(a)));

  // ---------- Authorship and dates ----------
  // Byline on the page (not the "author" field of a comment or review form)
  const authorEl = [...document.querySelectorAll('[rel="author"], [itemprop="author"], .author, .byline, [class*="author" i], [class*="byline" i]')]
    .find((el) => !el.closest('form, #reviews, .comment-respond') && norm(el.textContent).length >= 3 && norm(el.textContent).length <= 120);
  const authorText = /\b(written|reviewed|fact[- ]checked|medically reviewed|edited) by\b|\bby\s+(?:[Dd]r\.?|CA\.?|[Aa]dv\.?)?\s?[A-Z][a-z]+\s[A-Z][a-z]+/.test(bodyText);
  const credentials = /\b(dr\.|md\b|mbbs|bds|mds|phd|ca\b|cfa|cfp|llb|llm|advocate|rd\b|registered dietitian|nutritionist|certified)\b/i.test(bodyText);
  const reviewedText = /(medically|clinically|expert|fact[- ]?) ?(reviewed|checked) by|reviewed by/i.test(bodyText);
  const timeEl = document.querySelector('time[datetime]');
  const metaPub = document.querySelector('meta[property="article:published_time"], meta[property="article:modified_time"], meta[name="date"]');
  const updatedText = /(last )?updated( on)?:?\s+\w+/i.test(bodyText) || /published( on)?:?\s+\w+/i.test(bodyText);

  return {
    url: clip(location.href, 2048),
    schema,
    contact: {
      tel: tel.length,
      telVisible: tel.filter(visible).length,
      telSample: tel[0] ? clip(hrefOf(tel[0]), 40) : '',
      mail: mail.length,
      whatsapp: whatsapp.length,
      contactLinks: contactLinks.length,
      forms: forms.length,
      leadForms: leadForms.length,
      leadFormVisible: leadForms.some(visible),
      phoneText: phoneText ? clip(phoneText[0], 30) : '',
    },
    ctas,
    local: { addressEl: !!addressEl, addressText: pin || zip, mapEmbed, mapLink, hoursText },
    policies,
    trust,
    saas: { pricingLink },
    listing: { relNext, pageLinks, paramLinks },
    outbound: { total: outbound.length, affiliate: affiliate.length, affiliateNoRel: affNoRel.length, affiliateSamples: affNoRel.slice(0, 15).map((a) => clip(hrefOf(a), 120)), citations: citations.length },
    authorship: {
      authorEl: !!authorEl,
      authorText,
      credentials,
      reviewedText,
      dateEl: !!timeEl || !!metaPub,
      updatedText,
    },
    collectedAt: new Date().toISOString(),
  };
}
