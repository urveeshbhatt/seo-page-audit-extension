// Tiny local web server for integration tests.
// Serves tests/integration/pages and assets on 127.0.0.1 (the "site") and the
// same server is reachable as http://localhost:<port> (a "third party": a
// different host, so the browser treats it as cross-site).
//
//   ?delay=ms     wait before answering (slow CSS, slow image, slow SDK)
//   {{TP}}        in a page is replaced with the third-party origin
//   {{SITE}}      in a page is replaced with the site origin

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml', '.woff2': 'font/woff2',
};

const DYNAMIC = {
  '/slow.css': ['text/css', 'h1{color:#222}.price{font-weight:700}'],
  '/vendor.js': ['text/javascript', 'window.__vendorLoaded = true;'],
  '/gtag/js': ['text/javascript', 'window.dataLayer = window.dataLayer || [];'],
  '/dup.js': ['text/javascript', 'window.__dupRuns = (window.__dupRuns || 0) + 1;'],
  '/font.woff2': ['font/woff2', ''],
  '/robots.txt': ['text/plain', 'User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n'],
};

export async function startServer() {
  const server = http.createServer(async (req, res) => {
    const { port } = server.address(); // read before any await: the server may close meanwhile
    const url = new URL(req.url, 'http://x');
    const delay = Math.min(Number(url.searchParams.get('delay')) || 0, 5000);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      if (DYNAMIC[url.pathname]) {
        const [type, body] = DYNAMIC[url.pathname];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        res.end(body);
        return;
      }
      if (url.pathname === '/redirect-loop') { res.writeHead(302, { location: '/redirect-loop' }); res.end(); return; }
      if (url.pathname === '/not-html.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
      const base = url.pathname.startsWith('/img/') ? join(ROOT, 'assets', url.pathname.slice(5)) : join(ROOT, 'pages', url.pathname === '/' ? 'perf-good.html' : url.pathname);
      const file = normalize(base);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      let body = await readFile(file);
      const type = TYPES[extname(file)] || 'application/octet-stream';
      if (type.startsWith('text/html')) {
        body = Buffer.from(String(body).replaceAll('{{TP}}', `http://localhost:${port}`).replaceAll('{{SITE}}', `http://127.0.0.1:${port}`));
      }
      const headers = { 'content-type': type, 'cache-control': 'no-store' };
      if (url.pathname === '/csp-strict.html') headers['content-security-policy'] = "default-src 'none'; img-src 'self'";
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, port, site: `http://127.0.0.1:${port}`, thirdParty: `http://localhost:${port}`, close: () => new Promise((r) => server.close(r)) };
}
