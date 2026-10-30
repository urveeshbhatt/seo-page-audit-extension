// Phase 1 rules for page health (Step 5): DOM size, hidden content, CSS text,
// shadow DOM, iframes, render-blocking resources, tech stack.
// Runs in the side panel. Pure functions, no DOM.

import { finding, plural, isPrelaunch } from './phase1-rules.js';
import { conform, contextOf } from './conform.js';
import { SCHEMAS } from './schemas.js';

const short = (s, n = 70) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

// Hidden iframes from these hosts are tracking/testing frames, not content
const TRACKING_FRAME = /adsrvr|optimizely|doubleclick|googletagmanager|facebook\.com|bat\.bing|linkedin|hotjar|clarity|criteo|taboola|outbrain|google\.com\/recaptcha|recaptcha|stripe|paypal/i;
const VIDEO_FRAME = /youtube|youtu\.be|vimeo|wistia|loom/i;

// ---------------- DOM size ----------------

function domFindings(d) {
  const out = [];
  const { nodes, maxDepth, maxChildren, maxChildrenAt, htmlBytes } = d.dom;
  let flag = 'good';
  let why = 'Small DOM. Fast to render and cheap for Google to process.';
  if (nodes > 3000) { flag = 'warning'; why = 'Very large DOM. Slows rendering and INP on mobile. Usually page-builder wrappers or long lists rendered at once.'; }
  else if (nodes > 1500) { flag = 'warning'; why = 'Large DOM (Lighthouse warns above ~1,400). Trim nested containers or lazy-render long sections.'; }
  else if (nodes > 800) { flag = 'info'; why = 'Moderate DOM. Fine for most pages; keep an eye on it as sections are added.'; }
  out.push(finding('dom-size', 'DOM size', `${nodes.toLocaleString('en-US')} elements`, flag, why));

  if (maxDepth > 32) {
    out.push(finding('dom-depth', 'DOM depth', `${maxDepth} levels`, 'warning', 'Very deep nesting. Every style change costs more. Common with nested page-builder sections.'));
  } else {
    out.push(finding('dom-depth', 'DOM depth', `${maxDepth} levels`, 'good', 'Nesting depth is reasonable.'));
  }
  if (maxChildren > 60) {
    out.push(finding('dom-children', 'Widest element', `${maxChildren} children in ${short(maxChildrenAt, 50)}`, 'info',
      'One element has many direct children. Fine for lists; on <body> it often means many popups, scripts and widgets appended at the end.'));
  }
  if (htmlBytes > 1500 * 1024) {
    out.push(finding('dom-html', 'HTML size', kb(htmlBytes), 'warning',
      'Heavy HTML. Mobile users download all of it before the page settles. Check for inline JSON, inline SVG sprites or duplicated markup.'));
  }
  return out;
}

// ---------------- Hidden content ----------------

const CATEGORY_LABEL = {
  ui: 'menus, popups, tabs, accordions, cookie banner',
  breakpoint: 'device-specific copies (shown on another screen size)',
  framework: 'framework placeholders (React streaming)',
  a11y: 'screen-reader text',
  expandable: 'behind "show more" / collapsed lists',
  unknown: 'no known pattern',
};

function hiddenFindings(d) {
  const out = [];
  const groups = {};
  (d.hidden || []).forEach((h) => { (groups[h.category] = groups[h.category] || []).push(h); });
  const line = (h) => `${h.reason} · ${h.chars} chars · ${short(h.el, 50)} · "${short(h.sample, 70)}"`;

  const unknown = groups.unknown || [];
  if (unknown.length) {
    const chars = unknown.reduce((n, h) => n + h.chars, 0);
    out.push(finding('hidden-unknown', 'Hidden text (no known reason)', `${plural(unknown.length, 'block')} · ${chars} chars`, chars >= 300 ? 'warning' : 'info',
      'Text hidden with CSS and no obvious UI reason. Google may ignore or distrust it. Check each one: is it a leftover, a duplicate, or keyword stuffing?',
      null, unknown.map(line)));
  } else {
    out.push(finding('hidden-unknown', 'Hidden text', 'No unexplained hidden text', 'good', 'Everything hidden belongs to a known UI pattern.'));
  }

  if (groups.expandable) {
    out.push(finding('hidden-expandable', 'Collapsed content', plural(groups.expandable.length, 'block'), 'info',
      'Behind a "show more" or collapsed list. Google indexes it; fine as long as a user can open it. Keep money content (prices, key products) visible.',
      null, groups.expandable.map(line)));
  }
  if (groups.breakpoint) {
    out.push(finding('hidden-breakpoint', 'Device-specific copies', plural(groups.breakpoint.length, 'block'), 'info',
      'Same section built twice (one for mobile, one for desktop). Google sees both copies: duplicate headings and text. Prefer one responsive section.',
      null, groups.breakpoint.map(line)));
  }
  const ignored = ['ui', 'framework', 'a11y'].filter((k) => groups[k]);
  if (ignored.length) {
    const items = ignored.flatMap((k) => groups[k].map((h) => `[${k}] ${line(h)}`));
    out.push(finding('hidden-ignored', 'Hidden UI', ignored.map((k) => `${groups[k].length} ${CATEGORY_LABEL[k]}`).join(' · '), 'info',
      'Ignored. Hidden until clicked or swapped in by the framework. Crawlers report these as hidden text; they are not a problem.', 'Ignored', items));
  }
  return out;
}

// ---------------- CSS-generated text ----------------

function cssTextFindings(d) {
  const real = (d.cssText || []).filter((c) => !/elementor-device-mode|elementor-screen-only|screen-reader|sr-only/i.test(c.el));
  const traps = (d.cssText || []).length - real.length;
  if (!real.length) {
    return [finding('css-text', 'Text added by CSS', traps ? `None (${traps} builder marker ignored)` : 'None', 'good',
      'No words injected with ::before / ::after. All readable text is in the HTML.')];
  }
  const f = finding('css-text', 'Text added by CSS', plural(real.length, 'spot'), 'warning',
    'Words in CSS content are not indexed by Google and not read by most screen readers. Move labels like prices or badges into the HTML.',
    null, real.map((c) => `${short(c.el, 50)}${c.pseudo}: "${c.text}"`));
  f.targets = real.slice(0, 40).map((c) => ({ kind: 'desc', value: c.el }));
  return [f];
}

// ---------------- Shadow DOM / custom elements ----------------

function shadowFindings(d) {
  const s = d.shadow;
  const out = [];
  if (s.emptyCustom.length) {
    out.push(finding('shadow-empty', 'Custom elements with no readable text', plural(s.emptyCustom.length, 'element'), 'warning',
      'Large custom elements with no light-DOM text and no open shadow root. If they hold real content (reviews, prices), Google may not see it. Check with the URL Inspection tool.',
      null, s.emptyCustom));
  }
  if (s.openWithText) {
    out.push(finding('shadow-text', 'Text inside shadow DOM', plural(s.openWithText, 'component'), 'info',
      'Google flattens open shadow DOM when rendering, so this is usually indexed. Confirm in URL Inspection → View crawled page.'));
  }
  if (!out.length) {
    out.push(finding('shadow', 'Shadow DOM', s.open ? `${s.open} open root, no content inside` : 'Not used for content', 'good', 'No page content hidden inside web components.'));
  }
  return out;
}

// ---------------- iframes ----------------

function iframeFindings(d) {
  const frames = d.iframes || [];
  if (!frames.length) return [];
  const out = [];
  const tracking = frames.filter((f) => !f.visible && (TRACKING_FRAME.test(f.host) || f.host === '(no src yet)'));
  const content = frames.filter((f) => !tracking.includes(f));
  const notLoaded = content.filter((f) => f.host === '(no src yet)');
  const loaded = content.filter((f) => f.host !== '(no src yet)');

  if (notLoaded.length) {
    out.push(finding('iframe-empty', 'Embed not loaded', plural(notLoaded.length, 'iframe'), 'info',
      'Visible embed with no source yet. Usually a cookie-consent blocker or lazy-load waiting for a click or scroll. Check that the video plays after accepting cookies, and that Google gets a thumbnail or VideoObject schema.',
      null, notLoaded.map((f) => f.title || '(no title)')));
    out[out.length - 1].targets = [{ kind: 'iframe-empty' }];
  }
  if (loaded.length) {
    const videos = loaded.filter((f) => VIDEO_FRAME.test(f.host));
    out.push(finding('iframe-content', 'Embedded content', loaded.map((f) => f.host).join(', '), 'info',
      `Content inside an iframe counts for the other site, not this page.${videos.length ? ' For videos, add VideoObject schema and a text summary on the page.' : ''}`,
      null, loaded.map((f) => `${f.host}${f.title ? ` · ${f.title}` : ''}${f.lazy ? ' · lazy' : ''}`)));
  }
  if (tracking.length) {
    out.push(finding('iframe-tracking', 'Hidden tracking frames', plural(tracking.length, 'frame'), 'info',
      'Ignored. Invisible frames from analytics, ads or A/B testing tools.', 'Ignored', tracking.map((f) => f.host + (f.title ? ` · ${f.title}` : ''))));
  }
  return out;
}

// ---------------- Render-blocking resources ----------------

function resourceFindings(d) {
  const r = d.resources;
  const out = [];
  if (r.blockingCss > 10) {
    const has = (name) => (d.stack || []).some((x) => x.name === name);
    const tip = has('LiteSpeed Cache') ? ' In LiteSpeed Cache: Page Optimization → CSS Settings → turn on Load CSS Asynchronously and Generate Critical CSS, purge all, then re-test LCP and CLS. Avoid CSS Combine unless you test it: one big late file can make the layout jump (CLS).'
      : has('WP Rocket') ? ' In WP Rocket: File Optimization → Optimize CSS delivery.'
        : has('Elementor') ? ' In Elementor: Settings → Features → Improved CSS Loading (if your version shows it).' : '';
    out.push(finding('res-css', 'Render-blocking CSS', `${r.blockingCss} stylesheets in <head>`, 'warning',
      `The browser waits for every one of these files before painting anything. Directly affects LCP.${tip || ' Combine files or inline critical CSS (most cache plugins can).'}`));
  } else {
    out.push(finding('res-css', 'Render-blocking CSS', `${r.blockingCss} stylesheet${r.blockingCss === 1 ? '' : 's'} in <head>`, 'good', 'Few CSS files block the first paint.'));
  }
  if (r.blockingScriptCount) {
    out.push(finding('res-js', 'Render-blocking scripts', plural(r.blockingScriptCount, 'script'), r.blockingScriptCount > 2 ? 'warning' : 'info',
      'Scripts in <head> without async or defer stop the page from rendering until they download and run. Add defer where possible.',
      null, r.blockingScripts));
  } else {
    out.push(finding('res-js', 'Render-blocking scripts', 'None', 'good', 'Head scripts use async or defer.'));
  }
  if (r.inlineScriptKB > 500) {
    out.push(finding('res-inline', 'Inline script size', `${r.inlineScriptKB} KB`, 'warning',
      'Very large inline scripts, usually framework data (Next.js / Nuxt payload) embedded in the HTML. Every visitor downloads it before the page is usable. Ask devs to trim the props sent to the page.'));
  }
  out.push(finding('res-count', 'Scripts and styles', `${plural(r.scripts, 'script')} (${plural(r.externalScripts, 'file')}, ${r.inlineScriptKB} KB inline) · ${plural(r.stylesheets, 'stylesheet')}`, 'info',
    'For reference. Run PageSpeed Insights for the real cost of each file.'));
  return out;
}

// ---------------- Tech stack ----------------

const GROUP_ORDER = ['platform', 'framework', 'builder', 'seo', 'performance', 'cdn', 'consent', 'tracking', 'testing'];

function stackFindings(d, ctx) {
  const out = [];
  const stack = [...(d.stack || [])].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  const names = (g) => stack.filter((s) => s.group === g).map((s) => s.name);
  const core = [...names('platform'), ...names('framework'), ...names('builder')];
  const tools = [...names('seo'), ...names('performance'), ...names('cdn'), ...names('consent')];

  out.push(finding('stack-core', 'Built with', core.length ? core.join(' + ') : 'Not detected (custom or hidden)', 'info',
    core.includes('Next.js') || core.includes('Nuxt') ? 'JavaScript framework: check raw vs rendered on every template (Body tab).'
      : core.includes('Elementor') ? 'Page builder: watch DOM size, duplicate mobile/desktop sections and render-blocking CSS.'
        : 'Know the stack before suggesting fixes: the fix path differs per platform.',
    null, d.generator && d.generator.length ? d.generator.map((g) => `generator: ${g}`) : null));
  if (tools.length) {
    out.push(finding('stack-tools', 'SEO and site tools', tools.join(', '), 'info', 'Fix SEO tags in the SEO plugin, not in theme code. Clear the cache plugin after every change before re-testing.'));
  }

  const tracking = [...names('tracking'), ...names('testing')];
  const t = d.tags || {};
  const idList = [...(t.gtm || []), ...(t.ga4 || []), ...(t.aw || []), ...(t.ua || [])];
  // Shopify: tracking apps and custom pixels run sandboxed, off the page.
  const pixels = Array.isArray(d.shopifyPixels) ? d.shopifyPixels.filter((p) => p && typeof p === 'object') : [];
  const pixelCount = new Map();
  pixels.forEach((p) => {
    const line = `Shopify pixel: ${p.name}${Array.isArray(p.ids) && p.ids.length ? ` (${p.ids.join(', ')})` : ''}`;
    pixelCount.set(line, (pixelCount.get(line) || 0) + 1);
  });
  const pixelLines = [...pixelCount].map(([line, n]) => (n > 1 ? `${line} ×${n}` : line));
  const pixelIds = pixels.flatMap((p) => (Array.isArray(p.ids) ? p.ids : []));
  const onShopify = names('platform').includes('Shopify');
  if (!tracking.length && pixelIds.some((id) => /^(G|GT|GTM)-/.test(id))) {
    out.push(finding('stack-tracking', 'Tracking and testing', 'Google tag in a Shopify app pixel', 'info',
      'Shopify loads this tag inside its sandboxed pixel, so it does not show in the page code. Confirm data arrives in GA4 → Realtime.', null, pixelLines));
  } else if (!tracking.length && (onShopify || pixels.length)) {
    out.push(finding('stack-tracking', 'Analytics', pixels.length ? `No Google tag on the page · ${pixels.length} Shopify pixel${pixels.length === 1 ? '' : 's'}` : 'No Google tag on the page', 'warning',
      'Shopify runs tracking apps and custom pixels in a sandbox, so a page scan cannot see them. Check Shopify admin → Settings → Customer events (and the Google & YouTube app). If GA4 is not there, install it: without analytics you cannot prove SEO results.',
      'Check by hand', pixelLines.length ? pixelLines : null));
  } else if (!tracking.length) {
    out.push(finding('stack-tracking', 'Analytics', 'None detected', isPrelaunch(ctx) ? 'warning' : 'critical',
      isPrelaunch(ctx)
        ? 'No analytics found. You cannot prove SEO results without it. Install GA4 (or GTM) before launch.'
        : 'No analytics found on this live page. You cannot prove SEO results without it. Install GA4 (or GTM) now; tags added later have no history to compare against.'));
  } else {
    out.push(finding('stack-tracking', 'Tracking and testing', tracking.join(', '), 'info',
      'Each tag adds JavaScript. Keep only the ones someone actually uses.', null, idList.length ? idList.map((id) => `ID: ${id}`) : null));
  }
  if ((t.gtm || []).length > 1) {
    out.push(finding('stack-gtm-multi', 'Multiple GTM containers', t.gtm.join(', '), 'warning', 'More than one container can double-count events. Confirm each is needed.'));
  }
  if ((t.ga4 || []).length > 1) {
    out.push(finding('stack-ga4-multi', 'Multiple GA4 IDs', t.ga4.join(', '), 'info', 'Two GA4 properties on one page. Fine if intentional (agency + client); otherwise remove one.'));
  }
  if ((t.ua || []).length) {
    out.push(finding('stack-ua', 'Old Universal Analytics', t.ua.join(', '), 'info', 'UA stopped collecting data in 2023. Remove the tag.'));
  }
  return out;
}

// ---------------- HTML comments (Step 5E) ----------------

const LEAK = /\b(todo|fixme|hack|staging|stage\.|dev\.|localhost|127\.0\.0\.1|password|passwd|api[_-]?key|secret|token|debug|test site|do not publish)\b/i;

function commentFindings(d) {
  const c = d.comments;
  if (!Array.isArray(c)) return [];
  if (!c.length) return [finding('html-comments', 'HTML comments', 'None', 'good', 'Production build with comments stripped.')];
  const leaks = c.filter((t) => LEAK.test(t));
  const out = [];
  if (leaks.length) {
    out.push(finding('html-comments-leak', 'Comments that leak info', plural(leaks.length, 'comment'), 'warning',
      'Developer notes, staging URLs or secrets left in the HTML. Anyone can read them with View Source. Remove them.', null, leaks));
  }
  out.push(finding('html-comments', 'HTML comments', plural(c.length, 'comment'), 'info',
    'Clues to the stack (SEO plugin, cache plugin, builder, versions). Useful for the audit; harmless unless they leak info.', null, c.filter((t) => !leaks.includes(t))));
  return out;
}

// ---------------- public ----------------

export function evaluateHealth(data, context) {
  const d = conform(data, SCHEMAS.health);
  const ctx = contextOf(context);
  const groups = [
    { id: 'hidden', title: 'Hidden content', findings: [...hiddenFindings(d), ...cssTextFindings(d), ...shadowFindings(d)] },
    { id: 'dom', title: 'DOM size', findings: domFindings(d) },
    { id: 'resources', title: 'Render-blocking and weight', findings: resourceFindings(d) },
    { id: 'embeds', title: 'Embeds', findings: iframeFindings(d) },
    { id: 'stack', title: 'Tech stack', findings: [...stackFindings(d, ctx), ...commentFindings(d)] },
  ].filter((g) => g.findings.length);
  const counts = { critical: 0, warning: 0, good: 0, info: 0 };
  groups.forEach((g) => g.findings.forEach((f) => { counts[f.flag] += 1; }));
  return { groups, counts };
}
