// Side panel controller.
// Security rules followed in this file:
//   1. Page data is shown with textContent only (never innerHTML).
//   2. Scripts run only on the active tab, using the activeTab grant that
//      Chrome gives when the user clicks the toolbar icon.
//   3. Nothing is sent over the network.

import { collectBasics } from '../modules/phase1-elements.js';

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
};

ui.version.textContent = `v${chrome.runtime.getManifest().version}`;

// Pages where Chrome never allows extensions to run scripts.
const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;

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

function render(data) {
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

async function runAudit(event) {
  event.preventDefault();
  ui.button.disabled = true;
  ui.result.hidden = true;
  setStatus('Reading the page…');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) throw new Error('No active tab found.');
    if (tab.url && RESTRICTED.test(tab.url)) {
      throw new Error('cannot be scripted');
    }

    const context = readContext(); // used by the rules engine from M5
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectBasics,
    });

    if (!injection || !injection.result) throw new Error('The page returned no data.');
    render(injection.result);
    setStatus(`Done. Context: ${context.pageType}, ${context.status}, ${context.model}.`);
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
