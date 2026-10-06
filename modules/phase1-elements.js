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
  version: '0.2.0',
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
