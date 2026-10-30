// Phase 4 module: performance / Core Web Vitals checks (collector).
//
// collectPerformance() is injected into the audited page with
// chrome.scripting.executeScript({ func }), like the other collectors:
//   - fully self-contained (no imports, no outside variables)
//   - read-only: it never changes the page and makes NO network requests
//   - returns plain data only (strings, numbers, booleans, arrays, objects)
//
// It reads what Chrome already recorded for this visit: navigation and paint
// timings, the LCP entry, layout shifts, interactions (Event Timing), long
// animation frames (LoAF, with script attribution), resource timings and the
// running animations. Judgement lives in phase4-rules.js.

export const MODULE_INFO = {
  id: 'phase4-performance',
  name: 'Phase 4: Performance',
  version: '1.5.1',
};

export async function collectPerformance() {
  const clip = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
  const r0 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);
  const out = {
    url: clip(location.href, 2048),
    host: location.hostname,
    collectedAt: new Date().toISOString(),
    visibility: document.visibilityState,
    loafSupported: false,
    animationScan: 'running',
    nav: {},
    lcp: null,
    shifts: [],
    events: [],
    frames: [],
    renderBlocking: [],
    animations: [],
    resources: [],
    scripts: [],
    images: [],
    fonts: { files: [], preloaded: 0, faces: [], unreadableSheets: 0 },
    errors: [],
  };
  const err = (where, e) => { if (out.errors.length < 20) out.errors.push(clip(`${where}: ${e && e.message ? e.message : e}`, 200)); };

  // Short, valid CSS selector for an element (used for "Show on page").
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  const selectorOf = (node) => {
    let el = node;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || !el.tagName) return '';
    try {
      const tag = el.tagName.toLowerCase();
      if (el.id && el.id.length < 60) return clip(`${tag}#${esc(el.id)}`, 160);
      const cls = [...el.classList].filter((c) => c.length < 40 && !/^(is-|has-)?(active|loaded|lazyloaded|visible|show|open)$/i.test(c)).slice(0, 2);
      const own = cls.length ? `${tag}.${cls.map(esc).join('.')}` : tag;
      if (cls.length || !el.parentElement || el.parentElement === document.body) return clip(own, 160);
      return clip(`${selectorOf(el.parentElement)} > ${own}`, 160);
    } catch { return ''; }
  };

  // Entries Chrome already buffered for this page. buffered:true replays them.
  const supported = (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes) || [];
  const buffered = (type, extra = {}) => new Promise((resolve) => {
    if (!supported.includes(type)) { resolve(null); return; }
    let done = false;
    const got = [];
    try {
      const po = new PerformanceObserver((list) => { got.push(...list.getEntries()); });
      po.observe({ type, buffered: true, ...extra });
      setTimeout(() => {
        if (done) return;
        done = true;
        try { got.push(...po.takeRecords()); po.disconnect(); } catch { /* ignore */ }
        resolve(got);
      }, 120);
    } catch (e) { err(type, e); resolve(null); }
  });

  // ---------- navigation + paint ----------
  try {
    const n = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    out.nav = {
      ttfb: n ? r0(n.responseStart) : null,
      fcp: fcp ? r0(fcp.startTime) : null,
      dcl: n ? r0(n.domContentLoadedEventEnd) : null,
      load: n ? r0(n.loadEventEnd) : null,
      type: n ? clip(n.type, 20) : '',
    };
  } catch (e) { err('navigation', e); }

  const [lcpEntries, shiftEntries, eventEntries, loafEntries] = await Promise.all([
    buffered('largest-contentful-paint'),
    buffered('layout-shift'),
    buffered('event', { durationThreshold: 16 }),
    buffered('long-animation-frame'),
  ]);
  out.loafSupported = Array.isArray(loafEntries);

  // ---------- resources (also used for the LCP image and fonts) ----------
  let resources = [];
  try { resources = performance.getEntriesByType('resource').slice(0, 800); } catch (e) { err('resources', e); }
  const hostOf = (u) => { try { return new URL(u, location.href).hostname; } catch { return ''; } };
  const bytesOf = (r) => (r ? r.transferSize || r.encodedBodySize || 0 : 0);
  resources.forEach((r) => {
    out.resources.push({ host: hostOf(r.name), type: clip(r.initiatorType, 20), bytes: bytesOf(r), duration: r0(r.duration) });
    if (r.renderBlockingStatus === 'blocking' && out.renderBlocking.length < 40) {
      out.renderBlocking.push({ url: clip(r.name, 400), host: hostOf(r.name), type: clip(r.initiatorType, 20), duration: r0(r.responseEnd - r.startTime), bytes: bytesOf(r) });
    }
  });
  const resourceFor = (url) => {
    if (!url) return null;
    try { const list = performance.getEntriesByName(new URL(url, location.href).href, 'resource'); return list[list.length - 1] || null; } catch { return null; }
  };

  // ---------- LCP ----------
  try {
    const last = lcpEntries && lcpEntries[lcpEntries.length - 1];
    if (last) {
      const el = last.element;
      const tag = el && el.tagName ? el.tagName.toLowerCase() : '';
      const url = clip(last.url || '', 600);
      const res = resourceFor(url);
      out.lcp = {
        time: r0(last.renderTime || last.loadTime || last.startTime),
        tag,
        selector: el ? selectorOf(el) : '',
        url,
        size: r0(last.size),
        text: !url && el ? clip(String(el.textContent || '').replace(/\s+/g, ' ').trim(), 80) : '',
        resource: res ? { startTime: r0(res.startTime), requestStart: r0(res.requestStart), responseEnd: r0(res.responseEnd) } : null,
        img: null,
      };
      if (el && (tag === 'img' || tag === 'image')) {
        const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
        const target = abs(url);
        const preloaded = [...document.querySelectorAll('link[rel~="preload" i][as="image" i]')].some((l) => {
          if (abs(l.getAttribute('href') || '') === target) return true;
          return (l.getAttribute('imagesrcset') || '').split(',').some((part) => abs(part.trim().split(/\s+/)[0]) === target);
        });
        out.lcp.img = {
          loading: clip((el.getAttribute('loading') || '').toLowerCase(), 10),
          fetchpriority: clip((el.getAttribute('fetchpriority') || '').toLowerCase(), 10),
          decoding: clip(el.getAttribute('decoding') || '', 10),
          hasWidth: el.hasAttribute('width'),
          hasHeight: el.hasAttribute('height'),
          dataSrc: ['data-src', 'data-lazy-src', 'data-litespeed-src', 'data-lazyload'].some((a) => el.hasAttribute(a)) || /\blazyload\b/.test(el.className || ''),
          preloaded,
        };
      }
    }
  } catch (e) { err('lcp', e); }

  // ---------- layout shifts ----------
  (shiftEntries || []).slice(0, 400).forEach((s) => {
    try {
      out.shifts.push({
        value: Math.round(s.value * 100000) / 100000,
        time: r0(s.startTime),
        input: !!s.hadRecentInput,
        sources: (s.sources || []).slice(0, 5).map((src) => (src.node ? selectorOf(src.node) : '')).filter(Boolean),
      });
    } catch (e) { err('layout-shift', e); }
  });

  // ---------- interactions (Event Timing) ----------
  (eventEntries || []).filter((e) => e.interactionId).slice(0, 300).forEach((e) => {
    out.events.push({
      id: e.interactionId, name: clip(e.name, 30), duration: r0(e.duration), start: r0(e.startTime),
      processingStart: r0(e.processingStart), processingEnd: r0(e.processingEnd), target: e.target ? selectorOf(e.target) : '',
    });
  });

  // ---------- long animation frames (script attribution) ----------
  (loafEntries || []).slice().sort((a, b) => b.duration - a.duration).slice(0, 200).forEach((f) => {
    out.frames.push({
      start: r0(f.startTime), duration: r0(f.duration), blocking: r0(f.blockingDuration),
      scripts: (f.scripts || []).slice().sort((a, b) => b.duration - a.duration).slice(0, 6).map((s) => ({
        url: clip(s.sourceURL || '', 400), invoker: clip(s.invoker || '', 80), duration: r0(s.duration), forcedLayout: r0(s.forcedStyleAndLayoutDuration) || 0,
      })),
    });
  });

  // ---------- running animations ----------
  // document.getAnimations() costs time per running animation (14 s for 13,000
  // on a test page). On very large pages read the CSS @keyframes rules instead.
  const META = new Set(['offset', 'easing', 'composite', 'computedOffset']);
  if (document.getElementsByTagName('*').length > 15000) {
    out.animationScan = 'keyframes';
    const camel = (p) => p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const walkKeyframes = (rules, depth) => {
      if (!rules || depth > 4) return;
      [...rules].forEach((rule) => {
        if (out.animations.length >= 100) return;
        if (rule.type === 7 /* CSSKeyframesRule */) {
          const props = new Set();
          [...rule.cssRules].forEach((k) => { for (let i = 0; i < k.style.length; i += 1) props.add(camel(k.style[i])); });
          out.animations.push({ name: clip(rule.name, 80), target: '', props: [...props].slice(0, 12), infinite: null });
        } else if (rule.cssRules) walkKeyframes(rule.cssRules, depth + 1);
      });
    };
    [...document.styleSheets].slice(0, 200).forEach((sheet) => { try { walkKeyframes(sheet.cssRules, 0); } catch { /* cross-origin sheet */ } });
  } else try {
    (document.getAnimations ? document.getAnimations() : []).slice(0, 200).forEach((a) => {
      if (a.playState !== 'running' || !a.effect) return;
      const props = new Set();
      try { a.effect.getKeyframes().forEach((k) => Object.keys(k).forEach((p) => { if (!META.has(p)) props.add(p); })); } catch { /* ignore */ }
      if (!props.size && a.transitionProperty) props.add(a.transitionProperty);
      const timing = a.effect.getTiming ? a.effect.getTiming() : {};
      const target = a.effect.target ? selectorOf(a.effect.target) + (a.effect.pseudoElement || '') : '';
      // A CSS transition runs once after a state change (hover, a class added);
      // a CSS animation can loop. Only the second kind moves layout every frame.
      const kind = typeof CSSTransition !== 'undefined' && a instanceof CSSTransition ? 'transition'
        : typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation ? 'animation' : 'script';
      out.animations.push({ name: clip(a.animationName || a.transitionProperty || a.id || '', 80), target: clip(target, 180), props: [...props].slice(0, 12), infinite: timing.iterations === Infinity, kind });
    });
  } catch (e) { err('animations', e); }

  // ---------- scripts (for duplicate tags) ----------
  try {
    const seen = new Set();
    // A classic <script src> printed twice runs twice. A module script printed
    // twice is fetched and run once (the browser keeps one copy per URL), so
    // count it once: Shopify themes print the same module next to every block.
    document.querySelectorAll('script[src]').forEach((s) => {
      if (out.scripts.length >= 500) return;
      if (s.type === 'module' && seen.has(s.src)) return;
      out.scripts.push(clip(s.src, 400));
      seen.add(s.src);
    });
    resources.filter((r) => r.initiatorType === 'script' && !seen.has(r.name)).forEach((r) => { if (out.scripts.length < 500) { out.scripts.push(clip(r.name, 400)); seen.add(r.name); } });
  } catch (e) { err('scripts', e); }

  // ---------- images ----------
  // Only images a visitor can actually see count. Found on live sites: images in a
  // closed menu (height 0 + overflow hidden), opacity:0 zoom layers and slider
  // slides off screen to the right were reported as "above the fold".
  try {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const dpr = window.devicePixelRatio || 1;
    const clippedAway = (el, r) => {
      let o = el.parentElement;
      for (let depth = 0; o && o !== document.documentElement && depth < 25; depth += 1, o = o.parentElement) {
        const cs = getComputedStyle(o);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const p = o.getBoundingClientRect();
        if (Math.min(r.right, p.right) - Math.max(r.left, p.left) < 2 || Math.min(r.bottom, p.bottom) - Math.max(r.top, p.top) < 2) return true;
      }
      return false;
    };
    [...document.images].slice(0, 300).forEach((img) => {
      const rect = img.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return; // hidden or tracking pixel
      const style = getComputedStyle(img);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (img.checkVisibility ? !img.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : style.opacity === '0') return;
      if (clippedAway(img, rect)) return;
      const src = img.currentSrc || img.src || '';
      const res = resourceFor(src);
      out.images.push({
        src: clip(src, 400),
        selector: selectorOf(img),
        inViewport: rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0,
        positioned: style.position === 'absolute' || style.position === 'fixed',
        lazy: (img.getAttribute('loading') || '').toLowerCase() === 'lazy',
        hasSize: (img.hasAttribute('width') && img.hasAttribute('height')) || (!!style.aspectRatio && style.aspectRatio !== 'auto'),
        natural: img.naturalWidth || 0,
        shown: Math.round(rect.width),
        dpr,
        bytes: bytesOf(res),
      });
    });
  } catch (e) { err('images', e); }

  // ---------- fonts ----------
  try {
    resources.filter((r) => /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(r.name)).slice(0, 40)
      .forEach((r) => out.fonts.files.push({ url: clip(r.name, 300), host: hostOf(r.name), bytes: bytesOf(r) }));
    out.fonts.preloaded = document.querySelectorAll('link[rel~="preload" i][as="font" i]').length;
    const walk = (rules, depth) => {
      if (!rules || depth > 4) return;
      [...rules].forEach((rule) => {
        if (out.fonts.faces.length >= 100) return;
        if (rule.type === 5 /* CSSFontFaceRule */) {
          out.fonts.faces.push({
            family: clip(rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim(), 80),
            display: clip(rule.style.getPropertyValue('font-display').trim(), 20),
            inline: /url\(\s*["']?data:/i.test(rule.style.getPropertyValue('src')), // never downloaded
          });
        } else if (rule.cssRules) walk(rule.cssRules, depth + 1);
      });
    };
    [...document.styleSheets].slice(0, 200).forEach((sheet) => {
      try { walk(sheet.cssRules, 0); } catch { out.fonts.unreadableSheets += 1; }
    });
  } catch (e) { err('fonts', e); }

  return out;
}
