# Planning Center Audio Downloader - Chrome Extension

A Chrome extension that lets you download all audio stems from Planning Center Online as a ZIP file, directly from your browser.

## Installation & Usage

### Step 1: Install the Extension

1. **Open Chrome** and go to `chrome://extensions/`

2. **Enable "Developer mode"** (toggle in top-right corner)

3. **Click "Load unpacked"**

4. **Select this folder** (`stem-download/extension/`)

5. **Done!** The extension should now appear in your Chrome toolbar

### Step 2: Use the Extension

1. **Navigate** to any Planning Center plan with audio files
   - Example: https://services.planningcenteronline.com/plans/12345

2. **Click the extension icon** in your Chrome toolbar (the blue download icon)
   - A popup will appear

3. **Click "🔍 Scan for Audio Files"**
   - The extension will try to click the "Files" tab automatically
   - Then it waits for audio requests to be made
   - Any audio files found will be listed

4. **Click "📦 Download as ZIP"** 
   - A ZIP file will download with all the audio stems
   - Named: `planning-center-audio-YYYY-MM-DD.zip`

### Tips

- If the extension doesn't find files, try **manually clicking the "Files" tab** on the Planning Center page first
- Click the extension and then scan again
- Make sure you're logged into Planning Center
- The extension only runs on Planning Center pages

## How It Works

- **content.js** - Runs on Planning Center pages and intercepts all audio requests
- **popup.js** - Handles the UI and triggers the file download
- **background.js** - Downloads files and creates the ZIP

## Troubleshooting

**Extension not visible?**
- Make sure you're on a Planning Center page (services.planningcenteronline.com)
- Check that Developer mode is enabled in chrome://extensions/

**No files found?**
- Make sure the plan actually has media/audio files
- Try manually clicking different tabs on the page
- Refresh the page and try again

**Download didn't work?**
- Check your Downloads folder permissions
- Make sure JSZip library loads (requires internet connection)
- Try with a different plan

## Uninstalling

1. Go to `chrome://extensions/`
2. Find "Planning Center Audio Downloader"
3. Click the trash icon

---

Made with ❤️ for music teams
