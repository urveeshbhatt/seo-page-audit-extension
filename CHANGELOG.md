# Changelog

## 1.4.0 (Phase 3: JavaScript rendering)

New **Rendering** tab, built from the Phase 3 playbook and checked against live Buranshvalley and Regus pages.

- **How the page is built**: framework from the server HTML (Next.js App Router via `self.__next_f`, not only `__NEXT_DATA__`; Pages Router, Nuxt, Angular, Gatsby, Astro, Vue SSR, Shopify, WordPress + Elementor), empty app shell (`#root` with no text), share of content words in the server HTML. Server-rendered, hybrid (check by hand) or client-side rendered (critical on live revenue pages)
- **Build vs cache**: read from framework headers (`x-nextjs-cache`, `x-vercel-cache`, prerender) or `no-store`. A low TTFB is never read as "static"
- **Google vs AI readers**: the schema price and stock must also be in the page text and the server HTML. Price only in JSON-LD = launch blocker / critical, because shoppers cannot see it and AI live fetchers are reported not to read JSON-LD (Resoneo, Jan 2026). AI crawlers do not run JavaScript (Vercel, Dec 2024): share of text and schema they miss. Slow first byte vs AI fetch timeouts, with the "sources disagree" caveat
- **Meta tags raw vs rendered**: noindex removed by JavaScript (Google may skip rendering, so the fix never runs), noindex added by JavaScript, canonical added or changed, title added or changed, Open Graph only after JavaScript (share previews blank)
- **Links and pagination**: internal links that exist only after JavaScript, clickable elements that are not `<a href>` (`<style data-href>`, `<link>`, `<script>` are skipped), "Load more" buttons without page links (warning on listing pages, info elsewhere; cookie-banner "Show more" ignored)
- **Tabs and accordions**: panel text present in the server HTML or loaded by JavaScript
- **Confirm with Google**: reminder to use URL Inspection → Test live URL for Google's own view
- Content words are counted without header, menus, footer, cart and cookie banners, so JavaScript-injected chrome does not make a server-rendered page look hybrid
- Only prices inside a Product / Offer schema block count (`"price": 34900` in an analytics blob is ignored)

### Fixed

- **Phase 1 price check read "Free shipping over ₹999" as the product price.** Visible prices and the raw-HTML price sample now skip header, announcement bars, menus, mini-cart, footer and cookie banners. On Buranshvalley the Body tab used to pass "Schema price vs page"; it now says no price is shown in the page content
- "Schema price vs page" with no visible price is now a **Check by hand** warning instead of info
- 81 golden tests (16 new)

## 1.3.0 (Phase 2: Network)

New **Network** tab, built from the Phase 2 (Network panel) playbook and tested on live Buranshvalley and Regus pages.

- **Main document**: status, HTTP version, compression and sizes, charset, Cache-Control, Vary (cookie / user-agent split the cache), HSTS, version numbers in headers, `Link` header canonical vs HTML canonical. The WordPress REST API `Link` header is recognised and ignored (it is not a canonical)
- **Cache layers read separately**: CDN (Cloudflare, Hostinger CDN, CloudFront, Fastly, Akamai, Vercel, Netlify, Imperva, Sucuri, Bunny) and server cache (LiteSpeed, Next.js, WP cache). "CDN BYPASS + LiteSpeed HIT" is explained as a cookie (for example `_lscache_vary`) skipping the edge while the server cache still answers
- **TTFB, warm vs uncached**: 3 samples with your cookies, 3 as a guest on a fresh URL. Google's 800 ms / 1.8 s guide; spread between tries flagged
- **Bot-protection walls**: tiny Imperva / Cloudflare challenge pages are detected, so a 212-byte answer is not reported as a fast server. Sitemap files behind the wall are re-read with your cookies and flagged
- **Files and third parties**: page weight including HTML, own CSS/JS counts, HTTP/1.1 files, third-party domains, two tools doing the same job. Files that hide their size (no Timing-Allow-Origin) are counted and called out
- **robots.txt**: Google's matching rules (longest match, Allow wins ties, `*` and `$`), whole site or this page blocked, CSS/JS folders blocked, missing Sitemap line, repeated user-agent groups, AI search vs training bots, Cloudflare `Content-Signal`
- **Sitemap**: finds it from robots.txt or the usual paths, reads `.xml.gz`, samples 10 URLs for status, redirects, noindex and canonical; lastmod all the same date flagged. **llms.txt**: present, missing, or an HTML soft 404
- **Redirect tests (optional, asked per site)**: http://, www, trailing slash, combined and a fake URL. Every hop with status; 302/307, 3+ hops, loops, DNS failures, duplicates that answer 200, soft 404s and redirects to the homepage. Chrome's HSTS upgrade is shown as "HSTS" and not counted as a server hop
- Network findings are ranked in Summary and included in the report
- New optional permissions: `webRequest` and host access, requested only from the **Run redirect tests** button, removable with **Remove access**. CSP `connect-src` now allows http(s) for those tests
- 64 golden tests (22 new) plus an end-to-end run in Chromium against a local test site

## 1.2.0 (Phase 1 gaps closed)

Every check in the Phase 1 playbook (Elements panel) is now covered.

- **Schema vs page** (Body tab): schema price must be visible on the page (variant price ranges supported), and a schema rating must be backed by visible reviews. Mismatch = Critical on live sites, Launch blocker before launch
- **Schema per page type** (Head tab): homepage needs Organization + WebSite, blog needs Article/BlogPosting, city pages LocalBusiness or Place, BreadcrumbList as a bonus everywhere else
- **Schema added by JavaScript**: compares JSON-LD in the server HTML with the rendered page
- **X-Robots-Tag header**: read from the same-origin page fetch; a noindex header is caught even when the HTML looks fine
- **Minor bucket** (Head tab, note only): meta keywords, favicon, preconnect hints
- **HTML comments** (Health tab): stack clues listed; developer notes, staging URLs or secrets flagged
- **Canonical missing** now depends on the site: warning for shops and listings, info for small sites
- 42 golden tests

## 1.1.0 (business models)

- Business model now changes the audit. Seven models: D2C / ecommerce, B2B / lead gen, Local business, SaaS / software, Marketplace / listings, Content / affiliate / blog, Other / mixed
- New YMYL toggle (health, food safety, money, legal) that adds expert author, expert review, visible last-updated date and authoritative-source checks to any model
- New Business tab and collector: contact paths, calls to action (buy, lead, trial, demo, booking), NAP, map, hours, store policies, proof, pricing link, pagination and filter links, affiliate links and their `rel`, bylines, credentials and dates, business JSON-LD
- Known false alarms filtered: cookie-banner "powered by" links are not affiliate links; review-form "author" fields are not bylines
- Business findings are ranked in Summary and included in the report
- 33 golden tests (live Buranshvalley and Regus data, plus synthetic local, SaaS and affiliate pages)

## 1.0.0 (M6: report)

- New Report tab: every finding with a verdict dropdown (suggested verdict marked) and a note field
- Edits flow into the Summary tab and the overall verdict straight away
- Copy the report as Markdown, or download it as `.md` or `.csv` (UTF-8 with BOM for Excel)
- Report title and auditor name in the header; file names built from the page URL and date
- "Show on page" on findings with page elements (placeholders, test images, alt issues, generic links, contact links, H1, CSS text, empty embeds): outlines them on the audited tab and scrolls to the first one
- Highlight overlay lives in a closed shadow root; the page's own elements are never changed
- CSV export blocks spreadsheet formula injection; Markdown export escapes page text
- 23 golden tests

## 0.5.0 (M5: rules engine and summary)

- New Summary tab, opened automatically after an audit
- Overall verdict for the page: "Not ready", "Not ready to launch", "Good base, N fixes" or "Healthy"
- Every finding gets a suggested verdict: Fix now, Fix before launch, Fix, Check manually, Re-check after launch, Review, Ignore (known trap), OK
- "Fix first" list: top 7 issues across Head, Body and Health, ranked by severity and business impact (a dummy order number outranks a missing alt)
- Launch checklist for pre-launch pages (tick items as you fix them)
- Section chips jump to the Head, Body or Health tab; "More fixes", "To review" and "Known traps ignored" lists
- Changing the page context re-ranks the summary instantly
- Missing tab access no longer shows up under chrome://extensions → Errors (it is expected; the panel explains what to do)
- 18 golden tests

## 0.4.0 (M4: page health)

- New Health tab with five groups: Hidden content, DOM size, Render-blocking and weight, Embeds, Tech stack
- Hidden content sorted by reason: menus/popups/tabs/cookie banners (ignored), React streaming placeholders (ignored), screen-reader text (ignored), "show more" lists, mobile/desktop duplicate sections, and hidden text with no known reason (flagged)
- Text injected with CSS `::before` / `::after` (Elementor device marker ignored)
- Shadow DOM and empty custom elements
- DOM size, depth, widest element, HTML size
- Render-blocking CSS and scripts (nomodule polyfills excluded), inline script weight; tips adapt to the stack (LiteSpeed, WP Rocket, Elementor)
- Embeds: iframes not loaded yet (consent or lazy-load), third-party content, hidden tracking frames (ignored)
- Tech stack from page signals: platform, framework, builder, SEO and cache plugins, consent tool, tracking tags with IDs; flags missing analytics, multiple GTM containers, old UA tags
- Body and Health run in parallel after Head; one failing does not hide the others
- Active tab scrolls into view on narrow panels
- 14 golden tests

## 0.3.0 (M3: body checks)

- New Body tab with five groups: Unfinished content, Raw HTML vs rendered (Step 2), Headings (4A), Images (4B), Links (4C)
- Raw vs rendered: fetches the page's own HTML (same origin, read-only) and checks that H1, price and main text exist without JavaScript; compares link counts; flags tiny responses (bot protection) for a manual Ctrl+U check
- Unfinished content: `[____]`, `[__]%`, bracketed names, `lorem ipsum`, `{{ tokens }}`, dummy phone numbers (`91XXXXXXXXXX`), template links (`http://[URL]`) and test images. "Launch blocker" before launch, Critical when live
- Headings: H1 count, empty headings, skipped levels, full outline
- Images: missing / empty / generic / auto-generated alt, repeated alt, hero image lazy-load and fetchpriority, missing width/height, oversized files
- Links: missing href, `#` links, links with no text, generic anchors ("here", "learn more"), empty `tel:` links, mismatched WhatsApp/phone numbers
- Known traps auto-ignored: tracking pixels, icons, accordion/tab/cart/cookie toggles
- "Show details" lists under findings (e.g. every placeholder with its surrounding text)
- Link text ignores `<noscript>` fallbacks from lazy-load plugins
- Golden tests extended with body fixtures from Buranshvalley and Regus (10 tests)

## 0.2.0 (M2: head checks)

- New Head tab: indexing (robots, googlebot, canonical, viewport), search snippet (title, description), social preview (Open Graph, X card), structured data (types, Product name, brand, offer, rating), language (lang, hreflang)
- Every finding has a flag, a short label and a one-line reason
- Context-aware rules: noindex is a "Launch blocker" on pre-launch sites and Critical on live revenue pages; canonical 0 on a noindex page is "Re-check later"
- Changing the context re-judges the last audit without re-running it
- "Hide passed checks" filter and finding counts
- Golden tests from real Buranshvalley and Regus pages (`npm test`)

## 0.1.1

- Fix: toolbar click now reliably grants tab access (handled via `action.onClicked` instead of auto-open panel behaviour)
- New: keyboard shortcut Alt+Shift+A to open the panel and grant access on the current tab
- Panel shows "Tab ready" after the icon is clicked
- Tab bar no longer shows a scrollbar on narrow panels

## 0.1.0 (M1)

- Side panel opens from the toolbar icon
- Page context form: page type, site status, business model
- Audit reads page URL, title, title length and `lang`
- Title length flag (missing, short, good, may be cut)
- Security baseline: `activeTab` only, strict CSP, text-only rendering
