// "Show on page": draws outline boxes over the elements behind a finding.
// Both functions are injected into the audited tab with chrome.scripting, so
// they must be self-contained (no imports, no outer variables).
//
// Safety: the page's own elements are never modified. Boxes live in a separate
// overlay element with a CLOSED shadow root, so page scripts and CSS cannot
// read or restyle it. Labels use textContent only.

export function highlightTargets(targets, label) {
  const HOST_ID = 'page-audit-lens-overlay';
  const old = document.getElementById(HOST_ID);
  if (old) old.remove();

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const found = new Set();
  const add = (el) => { if (el && found.size < 60) found.add(el); };
  const fileOf = (img) => (img.currentSrc || img.src || img.getAttribute('data-src') || '').split('?')[0].split('/').pop();

  (Array.isArray(targets) ? targets : []).forEach((t) => {
    if (!t || typeof t !== 'object') return;
    const value = typeof t.value === 'string' ? t.value : '';
    switch (t.kind) {
      case 'img':
        document.querySelectorAll('img').forEach((img) => { if (value && fileOf(img) === value) add(img); });
        break;
      case 'href':
        document.querySelectorAll('a[href]').forEach((a) => { const h = a.getAttribute('href'); if (value && (h === value || h.startsWith(value))) add(a); });
        break;
      case 'link':
        document.querySelectorAll('a[href]').forEach((a) => {
          const h = a.getAttribute('href');
          if (typeof t.href === 'string' && (h === t.href || h.startsWith(t.href)) && (!t.text || norm(a.textContent) === t.text)) add(a);
        });
        break;
      case 'linktext':
        document.querySelectorAll('a:not([href])').forEach((a) => { if (value && norm(a.textContent).startsWith(value)) add(a); });
        break;
      case 'text': {
        if (!value) break;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n && found.size < 60; n = walker.nextNode()) {
          if (n.nodeValue.includes(value) && n.parentElement && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentElement.tagName)) add(n.parentElement);
        }
        break;
      }
      case 'heading': {
        const sel = t.level >= 1 && t.level <= 6 ? `h${t.level}` : 'h1,h2,h3,h4,h5,h6';
        document.querySelectorAll(sel).forEach((h) => { if (!t.empty || !norm(h.textContent)) add(h); });
        break;
      }
      case 'desc': {
        // "tag#id.class1.class2" from the collector → CSS selector, escaped
        const m = value.match(/^([a-z0-9-]+)(?:#([^.]+))?((?:\.[^.]+)*)$/i);
        if (!m) break;
        let sel = m[1];
        if (m[2]) sel += `#${CSS.escape(m[2])}`;
        if (m[3]) sel += m[3].split('.').filter(Boolean).map((c) => `.${CSS.escape(c)}`).join('');
        try { document.querySelectorAll(sel).forEach(add); } catch (e) { /* invalid selector: skip */ }
        break;
      }
      case 'iframe-empty':
        document.querySelectorAll('iframe').forEach((f) => { if (!f.getAttribute('src')) add(f); });
        break;
      default:
        break;
    }
  });

  const els = [...found];
  const shown = els.filter(visible);
  if (!shown.length) return { found: els.length, shown: 0 };

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .box{position:absolute;border:3px solid #e8590c;border-radius:4px;background:rgba(232,89,12,.08);}
    .tag{position:absolute;top:-22px;left:-3px;max-width:320px;padding:2px 6px;border-radius:4px;background:#e8590c;color:#fff;
      font:600 12px/16px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}`;
  root.append(style);
  const sx = window.scrollX;
  const sy = window.scrollY;
  shown.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'box';
    box.style.left = `${r.left + sx - 3}px`;
    box.style.top = `${r.top + sy - 3}px`;
    box.style.width = `${r.width + 6}px`;
    box.style.height = `${r.height + 6}px`;
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = `${i + 1}/${shown.length} · ${String(label || '').slice(0, 60)}`;
    box.append(tag);
    root.append(box);
  });
  document.documentElement.append(host);
  shown[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  return { found: els.length, shown: shown.length };
}

export function clearHighlights() {
  const host = document.getElementById('page-audit-lens-overlay');
  if (host) host.remove();
  return true;
}
