# Changelog

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
