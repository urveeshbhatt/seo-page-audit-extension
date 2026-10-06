// Phase 1 rules: turns collected <head> data into findings.
// Runs in the side panel (not in the audited page). Pure functions, no DOM.
//
// Finding shape:
//   { id, check, value, flag, label, why }
//   flag:  'critical' | 'warning' | 'good' | 'info'
//   label: short text on the pill (defaults by flag)
//   why:   one line a client could read

export const REVENUE_TYPES = new Set(['product', 'service', 'location', 'category', 'homepage']);

const DEFAULT_LABEL = {
  critical: 'Critical',
  warning: 'Check',
  good: 'Good',
  info: 'Info',
};

export function finding(id, check, value, flag, why, label, items) {
  const f = { id, check, value: value === '' || value == null ? '(none)' : String(value), flag, label: label || DEFAULT_LABEL[flag], why };
  if (items && items.length) f.items = items.slice(0, 50).map(String);
  return f;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function stripUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.href;
  } catch {
    return url || '';
  }
}

export function isPrelaunch(ctx) {
  return ctx && ctx.status === 'prelaunch';
}

// ---------------- Step 1: indexing ----------------

function robotsFindings(d, ctx) {
  const out = [];
  const all = [...d.robots, ...d.googlebot].join(', ').toLowerCase();
  const value = d.robots.length ? d.robots.join(' | ') : 'none (default: index, follow)';
  const hasNoindex = /\bnoindex\b|\bnone\b/.test(all);

  if (!hasNoindex) {
    out.push(finding('robots', 'Meta robots', value, 'good', 'Page can be indexed. No tag is fine: Google defaults to index, follow.'));
  } else if (isPrelaunch(ctx)) {
    out.push(finding('robots', 'Meta robots', value, 'warning', 'noindex is expected before launch. Remove it on launch day or this page stays out of Google.', 'Launch blocker'));
  } else if (REVENUE_TYPES.has(ctx.pageType)) {
    out.push(finding('robots', 'Meta robots', value, 'critical', 'This revenue page is blocked from Google. Organic traffic to it is zero until noindex is removed.'));
  } else {
    out.push(finding('robots', 'Meta robots', value, 'warning', 'noindex found. Fine for cart, thank-you, filter or search pages; a problem on pages that should rank. Is it intentional?'));
  }

  if (d.googlebot.length) {
    out.push(finding('googlebot', 'Meta googlebot', d.googlebot.join(' | '), 'info', 'A googlebot tag overrides the robots tag for Google. Make sure both agree.'));
  }
  if (/\bnofollow\b/.test(all) && !hasNoindex) {
    out.push(finding('nofollow', 'Robots nofollow', 'nofollow', 'warning', 'Links on this page pass no signals. Rarely wanted on a public page.'));
  }
  return out;
}

function canonicalFindings(d, ctx) {
  const c = d.canonicals;
  const noindex = /\bnoindex\b/.test([...d.robots, ...d.googlebot].join(' ').toLowerCase());

  if (c.length === 0) {
    if (noindex) {
      return [finding('canonical', 'Canonical', '0 tags', 'info', 'SEO plugins often drop the canonical on noindex pages. Re-check after noindex is removed: you should see exactly 1.', 'Re-check later')];
    }
    return [finding('canonical', 'Canonical', '0 tags', 'warning', 'No canonical. Parameter, slash and www variants of this URL can split ranking signals.')];
  }
  if (c.length > 1) {
    return [finding('canonical', 'Canonical', `${c.length} tags: ${c.join(' | ')}`, 'warning', 'More than one canonical. Google may ignore all of them. Usually a theme and a plugin both add one.')];
  }

  const canon = c[0];
  const here = stripUrl(d.url);
  let canonUrl = null;
  try { canonUrl = new URL(canon); } catch { /* invalid */ }
  if (!canonUrl) {
    return [finding('canonical', 'Canonical', canon, 'warning', 'Canonical is not a valid absolute URL.')];
  }
  const pageUrl = new URL(d.url);

  if (canonUrl.hostname.replace(/^www\./, '') !== pageUrl.hostname.replace(/^www\./, '')) {
    return [finding('canonical', 'Canonical', canon, 'critical', 'Canonical points to another domain. This page tells Google it is a copy of that site. Common leftover after a migration.')];
  }
  if (canonUrl.pathname === '/' && pageUrl.pathname !== '/' && ctx.pageType !== 'homepage') {
    return [finding('canonical', 'Canonical', canon, 'critical', 'Canonical points to the homepage. Google may drop this page as a duplicate of the homepage.')];
  }
  const out = [];
  if (canonUrl.protocol === 'http:' && pageUrl.protocol === 'https:') {
    out.push(finding('canonical-http', 'Canonical protocol', canon, 'warning', 'Canonical uses http on an https page. Usually an old URL left in the database.'));
  }
  if (stripUrl(canon) === here) {
    out.unshift(finding('canonical', 'Canonical', canon, 'good', 'One canonical, pointing to this page.'));
  } else {
    out.unshift(finding('canonical', 'Canonical', canon, 'warning', 'Canonical points to a different URL. Fine for variants and filters; a problem if this is the main page.'));
  }
  return out;
}

function viewportFindings(d) {
  const v = d.viewport[0] || '';
  if (!v) return [finding('viewport', 'Viewport', 'MISSING', 'critical', 'No viewport tag. Mobile shows a zoomed-out desktop page, and Google indexes the mobile version.')];
  if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/i.test(v)) {
    return [finding('viewport', 'Viewport', v, 'info', 'Zoom is disabled. An accessibility issue, not an SEO one.')];
  }
  return [finding('viewport', 'Viewport', v, 'good', 'Page fits mobile screens.')];
}

// ---------------- Step 3: snippet ----------------

function titleFindings(d) {
  const len = d.title.length;
  if (d.titleCount === 0 || len === 0) return [finding('title', 'Title', 'MISSING', 'critical', 'No title. Google will write one for you.')];
  const out = [];
  if (len < 30) out.push(finding('title', 'Title', `${d.title} (${len} chars)`, 'warning', 'Short title. Room for the main keyword and a reason to click.'));
  else if (len > 60) out.push(finding('title', 'Title', `${d.title} (${len} chars)`, 'warning', 'Over 60 characters. Likely cut or rewritten in Google. Aim for 51-60.'));
  else out.push(finding('title', 'Title', `${d.title} (${len} chars)`, 'good', 'Length is in the 30-60 range.'));
  if (d.titleCount > 1) out.push(finding('title-count', 'Title tags', `${d.titleCount} tags`, 'warning', 'More than one <title>. Google uses the first one.'));
  return out;
}

function descriptionFindings(d, ctx) {
  const descs = d.descriptions;
  if (descs.length === 0 || !descs[0].trim()) {
    const flag = REVENUE_TYPES.has(ctx.pageType) ? 'warning' : 'info';
    return [finding('description', 'Meta description', 'MISSING', flag, 'No description. Google writes its own snippet, and social shares lose their text. Not a ranking factor, but it drives clicks.')];
  }
  const text = descs[0];
  const len = text.length;
  const out = [];
  if (len > 160) out.push(finding('description', 'Meta description', `${text} (${len} chars)`, 'warning', 'Over 160 characters. The end will be cut in Google.'));
  else if (len < 70) out.push(finding('description', 'Meta description', `${text} (${len} chars)`, 'info', 'Short. 120-160 characters gives room for proof and a call to action.'));
  else out.push(finding('description', 'Meta description', `${text} (${len} chars)`, 'good', 'Present and a good length.'));
  if (/\s[,.]/.test(text) || /\s{2,}/.test(text)) {
    out.push(finding('description-typo', 'Description spacing', text, 'info', 'A space before a comma or full stop, or a double space. Small, but it shows in Google.'));
  }
  if (descs.length > 1) out.push(finding('description-count', 'Description tags', `${descs.length} tags`, 'warning', 'More than one meta description. Two plugins may be adding it.'));
  return out;
}

// ---------------- Step 3: social ----------------

function ogFindings(d, ctx) {
  const og = d.og;
  const out = [];
  if (og.length === 0) {
    out.push(finding('og', 'Open Graph', '0 tags', 'warning', ctx.model === 'b2b' ? 'No preview control on LinkedIn or WhatsApp shares.' : 'Shared links show no controlled image or text. WhatsApp sharing is a real channel for D2C.'));
    return out;
  }
  const props = og.map((t) => t.property);
  const get = (p) => (og.find((t) => t.property === p) || {}).content || '';
  const missing = ['og:title', 'og:description', 'og:image'].filter((p) => !props.includes(p));
  out.push(finding('og', 'Open Graph', plural(og.length, 'tag'), missing.length ? 'warning' : 'good', missing.length ? `Missing ${missing.join(', ')}. The share preview will be incomplete.` : 'Title, description and image are set.'));

  const dup = props.filter((p, i) => props.indexOf(p) !== i && !p.startsWith('og:image'));
  if (dup.length) out.push(finding('og-dup', 'OG duplicates', [...new Set(dup)].join(', '), 'warning', 'The same OG tag appears twice. Two plugins are adding tags; platforms may pick the wrong one.'));

  const img = get('og:image');
  const alt = get('og:image:alt');
  if (img && /test|placeholder|sample|dummy|lorem/i.test(img + ' ' + alt)) {
    const pre = isPrelaunch(ctx);
    out.push(finding('og-image', 'OG image', img, 'warning', 'Share image looks like a test or placeholder file. This is what WhatsApp and Facebook will show.', pre ? 'Launch blocker' : 'Check'));
  } else if (img) {
    out.push(finding('og-image', 'OG image', img, 'good', 'Open this URL to confirm it loads. 1200 x 630 works best.'));
  }
  if (d.twitterCount) out.push(finding('twitter', 'Twitter / X card', plural(d.twitterCount, 'tag'), 'good', 'X has its own card tags.'));
  return out;
}

// ---------------- Step 3: schema ----------------

function schemaFindings(d, ctx) {
  const s = d.jsonld;
  const out = [];
  if (s.scriptCount === 0) {
    out.push(finding('schema', 'Structured data', '0 JSON-LD blocks', 'warning', 'No schema. Google cannot show rich results like price or stars.'));
    return out;
  }
  out.push(finding('schema', 'Structured data', s.types.join(', ') || '(no @type)', 'good', `${plural(s.scriptCount, 'JSON-LD block')} found.`));
  if (s.parseErrors) out.push(finding('schema-parse', 'Schema errors', `${s.parseErrors} block(s) failed to parse`, 'critical', 'Broken JSON. Google ignores the whole block.'));

  if (ctx.pageType === 'product' && !s.types.includes('Product')) {
    out.push(finding('schema-product', 'Product schema', 'MISSING', 'warning', 'Product page without Product schema. No price or stock in search results.'));
  }

  s.products.slice(0, 1).forEach((p) => {
    if (/\s[|–—-]\s/.test(p.name) && p.name === d.title) {
      out.push(finding('schema-name', 'Product name', p.name, 'warning', 'Schema name copies the SEO title. Google Shopping should get the plain product name.'));
    } else {
      out.push(finding('schema-name', 'Product name', p.name, p.name ? 'good' : 'warning', p.name ? 'Clean product name.' : 'Product has no name.'));
    }
    out.push(finding('schema-brand', 'Product brand', p.brand, p.brand ? 'good' : 'warning', p.brand ? 'Brand is set.' : 'No brand. Google uses it in product listings.'));
    if (!p.hasOffers) {
      out.push(finding('schema-offer', 'Price / offer', 'MISSING', 'warning', 'No offer. Price and stock will not show in results.'));
    } else {
      const price = p.highPrice ? `${p.price} - ${p.highPrice}` : p.price;
      out.push(finding('schema-offer', 'Price / offer', `${price} ${p.currency} · ${p.availability.replace(/^https?:\/\/schema\.org\//, '')}`, 'good', 'Price, currency and stock are set. Make sure they match the page.'));
    }
    if (p.descriptionSample && /&amp;|&#\d+;|&[a-z]+;/i.test(p.descriptionSample)) {
      out.push(finding('schema-entity', 'Schema description', p.descriptionSample, 'info', 'HTML code like &amp; inside schema text. Write "and" instead of "&".'));
    }
    out.push(finding('schema-rating', 'Rating', p.hasRating ? 'present' : 'none', p.hasRating ? 'good' : 'info', p.hasRating ? 'Rating is set. It must match reviews visible on the page.' : 'No stars yet. Stars come from real reviews; never add a rating without them.'));
  });
  return out;
}

// ---------------- Step 3: language ----------------

function langFindings(d) {
  const out = [];
  out.push(d.lang
    ? finding('lang', 'html lang', d.lang, 'good', 'Language is declared.')
    : finding('lang', 'html lang', 'MISSING', 'warning', 'No lang attribute. Minor, but it helps search engines and screen readers.'));
  if (d.hreflang.length === 0) {
    out.push(finding('hreflang', 'hreflang', '0 tags', 'info', 'Only needed for sites with several languages or countries.'));
  } else {
    const here = stripUrl(d.url);
    const selfRef = d.hreflang.some((h) => stripUrl(h.href) === here);
    const list = d.hreflang.slice(0, 6).map((h) => h.lang).join(', ') + (d.hreflang.length > 6 ? ` +${d.hreflang.length - 6}` : '');
    out.push(finding('hreflang', 'hreflang', `${plural(d.hreflang.length, 'tag')}: ${list}`, selfRef ? 'good' : 'warning', selfRef ? 'This page lists itself, as it should.' : 'This page is missing from its own hreflang list.'));
  }
  return out;
}

// ---------------- public ----------------

export function evaluateHead(d, ctx) {
  const groups = [
    { id: 'indexing', title: 'Indexing (Step 1)', findings: [...robotsFindings(d, ctx), ...canonicalFindings(d, ctx), ...viewportFindings(d)] },
    { id: 'snippet', title: 'Search snippet', findings: [...titleFindings(d), ...descriptionFindings(d, ctx)] },
    { id: 'social', title: 'Social preview', findings: ogFindings(d, ctx) },
    { id: 'schema', title: 'Structured data', findings: schemaFindings(d, ctx) },
    { id: 'language', title: 'Language', findings: langFindings(d) },
  ];
  const counts = { critical: 0, warning: 0, good: 0, info: 0 };
  groups.forEach((g) => g.findings.forEach((f) => { counts[f.flag] += 1; }));
  return { groups, counts };
}
