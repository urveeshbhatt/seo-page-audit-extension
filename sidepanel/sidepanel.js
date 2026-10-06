// Side panel controller.
// Security rules followed in this file:
//   1. Page data is shown with textContent only (never innerHTML).
//   2. Scripts run only on the active tab, using the activeTab grant that
//      Chrome gives when the user clicks the toolbar icon.
//   3. Nothing is sent over the network.

import { collectBasics, collectHead } from '../modules/phase1-elements.js';
import { evaluateHead } from '../modules/phase1-rules.js';

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
  headCounts: $('head-counts'),
  headGroups: $('head-groups'),
  hideGood: $('head-hide-good'),
};

ui.version.textContent = `v${chrome.runtime.getManifest().version}`;

let lastHeadData = null; // raw data from the page (latest audit)
let lastHead = null; // { groups, counts } evaluated with the current context

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

function renderHead(result) {
  ui.headCounts.replaceChildren(
    ...COUNT_LABELS.map(([key, label]) => {
      const chip = el('div', `count count-${key}`);
      chip.append(el('span', 'count-num', String(result.counts[key])), el('span', 'count-label', label));
      return chip;
    }),
  );

  const hideGood = ui.hideGood.checked;
  const groups = result.groups.map((group) => {
    const visible = group.findings.filter((f) => !(hideGood && f.flag === 'good'));
    if (visible.length === 0) return null;
    const section = el('section', 'group');
    section.append(el('h3', 'group-title', group.title));
    const list = el('ul', 'findings');
    visible.forEach((f) => {
      const item = el('li', `finding finding-${f.flag}`);
      const top = el('div', 'finding-top');
      top.append(el('span', 'finding-check', f.check), el('span', `flag flag-${f.flag}`, f.label));
      item.append(top, el('div', 'finding-value mono wrap', f.value), el('p', 'finding-why', f.why));
      list.append(item);
    });
    section.append(list);
    return section;
  }).filter(Boolean);

  ui.headGroups.replaceChildren(...(groups.length ? groups : [el('p', 'hint', 'Everything passed. Untick "Hide passed checks" to see all.')]));
}

ui.hideGood.addEventListener('change', () => { if (lastHead) renderHead(lastHead); });

// Changing the context re-judges the same data, no need to audit again.
ui.form.addEventListener('change', () => {
  if (!lastHeadData) return;
  lastHead = evaluateHead(lastHeadData, readContext());
  renderHead(lastHead);
  const c = lastHead.counts;
  setStatus(`Re-judged with new context. ${c.critical} critical, ${c.warning} to check, ${c.good} passed.`);
});
ui.goHead.addEventListener('click', () => showTab('head'));

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
    lastHeadData = head;
    lastHead = evaluateHead(head, context);
    renderHead(lastHead);
    enableTab('head');
    ui.goHead.hidden = false;

    const c = lastHead.counts;
    setStatus(`Done. ${c.critical} critical, ${c.warning} to check, ${c.good} passed.`);
  } catch (error) {
    console.error('[Page Audit Lens]', error);
    setStatus(friendlyError(error), true);
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
