// Phase 3 rules: turns collectRendering() data into findings.
// Runs in the side panel. Pure functions, no DOM.
//
// Three readers, three verdicts:
//   Google           renders JavaScript, reads JSON-LD
//   AI crawlers      GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot: do not run
//                    JavaScript (Vercel, "The rise of the AI crawler", Dec 2024)
//   AI live fetchers ChatGPT-User, Claude-User, Gemini when a user pastes a link:
//                    reported not to run JavaScript or read JSON-LD (Resoneo, Jan 2026)

import { finding, plural, isPrelaunch, REVENUE_TYPES } from './phase1-rules.js';

const LISTING_TYPES = new Set(['category', 'location', 'homepage']);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const money = (v, cur) => `${cur === 'INR' ? '₹' : cur ? `${cur} ` : ''}${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// ---------------- strategy ----------------

export function frameworkOf(s = {}) {
  if (s.nextApp) return 'Next.js (App Router)';
  if (s.nextPages) return 'Next.js (Pages Router)';
  if (s.nextStatic) return 'Next.js';
  if (s.nuxt) return 'Nuxt (Vue)';
  if (s.angular) return 'Angular';
  if (s.gatsby) return 'Gatsby';
  if (s.astro) return 'Astro';
  if (s.vueSsr) return 'Vue (SSR)';
  if (s.shopify) return 'Shopify';
  if (s.wordpress) return s.elementor ? 'WordPress + Elementor' : 'WordPress';
  return '';
}

function strategyFindings(d, ctx, network) {
  const out = [];
  if (!d.raw.ok) {
    out.push(finding('rend-raw', 'Raw HTML', d.raw.reason || 'Not available', 'warning',
      d.raw.challenge
        ? 'Bot protection answered instead of the page, so raw and rendered could not be compared. Compare by hand: Ctrl+U on the page, or Search Console → URL Inspection → View crawled page.'
        : 'Could not read the raw HTML, so raw and rendered could not be compared. Check by hand with Ctrl+U.', 'Check by hand'));
    return out;
  }
  const fw = frameworkOf(d.signals);
  const share = pct(d.words.raw, d.words.rendered);
  const ratio = d.raw.bytes ? (d.renderedBytes / d.raw.bytes).toFixed(1) : '?';
  const value = `${fw ? `${fw} · ` : ''}${d.words.raw.toLocaleString('en-US')} words raw, ${d.words.rendered.toLocaleString('en-US')} rendered (${share}%) · size 1 : ${ratio}`;
  const emptyShell = d.mount && d.mount.rawWords < 20 && d.words.rendered > 150;
  const revenueLive = REVENUE_TYPES.has(ctx.pageType) && !isPrelaunch(ctx);

  if (d.words.rendered < 80) {
    out.push(finding('rend-strategy', 'How the page is built', value, 'info', 'Very little text on the page, so the raw vs rendered share says little. Compare by hand.'));
  } else if (emptyShell || share < 40) {
    out.push(finding('rend-strategy', 'How the page is built', value, revenueLive ? 'critical' : 'warning',
      `Client-side rendering: the server sends ${emptyShell ? `an empty ${d.mount.selector} shell` : 'little of the text'} and JavaScript builds the page. Google renders it after a delay and any script error hides the content; AI crawlers see almost nothing. Fix is architectural: server-side rendering or prerendering.`));
  } else if (share < 80) {
    out.push(finding('rend-strategy', 'How the page is built', value, 'warning',
      'Hybrid: part of the text is added by JavaScript. Fine if it is reviews, related items or widgets; a problem if it is the title, price, description or navigation. See "Only after JavaScript" below, or compare with Ctrl+Shift+P → "Disable JavaScript".', 'Check by hand'));
  } else {
    out.push(finding('rend-strategy', 'How the page is built', value, 'good', 'Server-rendered: the text is in the HTML before any JavaScript runs. Google and AI crawlers get the same content.'));
  }

  // Build type. Caching says how the HTML was served, not how it was built:
  // a fast cached SSR page and a static page look the same from outside.
  const h = (network && network.doc && network.doc.headers) || null;
  if (h) {
    const nextCache = (h['x-nextjs-cache'] || '').toUpperCase();
    const vercel = (h['x-vercel-cache'] || '').toUpperCase();
    const cc = h['cache-control'] || '';
    let build = '';
    let why = '';
    if (h['x-nextjs-prerender'] || vercel === 'PRERENDER') { build = 'Prerendered (static / ISR)'; why = 'The framework says this page was prerendered. Check how often it is rebuilt if prices or stock change.'; }
    else if (nextCache || vercel) { build = `Framework cache ${nextCache || vercel}`; why = 'Served from the framework cache (ISR or a cached render). Check the revalidate time if prices or stock change: the schema shows the old price until the page is rebuilt.'; }
    else if (/no-store|private/i.test(cc)) { build = 'Built on every request'; why = 'Dynamic server rendering: no cache in front of the HTML. Content is always fresh; speed depends on the server (see TTFB on the Network tab).'; }
    else { build = 'Unknown'; why = 'Headers do not say how the page is built. A low TTFB only means the HTML was ready (cached), not that the page is static.'; }
    out.push(finding('rend-build', 'Build / cache', build, 'info', why));
  }
  return out;
}

// ---------------- meta raw vs rendered ----------------

const same = (a, b) => (a || '') === (b || '');

function metaFindings(d, ctx) {
  if (!d.raw.ok) return [];
  const out = [];
  const r = d.meta.raw || {};
  const v = d.meta.rendered || {};
  const noindex = (x) => /\bnoindex\b|\bnone\b/i.test(x || '');
  const changed = [];

  if (noindex(r.robots) && !noindex(v.robots)) {
    out.push(finding('rend-robots', 'Robots tag changed by JavaScript', `raw: ${r.robots} → rendered: ${v.robots || '(none)'}`, isPrelaunch(ctx) ? 'warning' : 'critical',
      'The server HTML says noindex and JavaScript removes it. Google may skip rendering a noindex page, so the fix never runs and the page stays out. Remove noindex in the server HTML.', isPrelaunch(ctx) ? 'Launch blocker' : null));
  } else if (!noindex(r.robots) && noindex(v.robots)) {
    out.push(finding('rend-robots', 'Robots tag changed by JavaScript', `raw: ${r.robots || '(none)'} → rendered: ${v.robots}`, 'warning',
      'JavaScript adds noindex after load. Google may or may not apply it, other crawlers will not. Set robots in the server HTML so every reader gets the same answer.'));
  } else if (!same(r.robots, v.robots)) changed.push('robots');

  if (!r.canonical && v.canonical) {
    out.push(finding('rend-canonical', 'Canonical added by JavaScript', v.canonical, 'warning', 'The canonical only exists after JavaScript. Google may pick it up after rendering; other search engines and AI crawlers will not. Put it in the server HTML.'));
  } else if (r.canonical && v.canonical && !same(r.canonical, v.canonical)) {
    out.push(finding('rend-canonical', 'Canonical changed by JavaScript', `raw: ${r.canonical} → rendered: ${v.canonical}`, 'warning', 'Two different canonicals. Google says not to change the canonical with JavaScript; if you do, make sure both match. Fix the server HTML.'));
  }

  if (!r.title && v.title) out.push(finding('rend-title', 'Title added by JavaScript', v.title, 'warning', 'No <title> in the server HTML. Social previews and AI crawlers get no title. Render it on the server.'));
  else if (r.title && !same(r.title, v.title)) out.push(finding('rend-title', 'Title changed by JavaScript', `raw: ${r.title} → rendered: ${v.title}`, 'info', 'Google uses the rendered title; social previews and AI crawlers see the raw one. Keep them the same.'));

  if (!same(r.description, v.description)) changed.push('description');

  const og = ['ogTitle', 'ogImage', 'ogDescription'].filter((k) => !r[k] && v[k]);
  if (og.length) {
    out.push(finding('rend-og', 'Open Graph only after JavaScript', og.map((k) => k.replace('og', 'og:').toLowerCase()).join(', '), 'warning',
      'WhatsApp, Facebook and LinkedIn read the server HTML only, so share previews come out blank. Output og:title and og:image on the server.'));
  }

  const parts = ['title', 'description', 'canonical', 'robots', 'Open Graph'];
  if (!out.length && !changed.length) {
    out.push(finding('rend-meta', 'Meta tags before and after JavaScript', 'Same', 'good', `${parts.join(', ')} are identical in the server HTML and the rendered page.`));
  } else if (changed.length) {
    out.push(finding('rend-meta', 'Meta tags before and after JavaScript', `${changed.join(', ')} differ`, 'info', 'Small differences between the server HTML and the rendered page. Not a problem unless the meaning changes.'));
  }
  return out;
}

// ---------------- AI visibility ----------------

const NOTABLE = /^(Product|ProductGroup|Offer|AggregateOffer|aggregateRating|Review|BreadcrumbList|FAQPage|Organization|LocalBusiness|Store|Article|BlogPosting|NewsArticle|Event|Recipe|VideoObject|ItemList|Service|HowTo|SoftwareApplication)$/;

export function jsOnlySchema(d) {
  const raw = new Set([...(d.schema.raw || []), ...(d.schema.rawMicrodata || [])]);
  return [...new Set([...(d.schema.rendered || []), ...(d.schema.renderedMicrodata || [])])].filter((t) => NOTABLE.test(t) && !raw.has(t));
}

function aiFindings(d, ctx, network) {
  if (!d.raw.ok) return [];
  const out = [];
  const share = pct(d.words.raw, d.words.rendered);
  const jsSchema = jsOnlySchema(d);

  // 1. Price: the strongest business case
  const f = d.facts;
  if (f && f.prices && f.prices.length) {
    const shown = f.prices.filter((p) => p.visible);
    const inRaw = f.prices.filter((p) => p.inRawText);
    const value = f.prices.map((p) => `${money(p.value, p.currency)} ${p.visible ? 'on page' : 'NOT on page'}${p.inRawText ? '' : ', not in raw text'}`).join(' · ');
    if (!shown.length && !inRaw.length) {
      out.push(finding('rend-ai-price', 'Price in page text', value, isPrelaunch(ctx) ? 'warning' : 'critical',
        'The price is only in the schema (JSON-LD). Google can read it, but shoppers cannot see it, and AI live fetchers (ChatGPT-User, Claude-User) are reported not to read JSON-LD (Resoneo, Jan 2026), so they cannot answer "what does it cost?". Show the price on the page.', isPrelaunch(ctx) ? 'Launch blocker' : null));
    } else if (shown.length && !inRaw.length) {
      out.push(finding('rend-ai-price', 'Price in page text', value, 'warning', 'The price shows up only after JavaScript. Google sees it; AI crawlers and live fetchers do not. Render the price in the server HTML.'));
    } else {
      out.push(finding('rend-ai-price', 'Price in page text', value, 'good', 'The schema price is also written on the page and in the server HTML. Every reader gets it.'));
    }
    if (/InStock|LimitedAvailability|PreOrder/i.test(f.availability) && !f.stockTextVisible && !f.buyButton) {
      out.push(finding('rend-ai-stock', 'Stock in page text', `Schema: ${f.availability} · page: no stock text or buy button`, 'info', 'Availability is only in the schema. Say it on the page too ("In stock", or a buy button) so readers that skip JSON-LD get it.'));
    }
  }

  // 2. Content and schema that AI crawlers miss
  const items = jsSchema.map((t) => `Schema only after JavaScript: ${t}`);
  if (share < 50) {
    out.push(finding('rend-ai-content', 'What AI crawlers see', `${share}% of the text${jsSchema.length ? `, ${plural(jsSchema.length, 'schema type')} missing` : ''}`, 'warning',
      'AI crawlers (GPTBot, ClaudeBot, PerplexityBot) do not run JavaScript (Vercel, Dec 2024). They see only the server HTML, so most of this page is invisible in AI answers even if Google ranks it.', null, items));
  } else if (jsSchema.length) {
    out.push(finding('rend-ai-content', 'What AI crawlers see', `${share}% of the text, ${plural(jsSchema.length, 'schema type')} only after JavaScript`, 'warning',
      'The text is there, but some structured data is added by JavaScript. Google reads it; AI crawlers do not. Output the schema in the server HTML (SEO plugin or theme), not from a widget.', null, items));
  } else {
    out.push(finding('rend-ai-content', 'What AI crawlers see', `${share}% of the text, all schema`, 'good', 'AI crawlers that do not run JavaScript get the same text and structured data as Google.'));
  }

  // 3. Slow servers eat into AI fetch timeouts (reported, sources disagree)
  const warm = network && network.warm ? network.warm.filter((x) => x.status && !x.challenge).map((x) => x.ttfb).filter((n) => n != null).sort((a, b) => a - b) : [];
  const med = warm.length ? warm[Math.floor(warm.length / 2)] : null;
  if (med != null && med > 2500) {
    out.push(finding('rend-ai-ttfb', 'Server speed for AI fetchers', `${med} ms to first byte`, 'warning', 'Live AI fetchers give up after a few seconds (reported timeouts range from about 5 to 15 s; sources disagree). A slow first byte leaves little room for the rest of the HTML.'));
  }
  return out;
}

// ---------------- links and navigation ----------------

function linkFindings(d, ctx) {
  if (!d.raw.ok || !d.links) return [];
  const out = [];
  const l = d.links;
  if (l.onlyRendered >= 10 || (l.rendered && l.onlyRendered / l.rendered > 0.2)) {
    out.push(finding('rend-links-js', 'Links only after JavaScript', `${l.onlyRendered} of ${l.rendered} internal links`, 'warning',
      'These links are not in the server HTML. Google finds them after rendering; other crawlers and AI bots do not, and they get less weight in discovery. Render menus, breadcrumbs and product links on the server.', null, l.samples));
  } else if (l.onlyRendered) {
    out.push(finding('rend-links-js', 'Links only after JavaScript', `${l.onlyRendered} of ${l.rendered} internal links`, 'info', 'A few links are added by JavaScript (often account, cart or widget links). Check none of them is a page you want ranked.', null, l.samples));
  } else {
    out.push(finding('rend-links-js', 'Links only after JavaScript', `0 of ${l.rendered} internal links`, 'good', 'Every internal link is in the server HTML.'));
  }

  if (d.fakeLinks && d.fakeLinks.length) {
    out.push(finding('rend-fake-links', 'Clickable elements that are not links', plural(d.fakeLinks.length, 'element'), 'warning',
      'These go somewhere when clicked but are not <a href>. Google only follows <a href>. Fine for buttons that open menus or filters; pages people should reach need a real link.', 'Check by hand',
      d.fakeLinks.map((x) => `<${x.tag}> ${x.text || '(no text)'} → ${x.target || '?'}`)));
  } else {
    out.push(finding('rend-fake-links', 'Clickable elements that are not links', 'None found', 'good', 'No elements with data-href / onclick navigation. (Framework click handlers cannot be seen from outside; click-test key links if in doubt.)'));
  }

  const lm = (d.loadMore || []).filter((x) => !x.realLink);
  const rawPages = (d.pagination && d.pagination.raw) || [];
  const renderedPages = (d.pagination && d.pagination.rendered) || [];
  if (lm.length && !rawPages.length) {
    const listing = LISTING_TYPES.has(ctx.pageType);
    out.push(finding('rend-loadmore', '"Load more" without page links', lm.map((x) => `"${x.text}"`).join(', '), listing ? 'warning' : 'info',
      'Google does not click buttons, so items behind "Load more" get no link from this page. Test by hand: open ?page=2 (or /page/2/) and check the items are in the sitemap. Fix: add real <a href> pagination links (they can be visually small).', 'Check by hand'));
  } else if (renderedPages.length && !rawPages.length) {
    out.push(finding('rend-loadmore', 'Pagination links', 'Only after JavaScript', 'warning', 'Page 2, 3… links exist only after JavaScript. Put them in the server HTML.', null, renderedPages));
  } else if (rawPages.length) {
    out.push(finding('rend-loadmore', 'Pagination links', plural(rawPages.length, 'link'), 'good', 'Paginated pages are linked with <a href> in the server HTML.', null, rawPages));
  }
  return out;
}

// ---------------- tabs and accordions ----------------

function panelFindings(d) {
  if (!d.raw.ok || !d.panels || !d.panels.length) return [];
  const missing = d.panels.filter((p) => p.inRaw === false);
  const hidden = d.panels.filter((p) => !p.shown).length;
  if (missing.length) {
    return [finding('rend-panels', 'Tab and accordion content', `${missing.length} of ${d.panels.length} panels not in raw HTML`, 'warning',
      'This tab or accordion text is loaded by JavaScript. Google may miss it unless it renders the click; AI crawlers never see it. Put panel content in the HTML and only hide it with CSS. Primary content (description) should not sit behind a tab at all.', null,
      missing.map((p) => `${p.kind}: ${p.text}`))];
  }
  return [finding('rend-panels', 'Tab and accordion content', `${d.panels.length} panels, all in raw HTML${hidden ? ` (${hidden} closed)` : ''}`, 'good', 'Panel text is already in the HTML, so crawlers read it without clicking.')];
}

// ---------------- manual confirmation ----------------

function confirmFindings(d) {
  return [finding('rend-gsc', 'Confirm with Google', 'URL Inspection → Test live URL', 'info',
    'This tab compares the server HTML with what your browser renders. Google\'s own view can differ (blocked files, script errors). In Search Console: URL Inspection → Test live URL → View tested page → HTML, Screenshot, More info (page resources, JavaScript console).')];
}

// ---------------- public ----------------

export function evaluateRendering(d, ctx = {}, extra = {}) {
  const network = extra.network || null;
  const groups = [
    { id: 'strategy', title: 'How the page is built', findings: strategyFindings(d, ctx, network) },
    { id: 'ai', title: 'Google vs AI readers', findings: aiFindings(d, ctx, network) },
    { id: 'meta', title: 'Meta tags: raw vs rendered', findings: metaFindings(d, ctx) },
    { id: 'links', title: 'Links and pagination', findings: linkFindings(d, ctx) },
    { id: 'panels', title: 'Tabs and accordions', findings: panelFindings(d) },
    { id: 'confirm', title: 'Confirm with Google', findings: confirmFindings(d) },
  ].filter((g) => g.findings.length);
  const counts = { critical: 0, warning: 0, good: 0, info: 0 };
  groups.forEach((g) => g.findings.forEach((f) => { counts[f.flag] += 1; }));
  return { groups, counts };
}
