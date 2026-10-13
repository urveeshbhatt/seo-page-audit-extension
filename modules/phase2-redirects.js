// Phase 2, redirect tests. Runs in the side panel (not injected), only after
// the auditor grants access for this site with the "Run redirect tests" button.
//
// How it works: the side panel fetches a few variants of the page URL
// (http://, www toggle, trailing-slash toggle, a fake URL) and the optional
// webRequest permission lets it watch every hop of its own requests. Nothing
// is stored; listeners are removed after each trace. Bodies are never read.

export const MODULE_INFO = { name: 'phase2-redirects', version: '1.3.0' };

const TIMEOUT_MS = 8000;

function toggleWww(host) {
  return host.startsWith('www.') ? host.slice(4) : `www.${host}`;
}

/** Origins the auditor must grant for this page (bare + www, both schemes). */
export function originsFor(pageUrl) {
  const u = new URL(pageUrl);
  const hosts = [u.hostname, toggleWww(u.hostname)];
  const out = [];
  hosts.forEach((h) => ['https', 'http'].forEach((s) => out.push(`${s}://${h}/*`)));
  return out;
}

/**
 * The URL variants to test. Pure, so it is unit-tested.
 * @returns {{id: string, label: string, url: string, expect: string}[]}
 */
export function buildTestUrls(pageUrl, rand = Math.random().toString(36).slice(2, 8)) {
  const u = new URL(pageUrl);
  u.hash = '';
  const canonical = u.href;
  const tests = [];
  const add = (id, label, url, expect) => {
    if (url !== canonical && !tests.some((t) => t.url === url)) tests.push({ id, label, url, expect });
  };

  if (u.protocol === 'https:') {
    const http = new URL(canonical);
    http.protocol = 'http:';
    add('http', 'http:// version', http.href, 'redirect');
  }

  const www = new URL(canonical);
  www.hostname = toggleWww(u.hostname);
  add('www', `${www.hostname.startsWith('www.') ? 'With' : 'Without'} www`, www.href, 'redirect');

  if (u.pathname !== '/' && !/\.[a-z0-9]{2,5}$/i.test(u.pathname)) {
    const slash = new URL(canonical);
    slash.pathname = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : `${u.pathname}/`;
    add('slash', u.pathname.endsWith('/') ? 'Without trailing slash' : 'With trailing slash', slash.href, 'redirect');
  }

  if (u.protocol === 'https:') {
    const combo = new URL(canonical);
    combo.protocol = 'http:';
    combo.hostname = toggleWww(u.hostname);
    add('combo', 'http:// + www toggle', combo.href, 'redirect');
  }

  const fake = new URL(canonical);
  fake.pathname = `/pal-test-${rand}-404/`;
  fake.search = '';
  add('fake', 'Fake URL (should be 404)', fake.href, '404');

  return { canonical, tests };
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

/** True when Chrome redirected internally (HSTS upgrade) and no server answered. */
export function isInternalHop(hop) {
  return /internal redirect/i.test(hop.statusLine || '') || !!hop.nonAuthReason;
}

/**
 * Follow one URL and record every hop. Uses webRequest when granted;
 * otherwise falls back to what fetch() itself reports (no per-hop detail).
 */
export async function traceUrl(url) {
  const first = await traceOnce(url);
  if (first.observed || first.detail !== 'webRequest') return first;
  return traceOnce(url); // one retry if the listeners missed the request
}

async function traceOnce(url) {
  const wr = globalThis.chrome && chrome.webRequest;
  const ownOrigin = globalThis.location ? location.origin : '';
  const trace = { url, hops: [], finalUrl: '', finalStatus: 0, error: '', detail: wr ? 'webRequest' : 'fetch-only', ms: 0 };
  let requestId = null;
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  // Verified in Chromium: our own fetch carries initiator = this extension's
  // origin and type xmlhttprequest; tabId is the page's own tab, not -1.
  const mine = (d) => d.initiator === ownOrigin && d.type === 'xmlhttprequest';

  const onBefore = (d) => {
    if (requestId === null && mine(d) && d.url === url) requestId = d.requestId;
  };
  const onRedirect = (d) => {
    if (d.requestId !== requestId) return;
    trace.hopCount = (trace.hopCount || 0) + 1;
    if (trace.hops.length >= 10) return; // loops run to Chrome's limit of 20
    trace.hops.push({
      from: d.url,
      to: d.redirectUrl,
      status: d.statusCode,
      statusLine: d.statusLine || '',
      nonAuthReason: headerValue(d.responseHeaders, 'non-authoritative-reason'),
      location: headerValue(d.responseHeaders, 'location'),
      server: headerValue(d.responseHeaders, 'server'),
      cache: headerValue(d.responseHeaders, 'cf-cache-status') || headerValue(d.responseHeaders, 'x-cache') || '',
    });
  };
  const onDone = (d) => {
    if (d.requestId !== requestId) return;
    trace.finalUrl = d.url;
    trace.finalStatus = d.statusCode;
  };
  const onError = (d) => {
    if (d.requestId !== requestId) return;
    trace.finalUrl = d.url;
    if (d.error !== 'net::ERR_ABORTED') trace.error = d.error;
  };

  if (wr) {
    wr.onBeforeRequest.addListener(onBefore, filter);
    wr.onBeforeRedirect.addListener(onRedirect, filter, ['responseHeaders']);
    wr.onCompleted.addListener(onDone, filter);
    wr.onErrorOccurred.addListener(onError, filter);
    // addListener is registered asynchronously; a fast local fetch can start
    // before it lands (seen in testing), so give it a moment.
    await new Promise((r) => setTimeout(r, 40));
  }

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
    if (!trace.finalStatus) trace.finalStatus = res.status;
    if (!trace.finalUrl) trace.finalUrl = res.url;
    trace.fetchRedirected = res.redirected;
    try { await res.body?.cancel(); } catch (e) { /* body not needed */ }
  } catch (e) {
    if (!trace.error) trace.error = ctrl.signal.aborted ? 'timeout' : (e && e.message) || 'fetch failed';
  } finally {
    clearTimeout(timer);
    trace.ms = Date.now() - started;
    // onCompleted can land a tick after fetch resolves.
    await new Promise((r) => setTimeout(r, 50));
    if (wr) {
      wr.onBeforeRequest.removeListener(onBefore);
      wr.onBeforeRedirect.removeListener(onRedirect);
      wr.onCompleted.removeListener(onDone);
      wr.onErrorOccurred.removeListener(onError);
    }
  }
  trace.observed = requestId !== null;
  return trace;
}

/** Run every test one after another (parallel traces would mix up hops on slow hosts). */
export async function runRedirectTests(pageUrl, onProgress = () => {}) {
  const { canonical, tests } = buildTestUrls(pageUrl);
  const results = [];
  for (const t of tests) {
    onProgress(t);
    // eslint-disable-next-line no-await-in-loop
    results.push({ ...t, ...(await traceUrl(t.url)) });
  }
  return { canonical, collectedAt: new Date().toISOString(), webRequest: !!(globalThis.chrome && chrome.webRequest), results };
}
