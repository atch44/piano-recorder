import { toMidiFile } from './midi-file.js';
import { bleSupported, connectBle } from './ble-midi.js';
import { startPlayback, renderToBuffer, encodeWav, encodeMp3, createLiveAudio } from './audio-render.js';
import { putVideo, getVideo, delVideo } from './video-store.js';
import { rawCaptureSupported, startCapture, buildMp4 } from './video-capture.js';

const $ = (id) => document.getElementById(id);
const els = {
  videoToggle: $('videoToggle'), facing: $('facing'), preview: $('preview'),
  connect: $('connect'), bluetooth: $('bluetooth'), inputs: $('inputs'), status: $('status'),
  note: $('note'), timer: $('timer'), rec: $('rec'), stop: $('stop'),
  list: $('list'), empty: $('empty'),
};
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);

let access = null;
let currentInput = null;
let recording = false;
let startTime = 0;
let events = [];
let timerId = null;
let recordings = load();

// ---------- MIDI connection ----------
els.connect.addEventListener('click', async () => {
  if (!navigator.requestMIDIAccess) {
    els.status.textContent = 'Web MIDI is not supported here. Use Chrome on Android.';
    return;
  }
  try {
    access = await navigator.requestMIDIAccess();
  } catch (e) {
    els.status.textContent = 'MIDI access denied: ' + e.message;
    return;
  }
  access.onstatechange = refreshInputs;
  refreshInputs();
});

function refreshInputs() {
  const ins = [...access.inputs.values()];
  els.inputs.innerHTML = '';
  if (!ins.length) {
    els.inputs.innerHTML = '<option>No devices</option>';
    els.inputs.disabled = true;
    els.rec.disabled = recording || !ble;
    els.status.textContent = 'No MIDI device found. Plug in the piano via USB.';
    setInput(null);
    return;
  }
  for (const i of ins) {
    const o = document.createElement('option');
    o.value = i.id;
    o.textContent = i.name || i.id;
    els.inputs.appendChild(o);
  }
  els.inputs.disabled = false;
  const keep = ins.find((i) => i.id === currentInput?.id) || ins[0];
  els.inputs.value = keep.id;
  setInput(keep);
}

els.inputs.addEventListener('change', () => {
  setInput(access.inputs.get(els.inputs.value));
});

function setInput(input) {
  if (currentInput) currentInput.onmidimessage = null;
  currentInput = input;
  if (input) {
    input.onmidimessage = onMessage;
    els.status.textContent = `Connected: ${input.name}`;
    els.rec.disabled = recording;
  }
}

function onMessage(e) {
  handleMidi(e.data, e.timeStamp);
}

function handleMidi(data, time) {
  const [status, d1, d2] = data;
  const type = status & 0xf0;
  // Ignore clock / active sensing / sysex noise.
  if (status >= 0xf0) return;

  if (type === 0x90 && d2 > 0) els.note.textContent = `${noteName(d1)}  (vel ${d2})`;

  if (recording) {
    events.push({ t: time - startTime, data: Array.from(data) });
    liveAudio?.handle(data);
  }
}

// ---------- Bluetooth (BLE MIDI via Web Bluetooth) ----------
let ble = null;

els.bluetooth.addEventListener('click', async () => {
  if (!bleSupported()) {
    els.status.textContent = 'Web Bluetooth is not supported here. Use Chrome on Android.';
    return;
  }
  els.status.textContent = 'Choose your piano in the Bluetooth list…';
  try {
    ble = await connectBle(handleMidi, () => {
      ble = null;
      els.rec.disabled = recording || !currentInput;
      els.status.textContent = 'Bluetooth disconnected.';
    });
    els.status.textContent = `Connected via Bluetooth: ${ble.name}`;
    els.rec.disabled = recording;
  } catch (e) {
    els.status.textContent = 'Bluetooth: ' + (e.name === 'NotFoundError' ? 'no device chosen.' : e.message);
  }
});

// ---------- Camera ----------
let camStream = null;
let liveAudio = null; // live piano voice that feeds the video's audio track
let mediaRec = null;
let videoChunks = [];

async function startCamera() {
  stopCamera();
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: els.facing.value },
    audio: false,
  });
  els.preview.srcObject = camStream;
  els.preview.hidden = false;
}

function stopCamera() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  els.preview.srcObject = null;
  els.preview.hidden = true;
}

els.videoToggle.addEventListener('change', async () => {
  els.facing.hidden = !els.videoToggle.checked;
  if (!els.videoToggle.checked) return stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    els.status.textContent = 'Camera is not available in this browser.';
    els.videoToggle.checked = false;
    els.facing.hidden = true;
    return;
  }
  try {
    await startCamera();
  } catch (e) {
    els.status.textContent = `Camera: ${e.message}`;
    els.videoToggle.checked = false;
    els.facing.hidden = true;
  }
});

els.facing.addEventListener('change', () => {
  if (els.videoToggle.checked && !recording) {
    startCamera().catch((e) => { els.status.textContent = `Camera: ${e.message}`; });
  }
});

function pickVideoType() {
  const types = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

/** Camera video + live piano audio in one MediaRecorder. */
async function prepareVideo() {
  if (!camStream) await startCamera();
  els.status.textContent = 'Loading piano sound…';
  liveAudio = await createLiveAudio();
  const stream = new MediaStream([
    ...camStream.getVideoTracks(),
    ...liveAudio.stream.getAudioTracks(),
  ]);
  const mimeType = pickVideoType();
  videoChunks = [];
  const mr = new MediaRecorder(stream, {
    ...(mimeType && { mimeType }),
    videoBitsPerSecond: 2_500_000,
    audioBitsPerSecond: 128_000,
  });
  mr.ondataavailable = (e) => { if (e.data.size) videoChunks.push(e.data); };
  return mr;
}

/** Stops the recorder (after a short tail so the last notes ring out). Returns a Blob or null. */
async function finishVideo() {
  if (!mediaRec) return null;
  const mr = mediaRec;
  mediaRec = null;
  await new Promise((r) => setTimeout(r, 1000));
  await new Promise((resolve) => { mr.onstop = resolve; mr.stop(); });
  liveAudio?.close();
  liveAudio = null;
  const blob = new Blob(videoChunks, { type: mr.mimeType });
  videoChunks = [];
  return blob.size ? blob : null;
}

// ---------- Recording ----------
let capture = null; // frame-accurate WebCodecs capture (preferred)

els.rec.addEventListener('click', async () => {
  els.rec.disabled = true;
  let useCapture = false;
  if (els.videoToggle.checked) {
    try {
      if (!camStream || camStream.getVideoTracks()[0]?.readyState !== 'live') await startCamera();
      if (rawCaptureSupported()) useCapture = true;
      else mediaRec = await prepareVideo(); // fallback: live audio + MediaRecorder
    } catch (e) {
      els.status.textContent = `Video: ${e.message}`;
      els.rec.disabled = false;
      return;
    }
  }
  events = [];
  recording = true;
  startTime = performance.now();
  if (useCapture) capture = startCapture(camStream.getVideoTracks()[0]);
  mediaRec?.start(1000);
  els.status.textContent = capture || mediaRec ? 'Recording (with video)…' : 'Recording…';
  els.rec.classList.add('active');
  els.stop.disabled = false;
  timerId = setInterval(() => {
    els.timer.textContent = fmt(performance.now() - startTime);
  }, 250);
});

els.stop.addEventListener('click', async () => {
  if (!recording) return;
  recording = false;
  clearInterval(timerId);
  els.rec.classList.remove('active');
  els.stop.disabled = true;

  const notes = events.filter((e) => (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0).length;
  if (mediaRec || capture) els.status.textContent = 'Finishing video…';
  const videoBlob = await finishVideo();
  let cap = null;
  let capError = null;
  if (capture) {
    const c = capture;
    capture = null;
    await new Promise((r) => setTimeout(r, 1000)); // let the last notes ring out on video
    try { cap = await c.stop(); } catch (e) { capError = e; }
  }
  els.rec.disabled = !currentInput && !ble;

  if (!notes) {
    els.status.textContent = 'No notes recorded — nothing saved.';
    return;
  }
  // Shift so the recording starts at the first event, not the button press.
  const t0 = events[0].t;
  events.forEach((e) => (e.t -= t0));
  const rec = {
    id: Date.now(),
    name: 'Take ' + new Date().toLocaleString(),
    duration: events[events.length - 1].t,
    notes,
    events,
  };
  let videoError = capError && `Video failed (${capError.message}); MIDI was saved.`;
  if (videoBlob || cap) {
    try {
      if (cap) {
        await putVideo(rec.id, cap);
        rec.videoExt = 'mp4';
        rec.t0 = t0; // ms from record start to first MIDI event
        rec.videoStart = cap.startWall - startTime; // ms from record start to first frame
        const last = cap.chunks[cap.chunks.length - 1];
        rec.videoDuration = (last.ts + (last.dur || 33_333)) / 1000;
      } else {
        await putVideo(rec.id, videoBlob);
        rec.videoExt = videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
      }
      rec.hasVideo = true;
    } catch (e) {
      videoError = `Video could not be saved (${e.message}); MIDI was saved.`;
    }
  }
  recordings.unshift(rec);
  save();
  render();
  els.status.textContent = videoError || (rec.hasVideo ? 'Saved take with video.' : 'Saved.');
});

// ---------- Playback (sampled piano via Tone.js) ----------
let player = null;
let playTimer = null;
let playingId = null;

function stopPlayback() {
  clearTimeout(playTimer);
  player?.stop();
  player = null;
  playingId = null;
  render();
}

async function play(rec) {
  if (playingId) stopPlayback();
  playingId = rec.id;
  els.status.textContent = 'Loading piano sound…';
  render();
  try {
    const p = await startPlayback(rec);
    if (playingId !== rec.id) { p.stop(); return; } // stopped while loading
    player = p;
    els.status.textContent = 'Playing…';
    playTimer = setTimeout(stopPlayback, rec.duration + 4000);
  } catch (e) {
    playingId = null;
    els.status.textContent = `Playback failed: ${e.message}`;
    render();
  }
}

// ---------- Export / storage ----------
function saveBlob(blob, rec, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = rec.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.' + ext;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function download(rec) {
  saveBlob(new Blob([toMidiFile(rec.events)], { type: 'audio/midi' }), rec, 'mid');
}

async function exportAudio(rec, format, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  try {
    const buffer = await renderToBuffer(rec);
    const blob = format === 'mp3' ? await encodeMp3(buffer) : encodeWav(buffer);
    saveBlob(blob, rec, format);
  } catch (e) {
    els.status.textContent = `Export failed: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Finished video files, built once per session from the stored frames + rendered audio.
const builtVideos = new Map();

async function videoFile(rec, btn) {
  if (builtVideos.has(rec.id)) return builtVideos.get(rec.id);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const stored = await getVideo(rec.id);
    if (!stored) throw new Error('video not found (browser data cleared?)');
    let blob = stored;
    if (!(stored instanceof Blob)) {
      // Place the take's first note at the same moment it happened relative to the first frame.
      const audio = await renderToBuffer(rec, {
        offset: (rec.t0 - rec.videoStart) / 1000,
        seconds: Math.max(rec.videoDuration / 1000, 0.5),
        sampleRate: 48000,
      });
      blob = await buildMp4(stored, audio);
    }
    builtVideos.set(rec.id, blob);
    return blob;
  } catch (e) {
    els.status.textContent = `Video: ${e.message}`;
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function load() {
  try { return JSON.parse(localStorage.getItem('recordings') || '[]'); }
  catch { return []; }
}
function save() {
  try { localStorage.setItem('recordings', JSON.stringify(recordings)); }
  catch { els.status.textContent = 'Could not save (storage full?). Export your takes.'; }
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function render() {
  els.list.innerHTML = '';
  els.empty.hidden = recordings.length > 0;
  for (const rec of recordings) {
    const li = document.createElement('li');
    const playing = playingId === rec.id;
    li.innerHTML = `
      <div>${rec.name}</div>
      <div class="meta">${fmt(rec.duration)} · ${rec.notes} notes</div>
      <div class="actions">
        <button data-a="play">${playing ? '■ Stop' : '▶ Play'}</button>
        ${rec.hasVideo ? '<button data-a="watch">🎬 Watch</button><button data-a="vid">Video</button>' : ''}
        <button data-a="dl">.mid</button>
        <button data-a="mp3">MP3</button>
        <button data-a="wav">WAV</button>
        <button data-a="del">Delete</button>
      </div>`;
    li.querySelector('[data-a=play]').onclick = () => (playing ? stopPlayback() : play(rec));
    li.querySelector('[data-a=dl]').onclick = () => download(rec);
    if (rec.hasVideo) {
      li.querySelector('[data-a=vid]').onclick = async (ev) => {
        const blob = await videoFile(rec, ev.currentTarget);
        if (blob) saveBlob(blob, rec, rec.videoExt || 'webm');
      };
      li.querySelector('[data-a=watch]').onclick = async (ev) => {
        const existing = li.querySelector('video');
        if (existing) { URL.revokeObjectURL(existing.src); existing.remove(); return; }
        const blob = await videoFile(rec, ev.currentTarget);
        if (!blob) return;
        const v = document.createElement('video');
        v.src = URL.createObjectURL(blob);
        v.controls = true;
        v.playsInline = true;
        li.appendChild(v);
      };
    }
    for (const f of ['mp3', 'wav']) {
      const b = li.querySelector(`[data-a=${f}]`);
      b.onclick = () => exportAudio(rec, f, b);
    }
    li.querySelector('[data-a=del]').onclick = () => {
      if (!confirm('Delete this recording?')) return;
      if (playing) stopPlayback();
      recordings = recordings.filter((r) => r.id !== rec.id);
      if (rec.hasVideo) delVideo(rec.id).catch(() => {});
      builtVideos.delete(rec.id);
      save();
      render();
    };
    els.list.appendChild(li);
  }
}

render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
