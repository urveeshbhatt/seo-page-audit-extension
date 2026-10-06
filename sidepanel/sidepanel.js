// Side panel controller.
// Security rules followed in this file:
//   1. Page data is shown with textContent only (never innerHTML).
//   2. Scripts run only on the active tab, using the activeTab grant that
//      Chrome gives when the user clicks the toolbar icon.
//   3. Nothing is sent over the network.

import { collectBasics, collectHead, collectBody, collectHealth } from '../modules/phase1-elements.js';
import { evaluateHead } from '../modules/phase1-rules.js';
import { evaluateBody } from '../modules/phase1-body-rules.js';
import { evaluateHealth } from '../modules/phase1-health-rules.js';
import { buildSummary, VERDICTS } from '../modules/summary.js';

const $ = (id) => document.getElementById(id);

const ui = {
  form: $('context-form'),
  button: $('audit-btn'),
  status: $('status'),
  result: $('result'),
  url: $('out-url'),
  title: $('out-title'),
  titleLen: $('out-title-len'),
  titleFlag: $('out-title-flag'),
  lang: $('out-lang'),
  time: $('out-time'),
  version: $('version'),
  goHead: $('go-head'),
  goBody: $('go-body'),
  goHealth: $('go-health'),
  sumVerdict: $('sum-verdict'),
  sumTitle: $('sum-title'),
  sumLine: $('sum-line'),
  sumUrl: $('sum-url'),
  sumSections: $('sum-sections'),
  sumBody: $('sum-body'),
};

// One view per audit section. Each keeps the raw page data so a context change
// can re-judge it without touching the page again.
const views = {
  head: { evaluate: evaluateHead, counts: $('head-counts'), groups: $('head-groups'), hideGood: $('head-hide-good'), data: null, result: null },
  body: { evaluate: evaluateBody, counts: $('body-counts'), groups: $('body-groups'), hideGood: $('body-hide-good'), data: null, result: null },
  health: { evaluate: evaluateHealth, counts: $('health-counts'), groups: $('health-groups'), hideGood: $('health-hide-good'), data: null, result: null },
};

ui.version.textContent = `v${chrome.runtime.getManifest().version}`;


// Pages where Chrome never allows extensions to run scripts.
const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;

// ---------------- helpers ----------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // text only, never HTML
  return node;
}

function setStatus(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('is-error', isError);
}

function readContext() {
  const data = new FormData(ui.form);
  return {
    pageType: String(data.get('pageType')),
    status: String(data.get('status')),
    model: String(data.get('model')),
  };
}

// Title length rule from Phase 1 (Step 3A).
function titleFlag(length) {
  if (length === 0) return { text: 'Missing', cls: 'flag-critical' };
  if (length < 30) return { text: 'Short', cls: 'flag-warning' };
  if (length > 60) return { text: 'May be cut in Google', cls: 'flag-warning' };
  return { text: 'Good', cls: 'flag-good' };
}

function friendlyError(error) {
  const msg = String(error && error.message ? error.message : error);
  if (/Cannot access|activeTab|permission/i.test(msg)) {
    return 'No access to this tab yet. Click the Page Audit Lens icon in the toolbar (or press Alt+Shift+A) on this tab, then press Audit again.';
  }
  if (/cannot be scripted|chrome:\/\/|Chrome Web Store|extensions gallery/i.test(msg)) {
    return 'Chrome does not allow audits on this page (browser or Web Store page). Open a normal website.';
  }
  return `Audit failed: ${msg}`;
}

async function runInTab(tabId, func) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func });
  if (!injection || injection.result === undefined) throw new Error('The page returned no data.');
  return injection.result;
}

// ---------------- tabs ----------------

const tabButtons = [...document.querySelectorAll('.tab')];

function showTab(name) {
  tabButtons.forEach((b) => {
    const active = b.dataset.tab === name;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', String(active));
    if (active) b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // narrow panels: keep the active tab in view
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.hidden = p.id !== `panel-${name}`;
  });
}

tabButtons.forEach((b) => b.addEventListener('click', () => { if (!b.disabled) showTab(b.dataset.tab); }));

function enableTab(name) {
  const b = tabButtons.find((x) => x.dataset.tab === name);
  if (b) { b.disabled = false; b.removeAttribute('title'); }
}

// ---------------- rendering ----------------

function renderBasics(data) {
  ui.url.textContent = data.url;
  ui.title.textContent = data.title || '(empty)';
  ui.titleLen.textContent = `${data.titleLength} characters`;
  const flag = titleFlag(data.titleLength);
  ui.titleFlag.textContent = flag.text;
  ui.titleFlag.className = `flag ${flag.cls}`;
  ui.lang.textContent = data.lang || 'MISSING';
  ui.time.textContent = `Collected ${new Date(data.collectedAt).toLocaleTimeString()}`;
  ui.result.hidden = false;
}

const COUNT_LABELS = [
  ['critical', 'Critical'],
  ['warning', 'Check'],
  ['info', 'Info'],
  ['good', 'Passed'],
];

function renderFinding(f) {
  const item = el('li', `finding finding-${f.flag}`);
  const top = el('div', 'finding-top');
  top.append(el('span', 'finding-check', f.check), el('span', `flag flag-${f.flag}`, f.label));
  item.append(top, el('div', 'finding-value mono wrap', f.value), el('p', 'finding-why', f.why));
  if (f.items && f.items.length) {
    const details = el('details', 'finding-details');
    details.append(el('summary', null, `Show ${f.items.length} detail${f.items.length === 1 ? '' : 's'}`));
    const list = el('ul', 'detail-list mono');
    f.items.forEach((text) => list.append(el('li', 'wrap', text)));
    details.append(list);
    item.append(details);
  }
  return item;
}

function renderView(view) {
  const { result } = view;
  view.counts.replaceChildren(
    ...COUNT_LABELS.map(([key, label]) => {
      const chip = el('div', `count count-${key}`);
      chip.append(el('span', 'count-num', String(result.counts[key])), el('span', 'count-label', label));
      return chip;
    }),
  );

  const hideGood = view.hideGood.checked;
  const groups = result.groups.map((group) => {
    const visible = group.findings.filter((f) => !(hideGood && f.flag === 'good'));
    if (visible.length === 0) return null;
    const section = el('section', 'group');
    section.append(el('h3', 'group-title', group.title));
    const list = el('ul', 'findings');
    visible.forEach((f) => list.append(renderFinding(f)));
    section.append(list);
    return section;
  }).filter(Boolean);

  view.groups.replaceChildren(...(groups.length ? groups : [el('p', 'hint', 'Everything passed. Untick "Hide passed checks" to see all.')]));
}

function judge(name, context) {
  const view = views[name];
  if (!view.data) return;
  view.result = view.evaluate(view.data, context);
  renderView(view);
}

function totals() {
  const t = { critical: 0, warning: 0, good: 0, info: 0 };
  Object.values(views).forEach((v) => {
    if (v.result) Object.keys(t).forEach((k) => { t[k] += v.result.counts[k]; });
  });
  return t;
}

Object.values(views).forEach((view) => {
  view.hideGood.addEventListener('change', () => { if (view.result) renderView(view); });
});

// Changing the context re-judges the same data, no need to audit again.
ui.form.addEventListener('change', () => {
  if (!Object.values(views).some((v) => v.data)) return;
  const context = readContext();
  Object.keys(views).forEach((name) => judge(name, context));
  renderSummary();
  const c = totals();
  setStatus(`Re-judged with new context. ${c.critical} critical, ${c.warning} to check, ${c.good} passed.`);
});
ui.goHead.addEventListener('click', () => showTab('head'));
ui.goBody.addEventListener('click', () => showTab('body'));
ui.goHealth.addEventListener('click', () => showTab('health'));

// ---------------- summary ----------------

let lastUrl = '';
const checklist = new Set(); // ticked launch items for this audit (in memory only)

function verdictPill(key) {
  const v = VERDICTS[key];
  return el('span', `flag verdict-pill tone-${v.tone}`, v.label);
}

function summaryItem(f, index) {
  const item = el('li', `sum-item finding finding-${f.flag}`);
  const top = el('div', 'finding-top');
  const left = el('span', 'sum-check');
  if (index !== undefined) left.append(el('span', 'sum-num', `${index + 1}`));
  left.append(el('span', 'finding-check', f.check));
  const jump = el('button', 'section-link', f.sectionName);
  jump.type = 'button';
  jump.title = `Open the ${f.sectionName} tab`;
  jump.addEventListener('click', () => showTab(f.section));
  top.append(left, verdictPill(f.verdict));
  item.append(top, el('div', 'finding-value mono wrap', f.value), el('p', 'finding-why', f.why));
  const meta = el('div', 'sum-meta');
  meta.append(jump, el('span', 'sum-group', f.group));
  item.append(meta);
  return item;
}

function launchItem(f) {
  const item = el('li', 'check-item');
  const label = el('label', 'check-label');
  const box = el('input');
  box.type = 'checkbox';
  const key = `${f.section}:${f.id}`;
  box.checked = checklist.has(key);
  box.addEventListener('change', () => {
    if (box.checked) checklist.add(key); else checklist.delete(key);
    item.classList.toggle('is-done', box.checked);
  });
  item.classList.toggle('is-done', box.checked);
  const text = el('span', 'check-text');
  text.append(el('strong', null, f.check), el('span', 'check-value', ` · ${f.value}`));
  label.append(box, text);
  item.append(label);
  return item;
}

function collapsible(title, findings, render) {
  const details = el('details', 'sum-more');
  details.append(el('summary', null, `${title} (${findings.length})`));
  const list = el('ul', 'findings');
  findings.forEach((f) => list.append(render(f)));
  details.append(list);
  return details;
}

function compactItem(f) {
  const item = el('li', 'compact-item');
  const top = el('div', 'finding-top');
  top.append(el('span', 'finding-check', `${f.check}`), verdictPill(f.verdict));
  item.append(top, el('div', 'compact-value mono wrap', `${f.sectionName} · ${f.value}`));
  return item;
}

function renderSummary() {
  const results = {};
  Object.entries(views).forEach(([key, v]) => { if (v.result) results[key] = v.result; });
  if (!results.head) return;
  const s = buildSummary(results, readContext());

  ui.sumVerdict.className = `verdict tone-${s.overall.tone}`;
  ui.sumTitle.textContent = s.overall.title;
  ui.sumLine.textContent = s.overall.line;
  ui.sumUrl.textContent = lastUrl;

  ui.sumSections.replaceChildren(...s.sections.map((sec) => {
    const chip = el('button', 'section-chip');
    chip.type = 'button';
    chip.append(el('span', 'chip-name', sec.name));
    const n = el('span', 'chip-counts');
    if (sec.counts.critical) n.append(el('span', 'chip-c', `${sec.counts.critical} critical`));
    if (sec.counts.warning) n.append(el('span', 'chip-w', `${sec.counts.warning} check`));
    if (!sec.counts.critical && !sec.counts.warning) n.append(el('span', 'chip-g', 'all clear'));
    chip.append(n);
    chip.addEventListener('click', () => showTab(sec.key));
    return chip;
  }));

  const parts = [];
  if (s.top.length) {
    parts.push(el('h3', 'group-title', 'Fix first'));
    const list = el('ol', 'findings sum-top');
    s.top.forEach((f, i) => list.append(summaryItem(f, i)));
    parts.push(list);
  } else {
    parts.push(el('p', 'hint', 'Nothing to fix. See the review list below for small improvements.'));
  }

  if (s.prelaunch && s.launch.length) {
    parts.push(el('h3', 'group-title', 'Launch checklist'));
    parts.push(el('p', 'hint', 'Tick items as you fix them. Re-run the audit before launch day to confirm.'));
    const list = el('ul', 'checklist');
    s.launch.forEach((f) => list.append(launchItem(f)));
    parts.push(list);
  }

  const shown = new Set(s.top);
  const moreFixes = [...s.fixNow, ...s.launch, ...s.fixes].filter((f) => !shown.has(f));
  if (moreFixes.length) parts.push(collapsible('More fixes', moreFixes, compactItem));
  if (s.review.length) parts.push(collapsible('To review', s.review, compactItem));
  if (s.ignored.length) parts.push(collapsible('Known traps ignored', s.ignored, compactItem));
  parts.push(el('p', 'meta', `${s.passed} checks passed. Change the page context on Setup and the verdicts update instantly.`));

  ui.sumBody.replaceChildren(...parts);
}

// ---------------- audit ----------------

async function runAudit(event) {
  event.preventDefault();
  ui.button.disabled = true;
  ui.result.hidden = true;
  setStatus('Reading the page…');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) throw new Error('No active tab found.');
    if (tab.url && RESTRICTED.test(tab.url)) throw new Error('cannot be scripted');

    const context = readContext();
    const [basics, head] = await Promise.all([
      runInTab(tab.id, collectBasics),
      runInTab(tab.id, collectHead),
    ]);

    renderBasics(basics);
    lastUrl = basics.url;
    checklist.clear();
    views.head.data = head;
    judge('head', context);
    enableTab('head');
    ui.goHead.hidden = false;

    // Body and health checks run after head. A failure in one should not hide
    // the others. Body fetches the raw HTML, so it takes a moment longer.
    setStatus('Head done. Checking body and page health…');
    const failed = [];
    const sections = [
      ['health', collectHealth, ui.goHealth],
      ['body', collectBody, ui.goBody],
    ];
    await Promise.all(sections.map(async ([name, collector, button]) => {
      const view = views[name];
      view.data = null;
      view.result = null;
      try {
        view.data = await runInTab(tab.id, collector);
        judge(name, context);
        enableTab(name);
        button.hidden = false;
      } catch (sectionError) {
        if (!friendlyError(sectionError).startsWith('No access')) console.error(`[Page Audit Lens] ${name}`, sectionError);
        failed.push(name);
        view.counts.replaceChildren();
        view.groups.replaceChildren(el('p', 'hint', `The ${name} checks failed on this page. Other tabs are still valid.`));
      }
    }));
    renderSummary();
    enableTab('summary');
    if (failed.length) {
      setStatus(`Done, but ${failed.join(' and ')} checks failed on this page. See the other tabs.`, true);
      return;
    }

    const c = totals();
    setStatus(`Done. ${c.critical} critical, ${c.warning} to check, ${c.good} passed.`);
    showTab('summary');
  } catch (error) {
    const message = friendlyError(error);
    // Missing tab access is expected (user has not clicked the icon on this tab yet).
    // Show it in the panel only, so chrome://extensions → Errors stays for real bugs.
    if (!message.startsWith('No access') && !message.startsWith('Chrome does not allow')) console.error('[Page Audit Lens]', error);
    setStatus(message, true);
  } finally {
    ui.button.disabled = false;
  }
}

ui.form.addEventListener('submit', runAudit);

// The background worker tells us when the user clicked the icon (or used the
// shortcut) on a tab, which grants access to that tab.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return; // only trust our own extension
  if (message && message.type === 'tab-access-granted') {
    setStatus('Tab ready. Press "Audit this page".');
  }
});
