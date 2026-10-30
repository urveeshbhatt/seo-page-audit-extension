# Changelog

## 1.5.1 (Shopify fixes from a live store audit)

A full audit of a live Shopify store (Horizon theme) on 30 Oct 2026 found eight false alarms and one miss. Each one is now a test (`tests/platform-fixes.test.mjs` and the `shopify-horizon` integration page) and is fixed:

- **"Script loaded twice" for module scripts.** Shopify prints the same `<script type="module">` next to every block; the browser loads and runs it once. Module scripts are now counted once (a classic `<script>` printed twice still counts, because it runs twice)
- **CSS transitions reported as layout animations.** A 0.3 s border transition that happened to be running was flagged like a looping animation. Animations now carry a `kind`; transitions are left out
- **"No brand" on Shopify products.** Shopify writes `ProductGroup` (with brand) and one `Product` per variant (without). The group is now read as the product, with the variants' price range
- **"Schema price not on the page" while the price was shown.** The cookie-banner selector `[class*="cky-"]` also matched `sticky-`, which hid Shopify's main product block. Fixed in Body and Rendering, and page text is now read node by node instead of removing repeated text by string replace
- **"Analytics: none detected" (critical) on Shopify.** Shopify runs tracking apps and custom pixels in a sandbox. The Health tab now lists the store's pixels (from `webPixelsConfigList`), treats a Google tag inside a pixel as tracking, and otherwise asks to check Settings → Customer events. Live non-Shopify pages without analytics stay critical, without the "before launch" wording
- **Cloudflare cache-rule advice on Shopify.** Shopify (detected from `powered-by` / `x-shopid`) manages HTML caching itself: now an info note, no advice to change it
- **"Combine files with your cache plugin" on Shopify.** Now an info note: remove unused apps and sections instead. Other sites get "cache plugin (WordPress) or build tool"
- **Mobile menu reported as a content panel loaded by JavaScript**, and **"no buy button"** next to a visible "Add to cart": menus, drawers and dialogs are no longer panels, and the buy-button check reads the fixed page text
- **Missed: broken call / WhatsApp links.** New `links-badcontact` finding: two numbers in one `tel:` or `wa.me` link, or a `wa.me` number without the country code

Found while re-checking the fixed version on the same store:

- **"No buy button" next to a visible "Add to cart".** The mini-cart selector `[id*="cart"]` also matched Shopify's buy button (`id="…__add-to-cart"`). Add-to-cart ids are now kept as page content
- **Product image gallery reported as "custom elements with no readable text".** Large custom elements that hold images or video (Shopify's `<slideshow-slide>`) are no longer flagged
- **A long list of identical Shopify pixels** (one store had 10 custom pixels): repeated pixels are now one line with a count
- **Shopify's `data-url` endpoints reported as "clickable elements that are not links".** `data-url` pointing to a section/API endpoint (`/recommendations/`, `section_id=`, JSON) or to the same page (a filter's "Clear all") is what a script fetches, not a link

## 1.5.0 (Phase 4: Performance)

New **Performance** tab, built from the Phase 4 (Core Web Vitals) learning and checked against a live D2C product page.

- **Core Web Vitals of this visit**: LCP, CLS (largest session window, 1 s gap, 5 s cap, shifts after input ignored) and INP (slowest interaction, 1 outlier ignored per 50), FCP, with web.dev thresholds. Poor LCP, CLS or INP is critical on live revenue pages. Every audit reminds that Google ranks with field data (CrUX) and shows where to confirm it
- **LCP element and its four parts**: TTFB, resource load delay, load duration, render delay, with advice for the biggest part. Flags a lazy-loaded LCP image (critical on live revenue pages, launch blocker before launch), an LCP image found late (`data-src` or a long load delay), missing `fetchpriority="high"`, and a **loading screen or spinner as the LCP** (found on a live Shopify store)
- **Layout shifts and animations**: what moved (selectors, shift count and value), CSS animations that change layout (`left`, `top`, `width`, `margin`… a layout shift every frame), animations that repaint (`box-shadow`, `background-position`) and composited ones (`transform`, `opacity`, never flagged). Discrete properties like `z-index` are ignored. Warns when Chrome's 150-shift buffer is full, so CLS may be higher than shown
- **Render-blocking files** with time, owner (first-party or vendor) and file type; Early Hints files are labelled by extension, not "JS"
- **Main thread**: long animation frames (LoAF) grouped by owner (Google Tag Manager / gtag, Meta Pixel, Microsoft Clarity, this site…), forced-layout time and invokers. Frames caused by browser extensions, including this one, are not blamed on the site. Performance data is read before the other collectors run
- **INP phases**: input delay, processing and presentation, with entries of one tap (pointerdown, pointerup, click) combined, so a slow click handler shows as processing
- **Third parties**: requests and size per vendor; "size hidden" when the vendor sends no Timing-Allow-Origin. Platform CDNs (Shopify, WordPress.com…) count as first-party
- **Duplicate tags**: several GA4 IDs, a GA4 ID loaded twice, several GTM containers, Clarity projects or Meta pixels, and any script URL loaded twice
- **Images**: lazy images in the first screen, images without width/height or aspect-ratio (SVG exempt), files much larger than their display size
- **Fonts**: font files and size, `font-display` missing / auto / block on readable `@font-face` rules
- **Show on page** works for Performance findings (new `css` target kind; invalid selectors find nothing)

### Fixed (found while trying to break the extension)

- **JSON, images, PDFs and text files were audited as web pages** and got fake critical findings. The panel now says the tab shows a file, not a web page
- **A page that navigated during the audit was reported as "Done"** with sections from two different pages. The panel now warns and asks to run the audit again
- **One section's rules crashing stopped the whole audit.** Every section is now judged through a safety net: a crash becomes one "Checks could not run" finding and the other tabs still work. Fuzz tests measure how often each module needs it
- **Canonical `javascript:` / `data:` / `mailto:` was reported as "points to another domain".** It is now "not a web address"
- **`<script>` text inside a heading was read as heading text** (false "H1 missing in raw HTML")
- **Manifest description was longer than the Chrome Web Store limit (132 characters).** Shortened; a packaging test now checks limits, versions, permissions and CSP
- **Health tab advised "turn on CSS Combine" for LiteSpeed.** On Buranshvalley that made one late file and CLS 0.838. It now advises Load CSS Asynchronously + Generate Critical CSS and warns about Combine

### Hardened: all rules modules survive bad data

- Fuzz testing found ~180 places where the older rules (Head, Body, Health, Business, Network, Rendering) crashed on a wrong type, a missing key or an odd value. Every `evaluate*()` now first passes its input through `conform()` with a schema of that collector's output (`modules/schemas.js`), so arrays are arrays, text is text and missing keys get a safe default. Where a collector sends `null` on purpose (Network timings, Rendering meta tags), `null` is kept
- Schemas are inferred from 50 real captures: the live Buranshvalley, Regus and Two Brothers pages plus every collector run on six local test pages (`npm run capture`, `npm run build:schemas`). A test proves `conform()` returns real captures unchanged, and another fails if the schemas fall out of date
- Two value bugs fixed: a heading level outside 1–6 crashed the outline, and an unreadable page URL crashed the canonical check
- Result: 0 crashes in 12,000 damaged inputs per run, and 0 under a harsher run (20% of keys dropped, 25% replaced with junk). `safeEvaluate()` stays in the side panel as a last line of defence

### Fixed after verifying on live sites (Two Brothers, Buranshvalley, Brightland, Graza, example.com)

The extension's own code was run on five live sites and every finding was checked against the browser's raw data. Real problems matched (layout animation, LCP element, render-blocking files, duplicate scripts, INP). Five false alarms and one miss were fixed:

- **"LCP image found late" because of `data-src`**: WooCommerce keeps the zoom file in `data-src` while `src` loads normally. Now flagged only when the image really started late
- **Images in a closed menu or a slider slide off screen reported as "above the fold"**: images clipped by a parent with `overflow: hidden`, hidden with `opacity: 0`, or off screen to the left/right are no longer counted
- **Zoom layers reported as "images without size"**: `position: absolute/fixed` images cannot push content, so they are skipped
- **Icon fonts inlined as `data:` URIs asked for `font-display`**: they are never downloaded, so they are skipped (as in Lighthouse)
- **"Larger than shown" listed 127 small thumbnails**: now needs at least 2x the pixels and 200 px extra
- **Missed: Google Ads `AW-` tag loaded twice**: any Google tag ID (G-, AW-, GT-, DC-) requested twice is now reported

### Tests

- 144 unit, golden, fuzz, schema and packaging tests (`npm test`) and 23 integration tests in real Chromium (including a page of false-positive traps) (`npm run test:integration`): collectors on fixture pages, the full side-panel flow with the unpacked extension, "Show on page", and hostile pages (40,000 elements and 13,000 animations, XSS strings, `__proto__` in JSON-LD, broken and deeply nested JSON-LD, strict CSP, a page that overrides `fetch`, `JSON`, `Array`, `querySelectorAll`, `PerformanceObserver` and timers, a busy main thread, quirks mode, mid-audit navigation, JSON / image / text files)

## 1.4.1 (fix)

- **Network tab: TTFB was missing when run from the extension.** Requests made by an injected collector run in the extension's isolated world and do not appear in the page's Performance timeline, so the warm and uncached TTFB samples came back empty. TTFB is now timed directly (request start until the response headers arrive) whenever no Performance entry exists. Found by running the full side-panel flow in Chromium, not just the collectors

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
