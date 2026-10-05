// Phase 1 module: Elements panel checks.
//
// IMPORTANT: every collector function here is injected into the audited page
// with chrome.scripting.executeScript({ func }). That means:
//   - it must be fully self-contained (no imports, no outside variables)
//   - it must only READ the page, never change it
//   - it must return plain data (strings, numbers, arrays, objects)
// The side panel renders that data with textContent only, never innerHTML,
// so nothing from the audited page can run inside the extension.

export const MODULE_INFO = {
  id: 'phase1-elements',
  name: 'Phase 1: Elements',
  version: '0.1.0',
};

/**
 * M1 collector: basic page identity.
 * Runs inside the audited page.
 */
export function collectBasics() {
  const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  return {
    url: clip(location.href, 2048),
    title: clip(document.title, 500),
    titleLength: document.title.length,
    lang: clip(document.documentElement.getAttribute('lang') || '', 35),
    collectedAt: new Date().toISOString(),
  };
}
