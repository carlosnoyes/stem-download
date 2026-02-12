// Planning Center Mixer - Background Service Worker
// Relays fetch requests from the mixer page to the content script,
// since chrome.tabs is not available on extension pages.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchStemFromTab') {
        chrome.tabs.sendMessage(request.tabId, {
            action: 'downloadFile',
            url: request.url
        }, (response) => {
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse(response);
            }
        });
        return true;
    }

    if (request.action === 'saveFile') {
        chrome.downloads.download({
            url: request.dataUrl,
            filename: request.filename,
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ success: true, downloadId });
            }
        });
        return true;
    }

    // Unknown action — respond so callers don't hang
    sendResponse({ success: false, error: `Unknown action: ${request.action}` });
    return false;
});
