# Page Audit Lens

A Chrome extension that runs an on-page SEO audit in a side panel with one click.

It automates the checks a technical SEO does by hand in Chrome DevTools (Elements panel): robots and canonical, raw HTML vs rendered DOM, head tags, headings, images, links and page health. Each finding gets a flag, a one-line reason and a suggested verdict. The final call stays with the auditor.

> **Status:** v1.4.0. Covers the Phase 1 (Elements panel), Phase 2 (Network panel) and Phase 3 (JavaScript rendering) playbooks, plus business-model checks. See [Roadmap](#roadmap).

## Why

Crawlers report hundreds of issues. Most are noise: tracking pixels without alt text, accordion toggles without `href`, intentional `noindex` on a cart page. This tool collects the same data, filters the known false alarms, and drafts a verdict so the auditor can focus on the three issues that cost money.

## Install (developer mode)

1. Download the [latest release](https://github.com/urveeshbhatt/seo-page-audit-extension/releases) or clone: `git clone https://github.com/urveeshbhatt/seo-page-audit-extension.git`
2. Open `chrome://extensions` in Chrome
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the folder that contains `manifest.json`
5. Pin the extension: puzzle icon in the toolbar → pin **Page Audit Lens**

## Use

1. Open the page you want to audit
2. Click the **Page Audit Lens** icon. The side panel opens
3. Set the page context (page type, live or pre-launch, business model)
4. Click **Audit this page**. The **Summary** tab opens with the overall verdict and the issues to fix first
5. Open **Head**, **Body**, **Health** or any other tab for the detail behind each finding. **Show on page** outlines the element on the page
6. To measure INP, tap a few things on the page (menu, size, add to cart), then press **Audit this page** again
7. On **Report**, change any suggested verdict, add notes, then **Copy Markdown**, **Download .md** or **Download .csv**

| Tab | What it checks |
| --- | --- |
| Summary | Overall verdict, top 7 fixes ranked by impact, launch checklist, ignored traps |
| Head | Robots, canonical, viewport, title, description, Open Graph, schema (per page type), lang, hreflang, minor tags |
| Body | Raw HTML vs rendered, X-Robots-Tag header, schema vs visible price and reviews, headings, images, links, placeholders |
| Health | Hidden content, CSS-injected text, shadow DOM, DOM size, render-blocking files, embeds, tech stack, HTML comments |
| Business | Checks for the chosen business model (see below), plus stricter E-E-A-T checks for YMYL topics |
| Rendering | Server HTML vs rendered page: how the page is built (Next.js App/Pages Router, Nuxt, Shopify, WordPress…, empty app shell), build vs cache, title/description/canonical/robots/OG changed by JavaScript (incl. the noindex trap), schema price and stock in page text for AI readers, links only after JavaScript, fake links, "Load more" without page links, tab and accordion content in raw HTML. Separate verdicts for Google, AI crawlers and AI live fetchers |
| Network | Status, HTTP version, compression, cache headers per layer (CDN + server cache), TTFB warm vs uncached, bot-protection walls, page weight, third parties, robots.txt (rules, CSS/JS blocks, AI bots, Content-Signal), sitemap (reads `.gz`, samples 10 URLs), lastmod, llms.txt. Optional redirect tests (see below) |
| Performance | Core Web Vitals of this visit and the reasons behind them: LCP element and its four parts (TTFB, load delay, load time, render delay), lazy or late-found LCP image, loading screen as LCP, CLS session windows and what moved, animations that move layout (left/top/width) vs repaint vs composited, render-blocking files with time and owner, INP with input delay / processing / presentation, long animation frames grouped by script owner (Clarity, Meta, GTM…), third-party weight, duplicate GA4 / GTM / Clarity / Meta tags and scripts loaded twice, lazy images in the first screen, images without size, oversized images, font files and font-display. Lab data from your browser: confirm with PageSpeed Insights field data |
| Report | Edit verdicts and notes, export to Markdown or CSV |

If you switch to another tab, click the toolbar icon again (or press **Alt+Shift+A**) on that tab before auditing. This is a security feature (see below). Change the shortcut at `chrome://extensions/shortcuts`.

## Business models

The business model on Setup decides which conversion and trust checks run on the **Business** tab:

| Model | Checks |
| --- | --- |
| D2C / ecommerce | Visible buy button on product pages, returns and shipping policy links, reviews and certifications |
| B2B / lead gen | Visible quote/contact CTA or form, click-to-call, proof (case studies, client logos, testimonials) |
| Local business | Name, address, phone as text, LocalBusiness schema completeness, schema vs page phone match, map, hours, call/booking action |
| SaaS / software | Pricing link, trial or demo CTA, SoftwareApplication schema, proof |
| Marketplace / listings | Pagination, ItemList schema, filter and sort URL count |
| Content / affiliate / blog | Affiliate links without `rel="sponsored"`, author byline, visible dates, Article schema |
| Other / mixed | Contact paths only |

### Redirect tests (optional)

On the **Network** tab, **Run redirect tests** checks the http://, www, trailing-slash and combined versions of the URL plus a fake URL (should return 404). It shows every hop with its status code, flags 302/307, chains of 3+ hops, loops, soft 404s and missing-page-to-homepage redirects, and ignores Chrome's own HSTS upgrade (marked "HSTS", not counted as a server redirect).

Chrome asks you each time for access to that one site (bare + www) and the `webRequest` permission, so it can see each hop of its own test requests. **Remove access** takes it back. Nothing runs until you press the button.

Tick **YMYL topic** for health, food safety, money or legal pages to add expert-author, expert-review, last-updated and source checks to any model.

## Security and privacy

- **No permanent website access.** The extension has no host permissions at install. It runs only on the tab where you click its icon, using Chrome's `activeTab` grant. Redirect tests ask for access to one site at a time, only when you press the button, and you can remove it with one click
- **Read-only.** Collectors only read the page; they never change it. "Show on page" draws boxes in a separate overlay and removes it when you clear it
- **No outside network calls.** No analytics, no remote code, no external fonts or CDNs. Requests go only to the audited site itself: its own URL, robots.txt, llms.txt, sitemap and 10 sitemap URLs (same origin, from inside the tab), and the redirect-test URLs after you grant access. Audit data stays in your browser
- **Strict Content Security Policy** on extension pages: scripts only from the extension itself
- **No `innerHTML` with page data.** Everything from the audited page is rendered as text, so a malicious page cannot run code inside the extension

Details: [SECURITY.md](SECURITY.md)

## Architecture

```
manifest.json            Extension config, permissions, CSP
background.js            Opens the side panel on toolbar click
sidepanel/               UI (HTML, CSS, JS)
modules/
  phase1-elements.js     Phase 1 collectors (injected into the page)
  phase1-rules.js        Phase 1 head rules: flags, labels, reasons
  phase1-body-rules.js   Phase 1 body rules: raw vs rendered, headings, images, links, placeholders
  phase1-health-rules.js Phase 1 health rules: hidden content, DOM, render-blocking, embeds, stack
  phase2-network.js      Phase 2 collector (injected): headers, timing samples, resources, robots, sitemap
  phase2-redirects.js    Phase 2 redirect tests (side panel, optional webRequest)
  phase2-rules.js        Phase 2 rules: document, caching, redirects, resources, robots/sitemap
  phase3-rendering.js    Phase 3 collector (injected): raw HTML vs rendered DOM
  phase3-rules.js        Phase 3 rules: strategy, Google vs AI readers, meta, links, panels
  phase4-performance.js  Phase 4 collector (injected): performance timeline, LCP, shifts, interactions, long frames, animations
  phase4-rules.js        Phase 4 rules: vitals, LCP parts, shifts, render-blocking, main thread, third parties, images, fonts
  safe-evaluate.js       Safety net: a rules crash becomes one "could not judge" finding, not a failed audit
  conform.js             Puts collector data into the expected shape before any rules run
  schemas.js             Generated: shape of every collector's output (npm run build:schemas)
scripts/                 capture-collector-outputs.mjs, build-schemas.mjs
  summary.js             Rules engine: suggested verdicts, ranking, overall verdict
  business-rules.js      Business-model and YMYL rules
  report.js              Markdown and CSV export (escaped)
  highlight.js           "Show on page" overlay (closed shadow root)
tests/                   Unit, golden and fuzz tests (npm test)
tests/integration/       Real Chromium: collectors, full side-panel audits, hostile pages (npm run test:integration)
icons/
```

Each learning phase becomes one module. Collector, rules and report stay the same.

## Roadmap

| Milestone | Scope | Status |
| --- | --- | --- |
| M1 | Side panel, context form, page basics | Done |
| M2 | Head checks: robots, canonical, viewport, title, description, OG, schema, lang | Done |
| M3 | Raw vs rendered, headings, images, links, placeholders | Done |
| M4 | Page health: DOM size, hidden content, CSS text, shadow DOM, tech stack | Done |
| M5 | Rules engine: auto-ignore known traps, suggested verdicts, summary | Done |
| M6 | Report: edit verdicts, copy, download, highlight on page | Done |
| Phase 2 | Network tab: headers, cache layers, TTFB, robots.txt, sitemap, redirect tests | Done |
| Phase 3 | Rendering tab: raw vs rendered, strategy, AI-reader visibility, JS links, pagination, panels | Done |
| Phase 4 | Performance tab: Core Web Vitals with causes, render-blocking, long frames, third parties, images, fonts | Done |

Later modules: mobile parity, crawling at scale, log files.

## Tests

```
npm test                    # unit, golden and fuzz tests (no browser needed)
npm install                 # once, for integration tests
npx playwright install chromium
npm run test:integration    # real Chromium: collectors, full side-panel audits, hostile pages
npm run capture             # re-capture collector output on the local test pages
npm run build:schemas       # rebuild modules/schemas.js after a collector change
```

Rules are tested against real page data captured from a pre-launch D2C product page, a live B2B city page and a live D2C product page with known performance problems. Every rules module is fuzzed with thousands of damaged captures and must never crash. Integration tests load the unpacked extension into Chromium and run complete audits on local fixture pages, including pages built to break it (40,000 elements, XSS strings, broken JSON-LD, strict CSP, a page that overrides `fetch`/`JSON`/`Array`, a page that navigates away mid-audit, JSON and image files).

## License

MIT, see [LICENSE](LICENSE).
