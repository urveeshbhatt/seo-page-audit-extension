# Page Audit Lens

A Chrome extension that runs an on-page SEO audit in a side panel with one click.

It automates the checks a technical SEO does by hand in Chrome DevTools (Elements panel): robots and canonical, raw HTML vs rendered DOM, head tags, headings, images, links and page health. Each finding gets a flag, a one-line reason and a suggested verdict. The final call stays with the auditor.

> **Status:** v1.1.0. All six Phase 1 milestones are done, plus business-model checks. See [Roadmap](#roadmap).

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
5. Open **Head**, **Body** or **Health** for the detail behind each finding. **Show on page** outlines the element on the page
6. On **Report**, change any suggested verdict, add notes, then **Copy Markdown**, **Download .md** or **Download .csv**

| Tab | What it checks |
| --- | --- |
| Summary | Overall verdict, top 7 fixes ranked by impact, launch checklist, ignored traps |
| Head | Robots, canonical, viewport, title, description, Open Graph, schema, lang, hreflang |
| Body | Raw HTML vs rendered, headings, images, links, placeholders and test content |
| Health | Hidden content, CSS-injected text, shadow DOM, DOM size, render-blocking files, embeds, tech stack |
| Business | Checks for the chosen business model (see below), plus stricter E-E-A-T checks for YMYL topics |
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

Tick **YMYL topic** for health, food safety, money or legal pages to add expert-author, expert-review, last-updated and source checks to any model.

## Security and privacy

- **No permanent website access.** The extension has no host permissions. It runs only on the tab where you click its icon, using Chrome's `activeTab` grant
- **Read-only.** Collectors only read the page; they never change it. "Show on page" draws boxes in a separate overlay and removes it when you clear it
- **No outside network calls.** No analytics, no remote code, no external fonts or CDNs. The only request is the audited page re-fetching its own URL (same origin) to compare raw HTML with the rendered page. Audit data stays in your browser
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
  summary.js             Rules engine: suggested verdicts, ranking, overall verdict
  business-rules.js      Business-model and YMYL rules
  report.js              Markdown and CSV export (escaped)
  highlight.js           "Show on page" overlay (closed shadow root)
tests/                   Golden tests from real pages (npm test)
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

Later modules: Network (status codes, redirects, headers), JS rendering, performance, mobile parity.

## Tests

```
npm test
```

Rules are tested against real page data captured from a pre-launch D2C product page and a live B2B city page.

## License

MIT, see [LICENSE](LICENSE).
