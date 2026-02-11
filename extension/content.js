// Find all audio files from data-audio-* attributes in the DOM
const findAudioFiles = () => {
    const files = [];
    const seen = new Set();

    // Primary method: elements with data-audio-src (the actual audio player rows)
    const audioElements = document.querySelectorAll('[data-audio-src]');

    for (const el of audioElements) {
        const src = el.getAttribute('data-audio-src');
        const filename = el.getAttribute('data-audio-filename');
        const downloadSrc = el.getAttribute('data-audio-download-src');
        const fileId = el.getAttribute('data-file-id');

        if (!src || seen.has(src)) continue;
        seen.add(src);

        // Build the full download URL
        // Prefer data-audio-download-src (direct attachment), fall back to preview src
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

// Download a single file and return it as base64
// This runs in the page context so it has the user's session cookies
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

// Click the Files tab in the currently open song drawer
const clickFilesTab = () => {
    // Method 1: by ID (most reliable based on actual DOM)
    const byId = document.getElementById('item-tab-files');
    if (byId) {
        const tab = byId.closest('[role="tab"]') || byId;
        tab.click();
        return true;
    }

    // Method 2: role="tab" elements, find the one containing "Files" text
    const tabs = document.querySelectorAll('[role="tab"]');
    for (const tab of tabs) {
        if (tab.textContent.includes('Files')) {
            tab.click();
            return true;
        }
    }

    // Method 3: any clickable element with text "Files" inside the song drawer
    const allElements = document.querySelectorAll('p, span, div, button, a');
    for (const el of allElements) {
        if (el.textContent.trim() === 'Files' && el.offsetParent !== null) {
            el.click();
            return true;
        }
    }

    return false;
};

// Listen for messages from popup
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
        // Download a single file in the page context (with cookies)
        downloadFile(request.url)
            .then(dataUrl => sendResponse({ success: true, dataUrl }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep channel open for async
    }

    sendResponse({ error: 'Unknown action' });
    return true;
});

console.log('[Audio Downloader] Content script loaded on', window.location.href);
