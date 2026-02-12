let audioFiles = [];
let currentTabId = null;

const statusEl = document.getElementById('status');
const scanBtn = document.getElementById('scanBtn');
const mixBtn = document.getElementById('mixBtn');
const downloadBtn = document.getElementById('downloadBtn');
const filesList = document.getElementById('filesList');
const filesContainer = document.getElementById('files');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');

const updateStatus = (message, type = 'default') => {
    statusEl.textContent = message;
    statusEl.className = type;
};

const updateProgress = (current, total) => {
    progressBar.style.display = 'block';
    progressFill.style.width = Math.round((current / total) * 100) + '%';
};

async function ensureContentScript(tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        if (response && response.alive) return true;
    } catch (e) { }

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
    progressBar.style.display = 'none';
    mixBtn.disabled = true;
    downloadBtn.disabled = true;
    updateStatus('Scanning for audio files...', 'loading');
    scanBtn.disabled = true;

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
            updateStatus('Could not connect to page. Try refreshing.', 'error');
            scanBtn.disabled = false;
            return;
        }

        // Try clicking the Files tab
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

            filesContainer.innerHTML = audioFiles
                .map(f => `<div>\u266B ${f.name}</div>`)
                .join('');
            filesList.style.display = 'block';

            updateStatus(`Found ${audioFiles.length} stem(s). Open in mixer or download!`, 'success');
            mixBtn.disabled = false;
            downloadBtn.disabled = false;
        } else {
            updateStatus(
                'No audio files found. Open a song and make sure the Files tab is visible, then scan again.',
                'error'
            );
        }
    } catch (error) {
        console.error('Scan error:', error);
        updateStatus(`Error: ${error.message}`, 'error');
    }

    scanBtn.disabled = false;
});

// Download all scanned files
downloadBtn.addEventListener('click', async () => {
    if (audioFiles.length === 0 || !currentTabId) {
        updateStatus('No files to download.', 'error');
        return;
    }

    downloadBtn.disabled = true;
    scanBtn.disabled = true;
    mixBtn.disabled = true;
    let downloaded = 0;
    const failed = [];

    try {
        for (let i = 0; i < audioFiles.length; i++) {
            const file = audioFiles[i];
            updateStatus(`Downloading ${i + 1}/${audioFiles.length}: ${file.name}`, 'loading');
            updateProgress(i + 1, audioFiles.length);

            const result = await sendToContent(currentTabId, {
                action: 'downloadFile',
                url: file.url
            });

            if (!result || !result.success) {
                console.warn(`Failed to fetch ${file.name}:`, result?.error);
                failed.push(file.name);
                continue;
            }

            const fileName = file.name.replace(/[<>:"/\\|?*]/g, '_');
            await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({
                    action: 'saveFile',
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

        if (downloaded > 0 && failed.length === 0) {
            updateStatus(`Downloaded ${downloaded} file(s)!`, 'success');
        } else if (downloaded > 0) {
            updateStatus(`Downloaded ${downloaded} file(s). Failed: ${failed.join(', ')}`, 'success');
        } else {
            updateStatus('No files could be downloaded.', 'error');
        }
    } catch (error) {
        console.error('Download error:', error);
        updateStatus(`Error: ${error.message}`, 'error');
    }

    progressBar.style.display = 'none';
    downloadBtn.disabled = false;
    scanBtn.disabled = false;
    mixBtn.disabled = false;
});

// Open the mixer with the scanned file list
mixBtn.addEventListener('click', async () => {
    if (audioFiles.length === 0 || !currentTabId) {
        updateStatus('No stems to mix.', 'error');
        return;
    }

    mixBtn.disabled = true;
    updateStatus('Opening mixer...', 'loading');

    // Pass file list and source tab ID via URL hash
    const payload = {
        sourceTabId: currentTabId,
        files: audioFiles
    };
    const hash = encodeURIComponent(JSON.stringify(payload));
    const mixerUrl = chrome.runtime.getURL('mixer.html') + '#' + hash;
    chrome.tabs.create({ url: mixerUrl });
});

// Open mixer directly without stems (manual file loading)
document.getElementById('openMixerBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('mixer.html') });
});
