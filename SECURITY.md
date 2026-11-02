# Security model

Page Audit Lens audits third-party websites, so it treats every audited page as untrusted input.

## Permissions

| Permission | Why |
| --- | --- |
| `sidePanel` | Show the UI in Chrome's side panel |
| `activeTab` | Temporary access to the current tab, granted only when the user clicks the toolbar icon. Revoked when the tab navigates |
| `scripting` | Inject read-only collector functions into that tab, and the optional highlight overlay |

Optional, asked only when the user presses **Run redirect tests**, per site:

| Optional permission | Why |
| --- | --- |
| `webRequest` | See each redirect hop (status, Location) of the extension's **own** test requests. Listeners only match requests whose initiator is the extension, are added just before each test and removed right after. Read-only: the extension cannot block or change requests (no `webRequestBlocking`) |
| Host access to the audited site (`https://` and `http://`, bare + www) | Fetch the URL variants from the side panel. The `optional_host_permissions` pattern is broad because the site is not known in advance; Chrome only grants the four origins requested, and **Remove access** revokes them |

No install-time `host_permissions`, no `tabs`, no `storage`, no `cookies`.

## Rules the code follows

1. **Untrusted page data is rendered with `textContent` only.** Never `innerHTML`, `insertAdjacentHTML` or `document.write`
2. **Collectors are read-only.** They return plain data and never modify the audited page
3. **No remote code.** All JavaScript ships inside the extension. No `eval`, no `new Function`, no CDN scripts
4. **Requests go only to the audited site.** From inside the audited tab (same origin): the page's own URL (raw vs rendered for the Body and Rendering tabs, headers, 3 timing samples with the user's cookies and 3 without, using a throw-away `?pal-cold=` parameter), `/robots.txt`, `/llms.txt`, the sitemap (up to 4 child files) and 10 URLs from it. When bot protection answers a cookie-less request, that one file is fetched again with the user's cookies, and the finding says so. Responses are parsed with `DOMParser` or regular expressions (scripts never run); only headers, sizes, timings and short text samples come back to the panel. From the side panel, after the user grants access: the redirect-test URLs, fetched without cookies, bodies discarded unread
5. **Strict CSP for extension pages:** `default-src 'self'; script-src 'self'; object-src 'self'; connect-src 'self' http: https:; base-uri 'none'; form-action 'none'`. `connect-src` allows http(s) so the side panel can run the redirect tests; without granted host access, Chrome still applies normal CORS rules, so other sites cannot be read
6. **Size limits** on strings returned by collectors, so a huge page cannot flood the panel. The Performance collector also caps every list (shifts, frames, resources, images) and switches to reading CSS `@keyframes` on pages with more than 15,000 elements, so a huge page cannot freeze the audit
7. **"Show on page" never touches the page's own elements.** It adds one overlay element with a *closed* shadow root (page scripts and CSS cannot read or restyle it), draws boxes with `textContent` labels, and removes it on "Clear highlight". It only runs on the tab that was audited, when the user clicks the button
8. **Exports are escaped.** Markdown output escapes link, HTML and table syntax from page text. CSV output quotes every cell and prefixes cells starting with `= + - @` to block spreadsheet formula injection
9. **Nothing is stored.** Verdict edits, notes and the launch checklist live in memory and disappear when the panel closes. Reports leave the browser only when the user copies or downloads them
10. **The Performance collector makes no requests.** It only reads what Chrome already recorded for the visit (performance timeline, running animations, same-origin stylesheets) and returns plain data

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or email the maintainer. Please do not open a public issue for security problems.
