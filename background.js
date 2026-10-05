// Background service worker.
// Its only job right now: open the side panel when the toolbar icon is clicked.
// Called on every worker start (not only on install) so the behaviour
// survives browser restarts and extension updates.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[Page Audit Lens] setPanelBehavior failed:', error));
