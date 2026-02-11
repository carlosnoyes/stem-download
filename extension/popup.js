let audioFiles = [];
let currentTabId = null;

const statusEl = document.getElementById('status');
const scanBtn = document.getElementById('scanBtn');
const downloadBtn = document.getElementById('downloadBtn');
const filesList = document.getElementById('filesList');
const filesContainer = document.getElementById('files');

const updateStatus = (message, type = 'default') => {
    statusEl.textContent = message;
    statusEl.className = type;
};

// Ensure content script is injected into the tab
async function ensureContentScript(tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        if (response && response.alive) return true;
    } catch (e) {
        // Content script not there — inject it
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
        });
        await new Promise(r => setTimeout(r, 200));
        return true;
    } catch (e) {
        console.error('Failed to inject content script:', e);
        return false;
    }
}

// Send a message to the content script
function sendToContent(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

// Scan for audio files
scanBtn.addEventListener('click', async () => {
    audioFiles = [];
    filesContainer.innerHTML = '';
    filesList.style.display = 'none';
    updateStatus('Scanning for audio files...', 'loading');
    scanBtn.disabled = true;
    downloadBtn.disabled = true;

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab.url || !tab.url.includes('planningcenteronline.com')) {
            updateStatus('Not on a Planning Center page. Navigate to a plan first.', 'error');
            scanBtn.disabled = false;
            return;
        }

        currentTabId = tab.id;

        const injected = await ensureContentScript(tab.id);
        if (!injected) {
            updateStatus('Could not connect to page. Try refreshing the page.', 'error');
            scanBtn.disabled = false;
            return;
        }

        // Try clicking the Files tab (if a song drawer is open)
        try {
            await sendToContent(tab.id, { action: 'clickFilesTab' });
            await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
            console.log('Files tab click skipped:', e.message);
        }

        // Get audio files from the page
        const response = await sendToContent(tab.id, { action: 'getAudioFiles' });

        if (response && response.files && response.files.length > 0) {
            audioFiles = response.files;
            updateStatus(`Found ${audioFiles.length} audio file(s)!`, 'success');
            downloadBtn.disabled = false;

            filesContainer.innerHTML = audioFiles
                .map(f => `<div>&#9835; ${f.name}</div>`)
                .join('');
            filesList.style.display = 'block';
        } else {
            updateStatus(
                'No audio files found. Open a song (click on it) and make sure the Files tab is visible, then scan again.',
                'error'
            );
        }
    } catch (error) {
        console.error('Scan error:', error);
        updateStatus(`Error: ${error.message}`, 'error');
    }

    scanBtn.disabled = false;
});

// Download all files
downloadBtn.addEventListener('click', async () => {
    if (audioFiles.length === 0 || !currentTabId) {
        updateStatus('No files to download.', 'error');
        return;
    }

    downloadBtn.disabled = true;
    scanBtn.disabled = true;
    let downloaded = 0;

    try {
        for (let i = 0; i < audioFiles.length; i++) {
            const file = audioFiles[i];
            updateStatus(
                `Downloading ${i + 1}/${audioFiles.length}: ${file.name}`,
                'loading'
            );

            // Fetch file via content script (has page cookies)
            const result = await sendToContent(currentTabId, {
                action: 'downloadFile',
                url: file.url
            });

            if (!result || !result.success) {
                console.warn(`Failed to fetch ${file.name}:`, result?.error);
                continue;
            }

            // Send data URL to background script to trigger Chrome download
            const fileName = file.name.replace(/[<>:"/\\|?*]/g, '_');
            await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({
                    action: 'downloadFile',
                    dataUrl: result.dataUrl,
                    filename: fileName
                }, (resp) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(resp);
                    }
                });
            });

            downloaded++;
        }

        if (downloaded > 0) {
            updateStatus(`Downloaded ${downloaded} file(s)!`, 'success');
        } else {
            updateStatus('No files could be downloaded.', 'error');
        }
    } catch (error) {
        console.error('Download error:', error);
        updateStatus(`Error: ${error.message}`, 'error');
    }

    downloadBtn.disabled = false;
    scanBtn.disabled = false;
});
