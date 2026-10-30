// Phase 1 rules for the page body (Steps 2 and 4) and leftover placeholders.
// Runs in the side panel. Pure functions, no DOM. Same finding shape as head rules,
// plus optional `items` (a short list the UI shows under "Show details").

import { REVENUE_TYPES, finding, plural, isPrelaunch } from './phase1-rules.js';
import { conform, contextOf } from './conform.js';
import { SCHEMAS } from './schemas.js';

const isRevenue = (ctx) => REVENUE_TYPES.has(ctx && ctx.pageType);
const short = (s, n = 70) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

// Alt text that says nothing about the image
const GENERIC_ALT = /^(image|img|photo|picture|pic|graphic|banner|brand|home|logo|icon|location image|untitled|placeholder|default|thumbnail|\d+|.*\.(jpe?g|png|webp|gif|svg|avif))$/i;
// WooCommerce gallery fallback: "<Product name> - Image 2"
const AUTO_ALT = /\s[-–]\s(image|photo)\s\d+$/i;

// "Show on page" targets: how the side panel finds the elements behind a finding.
// kinds: img (file name), href (exact href), linktext (anchor without href, by text),
//        link (href + text), text (visible text), heading (level, optional empty)
function target(out, id, targets) {
  const f = out.find((x) => x.id === id);
  const list = targets.filter(Boolean).slice(0, 40);
  if (f && list.length) f.targets = list;
}
const imgT = (imgs) => imgs.filter((i) => i.file).map((i) => ({ kind: 'img', value: i.file }));
const hrefT = (links) => links.filter((l) => l.hasHref).map((l) => ({ kind: 'href', value: l.href }));

// ---------------- Step 1A extra: X-Robots-Tag HTTP header ----------------
// Read from the same-origin fetch of the page. A noindex here blocks the page
// even when the HTML robots tag says index.

function xRobotsFindings(r, ctx) {
  if (!r.bytes) return [];
  const v = r.xRobots || '';
  if (!v) return [finding('x-robots', 'X-Robots-Tag header', 'None', 'good', 'No HTTP header is blocking indexing.')];
  if (!/\bnoindex\b|\bnone\b/i.test(v)) return [finding('x-robots', 'X-Robots-Tag header', v, 'info', 'Header present without noindex. Check it matches the robots meta tag.')];
  if (isPrelaunch(ctx)) return [finding('x-robots', 'X-Robots-Tag header', v, 'warning', 'The server sends noindex in the HTTP header. Remove it at launch as well as the meta tag (server or plugin setting).', 'Launch blocker')];
  return [finding('x-robots', 'X-Robots-Tag header', v, isRevenue(ctx) ? 'critical' : 'warning',
    'The server tells Google not to index this page in the HTTP header. The HTML looks fine, so this is easy to miss. Check server config, CDN or security plugin.')];
}

// ---------------- Step 3D: schema vs what the page shows ----------------

const MAIN_TYPES = /^(Product|Organization|WebSite|LocalBusiness|Article|BlogPosting|NewsArticle|FAQPage|BreadcrumbList|Recipe|Event|Course|SoftwareApplication|Service|VideoObject|Review|AggregateRating|Place)$/;

function schemaPageFindings(d, ctx, head) {
  const out = [];
  if (!head || !head.jsonld) return out;
  const pre = isPrelaunch(ctx);
  const p = head.jsonld.products[0];

  if (p && p.hasOffers && Array.isArray(d.visiblePrices)) {
    const schemaPrices = [p.price, p.highPrice].filter(Boolean).map((x) => String(Number(String(x).replace(/,/g, '')))).filter((x) => x !== 'NaN');
    if (schemaPrices.length === 2 && d.visiblePrices.length) {
      // AggregateOffer (variants): the page usually shows one variant's price at a time
      const [low, high] = schemaPrices.map(Number);
      const inRange = d.visiblePrices.map(Number).filter((v) => v >= low && v <= high);
      out.push(inRange.length
        ? finding('schema-price-match', 'Schema price vs page', `Schema range ${low} - ${high} · page shows ${inRange.slice(0, 4).join(', ')}`, 'good',
          'Visible price sits inside the schema price range. Check each variant shows its own price when selected.')
        : finding('schema-price-match', 'Schema price vs page', `Schema range ${low} - ${high} · page shows ${d.visiblePrices.slice(0, 6).join(', ')}`, pre ? 'warning' : 'critical',
          'No visible price falls inside the schema price range. Markup that differs from the page breaks Google rules and Merchant listings.', pre ? 'Launch blocker' : undefined));
    } else if (schemaPrices.length && d.visiblePrices.length) {
      const missing = schemaPrices.filter((x) => !d.visiblePrices.includes(x));
      out.push(missing.length
        ? finding('schema-price-match', 'Schema price vs page', `Schema ${schemaPrices.join(' - ')} · page shows ${d.visiblePrices.slice(0, 6).join(', ')}`, pre ? 'warning' : 'critical',
          'Schema price is not shown on the page. Google treats markup that differs from visible content as spam (manual action risk) and Merchant listings get disapproved.', pre ? 'Launch blocker' : undefined)
        : finding('schema-price-match', 'Schema price vs page', `${schemaPrices.join(' - ')} shown on page`, 'good', 'Schema price matches what visitors see.'));
    } else if (schemaPrices.length) {
      out.push(finding('schema-price-match', 'Schema price vs page', `Schema ${schemaPrices.join(' - ')} · no price in page content`, 'warning',
        'The schema has a price but none shows in the page content (header bars, mini-cart and footer are skipped). Google requires markup to match visible content. Check by hand; the Rendering tab shows whether AI readers can see it.', 'Check by hand'));
    }
  }

  if (p && p.hasRating) {
    const rs = d.reviewSignals || {};
    const visible = rs.ratingText || (rs.reviewCount && rs.reviewCount > 0);
    out.push(visible
      ? finding('schema-rating-visible', 'Schema rating vs page', 'Reviews visible on page', 'good', 'Rating in schema is backed by reviews people can see.')
      : finding('schema-rating-visible', 'Schema rating vs page', rs.reviewCount === 0 ? 'Schema has rating, page shows 0 reviews' : 'Schema has rating, no reviews visible', pre ? 'warning' : 'critical',
        'Stars in schema without visible reviews break Google review-snippet rules. This is the classic fake-rating penalty.', pre ? 'Launch blocker' : undefined));
  }

  const r = d.raw || {};
  if (r.ok && Array.isArray(r.jsonldTypes)) {
    const jsOnly = head.jsonld.types.filter((t) => MAIN_TYPES.test(t) && !r.jsonldTypes.includes(t));
    if (jsOnly.length) {
      const key = jsOnly.includes('Product') && ctx.pageType === 'product';
      out.push(finding('schema-js', 'Schema added by JavaScript', jsOnly.join(', '), key ? 'warning' : 'info',
        'This schema is not in the server HTML; a script adds it later. Google usually reads it after rendering, but late and less reliably. Prefer server-side output (SEO plugin, not a tag manager).'));
    } else if (head.jsonld.scriptCount) {
      out.push(finding('schema-js', 'Schema in server HTML', `${r.jsonldCount} block${r.jsonldCount === 1 ? '' : 's'}`, 'good', 'All main schema types are in the HTML the server sends.'));
    }
  }
  return out;
}

// ---------------- Step 2: raw HTML vs rendered page ----------------

function renderingFindings(d, ctx) {
  const out = [];
  const r = d.raw || {};

  if (!r.ok) {
    out.push(finding('raw', 'Raw HTML check', r.reason || 'Not run', 'warning',
      'Could not compare raw HTML with the rendered page. Check by hand: Ctrl+U, then Ctrl+F for the H1 and price.', 'Check by hand'));
    return out;
  }

  const missing = r.tests.filter((t) => !t.inRaw);
  const tested = r.tests.map((t) => `${t.inRaw ? 'In raw' : 'MISSING'} · ${t.kind}: ${short(t.text, 60)}`);
  if (!r.tests.length) {
    out.push(finding('raw-tests', 'Key content in raw HTML', 'No samples found', 'info', 'No H1, price or long paragraph to test. Check by hand with Ctrl+U.'));
  } else if (!missing.length) {
    out.push(finding('raw-tests', 'Key content in raw HTML', `${r.tests.length}/${r.tests.length} samples found`, 'good',
      'H1, price and main text are in the HTML the server sends. Google sees them without running JavaScript.', null, tested));
  } else {
    const core = missing.some((t) => t.kind === 'H1' || t.kind === 'Price');
    const flag = core && isRevenue(ctx) ? 'critical' : 'warning';
    out.push(finding('raw-tests', 'Key content in raw HTML', `${missing.length} of ${r.tests.length} samples missing`, flag,
      'This content appears only after JavaScript runs. Google may index it late or not at all. Move it into server-rendered HTML.', null, tested));
  }

  if (r.h1Count === 0 && d.headings.some((h) => h.level === 1)) {
    out.push(finding('raw-h1', 'H1 in raw HTML', '0 in raw, present after render', 'warning', 'The H1 is added by JavaScript. Render it on the server.'));
  }

  const rendered = d.linkHrefTotal ?? d.linkTotal ?? 0; // compare like with like: <a href> in both
  if (rendered >= 20 && r.linkCount < rendered * 0.5) {
    out.push(finding('raw-links', 'Links in raw HTML', `${r.linkCount} raw vs ${rendered} rendered`, 'warning',
      'Most links are added by JavaScript. Google discovers pages slower through them. Use real <a href> in the HTML.'));
  } else {
    out.push(finding('raw-links', 'Links in raw HTML', `${r.linkCount} raw vs ${rendered} rendered`, 'good', 'Links exist in the server HTML, so crawlers can follow them.'));
  }

  out.push(...xRobotsFindings(r, ctx));
  out.push(finding('raw-size', 'Page weight', `${Math.round(r.bytes / 1024)} KB HTML · ${r.words} words raw · ${d.renderedWords} words visible`, 'info',
    r.bytes > 1500 * 1024
      ? 'Large HTML. Often inline JSON from the framework; it slows the first byte-to-paint on mobile.'
      : 'For reference. Raw words higher than visible words is normal (menus, hidden tabs).'));
  return out;
}

// ---------------- Step 4A: headings ----------------

function headingFindings(d, ctx) {
  const out = [];
  const h = d.headings || [];
  const h1s = h.filter((x) => x.level === 1 && x.visible);
  const indent = (level) => '  '.repeat(Math.min(5, Math.max(0, (Number.isFinite(level) ? Math.round(level) : 1) - 1)));
  const outline = h.map((x) => `${indent(x.level)}H${x.level}${x.visible ? '' : ' (hidden)'}: ${x.text || '(empty)'}`);

  if (h1s.length === 0) {
    out.push(finding('h1', 'H1', '0 visible', isRevenue(ctx) ? 'critical' : 'warning', 'No visible H1. Add one heading that names what this page sells or answers.'));
  } else if (h1s.length > 1) {
    out.push(finding('h1', 'H1', `${h1s.length}: ${h1s.map((x) => x.text).join(' | ')}`, 'warning', 'More than one H1. Usually the logo or a section title is wrapped in H1. Keep one.'));
  } else {
    out.push(finding('h1', 'H1', h1s[0].text, 'good', 'One clear H1.'));
  }

  const empty = h.filter((x) => !x.text);
  if (empty.length) {
    out.push(finding('h-empty', 'Empty headings', plural(empty.length, 'heading'), 'warning', 'Headings with no text. Often icon wrappers. Change them to <div> or <p>.'));
  }

  const skips = [];
  for (let i = 1; i < h.length; i += 1) {
    if (h[i].level > h[i - 1].level + 1) skips.push(`H${h[i - 1].level} → H${h[i].level}: ${short(h[i].text, 50)}`);
  }
  if (skips.length) {
    out.push(finding('h-skip', 'Heading levels', plural(skips.length, 'skipped level'), 'info', 'Levels jump (e.g. H2 to H4). Minor for SEO, matters for screen readers.', null, skips));
  }

  const total = d.headingTotal || h.length;
  const hidden = h.filter((x) => !x.visible).length;
  out.push(finding('h-outline', 'Heading outline', `${total} headings${hidden ? ` · ${hidden} hidden (tabs, menus, sliders)` : ''}`,
    total > 60 ? 'info' : 'good',
    total > 60 ? 'Many headings. Check if headings are used just for styling (cards, footer). Real sections only.' : 'Read the outline below: it should tell the page story in order.',
    null, outline));
  target(out, 'h1', [{ kind: 'heading', level: 1 }]);
  target(out, 'h-empty', [{ kind: 'heading', level: 0, empty: true }]);
  return out;
}

// ---------------- Step 4B: images ----------------

function imageFindings(d, ctx) {
  const out = [];
  const all = d.images || [];
  const trackers = all.filter((i) => i.tracker);
  const content = all.filter((i) => !i.tracker);
  const decorative = content.filter((i) => i.decorativeHint);
  const real = content.filter((i) => !i.decorativeHint);

  if (trackers.length) {
    out.push(finding('img-trackers', 'Tracking pixels', plural(trackers.length, 'pixel'), 'info',
      'Ignored. Crawlers flag these for missing alt, but they are not content.', 'Ignored', trackers.map((i) => short(i.src, 80))));
  }

  const noAlt = real.filter((i) => !i.hasAltAttr);
  const emptyAlt = real.filter((i) => i.hasAltAttr && !i.alt && i.visible && i.shownWidth >= 100);
  if (noAlt.length) {
    out.push(finding('img-noalt', 'Missing alt', plural(noAlt.length, 'image'), isRevenue(ctx) ? 'warning' : 'info',
      'No alt attribute. Google Images and screen readers get nothing. Describe the image in a few words.', null, noAlt.map((i) => i.file || short(i.src, 60))));
  }
  if (emptyAlt.length) {
    out.push(finding('img-emptyalt', 'Empty alt on content image', plural(emptyAlt.length, 'image'), 'warning',
      'alt="" tells Google the image is decoration. Fine for icons, wrong for product or hero images.', null, emptyAlt.map((i) => i.file)));
  }

  const generic = real.filter((i) => i.alt && GENERIC_ALT.test(i.alt.trim()));
  if (generic.length) {
    out.push(finding('img-genericalt', 'Generic alt text', plural(generic.length, 'image'), 'warning',
      'Alt like "image", "brand" or "home" describes nothing. Say what is in the picture.', null, generic.map((i) => `${i.file || '(no src)'} → "${i.alt}"`)));
  }

  const auto = real.filter((i) => AUTO_ALT.test(i.alt || ''));
  if (auto.length) {
    out.push(finding('img-autoalt', 'Auto-generated alt', plural(auto.length, 'image'), 'info',
      'Theme fallback alt ("… - Image 2"). Set a real alt in the media library, e.g. "500g jar of ghee on wooden table".', null, auto.map((i) => `${i.file} → "${i.alt}"`)));
  }

  const altCount = new Map();
  real.forEach((i) => { if (i.alt) altCount.set(i.alt, (altCount.get(i.alt) || 0) + 1); });
  const dupes = [...altCount].filter(([alt, n]) => n >= 3 && !GENERIC_ALT.test(alt));
  const genericDupes = [...altCount].filter(([alt, n]) => n >= 3 && GENERIC_ALT.test(alt));
  if (dupes.length || genericDupes.length) {
    out.push(finding('img-dupealt', 'Repeated alt text', [...dupes, ...genericDupes].map(([a, n]) => `"${short(a, 30)}" ×${n}`).join(', '), 'info',
      'Same alt on many images. Make each one specific (e.g. include the area or room name).'));
  }

  if (!noAlt.length && !emptyAlt.length && !generic.length && real.length) {
    out.push(finding('img-alt', 'Alt text', `${real.length} content images`, 'good', 'Every content image has a descriptive alt.'));
  }

  // Likely LCP image: biggest visible image above the fold
  const hero = real.filter((i) => i.visible && i.aboveFold).sort((a, b) => b.shownWidth - a.shownWidth)[0];
  if (hero) {
    if (hero.lazy) {
      out.push(finding('img-hero', 'Hero image loading', `${hero.file} is lazy-loaded`, 'warning',
        'The main image above the fold has loading="lazy". It delays LCP. Remove lazy on this one image.'));
    } else if (hero.fetchpriority === 'high') {
      out.push(finding('img-hero', 'Hero image loading', `${hero.file} · fetchpriority=high`, 'good', 'Main image loads first. Good for LCP.'));
    } else {
      out.push(finding('img-hero', 'Hero image loading', hero.file, 'info', 'Consider fetchpriority="high" on the main image above the fold to speed up LCP.'));
    }
  }

  const noDims = real.filter((i) => i.visible && i.aboveFold && !i.hasWidthHeight);
  if (noDims.length) {
    out.push(finding('img-dims', 'Image width/height', plural(noDims.length, 'image above the fold'), 'info',
      'No width and height attributes. The layout can jump while it loads (CLS).', null, noDims.map((i) => i.file)));
  }

  const oversized = real.filter((i) => i.visible && i.shownWidth > 0 && i.naturalWidth > i.shownWidth * 3 && i.naturalWidth > 1200);
  if (oversized.length) {
    out.push(finding('img-oversized', 'Oversized images', plural(oversized.length, 'image'), 'info',
      'File is over 3× wider than shown. Serve a smaller size (srcset) to save mobile data.', null, oversized.map((i) => `${i.file}: ${i.naturalWidth}px file, ${i.shownWidth}px shown`)));
  }

  if (decorative.length) {
    out.push(finding('img-decorative', 'Icons and UI images', plural(decorative.length, 'image'), 'info', 'Ignored for alt checks (icons, logos, cookie widget).', 'Ignored'));
  }
  target(out, 'img-noalt', imgT(noAlt));
  target(out, 'img-emptyalt', imgT(emptyAlt));
  target(out, 'img-genericalt', imgT(generic));
  target(out, 'img-autoalt', imgT(auto));
  target(out, 'img-hero', hero ? imgT([hero]) : []);
  target(out, 'img-dims', imgT(noDims));
  target(out, 'img-oversized', imgT(oversized));
  return out;
}

// ---------------- Step 4C: links ----------------

function linkFindings(d) {
  const out = [];
  const links = d.links || [];
  const ui = links.filter((l) => l.uiControl);
  const real = links.filter((l) => !l.uiControl);
  const internal = links.filter((l) => l.internal).length;
  const external = links.filter((l) => l.external).length;

  out.push(finding('links-count', 'Links', `${d.linkTotal} total · ${internal} internal · ${external} external`, 'info',
    'Internal links pass authority to your other pages. Revenue pages should link to related products or services.'));

  const noHref = real.filter((l) => !l.hasHref);
  if (noHref.length) {
    out.push(finding('links-nohref', 'Links without href', plural(noHref.length, 'link'), 'warning',
      'Google only follows <a href="…">. These are clickable for users but invisible to crawlers.', null, noHref.map((l) => short(l.text || l.label || '(no text)', 60))));
  }

  const hashOnly = real.filter((l) => l.hasHref && /^#?$|^javascript:/i.test(l.href.trim()));
  if (hashOnly.length) {
    out.push(finding('links-hash', 'Links to "#" or javascript:', plural(hashOnly.length, 'link'), 'warning',
      'These lead nowhere for a crawler. Use a real URL, or a <button> if it only opens something.', null, hashOnly.map((l) => short(l.text || l.label || '(no text)', 60))));
  }

  const empty = real.filter((l) => l.hasHref && !l.text && !l.label && !l.imgAlt);
  if (empty.length) {
    out.push(finding('links-empty', 'Links with no text', plural(empty.length, 'link'), 'warning',
      'No text, aria-label or image alt. Google gets no clue what the target page is about.', null, empty.map((l) => short(l.href, 70))));
  }

  const generic = real.filter((l) => l.generic);
  const genericVisible = generic.filter((l) => l.visible);
  if (generic.length) {
    out.push(finding('links-generic', 'Generic anchor text', `${plural(generic.length, 'link')}${genericVisible.length !== generic.length ? ` (${genericVisible.length} visible)` : ''}`,
      genericVisible.length ? 'warning' : 'info',
      'Anchors like "here" or "learn more" waste the strongest internal-link signal. Use the target topic: "office space in Mumbai".',
      null, generic.map((l) => `"${l.text}" → ${short(l.href, 60)}${l.visible ? '' : ' (hidden)'}`)));
  }

  if (!noHref.length && !hashOnly.length && !empty.length && !genericVisible.length) {
    out.push(finding('links-ok', 'Link quality', 'No crawl blockers found', 'good', 'Links use real href and descriptive text.'));
  }

  if (ui.length) {
    out.push(finding('links-ui', 'UI controls', plural(ui.length, 'control'), 'info',
      'Ignored: accordions, tabs, cart and cookie toggles. They are not navigation, so missing href is fine.', 'Ignored',
      ui.map((l) => short(l.text || l.label || l.cls || '(no text)', 60))));
  }

  // Contact numbers: real number in one place, placeholder in another
  const numbers = new Map();
  links.forEach((l) => {
    const m = l.href.match(/^(?:https?:\/\/)?(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|tel:)\+?([\dX ]{6,})/i);
    if (m) {
      const n = m[1].replace(/\s/g, '');
      numbers.set(n, (numbers.get(n) || 0) + 1);
    }
  });
  const blankContact = links.filter((l) => /^(tel:|mailto:|https?:\/\/wa\.me\/?)\s*(\?.*)?$/i.test(l.href.trim()));
  if (blankContact.length) {
    const anyVisible = blankContact.some((l) => l.visible);
    out.push(finding('links-blankcontact', 'Empty contact link', plural(blankContact.length, 'link'), anyVisible ? 'warning' : 'info',
      `A call / email / WhatsApp button has no number or address${anyVisible ? '' : ' (hidden right now, may show on mobile or another state)'}. Clicking it does nothing.`,
      null, blankContact.map((l) => `"${short(l.text || l.label || '(no text)', 40)}" → ${l.href || '(blank)'}`)));
  }

  // Broken call / WhatsApp links: two numbers in one link (a comma in tel: means
  // "dial the first, then send the second as tones"), or a wa.me number without
  // the country code (WhatsApp needs the full international number).
  const badContact = [];
  links.forEach((l) => {
    const href = String(l.href || '').trim();
    const tel = href.match(/^tel:(.*)$/i);
    const wa = href.match(/^(?:https?:\/\/)?(?:wa\.me\/([^?#]*)|api\.whatsapp\.com\/send\/?\?(?:[^#]*&)?phone=([^&#]*))/i);
    const num = tel ? tel[1] : wa ? (wa[1] || wa[2] || '') : null;
    if (num === null || /x/i.test(num)) return; // not a contact link, or a placeholder (checked elsewhere)
    let plain = num;
    try { plain = decodeURIComponent(num); } catch { /* malformed %-escape: read as written */ }
    const groups = plain.split(/[,;/]|\s{2,}/).map((g) => g.replace(/\D/g, '')).filter((g) => g.length >= 6);
    if (groups.length > 1) badContact.push({ l, why: `Two numbers in one link: ${href}` });
    else if (wa && groups.length === 1 && groups[0].length <= 10) badContact.push({ l, why: `No country code, WhatsApp cannot open it: ${href}` });
  });
  if (badContact.length) {
    const anyVisible = badContact.some((b) => b.l.visible);
    out.push(finding('links-badcontact', 'Broken call / WhatsApp link', plural(badContact.length, 'link'), anyVisible ? 'warning' : 'info',
      'These links do not reach the number. Use one number per link, written in full with the country code: tel:+919876543210 and https://wa.me/919876543210 (no +, no spaces).',
      null, badContact.map((b) => b.why)));
  }
  target(out, 'links-badcontact', hrefT(badContact.map((b) => b.l)));

  if (numbers.size > 1) {
    out.push(finding('links-phones', 'Contact numbers', [...numbers].map(([n, c]) => `${n} ×${c}`).join(', '), 'warning',
      'WhatsApp / phone links use different numbers. Customers may message the wrong one. Use one number everywhere.'));
  }
  target(out, 'links-nohref', noHref.map((l) => l.text && { kind: 'linktext', value: l.text }));
  target(out, 'links-hash', hashOnly.map((l) => ({ kind: 'link', href: l.href, text: l.text })));
  target(out, 'links-empty', hrefT(empty));
  target(out, 'links-generic', generic.map((l) => ({ kind: 'link', href: l.href, text: l.text })));
  target(out, 'links-blankcontact', hrefT(blankContact));
  target(out, 'links-phones', hrefT(links.filter((l) => /^(?:https?:\/\/)?(?:wa\.me\/|api\.whatsapp\.com|tel:)/i.test(l.href))));
  return out;
}

// ---------------- Placeholders and test content ----------------

function placeholderFindings(d, ctx) {
  const p = d.placeholders || [];
  if (!p.length) {
    return [finding('ph-none', 'Placeholders', 'None found', 'good', 'No [____], lorem ipsum, XXXXXXXXXX numbers, [URL] links or test images.')];
  }
  const pre = isPrelaunch(ctx);
  const flag = pre ? 'warning' : 'critical';
  const label = pre ? 'Launch blocker' : undefined;
  const out = [];

  const text = p.filter((x) => x.where === 'text');
  const phoneLinks = p.filter((x) => x.where === 'link' && /X{6,}/.test(x.match));
  const otherLinks = p.filter((x) => x.where === 'link' && !/X{6,}/.test(x.match));
  const images = p.filter((x) => x.where === 'image');

  if (text.length) {
    out.push(finding('ph-text', 'Placeholder text', plural(text.length, 'spot'), flag,
      pre ? 'Fill these before launch. Blank values like [__]% look broken and kill trust on a product page.'
        : 'Live visitors and Google see unfinished text. Fill it now.', label,
      text.map((x) => `${x.match}  ←  "${short(x.context, 90)}"`)));
  }
  if (phoneLinks.length) {
    out.push(finding('ph-phone', 'Placeholder phone number', plural(phoneLinks.length, 'link'), pre ? 'warning' : 'critical',
      'Buttons point to a dummy number (XXXXXXXXXX). Every click is a lost order. Put the real number in.', label,
      phoneLinks.map((x) => `${short(x.context || '(no text)', 30)} → ${short(x.match, 50)}`)));
  }
  if (otherLinks.length) {
    out.push(finding('ph-link', 'Placeholder link', plural(otherLinks.length, 'link'), flag,
      'Link points to a template value, not a real page. Users get an error.', label,
      otherLinks.map((x) => `${short(x.context || '(no text)', 40)} → ${short(x.match, 60)}`)));
  }
  if (images.length) {
    out.push(finding('ph-image', 'Test images', plural(images.length, 'image'), flag,
      'Test or dummy images on the page. Replace with real photos (and real alt text).', label,
      images.map((x) => `${x.match}${x.context ? ` (alt: ${short(x.context, 40)})` : ''}`)));
  }
  target(out, 'ph-text', [...new Set(text.map((x) => x.match))].map((m) => ({ kind: 'text', value: m })));
  target(out, 'ph-phone', [...new Set(phoneLinks.map((x) => x.match))].map((m) => ({ kind: 'href', value: m })));
  target(out, 'ph-link', [...new Set(otherLinks.map((x) => x.match))].map((m) => ({ kind: 'href', value: m })));
  target(out, 'ph-image', images.map((x) => ({ kind: 'img', value: x.match })));
  return out;
}

// ---------------- public ----------------

export function evaluateBody(data, context, headData) {
  const d = conform(data, SCHEMAS.body);
  const ctx = contextOf(context);
  const head = headData === null || headData === undefined ? headData : conform(headData, SCHEMAS.head);
  const groups = [
    { id: 'placeholders', title: 'Unfinished content', findings: placeholderFindings(d, ctx) },
    { id: 'schema-page', title: 'Schema vs page (Step 3D)', findings: schemaPageFindings(d, ctx, head) },
    { id: 'rendering', title: 'Raw HTML vs rendered (Step 2)', findings: renderingFindings(d, ctx) },
    { id: 'headings', title: 'Headings (Step 4A)', findings: headingFindings(d, ctx) },
    { id: 'images', title: 'Images (Step 4B)', findings: imageFindings(d, ctx) },
    { id: 'links', title: 'Links (Step 4C)', findings: linkFindings(d) },
  ].filter((g) => g.findings.length);
  const counts = { critical: 0, warning: 0, good: 0, info: 0 };
  groups.forEach((g) => g.findings.forEach((f) => { counts[f.flag] += 1; }));
  return { groups, counts };
}
