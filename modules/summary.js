// Rules engine, final layer: merges Head, Body and Health findings into one
// prioritised list, gives every finding a suggested verdict, and an overall
// verdict for the page. Pure functions, no DOM. Runs in the side panel.

const SECTIONS = { head: 'Head', body: 'Body', health: 'Health', business: 'Business', network: 'Network', rendering: 'Rendering', performance: 'Performance' };

// Business impact boost: how much a problem with this check costs the client.
// Only used to order findings that share the same flag.
const IMPACT = {
  robots: 90, 'ph-phone': 95, 'raw-tests': 85, canonical: 80, 'schema-parse': 75, 'ph-image': 70, h1: 70,
  'raw-h1': 65, title: 60, 'ph-text': 60, 'ph-link': 60, 'stack-tracking': 60, 'links-phones': 55,
  'schema-product': 50, 'og-image': 45, 'hidden-unknown': 40, description: 40, 'links-blankcontact': 35,
  'res-css': 30, 'img-hero': 30, 'links-nohref': 25, 'raw-links': 25, 'shadow-empty': 25, viewport: 25,
  'links-generic': 20, 'css-text': 20, 'res-inline': 20, 'dom-html': 15, 'img-genericalt': 15, 'img-noalt': 15,
  'schema-name': 15, 'schema-brand': 12, 'links-empty': 12, 'dom-size': 10, og: 10, 'title-count': 10,
  'x-robots': 92, 'schema-price-match': 78, 'schema-rating-visible': 76, 'html-comments-leak': 30, 'schema-type': 25, 'schema-js': 20,
  'biz-buy': 88, 'biz-lead': 82, 'biz-aff-rel': 75, 'biz-nap': 70, 'biz-signup': 62, 'biz-contact': 60,
  'biz-phone-match': 55, 'biz-pricing': 50, 'biz-local-cta': 50, 'ymyl-author': 50, 'biz-policies': 45,
  'ymyl-review': 45, 'biz-schema': 40, 'biz-trust': 30, 'ymyl-date': 30, 'biz-facets': 30, 'biz-author': 35,
  'net-robots': 93, 'net-status': 91, 'net-redir-http': 72, 'net-redir-www': 70, 'net-redir-combo': 66, 'net-challenge': 68,
  'net-robots-assets': 64, 'net-ttfb-cold': 58, 'net-ttfb-warm': 56, 'net-cache-hit': 54, 'net-sitemap': 52, 'net-sitemap-noindex': 50,
  'net-sitemap-status': 46, 'net-redir-fake': 44, 'net-redir-slash': 42, 'net-link-canonical': 48, 'net-robots-ai': 40,
  'net-sitemap-canonical': 38, 'net-encoding': 36, 'net-vary': 34, 'net-protocol': 28, 'net-sitemap-lastmod': 22, 'net-weight': 24,
  'net-files': 18, 'net-thirdparty': 14, 'net-hsts': 12, 'net-guest-blocked': 62, 'net-sitemap-wall': 60,
  'rend-robots': 94, 'rend-ai-price': 89, 'rend-strategy': 84, 'rend-canonical': 79, 'rend-raw': 58, 'rend-links-js': 57,
  'rend-ai-content': 52, 'rend-loadmore': 47, 'rend-panels': 43, 'rend-og': 41, 'rend-title': 33, 'rend-fake-links': 32,
  'rend-ai-ttfb': 29, 'rend-ai-stock': 26,
  'perf-anim-layout': 87, 'perf-lcp-loader': 84, 'perf-cls-limit': 9, 'perf-lcp-lazy': 86, 'perf-cls': 83, 'perf-lcp': 81, 'perf-inp': 80, 'perf-render-blocking': 61,
  'perf-main': 59, 'perf-dup-tags': 53, 'perf-lcp-discovery': 51, 'perf-fcp': 39, 'perf-img-size': 37, 'perf-img-lazy': 36,
  'perf-font-display': 27, 'perf-fonts': 21, 'perf-anim-paint': 19, 'perf-3p': 16, 'perf-lcp-priority': 13, 'perf-img-big': 11,
};

// Suggested verdicts. M6 will let the auditor override them.
export const VERDICTS = {
  'fix-now': { label: 'Fix now', tone: 'critical' },
  'fix-launch': { label: 'Fix before launch', tone: 'warning' },
  fix: { label: 'Fix', tone: 'warning' },
  manual: { label: 'Check manually', tone: 'warning' },
  later: { label: 'Re-check after launch', tone: 'info' },
  review: { label: 'Review', tone: 'info' },
  ignore: { label: 'Ignore (known trap)', tone: 'muted' },
  ok: { label: 'OK', tone: 'good' },
};

export function suggestVerdict(f) {
  if (f.flag === 'critical') return 'fix-now';
  if (f.label === 'Launch blocker') return 'fix-launch';
  if (f.label === 'Check by hand') return 'manual';
  if (f.label === 'Re-check later') return 'later';
  if (f.label === 'Ignored') return 'ignore';
  if (f.flag === 'warning') return 'fix';
  if (f.flag === 'info') return 'review';
  return 'ok';
}

const TIER = { 'fix-now': 1000, 'fix-launch': 800, manual: 600, fix: 500, later: 200, review: 100, ignore: 0, ok: -100 };

function score(f, verdict) {
  return TIER[verdict] + (IMPACT[f.id] || 0);
}

/**
 * @param {{head?: {groups}, body?: {groups}, health?: {groups}}} results evaluated sections
 * @param {{status: string}} ctx page context
 * @param {Object<string, {verdict?: string, note?: string}>} overrides auditor edits keyed by findingKey()
 */
export const findingKey = (section, id) => `${section}:${id}`;

export function buildSummary(results, ctx, overrides = {}) {
  const all = [];
  Object.entries(SECTIONS).forEach(([key, name], sectionIndex) => {
    const r = results[key];
    if (!r) return;
    let i = 0;
    r.groups.forEach((g) => g.findings.forEach((f) => {
      const suggested = suggestVerdict(f);
      const fk = findingKey(key, f.id);
      const o = overrides[fk] || {};
      const verdict = o.verdict && VERDICTS[o.verdict] ? o.verdict : suggested;
      all.push({ ...f, key: fk, section: key, sectionName: name, group: g.title, suggested, verdict, edited: verdict !== suggested, note: o.note || '', score: score(f, verdict), order: sectionIndex * 1000 + i });
      i += 1;
    }));
  });
  all.sort((a, b) => b.score - a.score || a.order - b.order);

  const by = (v) => all.filter((f) => f.verdict === v);
  const fixNow = by('fix-now');
  const launch = by('fix-launch');
  const fixes = [...by('manual'), ...by('fix')];
  const review = [...by('later'), ...by('review')];
  const ignored = by('ignore');
  const ok = by('ok');
  const prelaunch = ctx && ctx.status === 'prelaunch';

  let overall;
  if (fixNow.length) {
    overall = { tone: 'critical', title: `Not ready: ${fixNow.length} critical issue${fixNow.length === 1 ? '' : 's'}`, line: 'These cost traffic or sales today. Fix them before anything else.' };
  } else if (launch.length) {
    overall = { tone: 'warning', title: `Not ready to launch: ${launch.length} blocker${launch.length === 1 ? '' : 's'}`, line: 'Expected on a pre-launch page. Clear this list before removing noindex.' };
  } else if (fixes.length) {
    overall = { tone: 'warning', title: `Good base, ${fixes.length} fix${fixes.length === 1 ? '' : 'es'} to make`, line: 'Nothing blocks indexing. Work through the list from the top.' };
  } else {
    overall = { tone: 'good', title: 'Healthy page', line: 'No blocking or important issues found. Review the info items when you have time.' };
  }

  const sections = Object.entries(SECTIONS).filter(([key]) => results[key]).map(([key, name]) => ({ key, name, counts: results[key].counts }));

  return {
    overall,
    prelaunch,
    top: [...fixNow, ...launch, ...fixes].slice(0, 7),
    launch,
    fixNow,
    fixes,
    review,
    ignored,
    passed: ok.length,
    sections,
    totals: { fixNow: fixNow.length, launch: launch.length, fixes: fixes.length, review: review.length, ignored: ignored.length, ok: ok.length },
    all,
  };
}
