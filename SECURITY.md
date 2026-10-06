# Security model

Page Audit Lens audits third-party websites, so it treats every audited page as untrusted input.

## Permissions

| Permission | Why |
| --- | --- |
| `sidePanel` | Show the UI in Chrome's side panel |
| `activeTab` | Temporary access to the current tab, granted only when the user clicks the toolbar icon. Revoked when the tab navigates |
| `scripting` | Inject read-only collector functions into that tab, and the optional highlight overlay |

No `host_permissions`, no `tabs`, no `storage`, no `cookies`, no `webRequest`. Future modules that need more access will request it as optional permissions, at the moment of use.

## Rules the code follows

1. **Untrusted page data is rendered with `textContent` only.** Never `innerHTML`, `insertAdjacentHTML` or `document.write`
2. **Collectors are read-only.** They return plain data and never modify the audited page
3. **No remote code.** All JavaScript ships inside the extension. No `eval`, no `new Function`, no CDN scripts
4. **No outbound network calls.** The only request is a same-origin `fetch` of the audited page's own URL (raw vs rendered check), made from inside that page with its own cookies. The response is parsed with `DOMParser` (scripts never run) and only counts and short text samples come back to the panel
5. **Strict CSP for extension pages:** `default-src 'self'; script-src 'self'; object-src 'self'; base-uri 'none'; form-action 'none'`
6. **Size limits** on strings returned by collectors, so a huge page cannot flood the panel
7. **"Show on page" never touches the page's own elements.** It adds one overlay element with a *closed* shadow root (page scripts and CSS cannot read or restyle it), draws boxes with `textContent` labels, and removes it on "Clear highlight". It only runs on the tab that was audited, when the user clicks the button
8. **Exports are escaped.** Markdown output escapes link, HTML and table syntax from page text. CSV output quotes every cell and prefixes cells starting with `= + - @` to block spreadsheet formula injection
9. **Nothing is stored.** Verdict edits, notes and the launch checklist live in memory and disappear when the panel closes. Reports leave the browser only when the user copies or downloads them

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or email the maintainer. Please do not open a public issue for security problems.
