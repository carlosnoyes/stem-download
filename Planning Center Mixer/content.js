// Planning Center Mixer - Content Script
// Runs on Planning Center pages to find and fetch audio stems

const findAudioFiles = () => {
    const files = [];
    const seen = new Set();

    const audioElements = document.querySelectorAll('[data-audio-src]');

    for (const el of audioElements) {
        const src = el.getAttribute('data-audio-src');
        const filename = el.getAttribute('data-audio-filename');
        const downloadSrc = el.getAttribute('data-audio-download-src');
        const fileId = el.getAttribute('data-file-id');

        if (!src || seen.has(src)) continue;
        seen.add(src);

        const path = downloadSrc || src;
        const url = path.startsWith('http') ? path : `${window.location.origin}${path}`;

        files.push({
            url,
            name: filename || `audio-${fileId || Date.now()}.mp3`,
            fileId: fileId || null,
            previewUrl: src.startsWith('http') ? src : `${window.location.origin}${src}`
        });
    }

    return files;
};

const downloadFile = async (url) => {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

const clickFilesTab = () => {
    const byId = document.getElementById('item-tab-files');
    if (byId) {
        const tab = byId.closest('[role="tab"]') || byId;
        tab.click();
        return true;
    }

    const tabs = document.querySelectorAll('[role="tab"]');
    for (const tab of tabs) {
        if (tab.textContent.includes('Files')) {
            tab.click();
            return true;
        }
    }

    const allElements = document.querySelectorAll('p, span, div, button, a');
    for (const el of allElements) {
        if (el.textContent.trim() === 'Files' && el.offsetParent !== null) {
            el.click();
            return true;
        }
    }

    return false;
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
        sendResponse({ alive: true });
        return true;
    }

    if (request.action === 'clickFilesTab') {
        const clicked = clickFilesTab();
        sendResponse({ clicked });
        return true;
    }

    if (request.action === 'getAudioFiles') {
        const files = findAudioFiles();
        sendResponse({ files });
        return true;
    }

    if (request.action === 'downloadFile') {
        downloadFile(request.url)
            .then(dataUrl => sendResponse({ success: true, dataUrl }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    sendResponse({ error: 'Unknown action' });
    return true;
});

console.log('[Planning Center Mixer] Content script loaded on', window.location.href);
