// Background service worker.
//
// We handle the toolbar click ourselves (instead of openPanelOnActionClick),
// because action.onClicked reliably grants the activeTab permission for the
// clicked tab. The same happens for the keyboard shortcut (_execute_action).

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch((error) => console.error('[Page Audit Lens] setPanelBehavior failed:', error));

chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open must run inside the user gesture, so call it first, without awaiting anything before it.
  chrome.sidePanel
    .open({ windowId: tab.windowId })
    .catch((error) => console.error('[Page Audit Lens] sidePanel.open failed:', error));

  // Tell an already-open panel that this tab is now ready to audit.
  chrome.runtime
    .sendMessage({ type: 'tab-access-granted', tabId: tab.id })
    .catch(() => { /* panel not open yet: nothing to notify */ });
});
