// Phase 3 module: JavaScript rendering checks (collector).
//
// collectRendering() is injected into the audited page with
// chrome.scripting.executeScript({ func }), like the other collectors:
//   - fully self-contained (no imports, no outside variables)
//   - read-only: it never changes the page
//   - returns plain data only
//
// It makes one same-origin request: the page's own URL, to get the raw HTML
// the server sends (what crawlers that do not run JavaScript see). The raw
// HTML is parsed with DOMParser, so its scripts never run.
//
// Judgement (flags and reasons) lives in phase3-rules.js, not here.

export const MODULE_INFO = {
  id: 'phase3-rendering',
  name: 'Phase 3: Rendering',
  version: '1.4.0',
};

export async function collectRendering() {
  const clip = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const out = {
    url: clip(location.href, 2048),
    collectedAt: new Date().toISOString(),
    raw: { ok: false, reason: '', bytes: 0, challenge: false },
    renderedBytes: document.documentElement ? document.documentElement.outerHTML.length : 0,
    signals: {},
    mount: null,
    words: { raw: 0, rendered: 0 },
    meta: { raw: {}, rendered: {} },
    schema: { raw: [], rendered: [], rawMicrodata: [], renderedMicrodata: [] },
    facts: null,
    links: null,
    loadMore: [],
    pagination: { raw: [], rendered: [] },
    panels: [],
    fakeLinks: [],
    errors: [],
  };

  // Areas whose text is not the page's own content: site header, menus,
  // announcement bars ("Free shipping over ₹999"), mini-cart (₹0.00), footer.
  const NOT_CONTENT = [
    'header', 'nav', 'footer', '[role="banner"]', '[role="navigation"]', '[role="contentinfo"]',
    '[data-elementor-type="header"]', '[data-elementor-type="footer"]',
    '[class*="announcement"]', '[class*="topbar"]', '[class*="top-bar"]', '[class*="promo-bar"]', '[class*="marquee"]',
    '[class*="mini-cart"]', '[class*="minicart"]', '[class*="cart-drawer"]', '[class*="side-cart"]',
    // cart drawers and mini-carts, but not the buy button (Shopify: id "…__add-to-cart")
    '[id*="cart"]:not([id*="add-to-cart" i]):not([id*="addtocart" i]):not([id*="add_to_cart" i])', '.widget_shopping_cart',
    // CookieYes classes start with "cky-"; [class*="cky-"] also matched "sticky-"
    // and removed Shopify's main product block (.sticky-content).
    '[class*="cookie"]', '[id*="cookie"]', '[class^="cky-"]', '[class*=" cky-"]',
  ].join(',');
  const SKIP = 'script, style, noscript, template, svg';

  const textWithout = (root, removeSelector) => {
    if (!root) return '';
    const copy = root.cloneNode(true);
    copy.querySelectorAll(SKIP).forEach((n) => n.remove());
    if (removeSelector) copy.querySelectorAll(removeSelector).forEach((n) => n.remove());
    return norm(copy.textContent);
  };
  const countWords = (t) => (t ? t.split(' ').length : 0);

  // ---------- raw HTML ----------
  let raw = '';
  let rawDoc = null;
  try {
    const res = await fetch(location.href, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
    raw = await res.text();
    out.raw.bytes = raw.length;
    out.raw.status = res.status;
    out.raw.challenge = raw.length < 20000 && /_Incapsula_Resource|incapsula|_incap_|cf-chl|challenge-platform|captcha|just a moment/i.test(raw);
    if (!res.ok) out.raw.reason = `HTTP ${res.status}`;
    else if (out.raw.challenge) out.raw.reason = 'Bot protection answered instead of the page';
    else {
      rawDoc = new DOMParser().parseFromString(raw, 'text/html');
      out.raw.ok = true;
    }
  } catch (e) {
    out.raw.reason = clip(`Could not fetch raw HTML: ${e && e.message ? e.message : e}`, 200);
  }

  // ---------- framework / strategy signals (raw HTML) ----------
  const has = (needle) => raw.includes(needle);
  out.signals = {
    nextPages: has('__NEXT_DATA__'),
    nextApp: has('self.__next_f'),
    nextStatic: has('/_next/static/'),
    nuxt: has('__NUXT__') || has('/_nuxt/'),
    angular: /\bng-version=/.test(raw),
    vueSsr: has('data-server-rendered'),
    gatsby: has('___gatsby'),
    astro: has('astro-island'),
    shopify: has('Shopify.theme') || has('cdn.shopify.com'),
    wordpress: has('/wp-content/') || has('/wp-includes/'),
    elementor: has('elementor'),
    reactRootAttr: has('data-reactroot'),
  };

  // Empty app shell: <div id="root"></div> with little text in the raw HTML
  if (rawDoc) {
    const mountEl = rawDoc.querySelector('#root, #app, #__next, #__nuxt, [data-reactroot], app-root');
    if (mountEl) {
      const live = document.getElementById(mountEl.id || '') || null;
      out.mount = {
        selector: mountEl.id ? `#${mountEl.id}` : mountEl.tagName.toLowerCase(),
        rawWords: countWords(textWithout(mountEl)),
        renderedWords: live ? countWords(textWithout(live)) : null,
      };
    }
  }

  // ---------- words: raw vs rendered (same counting on both) ----------
  // Content words only: cookie banners, chat widgets and menus are often injected
  // by JavaScript on purpose and would make a server-rendered page look "hybrid".
  out.words.raw = rawDoc ? countWords(textWithout(rawDoc.body, NOT_CONTENT)) : 0;
  out.words.rendered = countWords(textWithout(document.body, NOT_CONTENT));

  // ---------- meta: raw vs rendered ----------
  const metaOf = (doc) => {
    const attr = (sel, a = 'content') => { const el = doc.querySelector(sel); return el ? norm(el.getAttribute(a)) : null; };
    const all = (sel) => [...doc.querySelectorAll(sel)].map((m) => norm(m.getAttribute('content'))).filter(Boolean);
    const titleEl = doc.querySelector('title');
    return {
      title: titleEl ? clip(norm(titleEl.textContent), 300) : null,
      description: clip(attr('meta[name="description" i]') || '', 400) || null,
      canonical: attr('link[rel="canonical" i]', 'href'),
      robots: [...all('meta[name="robots" i]'), ...all('meta[name="googlebot" i]')].join(', ') || null,
      ogTitle: attr('meta[property="og:title" i]'),
      ogDescription: clip(attr('meta[property="og:description" i]') || '', 300) || null,
      ogImage: attr('meta[property="og:image" i]'),
      twitterCard: attr('meta[name="twitter:card" i]'),
      lang: doc.documentElement ? norm(doc.documentElement.getAttribute('lang')) || null : null,
      h1: [...doc.querySelectorAll('h1')].slice(0, 3).map((h) => clip(norm(h.textContent), 120)).filter(Boolean),
    };
  };
  if (rawDoc) out.meta.raw = metaOf(rawDoc);
  out.meta.rendered = metaOf(document);
  // canonical: resolve both against the page URL so relative vs absolute is not a "change"
  ['raw', 'rendered'].forEach((k) => {
    const c = out.meta[k].canonical;
    if (c) { try { out.meta[k].canonical = new URL(c, location.href).href; } catch { /* keep as is */ } }
  });

  // ---------- schema: raw vs rendered ----------
  const offers = [];
  const schemaOf = (doc, collectOffers) => {
    const types = new Set();
    const walk = (n, depth, inProduct) => {
      if (!n || typeof n !== 'object' || depth > 10) return;
      if (Array.isArray(n)) { n.forEach((x) => walk(x, depth + 1, inProduct)); return; }
      const t = [].concat(n['@type'] || []).map(String);
      t.forEach((x) => types.add(x));
      if (n.aggregateRating) types.add('aggregateRating');
      const isProduct = t.some((x) => /^(Product|ProductGroup|IndividualProduct)$/.test(x));
      const isOffer = t.some((x) => /^(Offer|AggregateOffer)$/.test(x));
      // Only prices inside Product/Offer count. "price": 34900 in an analytics blob does not.
      if (collectOffers && isOffer && (inProduct || isProduct)) {
        ['price', 'lowPrice', 'highPrice'].forEach((k) => {
          if (n[k] !== undefined && n[k] !== '' && offers.length < 10) offers.push({ key: k, value: String(n[k]), currency: String(n.priceCurrency || ''), availability: String(n.availability || '') });
        });
      }
      Object.values(n).forEach((v) => { if (v && typeof v === 'object') walk(v, depth + 1, inProduct || isProduct); });
    };
    let parseErrors = 0;
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { walk(JSON.parse(s.textContent), 0, false); } catch { parseErrors += 1; }
    });
    // A Product whose offers are listed at the top level (@graph) still counts
    if (collectOffers && !offers.length) {
      doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try {
          const all = [];
          const flat = (n, d) => { if (!n || typeof n !== 'object' || d > 10) return; if (Array.isArray(n)) { n.forEach((x) => flat(x, d + 1)); return; } all.push(n); Object.values(n).forEach((v) => flat(v, d + 1)); };
          flat(JSON.parse(s.textContent), 0);
          if (all.some((n) => [].concat(n['@type'] || []).includes('Product'))) {
            all.filter((n) => [].concat(n['@type'] || []).some((x) => /^(Offer|AggregateOffer)$/.test(x))).forEach((n) => {
              ['price', 'lowPrice', 'highPrice'].forEach((k) => { if (n[k] !== undefined && n[k] !== '' && offers.length < 10) offers.push({ key: k, value: String(n[k]), currency: String(n.priceCurrency || ''), availability: String(n.availability || '') }); });
            });
          }
        } catch { /* counted above */ }
      });
    }
    const micro = [...doc.querySelectorAll('[itemtype]')].map((e) => (e.getAttribute('itemtype') || '').split('/').pop()).filter(Boolean);
    return { types: [...types].slice(0, 60), micro: [...new Set(micro)].slice(0, 30), parseErrors };
  };
  if (rawDoc) {
    const s = schemaOf(rawDoc, false);
    out.schema.raw = s.types;
    out.schema.rawMicrodata = s.micro;
  }
  const rs = schemaOf(document, true);
  out.schema.rendered = rs.types;
  out.schema.renderedMicrodata = rs.micro;
  out.schema.parseErrors = rs.parseErrors;

  // ---------- facts: is the schema price / stock in the page text? ----------
  // Live AI fetchers (a user pastes the link into a chatbot) are reported to read
  // the page text, not JSON-LD. Google reads both. So the price has to be in text.
  const numbersIn = (text) => {
    const found = new Set();
    (text.match(/\d[\d,]*(?:\.\d+)?/g) || []).slice(0, 5000).forEach((n) => {
      const v = Number(n.replace(/,/g, ''));
      if (Number.isFinite(v)) found.add(Math.round(v * 100));
    });
    return found;
  };
  // What a visitor can read on screen, minus header/menus/announcement bar/cart/footer.
  // Read node by node: removing each zone's text by string replace removed the
  // first match, which can be the main content when a sticky bar repeats it.
  const visibleText = (() => {
    if (!document.body) return '';
    const parts = [];
    const ok = new Map();
    const keep = (el) => {
      if (ok.has(el)) return ok.get(el);
      const v = !el.closest(NOT_CONTENT) && !el.closest(SKIP)
        && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0);
      ok.set(el, v);
      return v;
    };
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n && parts.length < 20000; n = tw.nextNode()) {
      const el = n.parentElement;
      if (el && n.nodeValue.trim() && keep(el)) parts.push(n.nodeValue);
    }
    return norm(parts.join(' '));
  })();
  const rawContentText = rawDoc ? textWithout(rawDoc.body, NOT_CONTENT) : '';
  if (offers.length) {
    const vis = numbersIn(visibleText);
    const rawNums = numbersIn(rawContentText);
    const cents = (v) => Math.round(Number(String(v).replace(/,/g, '')) * 100);
    const avail = ((offers.find((o) => o.availability) || {}).availability || '').split('/').pop();
    out.facts = {
      prices: offers.slice(0, 6).map((o) => ({ ...o, visible: vis.has(cents(o.value)), inRawText: rawNums.has(cents(o.value)) })),
      availability: avail,
      stockTextVisible: /\b(in stock|out of stock|sold out|available now|only \d+ left)\b/i.test(visibleText),
      buyButton: /\b(add to cart|add to bag|buy now|order now)\b/i.test(visibleText),
    };
  }

  // ---------- links: which internal links appear only after JavaScript ----------
  const linkSet = (doc) => {
    const set = new Set();
    doc.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href') || '';
      if (!h || h.startsWith('#') || /^(javascript|mailto|tel|sms|whatsapp):/i.test(h)) return;
      try {
        const u = new URL(h, location.href);
        if (u.origin !== location.origin) return;
        u.hash = '';
        set.add(u.pathname + u.search);
      } catch { /* skip bad href */ }
    });
    return set;
  };
  const renderedLinks = linkSet(document);
  const rawLinks = rawDoc ? linkSet(rawDoc) : new Set();
  const onlyRendered = [...renderedLinks].filter((l) => !rawLinks.has(l));
  out.links = { raw: rawLinks.size, rendered: renderedLinks.size, onlyRendered: onlyRendered.length, samples: onlyRendered.slice(0, 25).map((l) => clip(l, 160)) };

  // ---------- fake links: clickable things that are not <a href> ----------
  // <style data-href> (Next.js font CSS) and <link>/<script>/<meta> are not links.
  const NOT_CLICKABLE = new Set(['STYLE', 'SCRIPT', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'HTML', 'BODY']);
  document.querySelectorAll('[data-href], [data-url], [data-link], [role="link"], [onclick*="location"], [onclick*="href"]').forEach((el) => {
    if (out.fakeLinks.length >= 30 || el.tagName === 'A' || NOT_CLICKABLE.has(el.tagName)) return;
    const target = el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link') || (el.getAttribute('onclick') || '').slice(0, 80);
    // data-url is often what a script fetches, not where a click goes: Shopify
    // section and API endpoints, JSON, or this same page (a filter's "Clear all").
    if (!el.hasAttribute('data-href') && !el.hasAttribute('data-link') && el.hasAttribute('data-url')) {
      try {
        const u = new URL(target, location.href);
        if (u.pathname === location.pathname || /\/recommendations\/|[?&]section_id=|\/search\/suggest|^\/cart(\/|\.js|$)|\.json$|\/api\//i.test(u.pathname + u.search)) return;
      } catch { /* not a URL: keep it */ }
    }
    out.fakeLinks.push({ tag: el.tagName.toLowerCase(), text: clip(norm(el.innerText || el.getAttribute('aria-label') || ''), 60), target: clip(target, 120) });
  });

  // ---------- load more vs crawlable pagination ----------
  const LOAD_MORE = /^(load|show|view|see) (more|all)\b|^more (results|products|items|locations)\b|^load more\b/i;
  document.querySelectorAll('button, a, [role="button"]').forEach((el) => {
    const t = norm(el.innerText || el.getAttribute('aria-label') || '');
    if (t.length > 40 || !LOAD_MORE.test(t) || out.loadMore.length >= 5) return;
    // Cookie banners have their own "Show more" (CookieYes: cky-show-desc-btn); dialogs and menus are not lists
    if (el.closest(NOT_CONTENT) || el.closest('[role="dialog"], [aria-modal="true"]')) return;
    if (!el.getClientRects().length) return;
    const href = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
    out.loadMore.push({ tag: el.tagName.toLowerCase(), text: clip(t, 40), href: clip(href, 160), realLink: !!href && !href.startsWith('#') && !/^javascript:/i.test(href) });
  });
  const PAGINATION = 'a[href*="page="], a[href*="/page/"], a[href*="?p="], a[href*="&p="], a[rel~="next"], link[rel~="next"]';
  const pageLinks = (doc) => [...new Set([...doc.querySelectorAll(PAGINATION)].map((a) => clip(a.getAttribute('href') || '', 160)).filter(Boolean))].slice(0, 10);
  out.pagination.rendered = pageLinks(document);
  out.pagination.raw = rawDoc ? pageLinks(rawDoc) : [];

  // ---------- tabs and accordions: is the hidden panel text in the raw HTML? ----------
  const PANELS = '[role="tabpanel"], details, .tab-pane, .woocommerce-Tabs-panel, .elementor-tab-content, .e-n-accordion-item, .accordion-content, .accordion-body, .accordion-collapse, [class*="accordion"] [class*="content"], [class*="faq"] [class*="answer"]';
  const rawLower = rawDoc ? textWithout(rawDoc.body).toLowerCase() : '';
  const seen = new Set();
  // Menus, drawers and dialogs use <details> too (Shopify's mobile menu, whose
  // search results are filled in by JavaScript): they are not content panels.
  const NOT_PANEL = 'header, nav, footer, dialog, [role="dialog"], [role="navigation"], [class*="menu"], [class*="drawer"]';
  document.querySelectorAll(PANELS).forEach((el) => {
    if (out.panels.length >= 15) return;
    if (el.closest(NOT_PANEL)) return;
    const text = textWithout(el);
    if (text.length < 40) return;
    const probe = text.slice(0, 80).toLowerCase();
    if (seen.has(probe)) return;
    seen.add(probe);
    const shown = el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    out.panels.push({ kind: el.matches('details') ? 'details' : el.matches('[role="tabpanel"], .tab-pane, .woocommerce-Tabs-panel, .elementor-tab-content') ? 'tab' : 'accordion', text: clip(text.slice(0, 70), 70), shown, inRaw: rawDoc ? rawLower.includes(probe.slice(0, 60)) : null });
  });

  return out;
}
