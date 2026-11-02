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
  version: '1.6.0',
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
    preloads: [],
    fonts: { files: [], preloaded: 0, faces: [], unreadableSheets: 0 },
    errors: [],
  };
  const err = (where, e) => { if (out.errors.length < 20) out.errors.push(clip(`${where}: ${e && e.message ? e.message : e}`, 200)); };
  out.imageScan = { total: 0, measured: 0, hidden: 0, pageHidden: '' };

  // srcset read the way the HTML spec reads it: a URL runs to the next space, then
  // its descriptor runs to the next comma. Shopify Dawn writes "a 165w,b 360w"
  // with no space after the comma, which a split on ", " misses entirely.
  const parseSrcset = (value) => {
    const s = String(value || '');
    const list = [];
    let i = 0;
    while (i < s.length && list.length < 60) {
      while (i < s.length && /[\s,]/.test(s[i])) i += 1;
      if (i >= s.length) break;
      const start = i;
      while (i < s.length && !/\s/.test(s[i])) i += 1;
      let url = s.slice(start, i);
      let descriptor = '';
      if (/,$/.test(url)) url = url.replace(/,+$/, '');
      else {
        const d0 = i;
        while (i < s.length && s[i] !== ',') i += 1;
        descriptor = s.slice(d0, i).trim();
      }
      if (url) list.push({ url, descriptor });
    }
    return list;
  };

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
          return parseSrcset(l.getAttribute('imagesrcset')).some((c) => abs(c.url) === target);
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
    // srcset / sizes, read the way the browser reads them, so the rules can say
    // WHY a file is the wrong size: "sizes says 412 px" or "no file between 352
    // and 832". naturalWidth is density-corrected for srcset images (it shows the
    // slot width), so the real file width is natural × (candidate w ÷ slot).
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
    const candidatesOf = (srcset) => parseSrcset(srcset).map(({ url: u, descriptor: d }) => {
      const m = /^(\d+(?:\.\d+)?)(w|x)$/i.exec(d || '1x');
      return u && m ? { url: abs(u), value: Number(m[1]), unit: m[2].toLowerCase() } : null;
    }).filter(Boolean);
    const topLevelSplit = (s) => {
      const parts = []; let depth = 0; let cur = '';
      for (const ch of String(s || '')) {
        if (ch === '(') depth += 1; else if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
      }
      if (cur.trim()) parts.push(cur.trim());
      return parts;
    };
    const LENGTH_AT_END = /((?:calc|min|max|clamp)\(.*\)|-?\d*\.?\d+(?:px|vw|vh|vmin|vmax|em|rem|%)|auto)\s*$/i;
    const measure = (length) => {
      // A custom tag with !important styles: themes hide empty divs
      // (Shopify Dawn: div:empty { display: none }), which measured 0.
      const probe = document.createElement('pal-size-probe');
      ['position:absolute', 'display:block', 'visibility:hidden', 'left:0', 'top:0', 'height:0', 'padding:0', 'border:0', 'margin:0', 'box-sizing:content-box', `width:${length}`]
        .forEach((d) => { const i = d.indexOf(':'); probe.style.setProperty(d.slice(0, i), d.slice(i + 1), 'important'); });
      document.documentElement.appendChild(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      return w;
    };
    const slotOf = (img, shownWidth) => {
      const entries = topLevelSplit(img.getAttribute('sizes') || '100vw');
      for (const entry of entries) {
        const m = LENGTH_AT_END.exec(entry);
        if (!m) continue;
        const media = entry.slice(0, m.index).trim();
        if (media && !(window.matchMedia && window.matchMedia(media).matches)) continue;
        if (/^auto$/i.test(m[1])) return shownWidth; // sizes="auto" (lazy images): the layout width
        const w = measure(m[1]);
        return Number.isFinite(w) && w > 0 ? Math.round(w) : null;
      }
      return Math.round(window.innerWidth); // nothing matched: the HTML default is 100vw
    };
    // A full-screen pop-up or a theme that fades the page in can hide every image
    // at audit time; count those so the report can say so instead of "all good".
    ['documentElement', 'body'].forEach((k) => {
      const el = document[k];
      if (!el || out.imageScan.pageHidden) return;
      const cs = getComputedStyle(el);
      if (cs.opacity === '0') out.imageScan.pageHidden = `${el.tagName} opacity 0`;
      else if (cs.visibility === 'hidden') out.imageScan.pageHidden = `${el.tagName} visibility hidden`;
    });
    [...document.images].slice(0, 300).forEach((img) => {
      const rect = img.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return; // hidden or tracking pixel
      out.imageScan.total += 1;
      const style = getComputedStyle(img);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (img.checkVisibility ? !img.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : style.opacity === '0') { out.imageScan.hidden += 1; return; }
      if (clippedAway(img, rect)) return;
      out.imageScan.measured += 1;
      const src = img.currentSrc || img.src || '';
      const res = resourceFor(src);
      const cands = candidatesOf(img.getAttribute('srcset'));
      const widths = [...new Set(cands.filter((c) => c.unit === 'w').map((c) => c.value))].sort((a, b) => a - b).slice(0, 30);
      const chosen = cands.find((c) => c.url === abs(src));
      const slot = widths.length ? slotOf(img, rect.width) : null;
      const natural = img.naturalWidth || 0;
      let file = natural;
      if (natural && chosen && chosen.unit === 'w' && slot) file = Math.round(natural * (chosen.value / slot));
      else if (natural && chosen && chosen.unit === 'x') file = Math.round(natural * chosen.value);
      out.images.push({
        slot,
        file,
        widths,
        type: clip(res && res.contentType ? res.contentType : '', 40),
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
    // FontFace.status tells whether any text needed the face: "loaded" once text
    // was drawn with it, "unloaded" when no text used it (even if a preload already
    // downloaded the file). Matched to the @font-face rule by family, weight, style.
    const norm = (s) => String(s || '').replace(/["']/g, '').trim().toLowerCase();
    const weightOf = (w) => ({ normal: '400', bold: '700' }[norm(w)] || norm(w) || '400');
    const statusOf = (family, weight, style) => {
      let found = '';
      try {
        document.fonts.forEach((f) => {
          if (norm(f.family) !== norm(family) || weightOf(f.weight) !== weightOf(weight) || (norm(f.style) || 'normal') !== (norm(style) || 'normal')) return;
          if (f.status === 'loaded' || !found) found = f.status;
        });
      } catch { /* FontFaceSet not available */ }
      return found;
    };
    const walk = (rules, depth, base) => {
      if (!rules || depth > 4) return;
      [...rules].forEach((rule) => {
        if (out.fonts.faces.length >= 100) return;
        if (rule.type === 5 /* CSSFontFaceRule */) {
          const family = rule.style.getPropertyValue('font-family');
          const weight = rule.style.getPropertyValue('font-weight');
          const fstyle = rule.style.getPropertyValue('font-style');
          const src = rule.style.getPropertyValue('src');
          const urls = [...src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((m) => m[1]).filter((u) => !/^data:/i.test(u))
            .map((u) => { try { return clip(new URL(u, base).href, 300); } catch { return ''; } }).filter(Boolean).slice(0, 4);
          out.fonts.faces.push({
            family: clip(family.replace(/["']/g, '').trim(), 80),
            weight: clip(weightOf(weight), 20),
            display: clip(rule.style.getPropertyValue('font-display').trim(), 20),
            inline: /url\(\s*["']?data:/i.test(src), // never downloaded
            status: clip(statusOf(family, weight, fstyle), 12),
            urls,
          });
        } else if (rule.cssRules) walk(rule.cssRules, depth + 1, base);
      });
    };
    [...document.styleSheets].slice(0, 200).forEach((sheet) => {
      try { walk(sheet.cssRules, 0, sheet.href || location.href); } catch { out.fonts.unreadableSheets += 1; }
    });
  } catch (e) { err('fonts', e); }

  // ---------- preloads: was each one used? ----------
  // A preload downloads early and competes with the files the first screen needs.
  // Fonts are judged with the @font-face status above (used: null here).
  try {
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
    const imageUrls = new Set();
    // open shadow roots (web components such as Shopify Horizon's <overflow-list>)
    // link their own stylesheets and images
    const roots = [document];
    [...document.querySelectorAll('*')].slice(0, 6000).forEach((el) => { if (el.shadowRoot && roots.length < 300) roots.push(el.shadowRoot); });
    const all = (sel) => roots.flatMap((r) => [...r.querySelectorAll(sel)]);
    all('img').slice(0, 1000).forEach((i) => {
      if (i.currentSrc) imageUrls.add(i.currentSrc);
      if (i.getAttribute('src')) imageUrls.add(abs(i.getAttribute('src')));
      parseSrcset(i.getAttribute('srcset')).forEach((c) => imageUrls.add(abs(c.url)));
    });
    all('picture source[srcset]').forEach((s) => parseSrcset(s.getAttribute('srcset')).forEach((c) => imageUrls.add(abs(c.url))));
    // CSS background images (hero sections often preload these)
    [...document.querySelectorAll('body *')].slice(0, 4000).forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') [...bg.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].forEach((m) => imageUrls.add(abs(m[1])));
    });
    const sheets = new Set([...document.styleSheets].map((s) => s.href).filter(Boolean));
    all('link[rel~="stylesheet" i][href]').forEach((l) => sheets.add(abs(l.getAttribute('href'))));
    const scripts = new Set([...document.scripts].map((s) => s.src).filter(Boolean));
    out.preloads = [...document.querySelectorAll('link[rel~="preload" i]')].slice(0, 60).map((l) => {
      const as = String(l.getAttribute('as') || '').toLowerCase();
      const url = abs(l.getAttribute('href') || '');
      const set = parseSrcset(l.getAttribute('imagesrcset')).map((c) => abs(c.url)).filter(Boolean);
      let used = null;
      if (as === 'image') used = [url, ...set].some((u) => u && imageUrls.has(u));
      else if (as === 'style') used = sheets.has(url);
      else if (as === 'script') used = scripts.has(url);
      return { url: clip(url || set[0] || '', 300), as: clip(as, 12), used };
    });
  } catch (e) { err('preloads', e); }

  return out;
}
