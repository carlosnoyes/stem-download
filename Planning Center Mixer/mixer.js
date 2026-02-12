// ===== Audio Engine =====
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let masterGain = null;
let analyserNode = null;

const stems = [];
let isPlaying = false;
let startTime = 0;
let pauseOffset = 0;
let playbackRate = 1;
let totalDuration = 0;
let userMasterVolume = 0.5;
let outLowOn = true;
let outMidOn = true;
let outHighOn = true;
let outBandNodes = null;

// Visualization
let vizMode = 'energy';
let vizAnimId = null;

// Spectrogram: time-indexed storage
// Map from time-slot index to computed frequency bins + mix revision
const spectrogramMap = new Map();
let spectroMixRevision = 0;
let spectroComputeQueued = false;
let spectroComputeInFlight = false;
let spectroComputeToken = 0;
const SPECTRO_PLAY_LOOKAHEAD_SLOTS = 96; // 8 beats at 1/12-beat slots
const SPECTRO_CHUNK_SLOTS = 48;          // 4 beats per offline render chunk
const SPECTRO_FREQ_BINS = 66;            // note-centered bands
const PIANO_A0_FREQ = 27.5;

function getPianoBandEdges(numBands = SPECTRO_FREQ_BINS) {
  const edges = new Float32Array(numBands + 1);
  const semitoneRatio = Math.pow(2, 1 / 12);
  const halfSemitoneRatio = Math.pow(2, 1 / 24);

  for (let i = 0; i < numBands; i++) {
    const center = PIANO_A0_FREQ * Math.pow(semitoneRatio, i);
    if (i === 0) edges[0] = center / halfSemitoneRatio;
    if (i < numBands - 1) {
      const nextCenter = PIANO_A0_FREQ * Math.pow(semitoneRatio, i + 1);
      edges[i + 1] = Math.sqrt(center * nextCenter);
    } else {
      edges[numBands] = center * halfSemitoneRatio;
    }
  }

  return edges;
}

function getPianoThirdBandSplits() {
  const edges = getPianoBandEdges(SPECTRO_FREQ_BINS);
  const i1 = Math.floor(SPECTRO_FREQ_BINS / 3);
  const i2 = Math.floor((2 * SPECTRO_FREQ_BINS) / 3);
  return { lowMidHz: edges[i1], midHighHz: edges[i2], i1, i2 };
}

function getVisibleSpectroBandWindow() {
  const { i1, i2 } = getPianoThirdBandSplits();
  // Special case requested: low+high on, mid off => show full range.
  if (outLowOn && outHighOn && !outMidOn) return { start: 0, end: SPECTRO_FREQ_BINS };
  if (outLowOn && outMidOn && outHighOn) return { start: 0, end: SPECTRO_FREQ_BINS };
  if (outLowOn && outMidOn) return { start: 0, end: i2 };
  if (outMidOn && outHighOn) return { start: i1, end: SPECTRO_FREQ_BINS };
  if (outLowOn) return { start: 0, end: i1 };
  if (outMidOn) return { start: i1, end: i2 };
  if (outHighOn) return { start: i2, end: SPECTRO_FREQ_BINS };
  return { start: 0, end: SPECTRO_FREQ_BINS };
}

// Energy visualization: precomputed from raw audio buffers
let energyData = null;       // Float32Array of RMS values
let energyOnsetData = null;  // Float32Array of onset/transient strength
let energySampleRate = 0;    // samples per second in energyData
const ENERGY_WINDOW_MS = 5;  // 5ms window for high resolution

// Metronome
let metronomeOn = false;
let metroBpm = 120;
let metroBeatsPerMeasure = 4;
let metroBeatUnit = 4;
let metronomeIntervalId = null;
let nextMetronomeBeatTime = 0;
let metronomeScheduleAhead = 0.1;
let metronomeLookAhead = 25;
let metronomeQueue = [];

// Loop
let loopStartBeat = null;
let loopEndBeat = null;
let loopCheckIntervalId = null;

// Zoom & Pan
let viewStart = 0;        // visible window start time (seconds)
let viewDuration = 0;     // visible window duration (seconds) — 0 means show all
let isPanning = false;
let panStartX = 0;
let panStartViewStart = 0;

function getViewStart() { return viewStart; }
function getViewEnd() {
  const vd = viewDuration > 0 ? viewDuration : totalDuration;
  return Math.min(viewStart + vd, totalDuration);
}
function getViewDuration() {
  return viewDuration > 0 ? viewDuration : totalDuration;
}

function autoFollowPlayhead() {
  if (!isPlaying || totalDuration === 0) return;
  const vd = getViewDuration();
  // Only auto-follow when zoomed in (window smaller than full track).
  if (vd <= 0 || vd >= totalDuration * 0.99) return;

  const t = getCurrentTime();
  const followTime = viewStart + vd * 0.8;
  if (t > followTime) {
    const newStart = Math.max(0, Math.min(t - vd * 0.8, totalDuration - vd));
    viewStart = newStart;
  }
}

function getSpectroSlotDuration() {
  const bpm = Math.max(1, metroBpm || 120);
  return (60 / bpm) / 12;
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function fftRadix2(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) return;

  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wlenCos = Math.cos(ang);
    const wlenSin = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + half] * wRe - im[i + k + half] * wIm;
        const vIm = re[i + k + half] * wIm + im[i + k + half] * wRe;

        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;

        const nextRe = wRe * wlenCos - wIm * wlenSin;
        wIm = wRe * wlenSin + wIm * wlenCos;
        wRe = nextRe;
      }
    }
  }
}

function computeSpectroBinsForSlot(channelData, sampleRate, i0, i1) {
  const slotSamples = Math.max(32, i1 - i0);
  const fftSize = Math.max(256, Math.min(4096, nextPowerOfTwo(slotSamples)));
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  let windowSum = 0;

  // Hann windowed frame from the slot signal (zero padded as needed)
  const len = Math.min(slotSamples, fftSize);
  for (let i = 0; i < len; i++) {
    const srcIdx = i0 + i;
    const x = srcIdx < channelData.length ? channelData[srcIdx] : 0;
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, len - 1)));
    re[i] = x * w;
    windowSum += w;
  }

  fftRadix2(re, im);

  const nyquist = sampleRate / 2;
  const freqRes = sampleRate / fftSize;
  const out = new Uint8Array(SPECTRO_FREQ_BINS);
  const dbFloor = -110;
  const dbCeil = -24;
  const ampNorm = Math.max(1e-9, windowSum);
  const bandEdges = getPianoBandEdges(SPECTRO_FREQ_BINS);

  for (let b = 0; b < SPECTRO_FREQ_BINS; b++) {
    const fLo = Math.max(1, bandEdges[b]);
    const fHi = Math.min(nyquist, bandEdges[b + 1]);
    if (fHi <= fLo) {
      out[b] = 0;
      continue;
    }

    let k0 = Math.floor(fLo / freqRes);
    let k1 = Math.ceil(fHi / freqRes);
    k0 = Math.max(1, Math.min(k0, (fftSize >> 1) - 1));
    k1 = Math.max(k0, Math.min(k1, (fftSize >> 1) - 1));

    let sumMag = 0;
    let count = 0;
    for (let k = k0; k <= k1; k++) {
      const mag = Math.hypot(re[k], im[k]);
      sumMag += mag;
      count++;
    }

    const avgMag = count > 0 ? (sumMag / count) : 0;
    const amp = (2 * avgMag) / ampNorm; // approximate one-sided amplitude (dBFS-like)
    const db = 20 * Math.log10(amp + 1e-12);
    const norm = Math.max(0, Math.min(1, (db - dbFloor) / (dbCeil - dbFloor)));
    out[b] = Math.round(norm * 255);
  }

  return out;
}

function clearSpectrogramFromSlot(startSlot) {
  for (const slot of spectrogramMap.keys()) {
    if (slot >= startSlot) spectrogramMap.delete(slot);
  }
}

function bumpSpectroMixRevision() {
  spectroMixRevision++;
  if (totalDuration === 0) return;
  const slotDur = getSpectroSlotDuration();
  const currentSlot = Math.max(0, Math.floor(getCurrentTime() / slotDur));
  clearSpectrogramFromSlot(currentSlot);
  queueSpectrogramCompute();
}

function resetSpectrogramCache() {
  spectrogramMap.clear();
  spectroComputeToken++;
  spectroComputeQueued = false;
  spectroComputeInFlight = false;
}

function queueSpectrogramCompute(force = false) {
  if (stems.length === 0 || totalDuration === 0) return;
  if (spectroComputeQueued || spectroComputeInFlight) return;
  spectroComputeQueued = true;
  setTimeout(async () => {
    spectroComputeQueued = false;
    await computeSpectrogramForward();
  }, 0);
}

async function computeSpectrogramForward() {
  if (spectroComputeInFlight || stems.length === 0 || totalDuration === 0) return;
  const slotDur = getSpectroSlotDuration();
  const totalSlots = Math.ceil(totalDuration / slotDur);
  const currentSlot = Math.max(0, Math.floor(getCurrentTime() / slotDur));
  if (currentSlot >= totalSlots) return;

  // Playing: only stay at/after current position + short lookahead (skip older gaps).
  // Paused: keep calculating forward to track end.
  const targetEndSlot = isPlaying
    ? Math.min(totalSlots, currentSlot + SPECTRO_PLAY_LOOKAHEAD_SLOTS)
    : totalSlots;

  let startSlot = -1;
  for (let s = currentSlot; s < targetEndSlot; s++) {
    const cached = spectrogramMap.get(s);
    if (!cached || cached.rev !== spectroMixRevision) {
      startSlot = s;
      break;
    }
  }
  if (startSlot < 0) return;

  const endSlot = Math.min(targetEndSlot, startSlot + SPECTRO_CHUNK_SLOTS);
  const startTimeSec = startSlot * slotDur;
  const endTimeSec = Math.min(totalDuration, endSlot * slotDur);

  const sampleRate = stems[0].buffer.sampleRate;
  const lengthSamples = Math.max(1, Math.ceil((endTimeSec - startTimeSec) * sampleRate));
  const anySolo = stems.some(s => s.solo);
  const audible = stems.filter(s => !(s.muted || (anySolo && !s.solo) || s.volume === 0));

  const token = ++spectroComputeToken;
  spectroComputeInFlight = true;

  if (audible.length === 0) {
    for (let s = startSlot; s < endSlot; s++) {
      spectrogramMap.set(s, { bins: new Uint8Array(SPECTRO_FREQ_BINS), rev: spectroMixRevision });
    }
    spectroComputeInFlight = false;
    queueSpectrogramCompute();
    return;
  }

  try {
    const offCtx = new OfflineAudioContext(1, lengthSamples, sampleRate);
    const mixBus = offCtx.createGain();
    for (const stem of audible) {
      const source = offCtx.createBufferSource();
      source.buffer = stem.buffer;

      const gain = offCtx.createGain();
      gain.gain.value = stem.volume;
      source.connect(gain);
      gain.connect(mixBus);

      source.start(0, startTimeSec);
    }
    connectOutputBandGraphOffline(offCtx, mixBus, offCtx.destination);

    const rendered = await offCtx.startRendering();
    if (token !== spectroComputeToken) {
      spectroComputeInFlight = false;
      return;
    }

    const channelData = rendered.getChannelData(0);
    for (let s = startSlot; s < endSlot; s++) {
      const localStartSec = (s - startSlot) * slotDur;
      const localEndSec = Math.min((s - startSlot + 1) * slotDur, endTimeSec - startTimeSec);
      const i0 = Math.max(0, Math.floor(localStartSec * sampleRate));
      const i1 = Math.max(i0 + 1, Math.min(channelData.length, Math.ceil(localEndSec * sampleRate)));

      const bins = computeSpectroBinsForSlot(channelData, sampleRate, i0, i1);
      spectrogramMap.set(s, { bins, rev: spectroMixRevision });
    }
  } catch (e) {
    console.error('Spectrogram offline render failed', e);
  } finally {
    spectroComputeInFlight = false;
    queueSpectrogramCompute();
  }
}

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new AudioCtx();
    masterGain = audioCtx.createGain();
    userMasterVolume = parseFloat(document.getElementById('masterVolume').value);
    masterGain.gain.value = userMasterVolume;
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    setupOutputBandGraph();
    analyserNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  updateMasterOutputGain();
  updateOutputBandGains();
}

function setupOutputBandGraph() {
  if (!audioCtx || !masterGain || !analyserNode || outBandNodes) return;
  const { lowMidHz, midHighHz } = getPianoThirdBandSplits();

  const lowpass = audioCtx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = lowMidHz;
  lowpass.Q.value = 0.707;
  const lowGain = audioCtx.createGain();

  const midHp = audioCtx.createBiquadFilter();
  midHp.type = 'highpass';
  midHp.frequency.value = lowMidHz;
  midHp.Q.value = 0.707;
  const midLp = audioCtx.createBiquadFilter();
  midLp.type = 'lowpass';
  midLp.frequency.value = midHighHz;
  midLp.Q.value = 0.707;
  const midGain = audioCtx.createGain();

  const highpass = audioCtx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = midHighHz;
  highpass.Q.value = 0.707;
  const highGain = audioCtx.createGain();

  masterGain.connect(lowpass);
  lowpass.connect(lowGain);
  lowGain.connect(analyserNode);

  masterGain.connect(midHp);
  midHp.connect(midLp);
  midLp.connect(midGain);
  midGain.connect(analyserNode);

  masterGain.connect(highpass);
  highpass.connect(highGain);
  highGain.connect(analyserNode);

  outBandNodes = { lowGain, midGain, highGain };
}

function updateOutputBandGains() {
  if (!outBandNodes) return;
  const t = audioCtx ? audioCtx.currentTime : 0;
  outBandNodes.lowGain.gain.setTargetAtTime(outLowOn ? 1 : 0, t, 0.01);
  outBandNodes.midGain.gain.setTargetAtTime(outMidOn ? 1 : 0, t, 0.01);
  outBandNodes.highGain.gain.setTargetAtTime(outHighOn ? 1 : 0, t, 0.01);
}

function connectOutputBandGraphOffline(ctx, inputNode, outputNode) {
  const { lowMidHz, midHighHz } = getPianoThirdBandSplits();

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = lowMidHz;
  lowpass.Q.value = 0.707;
  const lowGain = ctx.createGain();
  lowGain.gain.value = outLowOn ? 1 : 0;

  const midHp = ctx.createBiquadFilter();
  midHp.type = 'highpass';
  midHp.frequency.value = lowMidHz;
  midHp.Q.value = 0.707;
  const midLp = ctx.createBiquadFilter();
  midLp.type = 'lowpass';
  midLp.frequency.value = midHighHz;
  midLp.Q.value = 0.707;
  const midGain = ctx.createGain();
  midGain.gain.value = outMidOn ? 1 : 0;

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = midHighHz;
  highpass.Q.value = 0.707;
  const highGain = ctx.createGain();
  highGain.gain.value = outHighOn ? 1 : 0;

  inputNode.connect(lowpass);
  lowpass.connect(lowGain);
  lowGain.connect(outputNode);

  inputNode.connect(midHp);
  midHp.connect(midLp);
  midLp.connect(midGain);
  midGain.connect(outputNode);

  inputNode.connect(highpass);
  highpass.connect(highGain);
  highGain.connect(outputNode);
}

function getMixCompensationGain() {
  if (stems.length === 0) return 1;
  const anySolo = stems.some(s => s.solo);
  let power = 0;
  for (const stem of stems) {
    const effectivelyMuted = stem.muted || (anySolo && !stem.solo);
    if (effectivelyMuted) continue;
    const v = Math.max(0, stem.volume || 0);
    power += v * v;
  }
  // Equal-power normalization: keeps loudness more stable as stems are added.
  return 1 / Math.max(1, Math.sqrt(power));
}

function updateMasterOutputGain() {
  if (!masterGain) return;
  // UI range is 0..1; map to 0..2 internal gain to preserve previous max loudness.
  const target = (userMasterVolume * 2) * getMixCompensationGain();
  if (audioCtx) {
    masterGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.02);
  } else {
    masterGain.gain.value = target;
  }
}

function updateOutputFilterButtons() {
  const lowBtn = document.getElementById('outLowBtn');
  const midBtn = document.getElementById('outMidBtn');
  const highBtn = document.getElementById('outHighBtn');
  lowBtn.classList.toggle('active', outLowOn);
  midBtn.classList.toggle('active', outMidOn);
  highBtn.classList.toggle('active', outHighOn);
}

function handleOutputFilterChanged() {
  updateOutputFilterButtons();
  updateOutputBandGains();
  handleMixStateChanged();
}

// ===== File Loading =====
const SUPPORTED = ['.mp3','.wav','.ogg','.flac','.aac','.m4a','.webm'];

document.getElementById('loadFolderBtn').addEventListener('click', async () => {
  try {
    const dirHandle = await window.showDirectoryPicker();
    const files = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file') {
        const ext = '.' + entry.name.split('.').pop().toLowerCase();
        if (SUPPORTED.includes(ext)) {
          const file = await entry.getFile();
          files.push(file);
        }
      }
    }
    if (files.length === 0) { alert('No supported audio files found in folder.'); return; }
    files.sort((a, b) => a.name.localeCompare(b.name));
    await loadFiles(files);
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
});

document.getElementById('loadFilesBtn').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = SUPPORTED.join(',');
  input.onchange = async () => {
    const files = Array.from(input.files).filter(f => {
      const ext = '.' + f.name.split('.').pop().toLowerCase();
      return SUPPORTED.includes(ext);
    });
    if (files.length === 0) { alert('No supported audio files selected.'); return; }
    files.sort((a, b) => a.name.localeCompare(b.name));
    await loadFiles(files);
  };
  input.click();
});

async function loadFiles(files) {
  ensureAudioCtx();
  stopPlayback();
  stems.length = 0;
  resetSpectrogramCache();

  const container = document.getElementById('stemsContainer');
  container.innerHTML = '<div class="empty-msg">Loading stems...</div>';

  for (const file of files) {
    try {
      const arrayBuf = await file.arrayBuffer();
      const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
      stems.push({
        name: file.name.replace(/\.[^.]+$/, ''),
        buffer: audioBuf,
        sourceNode: null,
        gainNode: null,
        filterNode: null,
        muted: false,
        solo: false,
        volume: 1,
        filterOn: false,
        lowFreq: 20,
        highFreq: 20000,
      });
    } catch (e) {
      console.error('Failed to decode', file.name, e);
    }
  }

  totalDuration = Math.max(...stems.map(s => s.buffer.duration));
  pauseOffset = 0;
  viewStart = 0;
  viewDuration = 0; // show all
  updateMasterOutputGain();
  computeEnergyData();
  renderStems();
  startVisualization();
  await autoDetectBpmAfterLoad();
  queueSpectrogramCompute(true);
}

async function autoDetectBpmAfterLoad() {
  if (stems.length === 0) return;
  const btn = document.getElementById('autoBpmBtn');
  const prevText = btn.textContent;
  btn.textContent = '...';
  btn.disabled = true;

  try {
    const detected = await detectBPM();
    if (detected) {
      metroBpm = detected;
      document.getElementById('metroBpm').value = detected;
      resetSpectrogramCache();
    }
  } catch (e) {
    console.error('Auto BPM after load failed', e);
  } finally {
    btn.textContent = prevText;
    btn.disabled = false;
  }
}

let energyComputeTimer = null;

function scheduleEnergyRecompute() {
  if (energyComputeTimer) clearTimeout(energyComputeTimer);
  energyComputeTimer = setTimeout(() => computeEnergyData(), 80);
}

function handleMixStateChanged() {
  scheduleEnergyRecompute();
  bumpSpectroMixRevision();
}

function computeEnergyData() {
  if (stems.length === 0 || totalDuration === 0) {
    energyData = null;
    energyOnsetData = null;
    return;
  }

  const anySolo = stems.some(s => s.solo);
  const sampleRate = stems[0].buffer.sampleRate;
  const windowSamples = Math.floor(sampleRate * ENERGY_WINDOW_MS / 1000);
  const totalSamples = Math.floor(totalDuration * sampleRate);
  const numWindows = Math.ceil(totalSamples / windowSamples);
  energySampleRate = 1000 / ENERGY_WINDOW_MS;

  energyData = new Float32Array(numWindows);
  energyOnsetData = new Float32Array(numWindows);

  // Mix audible stems down to mono, respecting mute/solo/volume/filter
  for (let w = 0; w < numWindows; w++) {
    const startSample = w * windowSamples;
    const endSample = Math.min(startSample + windowSamples, totalSamples);
    let sumSq = 0;
    let count = 0;

    for (const stem of stems) {
      // Skip muted stems; if any solo exists, skip non-soloed
      const muted = stem.muted || (anySolo && !stem.solo);
      if (muted) continue;

      const vol = stem.volume;
      if (vol === 0) continue;

      const buf = stem.buffer;
      const numChannels = buf.numberOfChannels;
      for (let ch = 0; ch < numChannels; ch++) {
        const channelData = buf.getChannelData(ch);
        for (let s = startSample; s < endSample && s < channelData.length; s++) {
          // Apply volume; filter is approximated below
          const sample = channelData[s] * vol;
          sumSq += sample * sample;
          count++;
        }
      }
    }

    energyData[w] = count > 0 ? Math.sqrt(sumSq / count) : 0;
  }

  // If output band filtering is engaged, recompute with offline rendering for accuracy
  const anyFilter = !(outLowOn && outMidOn && outHighOn);
  if (anyFilter) {
    computeEnergyFiltered();
    return;
  }

  finalizeEnergy(numWindows);
}

async function computeEnergyFiltered() {
  const sampleRate = stems[0].buffer.sampleRate;
  const totalSamples = Math.floor(totalDuration * sampleRate);
  const anySolo = stems.some(s => s.solo);

  // Render the audible mix offline with filters applied
  const offCtx = new OfflineAudioContext(1, totalSamples, sampleRate);

  const mixBus = offCtx.createGain();
  for (const stem of stems) {
    const muted = stem.muted || (anySolo && !stem.solo);
    if (muted || stem.volume === 0) continue;

    const source = offCtx.createBufferSource();
    source.buffer = stem.buffer;

    const gain = offCtx.createGain();
    gain.gain.value = stem.volume;
    source.connect(gain);
    gain.connect(mixBus);

    source.start(0);
  }
  connectOutputBandGraphOffline(offCtx, mixBus, offCtx.destination);

  try {
    const rendered = await offCtx.startRendering();
    const channelData = rendered.getChannelData(0);
    const windowSamples = Math.floor(sampleRate * ENERGY_WINDOW_MS / 1000);
    const numWindows = Math.ceil(totalSamples / windowSamples);

    energyData = new Float32Array(numWindows);
    energyOnsetData = new Float32Array(numWindows);

    for (let w = 0; w < numWindows; w++) {
      const start = w * windowSamples;
      const end = Math.min(start + windowSamples, totalSamples);
      let sumSq = 0;
      for (let s = start; s < end; s++) {
        sumSq += channelData[s] * channelData[s];
      }
      energyData[w] = Math.sqrt(sumSq / (end - start));
    }

    finalizeEnergy(numWindows);
  } catch (e) {
    console.error('Offline render failed', e);
  }
}

function finalizeEnergy(numWindows) {
  // Normalize energy to 0..1
  let maxEnergy = 0;
  for (let i = 0; i < numWindows; i++) {
    if (energyData[i] > maxEnergy) maxEnergy = energyData[i];
  }
  if (maxEnergy > 0) {
    for (let i = 0; i < numWindows; i++) {
      energyData[i] /= maxEnergy;
    }
  }

  // Onset detection
  for (let i = 1; i < numWindows; i++) {
    const diff = energyData[i] - energyData[i - 1];
    energyOnsetData[i] = diff > 0 ? diff : 0;
  }
  energyOnsetData[0] = energyData[0];

  let maxOnset = 0;
  for (let i = 0; i < numWindows; i++) {
    if (energyOnsetData[i] > maxOnset) maxOnset = energyOnsetData[i];
  }
  if (maxOnset > 0) {
    for (let i = 0; i < numWindows; i++) {
      energyOnsetData[i] /= maxOnset;
    }
  }
}

async function detectBPM() {
  if (stems.length === 0 || totalDuration === 0) return null;

  const sampleRate = stems[0].buffer.sampleRate;
  const totalSamples = Math.floor(totalDuration * sampleRate);
  const anySolo = stems.some(s => s.solo);

  // Render all audible stems through a 3kHz highpass to isolate hi-hats/snare
  const offCtx = new OfflineAudioContext(1, totalSamples, sampleRate);

  let hasAudible = false;
  for (const stem of stems) {
    const muted = stem.muted || (anySolo && !stem.solo);
    if (muted || stem.volume === 0) continue;
    hasAudible = true;

    const source = offCtx.createBufferSource();
    source.buffer = stem.buffer;

    const gain = offCtx.createGain();
    gain.gain.value = stem.volume;
    source.connect(gain);

    // Highpass at 3kHz to focus on transients (hi-hats, snare attack)
    const hp = offCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    hp.Q.value = 0.7;
    gain.connect(hp);
    hp.connect(offCtx.destination);

    source.start(0);
  }

  if (!hasAudible) return null;

  let rendered;
  try {
    rendered = await offCtx.startRendering();
  } catch (e) {
    console.error('BPM offline render failed', e);
    return null;
  }

  const channelData = rendered.getChannelData(0);
  const windowMs = ENERGY_WINDOW_MS;
  const windowSamples = Math.floor(sampleRate * windowMs / 1000);
  const numWindows = Math.ceil(totalSamples / windowSamples);
  const sampleRateHz = 1000 / windowMs;

  // Compute RMS energy per window from highpassed signal
  const hfEnergy = new Float32Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    const start = w * windowSamples;
    const end = Math.min(start + windowSamples, totalSamples);
    let sumSq = 0;
    for (let s = start; s < end; s++) {
      sumSq += channelData[s] * channelData[s];
    }
    hfEnergy[w] = Math.sqrt(sumSq / (end - start));
  }

  // Normalize
  let maxE = 0;
  for (let i = 0; i < numWindows; i++) if (hfEnergy[i] > maxE) maxE = hfEnergy[i];
  if (maxE > 0) for (let i = 0; i < numWindows; i++) hfEnergy[i] /= maxE;

  // Onset detection on highpassed energy
  const onsets = new Float32Array(numWindows);
  for (let i = 1; i < numWindows; i++) {
    const diff = hfEnergy[i] - hfEnergy[i - 1];
    onsets[i] = diff > 0 ? diff : 0;
  }
  onsets[0] = hfEnergy[0];
  let maxO = 0;
  for (let i = 0; i < numWindows; i++) if (onsets[i] > maxO) maxO = onsets[i];
  if (maxO > 0) for (let i = 0; i < numWindows; i++) onsets[i] /= maxO;

  // Autocorrelation on onset data
  const minLag = Math.floor(sampleRateHz * 60 / 400);
  const maxLag = Math.ceil(sampleRateHz * 60 / 40);
  const analyzeLen = Math.min(numWindows, Math.floor(30 * sampleRateHz));

  const corr = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag && lag < analyzeLen; lag++) {
    let sum = 0;
    const count = analyzeLen - lag;
    for (let i = 0; i < count; i++) {
      sum += onsets[i] * onsets[i + lag];
    }
    corr[lag] = sum / count;
  }

  // Find best lag with musical weighting
  let bestLag = minLag;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < analyzeLen; lag++) {
    const bpm = (sampleRateHz * 60) / lag;
    let weight = 1;
    if (bpm >= 80 && bpm <= 160) weight = 1.3;
    else if (bpm >= 60 && bpm <= 200) weight = 1.1;

    const weighted = corr[lag] * weight;
    if (weighted > bestVal) {
      bestVal = weighted;
      bestLag = lag;
    }
  }

  // Refine: check double/half tempo
  const bestBpm = (sampleRateHz * 60) / bestLag;
  const halfLag = Math.round(bestLag / 2);
  const doubleLag = bestLag * 2;

  if (halfLag >= minLag && halfLag <= maxLag) {
    const halfBpm = bestBpm * 2;
    if (halfBpm >= 80 && halfBpm <= 400 && corr[halfLag] > corr[bestLag] * 0.8) {
      return Math.round(halfBpm);
    }
  }

  if (doubleLag >= minLag && doubleLag <= maxLag && doubleLag < analyzeLen) {
    const doubleBpm = bestBpm / 2;
    if (doubleBpm >= 80 && doubleBpm <= 160 && corr[doubleLag] > corr[bestLag] * 0.9) {
      return Math.round(doubleBpm);
    }
  }

  return Math.round(bestBpm);
}

document.getElementById('autoBpmBtn').addEventListener('click', async () => {
  if (stems.length === 0) {
    alert('Load audio stems first.');
    return;
  }

  const btn = document.getElementById('autoBpmBtn');
  btn.textContent = '...';
  btn.disabled = true;

  try {
    const detected = await detectBPM();
    if (detected) {
      metroBpm = detected;
      document.getElementById('metroBpm').value = detected;
      resetSpectrogramCache();
      queueSpectrogramCompute(true);
    } else {
      alert('Could not detect BPM.');
    }
  } finally {
    btn.textContent = 'Auto';
    btn.disabled = false;
  }
});

// ===== Playback =====
function createSourceNodes() {
  const anySolo = stems.some(s => s.solo);
  for (const stem of stems) {
    const source = audioCtx.createBufferSource();
    source.buffer = stem.buffer;
    source.playbackRate.value = playbackRate;

    const gain = audioCtx.createGain();
    const effectivelyMuted = stem.muted || (anySolo && !stem.solo);
    gain.gain.value = effectivelyMuted ? 0 : stem.volume;

    stem.gainNode = gain;
    source.connect(gain);
    gain.connect(masterGain);
    stem.filterNode = null;

    stem.sourceNode = source;
  }
}

function startPlayback() {
  if (stems.length === 0) return;
  ensureAudioCtx();

  createSourceNodes();
  startTime = audioCtx.currentTime;

  for (const stem of stems) {
    stem.sourceNode.start(0, pauseOffset);
  }

  isPlaying = true;
  document.getElementById('playBtn').innerHTML = '&#10074;&#10074;';
  document.getElementById('playBtn').classList.add('active');

  startVisualization();
  startLoopCheck();
  if (metronomeOn) startMetronome();
}

function pausePlayback() {
  if (!isPlaying) return;
  pauseOffset = getCurrentTime();
  stopSources();
  isPlaying = false;
  document.getElementById('playBtn').innerHTML = '&#9654;';
  document.getElementById('playBtn').classList.remove('active');
  stopMetronome();
  stopLoopCheck();
}

function stopPlayback() {
  stopSources();
  pauseOffset = 0;
  isPlaying = false;
  document.getElementById('playBtn').innerHTML = '&#9654;';
  document.getElementById('playBtn').classList.remove('active');
  updateTimeDisplay();
  updatePlayheads();
  stopMetronome();
  stopLoopCheck();
}

function stopSources() {
  for (const stem of stems) {
    if (stem.sourceNode) {
      try { stem.sourceNode.stop(); } catch (e) {}
      stem.sourceNode = null;
    }
  }
}

function getCurrentTime() {
  if (!isPlaying) return pauseOffset;
  const elapsed = (audioCtx.currentTime - startTime) * playbackRate;
  let t = pauseOffset + elapsed;
  if (t >= totalDuration) t = totalDuration;
  return t;
}

function seekTo(time) {
  const wasPlaying = isPlaying;
  if (isPlaying) {
    stopSources();
    isPlaying = false;
  }
  pauseOffset = Math.max(0, Math.min(time, totalDuration));
  if (wasPlaying) startPlayback();
  updateTimeDisplay();
  updatePlayheads();
  queueSpectrogramCompute(true);
}

// Transport controls
document.getElementById('playBtn').addEventListener('click', () => {
  if (isPlaying) pausePlayback();
  else startPlayback();
});

document.getElementById('stopBtn').addEventListener('click', stopPlayback);

// Speed
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    playbackRate = parseFloat(btn.dataset.speed);
    if (isPlaying) {
      for (const stem of stems) {
        if (stem.sourceNode) stem.sourceNode.playbackRate.value = playbackRate;
      }
    }
  });
});

// Master volume
document.getElementById('masterVolume').addEventListener('input', (e) => {
  userMasterVolume = parseFloat(e.target.value);
  updateMasterOutputGain();
  document.getElementById('masterVolVal').textContent = Math.round(userMasterVolume * 100) + '%';
});

document.getElementById('outLowBtn').addEventListener('click', () => {
  outLowOn = !outLowOn;
  handleOutputFilterChanged();
});
document.getElementById('outMidBtn').addEventListener('click', () => {
  outMidOn = !outMidOn;
  handleOutputFilterChanged();
});
document.getElementById('outHighBtn').addEventListener('click', () => {
  outHighOn = !outHighOn;
  handleOutputFilterChanged();
});

// ===== Stem UI =====
let stemClickHandler = null;
let stemInputHandler = null;

function renderStems() {
  const container = document.getElementById('stemsContainer');
  const toolbar = document.getElementById('stemsToolbar');

  if (stemClickHandler) container.removeEventListener('click', stemClickHandler);
  if (stemInputHandler) container.removeEventListener('input', stemInputHandler);

  container.innerHTML = '';

  if (stems.length === 0) {
    toolbar.style.display = 'none';
    container.innerHTML = '<div class="empty-msg">Scan stems from Planning Center using the extension popup, or load files manually.<br><small>Supports .mp3, .wav, .ogg, .flac, .aac, .m4a, .webm</small></div>';
    return;
  }

  toolbar.style.display = 'flex';

  stems.forEach((stem, i) => {
    const row = document.createElement('div');
    row.className = 'stem-row' + (stem.muted ? ' muted' : '');
    row.dataset.index = i;
    row.innerHTML = `
      <span class="stem-name" title="${stem.name}">${stem.name}</span>
      <button class="stem-btn ${stem.muted ? 'mute-on' : ''}" data-action="mute" title="Mute — silences this stem">M</button>
      <button class="stem-btn ${stem.solo ? 'solo-on' : ''}" data-action="solo" title="Solo — hear only soloed stems">S</button>
      <div class="stem-volume-group">
        <label>Vol</label>
        <input type="range" min="0" max="1" step="0.01" value="${stem.volume}" data-action="volume" style="width:100px;">
        <span class="vol-value">${Math.round(stem.volume * 100)}%</span>
      </div>
      <div class="stem-filter-group">
        <button class="filter-toggle ${stem.filterOn ? 'active' : ''}" data-action="filter-toggle">Filter</button>
        <button class="filter-preset-btn" data-preset="low">Low</button>
        <button class="filter-preset-btn" data-preset="mid">Mid</button>
        <button class="filter-preset-btn" data-preset="high">High</button>
        <button class="filter-preset-btn" data-preset="full">Full</button>
        <div class="filter-range-container">
          <span class="freq-label" data-label="low">${formatFreq(stem.lowFreq)}</span>
          <input type="range" min="0" max="1" step="0.001" value="${freqToSlider(stem.lowFreq)}" data-action="filter-low" style="width:80px;">
          <input type="range" min="0" max="1" step="0.001" value="${freqToSlider(stem.highFreq)}" data-action="filter-high" style="width:80px;">
          <span class="freq-label" data-label="high">${formatFreq(stem.highFreq)}</span>
        </div>
      </div>
    `;
    container.appendChild(row);
  });

  stemClickHandler = handleStemClick;
  stemInputHandler = handleStemInput;
  container.addEventListener('click', stemClickHandler);
  container.addEventListener('input', stemInputHandler);
}

// Mute All / Unmute All / Clear Solo
document.getElementById('muteAllBtn').addEventListener('click', () => {
  stems.forEach(s => s.muted = true);
  updateStemGains();
  handleMixStateChanged();
  renderStems();
});

document.getElementById('unmuteAllBtn').addEventListener('click', () => {
  stems.forEach(s => s.muted = false);
  updateStemGains();
  handleMixStateChanged();
  renderStems();
});

document.getElementById('clearSoloBtn').addEventListener('click', () => {
  stems.forEach(s => s.solo = false);
  updateStemGains();
  handleMixStateChanged();
  renderStems();
});

function handleStemClick(e) {
  const btn = e.target.closest('[data-action], [data-preset]');
  if (!btn) return;
  const row = e.target.closest('.stem-row');
  if (!row) return;
  const idx = parseInt(row.dataset.index);
  const stem = stems[idx];

  if (btn.dataset.action === 'mute') {
    stem.muted = !stem.muted;
    updateStemGains();
    handleMixStateChanged();
    renderStems();
  } else if (btn.dataset.action === 'solo') {
    stem.solo = !stem.solo;
    updateStemGains();
    handleMixStateChanged();
    renderStems();
  } else if (btn.dataset.action === 'filter-toggle') {
    stem.filterOn = !stem.filterOn;
    reconnectStem(idx);
    handleMixStateChanged();
    renderStems();
  } else if (btn.dataset.preset) {
    stem.filterOn = true;
    switch (btn.dataset.preset) {
      case 'low': stem.lowFreq = 20; stem.highFreq = 300; break;
      case 'mid': stem.lowFreq = 300; stem.highFreq = 4000; break;
      case 'high': stem.lowFreq = 4000; stem.highFreq = 20000; break;
      case 'full': stem.lowFreq = 20; stem.highFreq = 20000; break;
    }
    reconnectStem(idx);
    handleMixStateChanged();
    renderStems();
  }
}

function handleStemInput(e) {
  const input = e.target;
  if (!input.dataset.action) return;
  const row = e.target.closest('.stem-row');
  if (!row) return;
  const idx = parseInt(row.dataset.index);
  const stem = stems[idx];

  if (input.dataset.action === 'volume') {
    stem.volume = parseFloat(input.value);
    row.querySelector('.vol-value').textContent = Math.round(stem.volume * 100) + '%';
    updateStemGains();
    handleMixStateChanged();
  } else if (input.dataset.action === 'filter-low') {
    stem.lowFreq = sliderToFreq(parseFloat(input.value));
    if (stem.lowFreq > stem.highFreq) {
      stem.highFreq = stem.lowFreq;
      row.querySelector('[data-action="filter-high"]').value = freqToSlider(stem.highFreq);
    }
    row.querySelector('[data-label="low"]').textContent = formatFreq(stem.lowFreq);
    row.querySelector('[data-label="high"]').textContent = formatFreq(stem.highFreq);
    updateStemFilter(idx);
    handleMixStateChanged();
  } else if (input.dataset.action === 'filter-high') {
    stem.highFreq = sliderToFreq(parseFloat(input.value));
    if (stem.highFreq < stem.lowFreq) {
      stem.lowFreq = stem.highFreq;
      row.querySelector('[data-action="filter-low"]').value = freqToSlider(stem.lowFreq);
    }
    row.querySelector('[data-label="low"]').textContent = formatFreq(stem.lowFreq);
    row.querySelector('[data-label="high"]').textContent = formatFreq(stem.highFreq);
    updateStemFilter(idx);
    handleMixStateChanged();
  }
}

function freqToSlider(freq) {
  return Math.log2(freq / 20) / Math.log2(20000 / 20);
}
function sliderToFreq(val) {
  return 20 * Math.pow(20000 / 20, val);
}
function formatFreq(f) {
  if (f >= 1000) return (f / 1000).toFixed(1) + 'k';
  return Math.round(f) + '';
}

function updateStemGains() {
  const anySolo = stems.some(s => s.solo);
  stems.forEach(stem => {
    if (stem.gainNode) {
      const effectivelyMuted = stem.muted || (anySolo && !stem.solo);
      stem.gainNode.gain.value = effectivelyMuted ? 0 : stem.volume;
    }
  });
  updateMasterOutputGain();
}

function updateStemFilter(idx) {
  const stem = stems[idx];
  if (stem.filterNode && stem.filterOn) {
    stem.filterNode.highpass.frequency.value = stem.lowFreq;
    stem.filterNode.lowpass.frequency.value = stem.highFreq;
  }
}

function reconnectStem(idx) {
  const stem = stems[idx];
  if (!isPlaying || !stem.sourceNode) return;
  if (stem.gainNode) stem.gainNode.disconnect();

  if (stem.filterOn) {
    const highpass = audioCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = stem.lowFreq;
    highpass.Q.value = 0.7;
    const lowpass = audioCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = stem.highFreq;
    lowpass.Q.value = 0.7;
    stem.gainNode.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(masterGain);
    stem.filterNode = { highpass, lowpass };
  } else {
    stem.gainNode.connect(masterGain);
    stem.filterNode = null;
  }
}

// ===== Visualization =====
document.querySelectorAll('.viz-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.viz-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    vizMode = btn.dataset.viz;
    if (vizMode === 'spectrogram' || vizMode === 'both') queueSpectrogramCompute(true);
  });
});

function startVisualization() {
  if (vizAnimId) cancelAnimationFrame(vizAnimId);
  const canvas = document.getElementById('vizCanvas');
  const ctx = canvas.getContext('2d');
  const rulerCanvas = document.getElementById('rulerCanvas');
  const rulerCtx = rulerCanvas.getContext('2d');

  function resize() {
    const dpr = window.devicePixelRatio;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    rulerCanvas.width = rulerCanvas.clientWidth * dpr;
    rulerCanvas.height = rulerCanvas.clientHeight * dpr;
  }
  resize();
  window.addEventListener('resize', resize);

  function draw() {
    vizAnimId = requestAnimationFrame(draw);
    const dpr = window.devicePixelRatio;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, cw, ch);

    if (!analyserNode || totalDuration === 0) {
      updateTimeDisplay();
      return;
    }

    // Keep spectrogram cache computed from current position forward, regardless of viz mode.
    queueSpectrogramCompute();

    // Draw metronome overlay behind viz
    drawMetronomeOverlay(ctx, cw, ch);

    if (vizMode === 'spectrogram') {
      drawSpectrogram(ctx, cw, ch);
    } else if (vizMode === 'both') {
      drawSpectrogram(ctx, cw, ch);
      drawEnergy(ctx, cw, ch, true);
    } else {
      drawEnergy(ctx, cw, ch, false);
    }

    // Draw loop region on viz
    drawLoopOverlay(ctx, cw, ch);

    // Draw beat ruler
    drawBeatRuler(rulerCtx, rulerCanvas.clientWidth, rulerCanvas.clientHeight);

    autoFollowPlayhead();
    updateTimeDisplay();
    updatePlayheads();
    updateZoomInfo();
    checkPlaybackEnd();
  }

  draw();
}

// Convert time to X pixel position within current view
function timeToX(t, w) {
  const vs = getViewStart();
  const vd = getViewDuration();
  if (vd === 0) return 0;
  return ((t - vs) / vd) * w;
}

// Convert X pixel position to time
function xToTime(x, w) {
  const vs = getViewStart();
  const vd = getViewDuration();
  return vs + (x / w) * vd;
}

function drawSpectrogram(ctx, w, h) {
  // Draw time-frequency spectrogram: x=time, y=frequency (low->high), color=intensity.
  const vs = getViewStart();
  const vd = getViewDuration();
  if (vd === 0) return;

  const slotDur = getSpectroSlotDuration();
  const startSlot = Math.floor(vs / slotDur);
  const endSlot = Math.ceil((vs + vd) / slotDur);
  const totalSlots = endSlot - startSlot;
  if (totalSlots <= 0) return;

  const visibleBandWindow = getVisibleSpectroBandWindow();
  const bandStart = Math.max(0, visibleBandWindow.start);
  const bandEnd = Math.min(SPECTRO_FREQ_BINS, visibleBandWindow.end);
  const bandCount = Math.max(1, bandEnd - bandStart);

  const colW = w / totalSlots;
  const binH = h / bandCount;

  // Adaptive color range:
  // 1) global histogram for broad contrast
  // 2) per-frequency-row histogram so each band keeps usable detail
  const globalHist = new Uint32Array(256);
  const rowHists = Array.from({ length: SPECTRO_FREQ_BINS }, () => new Uint32Array(256));
  const rowCounts = new Uint32Array(SPECTRO_FREQ_BINS);
  let sampleCount = 0;
  for (let s = startSlot; s < endSlot; s++) {
    const cell = spectrogramMap.get(s);
    if (!cell || !cell.bins) continue;
    const bins = cell.bins;
    const usableBins = Math.min(SPECTRO_FREQ_BINS, bins.length);
    for (let y = bandStart; y < usableBins && y < bandEnd; y++) {
      const v = bins[y];
      globalHist[v]++;
      rowHists[y][v]++;
      rowCounts[y]++;
      sampleCount++;
    }
  }

  let globalLo = 0;
  let globalHi = 255;
  if (sampleCount > 0) {
    const loTarget = Math.floor(sampleCount * 0.08);   // ignore darkest 8%
    const hiTarget = Math.floor(sampleCount * 0.995);  // clip brightest 0.5%
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += globalHist[i];
      if (acc >= loTarget) { globalLo = i; break; }
    }
    acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += globalHist[i];
      if (acc >= hiTarget) { globalHi = i; break; }
    }
  }
  if (globalHi <= globalLo + 6) {
    globalLo = Math.max(0, globalLo - 8);
    globalHi = Math.min(255, globalLo + 32);
  }

  const rowLo = new Uint8Array(SPECTRO_FREQ_BINS);
  const rowHi = new Uint8Array(SPECTRO_FREQ_BINS);
  for (let y = 0; y < SPECTRO_FREQ_BINS; y++) {
    const cnt = rowCounts[y];
    if (cnt < 16) {
      rowLo[y] = globalLo;
      rowHi[y] = globalHi;
      continue;
    }

    const loTarget = Math.floor(cnt * 0.14);
    const hiTarget = Math.floor(cnt * 0.995);
    let lo = 0;
    let hi = 255;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += rowHists[y][i];
      if (acc >= loTarget) { lo = i; break; }
    }
    acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += rowHists[y][i];
      if (acc >= hiTarget) { hi = i; break; }
    }
    if (hi <= lo + 10) {
      lo = Math.max(0, lo - 6);
      hi = Math.min(255, lo + 40);
    }

    // Blend with global to avoid overfitting single rows.
    rowLo[y] = Math.round(lo * 0.7 + globalLo * 0.3);
    rowHi[y] = Math.round(hi * 0.7 + globalHi * 0.3);
  }

  for (let s = startSlot; s < endSlot; s++) {
    const cell = spectrogramMap.get(s);
    if (!cell) continue; // leave blank if not computed yet

    const x = ((s - startSlot) / totalSlots) * w;
    const bins = cell.bins;
    if (!bins || bins.length === 0) continue;

    const usableBins = Math.min(SPECTRO_FREQ_BINS, bins.length);
    for (let y = bandStart; y < usableBins && y < bandEnd; y++) {
      const val = bins[y];
      if (val < 2) continue;

      const lo = rowLo[y];
      const hi = rowHi[y];
      const invRange = 1 / Math.max(1, hi - lo);
      let t = (val - lo) * invRange;
      if (t <= 0) continue;
      t = Math.min(1, t);
      const tColor = Math.pow(t, 1.15);
      const alpha = Math.pow(t, 2.35); // low-intensity bins fade out much faster
      if (alpha < 0.03) continue;

      const hue = 235 - tColor * 235; // blue -> red
      const sat = 62 + tColor * 30;
      const light = 3 + tColor * 66;
      ctx.fillStyle = `hsla(${hue}, ${sat}%, ${light}%, ${Math.min(1, alpha)})`;
      // y=0 is lowest frequency, drawn at bottom
      const yLocal = y - bandStart;
      ctx.fillRect(x, h - (yLocal + 1) * binH, colW + 0.5, binH + 0.5);
    }
  }
}

function drawEnergy(ctx, w, h, overlay = false) {
  if (!energyData || energyData.length === 0) return;

  const vs = getViewStart();
  const vd = getViewDuration();
  if (vd === 0) return;

  const windowDuration = ENERGY_WINDOW_MS / 1000;
  const startIdx = Math.max(0, Math.floor(vs / windowDuration));
  const endIdx = Math.min(energyData.length, Math.ceil((vs + vd) / windowDuration));
  const visibleCount = endIdx - startIdx;
  if (visibleCount <= 0) return;

  // Downsample: at most ~1 point per pixel (use peak per bucket to preserve transients)
  const pixelW = Math.ceil(w);
  const step = Math.max(1, Math.floor(visibleCount / pixelW));
  const numPoints = Math.ceil(visibleCount / step);

  // Build downsampled array (peak per bucket)
  const dsValues = new Float32Array(numPoints);
  const dsIndices = new Int32Array(numPoints); // original index for time mapping
  for (let p = 0; p < numPoints; p++) {
    const bucketStart = startIdx + p * step;
    const bucketEnd = Math.min(bucketStart + step, endIdx);
    let peak = 0;
    let peakIdx = bucketStart;
    for (let i = bucketStart; i < bucketEnd; i++) {
      if (energyData[i] > peak) {
        peak = energyData[i];
        peakIdx = i;
      }
    }
    dsValues[p] = peak;
    dsIndices[p] = peakIdx;
  }

  // Draw RMS energy as filled area
  const gradient = ctx.createLinearGradient(0, h, 0, 0);
  if (overlay) {
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0.05)');
    gradient.addColorStop(0.4, 'rgba(0, 0, 0, 0.1)');
    gradient.addColorStop(0.8, 'rgba(0, 0, 0, 0.14)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.18)');
  } else {
    gradient.addColorStop(0, 'rgba(78, 204, 163, 0.1)');
    gradient.addColorStop(0.4, 'rgba(78, 204, 163, 0.4)');
    gradient.addColorStop(0.8, 'rgba(78, 204, 163, 0.6)');
    gradient.addColorStop(1, 'rgba(240, 192, 64, 0.8)');
  }

  // Fill area under curve
  ctx.beginPath();
  ctx.moveTo(timeToX(dsIndices[0] * windowDuration, w), h);
  for (let p = 0; p < numPoints; p++) {
    const x = timeToX(dsIndices[p] * windowDuration, w);
    const y = h - dsValues[p] * h * 0.85;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(timeToX(dsIndices[numPoints - 1] * windowDuration, w), h);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Draw RMS outline
  ctx.beginPath();
  for (let p = 0; p < numPoints; p++) {
    const x = timeToX(dsIndices[p] * windowDuration, w);
    const y = h - dsValues[p] * h * 0.85;
    if (p === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = overlay ? 'rgba(0, 0, 0, 0.98)' : '#4ecca3';
  ctx.lineWidth = overlay ? 1.4 : 1.5;
  if (overlay) {
    ctx.shadowColor = 'rgba(255,255,255,0.65)';
    ctx.shadowBlur = 1.5;
  } else {
    ctx.shadowBlur = 0;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Label
  if (!overlay) {
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('RMS Energy', 8, 6);
  }
}

function drawMetronomeOverlay(ctx, w, h) {
  if (!metronomeOn || totalDuration === 0) return;

  const currentTime = getCurrentTime();
  const beatDuration = 60 / metroBpm;
  const vs = getViewStart();
  const ve = getViewEnd();

  const firstBeat = Math.floor(vs / beatDuration);
  const lastBeat = Math.ceil(ve / beatDuration);

  for (let b = firstBeat; b <= lastBeat; b++) {
    const beatTime = b * beatDuration;
    if (beatTime < vs || beatTime > ve) continue;

    const x = timeToX(beatTime, w);
    const beatInMeasure = ((b % metroBeatsPerMeasure) + metroBeatsPerMeasure) % metroBeatsPerMeasure;

    let alpha, lineWidth;
    if (beatInMeasure === 0) {
      alpha = 0.35;
      lineWidth = 2.5;
    } else if (metroBeatsPerMeasure === 4 && beatInMeasure === 2) {
      alpha = 0.2;
      lineWidth = 1.5;
    } else {
      alpha = 0.1;
      lineWidth = 1;
    }

    ctx.strokeStyle = `rgba(240, 192, 64, ${alpha})`;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // Flash on current beat
  if (isPlaying) {
    const currentBeat = currentTime / beatDuration;
    const beatFrac = currentBeat - Math.floor(currentBeat);
    if (beatFrac < 0.08) {
      const beatInMeasure = Math.floor(currentBeat) % metroBeatsPerMeasure;
      let flashAlpha = (1 - beatFrac / 0.08) * 0.3;
      if (beatInMeasure === 0) flashAlpha *= 2;
      ctx.fillStyle = `rgba(240, 192, 64, ${Math.min(flashAlpha, 0.5)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }
}

function drawLoopOverlay(ctx, w, h) {
  if (loopStartBeat === null || loopEndBeat === null) return;
  const beatDur = 60 / metroBpm;
  const loopStartTime = loopStartBeat * beatDur;
  const loopEndTime = loopEndBeat * beatDur;
  const x1 = timeToX(loopStartTime, w);
  const x2 = timeToX(loopEndTime, w);
  ctx.fillStyle = 'rgba(78, 204, 163, 0.08)';
  ctx.fillRect(x1, 0, x2 - x1, h);
  ctx.strokeStyle = 'rgba(78, 204, 163, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, 0); ctx.lineTo(x2, h);
  ctx.stroke();
}

// ===== Beat Ruler (canvas-based, synced with zoom) =====
function drawBeatRuler(ctx, w, h) {
  const dpr = window.devicePixelRatio;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d0d1d';
  ctx.fillRect(0, 0, w, h);

  if (totalDuration === 0) return;

  const beatDuration = 60 / metroBpm;
  const vs = getViewStart();
  const ve = getViewEnd();

  const firstBeat = Math.max(0, Math.floor(vs / beatDuration));
  const lastBeat = Math.ceil(ve / beatDuration);

  for (let b = firstBeat; b <= lastBeat; b++) {
    const beatTime = b * beatDuration;
    const x = timeToX(beatTime, w);
    const beatInMeasure = ((b % metroBeatsPerMeasure) + metroBeatsPerMeasure) % metroBeatsPerMeasure;

    // Draw beat separator line
    if (beatInMeasure === 0) {
      ctx.strokeStyle = 'rgba(240, 192, 64, 0.5)';
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    // Draw beat label
    const nextBeatX = timeToX((b + 1) * beatDuration, w);
    const cellW = nextBeatX - x;

    if (cellW > 8) { // Only draw text if cell is wide enough
      ctx.font = `${beatInMeasure === 0 ? 'bold' : 'normal'} ${Math.min(10, cellW * 0.4)}px sans-serif`;
      ctx.fillStyle = beatInMeasure === 0 ? '#f0c040' : '#666';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (beatInMeasure === 0) {
        const measureNum = Math.floor(b / metroBeatsPerMeasure) + 1;
        ctx.fillText(measureNum, x + cellW / 2, h / 2);
      } else if (cellW > 18) {
        ctx.fillText(beatInMeasure + 1, x + cellW / 2, h / 2);
      }
    }

    // Highlight loop region
    if (loopStartBeat !== null && loopEndBeat !== null) {
      if (b >= loopStartBeat && b < loopEndBeat) {
        ctx.fillStyle = 'rgba(78, 204, 163, 0.15)';
        ctx.fillRect(x, 0, cellW, h);
      }
    }
  }

  // Loop boundary lines
  if (loopStartBeat !== null && loopEndBeat !== null) {
    const x1 = timeToX(loopStartBeat * beatDuration, w);
    const x2 = timeToX(loopEndBeat * beatDuration, w);
    ctx.strokeStyle = '#4ecca3';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, 0); ctx.lineTo(x2, h); ctx.stroke();
  }
}

// ===== Beat Ruler Click (loop) =====
document.getElementById('beatRuler').addEventListener('click', (e) => {
  if (totalDuration === 0) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const w = rect.width;
  const clickTime = xToTime(x, w);

  // Snap to nearest beat
  const beatDuration = 60 / metroBpm;
  const beat = Math.round(clickTime / beatDuration);
  const clampedBeat = Math.max(0, Math.min(beat, Math.ceil(totalDuration / beatDuration)));

  handleBeatClick(clampedBeat);
});

// ===== Metronome =====
document.getElementById('metroToggle').addEventListener('click', () => {
  metronomeOn = !metronomeOn;
  const btn = document.getElementById('metroToggle');
  btn.textContent = metronomeOn ? 'ON' : 'OFF';
  btn.classList.toggle('active', metronomeOn);
  if (metronomeOn && isPlaying) startMetronome();
  else stopMetronome();
});

document.getElementById('metroBpm').addEventListener('input', (e) => {
  metroBpm = parseInt(e.target.value) || 120;
  resetSpectrogramCache();
  queueSpectrogramCompute(true);
});

document.getElementById('metroTimeSig').addEventListener('change', (e) => {
  const parts = e.target.value.split('/');
  metroBeatsPerMeasure = parseInt(parts[0]);
  metroBeatUnit = parseInt(parts[1]);
});

function startMetronome() {
  stopMetronome();
  if (!metronomeOn || !isPlaying) return;
  nextMetronomeBeatTime = audioCtx.currentTime;
  metronomeQueue = [];
  scheduleMetronome();
  metronomeIntervalId = setInterval(scheduleMetronome, metronomeLookAhead);
}

function stopMetronome() {
  if (metronomeIntervalId) {
    clearInterval(metronomeIntervalId);
    metronomeIntervalId = null;
  }
  metronomeQueue = [];
}

function scheduleMetronome() {
  if (!audioCtx || !isPlaying) return;
  while (nextMetronomeBeatTime < audioCtx.currentTime + metronomeScheduleAhead) {
    const currentTrackTime = pauseOffset + (nextMetronomeBeatTime - startTime) * playbackRate;
    if (currentTrackTime > totalDuration) break;

    const beatDuration = 60 / metroBpm;
    const beatIndex = Math.round(currentTrackTime / beatDuration);
    const beatInMeasure = ((beatIndex % metroBeatsPerMeasure) + metroBeatsPerMeasure) % metroBeatsPerMeasure;

    let freq = 800;
    let vol = 0.3;
    if (beatInMeasure === 0) { freq = 1200; vol = 0.6; }
    else if (metroBeatsPerMeasure === 4 && beatInMeasure === 2) { freq = 1000; vol = 0.45; }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'triangle';
    gain.gain.setValueAtTime(vol, nextMetronomeBeatTime);
    gain.gain.exponentialRampToValueAtTime(0.001, nextMetronomeBeatTime + 0.05);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(nextMetronomeBeatTime);
    osc.stop(nextMetronomeBeatTime + 0.06);

    metronomeQueue.push({ time: nextMetronomeBeatTime, beatInMeasure, trackTime: currentTrackTime });
    if (metronomeQueue.length > 200) metronomeQueue = metronomeQueue.slice(-100);

    nextMetronomeBeatTime += beatDuration / playbackRate;
  }
}

// ===== Loop =====
function handleBeatClick(beat) {
  if (loopStartBeat === null) {
    loopStartBeat = beat;
    loopEndBeat = null;
    updateLoopUI();
  } else if (loopEndBeat === null) {
    if (beat <= loopStartBeat) {
      loopStartBeat = beat;
      updateLoopUI();
    } else {
      loopEndBeat = beat;
      updateLoopUI();
    }
  } else {
    loopStartBeat = beat;
    loopEndBeat = null;
    updateLoopUI();
  }
}

function updateLoopUI() {
  const group = document.getElementById('loopGroup');
  const info = document.getElementById('loopInfo');
  if (loopStartBeat !== null) {
    group.style.display = 'flex';
    if (loopEndBeat !== null) {
      const startMeasure = Math.floor(loopStartBeat / metroBeatsPerMeasure) + 1;
      const startBeatInM = (loopStartBeat % metroBeatsPerMeasure) + 1;
      const endMeasure = Math.floor(loopEndBeat / metroBeatsPerMeasure) + 1;
      const endBeatInM = (loopEndBeat % metroBeatsPerMeasure) + 1;
      info.textContent = `${startMeasure}.${startBeatInM} \u2192 ${endMeasure}.${endBeatInM}`;
    } else {
      const startMeasure = Math.floor(loopStartBeat / metroBeatsPerMeasure) + 1;
      const startBeatInM = (loopStartBeat % metroBeatsPerMeasure) + 1;
      info.textContent = `Start: ${startMeasure}.${startBeatInM} \u2014 click end beat`;
    }
  } else {
    group.style.display = 'none';
  }
}

document.getElementById('loopClearBtn').addEventListener('click', () => {
  loopStartBeat = null;
  loopEndBeat = null;
  updateLoopUI();
});

function startLoopCheck() {
  stopLoopCheck();
  loopCheckIntervalId = setInterval(() => {
    if (!isPlaying || loopStartBeat === null || loopEndBeat === null) return;
    const beatDur = 60 / metroBpm;
    const loopEnd = loopEndBeat * beatDur;
    const current = getCurrentTime();
    if (current >= loopEnd) {
      seekTo(loopStartBeat * beatDur);
    }
  }, 20);
}

function stopLoopCheck() {
  if (loopCheckIntervalId) {
    clearInterval(loopCheckIntervalId);
    loopCheckIntervalId = null;
  }
}

// ===== Playhead & Time =====
function updateTimeDisplay() {
  const t = getCurrentTime();
  const mins = Math.floor(t / 60);
  const secs = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 10);
  document.getElementById('timeDisplay').textContent =
    `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
}

function updatePlayheads() {
  if (totalDuration === 0) return;
  const t = getCurrentTime();
  const vizContainer = document.getElementById('vizContainer');
  const w = vizContainer.clientWidth;
  const xPx = timeToX(t, w);
  const pct = (xPx / w) * 100;
  const clamped = Math.max(0, Math.min(pct, 100));
  document.getElementById('vizPlayhead').style.left = clamped + '%';
  document.getElementById('rulerPlayhead').style.left = clamped + '%';
}

function updateZoomInfo() {
  const el = document.getElementById('zoomInfo');
  if (totalDuration === 0) {
    el.textContent = '';
    return;
  }
  const vd = getViewDuration();
  const zoomPct = Math.round((totalDuration / vd) * 100);
  if (zoomPct <= 105) {
    el.textContent = '';
  } else {
    const vs = getViewStart();
    const ve = getViewEnd();
    el.textContent = `${formatTime(vs)} - ${formatTime(ve)} (${zoomPct}%)`;
  }
}

function formatTime(t) {
  const mins = Math.floor(t / 60);
  const secs = Math.floor(t % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function checkPlaybackEnd() {
  if (!isPlaying) return;
  const t = getCurrentTime();
  if (t >= totalDuration) {
    if (loopStartBeat !== null && loopEndBeat !== null) {
      const beatDur = 60 / metroBpm;
      seekTo(loopStartBeat * beatDur);
    } else {
      stopPlayback();
    }
  }
}

// ===== Zoom & Pan =====
const vizContainer = document.getElementById('vizContainer');
const beatRuler = document.getElementById('beatRuler');

// Scroll wheel to zoom (on both viz and ruler)
function handleWheel(e) {
  if (totalDuration === 0) return;
  e.preventDefault();

  const rect = e.currentTarget.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const w = rect.width;

  // Time at mouse position before zoom
  const mouseTime = xToTime(mouseX, w);

  // Zoom factor
  const zoomFactor = e.deltaY > 0 ? 1.15 : (1 / 1.15);
  let newVd = getViewDuration() * zoomFactor;

  // Clamp: min ~0.5s, max = total duration
  newVd = Math.max(0.5, Math.min(newVd, totalDuration));

  // Adjust viewStart so the time under the mouse stays in the same screen position
  const mouseRatio = mouseX / w;
  let newVs = mouseTime - mouseRatio * newVd;
  newVs = Math.max(0, Math.min(newVs, totalDuration - newVd));

  viewStart = newVs;
  viewDuration = newVd >= totalDuration * 0.99 ? 0 : newVd; // snap to "show all" when nearly full
}

vizContainer.addEventListener('wheel', handleWheel, { passive: false });
beatRuler.addEventListener('wheel', handleWheel, { passive: false });

// Right-click drag to pan (on both viz and ruler)
function handlePanStart(e) {
  if (e.button !== 2) return; // right click only
  e.preventDefault();
  isPanning = true;
  panStartX = e.clientX;
  panStartViewStart = viewStart;
  document.body.style.cursor = 'grabbing';
}

function handlePanMove(e) {
  if (!isPanning) return;
  e.preventDefault();
  const rect = vizContainer.getBoundingClientRect();
  const dx = e.clientX - panStartX;
  const vd = getViewDuration();
  const timeDelta = -(dx / rect.width) * vd;
  let newVs = panStartViewStart + timeDelta;
  newVs = Math.max(0, Math.min(newVs, totalDuration - vd));
  viewStart = newVs;
}

function handlePanEnd(e) {
  if (!isPanning) return;
  isPanning = false;
  document.body.style.cursor = '';
}

vizContainer.addEventListener('mousedown', handlePanStart);
beatRuler.addEventListener('mousedown', handlePanStart);
document.addEventListener('mousemove', handlePanMove);
document.addEventListener('mouseup', handlePanEnd);

// Prevent context menu on right-click in viz/ruler
vizContainer.addEventListener('contextmenu', (e) => e.preventDefault());
beatRuler.addEventListener('contextmenu', (e) => e.preventDefault());

// Click on visualization to seek (left click only)
document.getElementById('vizCanvas').addEventListener('click', (e) => {
  if (totalDuration === 0 || isPanning) return;
  if (e.button !== 0) return;
  const rect = e.target.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const time = xToTime(x, rect.width);
  seekTo(Math.max(0, Math.min(time, totalDuration)));
});

// Double-click on beat ruler to seek
beatRuler.addEventListener('dblclick', (e) => {
  if (totalDuration === 0) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const time = xToTime(x, rect.width);
  seekTo(Math.max(0, Math.min(time, totalDuration)));
});

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (isPlaying) pausePlayback();
    else startPlayback();
  }
  // Home to reset zoom
  if (e.code === 'Home') {
    viewStart = 0;
    viewDuration = 0;
  }
});

// ===== Extension Integration =====
// URL hash contains the file list and source tab ID from the popup.
// We relay fetch requests through the background service worker since
// chrome.tabs is not available on extension pages.

function sendBgMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

async function loadStemsFromExtension() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

  const hash = window.location.hash.slice(1);
  if (!hash) return;

  let info;
  try {
    info = JSON.parse(decodeURIComponent(hash));
  } catch (e) {
    console.error('Failed to parse stem info from URL hash:', e);
    return;
  }

  if (!info || !info.files || info.files.length === 0 || !info.sourceTabId) return;

  // Clear the hash so a page refresh doesn't re-fetch
  history.replaceState(null, '', window.location.pathname);

  const container = document.getElementById('stemsContainer');
  const total = info.files.length;
  container.innerHTML = `<div class="empty-msg">Fetching stems from Planning Center (0/${total})...<br><small>Keep the Planning Center tab open</small></div>`;

  const files = [];
  for (let i = 0; i < total; i++) {
    const stem = info.files[i];
    container.innerHTML = `<div class="empty-msg">Fetching stems from Planning Center (${i + 1}/${total})...<br><small>${stem.name}</small></div>`;

    try {
      const result = await sendBgMsg({
        action: 'fetchStemFromTab',
        tabId: info.sourceTabId,
        url: stem.url
      });

      if (result && result.success && result.dataUrl) {
        const res = await fetch(result.dataUrl);
        const blob = await res.blob();
        files.push(new File([blob], stem.name, { type: blob.type }));
      } else {
        console.warn('Failed to fetch stem:', stem.name, result?.error);
      }
    } catch (e) {
      console.error('Failed to fetch stem:', stem.name, e);
      container.innerHTML = `<div class="empty-msg">Error: ${e.message}<br><small>Make sure the Planning Center tab is still open.</small></div>`;
      return;
    }
  }

  if (files.length > 0) {
    files.sort((a, b) => a.name.localeCompare(b.name));
    await loadFiles(files);
  } else {
    container.innerHTML = '<div class="empty-msg">Could not fetch stems. Try loading files manually.</div>';
  }
}

// Initial viz
startVisualization();

// Auto-load from extension on page open
loadStemsFromExtension();
