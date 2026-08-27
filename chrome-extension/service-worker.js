function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'pt-add-selection', title: 'Add selection to Project Tracker', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'pt-add-page', title: 'Add page to Project Tracker', contexts: ['page', 'link'] });
  });
}
chrome.runtime.onInstalled.addListener(installMenus);
chrome.runtime.onStartup.addListener(installMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const pending = {
    sourceUrl: info.linkUrl || info.pageUrl || (tab && tab.url) || '',
    sourceTitle: (tab && tab.title) || '',
    quote: info.selectionText || '',
    createdAt: Date.now()
  };
  await chrome.storage.local.set({ pendingCapture: pending });
  const url = chrome.runtime.getURL('popup.html?pending=1');
  chrome.windows.create({ url, type: 'popup', width: 430, height: 720 });
});
