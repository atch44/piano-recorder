import { toMidiFile } from './midi-file.js';

const $ = (id) => document.getElementById(id);
const els = {
  connect: $('connect'), inputs: $('inputs'), status: $('status'),
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
    els.rec.disabled = true;
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
  const [status, d1, d2] = e.data;
  const type = status & 0xf0;
  // Ignore clock / active sensing / sysex noise.
  if (status >= 0xf0) return;

  if (type === 0x90 && d2 > 0) els.note.textContent = `${noteName(d1)}  (vel ${d2})`;

  if (recording) {
    events.push({ t: e.timeStamp - startTime, data: Array.from(e.data) });
  }
}

// ---------- Recording ----------
els.rec.addEventListener('click', () => {
  events = [];
  recording = true;
  startTime = performance.now();
  els.rec.classList.add('active');
  els.rec.disabled = true;
  els.stop.disabled = false;
  timerId = setInterval(() => {
    els.timer.textContent = fmt(performance.now() - startTime);
  }, 250);
});

els.stop.addEventListener('click', () => {
  if (!recording) return;
  recording = false;
  clearInterval(timerId);
  els.rec.classList.remove('active');
  els.rec.disabled = !currentInput;
  els.stop.disabled = true;

  const notes = events.filter((e) => (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0).length;
  if (!notes) {
    els.status.textContent = 'No notes recorded — nothing saved.';
    return;
  }
  // Shift so the recording starts at the first event, not the button press.
  const t0 = events[0].t;
  events.forEach((e) => (e.t -= t0));
  recordings.unshift({
    id: Date.now(),
    name: 'Take ' + new Date().toLocaleString(),
    duration: events[events.length - 1].t,
    notes,
    events,
  });
  save();
  render();
});

// ---------- Playback (simple oscillator synth) ----------
let audio = null;
let playTimers = [];
let playingId = null;

function stopPlayback() {
  playTimers.forEach(clearTimeout);
  playTimers = [];
  if (audio) { audio.close(); audio = null; }
  playingId = null;
  render();
}

function play(rec) {
  if (playingId) stopPlayback();
  audio = new AudioContext();
  playingId = rec.id;
  const voices = new Map();
  const now = audio.currentTime + 0.1;

  for (const ev of rec.events) {
    const [status, n, vel] = ev.data;
    const type = status & 0xf0;
    const when = now + ev.t / 1000;
    if (type === 0x90 && vel > 0) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 440 * 2 ** ((n - 69) / 12);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime((vel / 127) * 0.3, when + 0.01);
      osc.connect(gain).connect(audio.destination);
      osc.start(when);
      voices.set(n, { osc, gain });
    } else if (type === 0x80 || (type === 0x90 && vel === 0)) {
      const v = voices.get(n);
      if (v) {
        v.gain.gain.setTargetAtTime(0, when, 0.08);
        v.osc.stop(when + 0.6);
        voices.delete(n);
      }
    }
  }
  playTimers.push(setTimeout(stopPlayback, rec.duration + 1500));
  render();
}

// ---------- Export / storage ----------
function download(rec) {
  const blob = new Blob([toMidiFile(rec.events)], { type: 'audio/midi' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = rec.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.mid';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
        <button data-a="dl">Download .mid</button>
        <button data-a="del">Delete</button>
      </div>`;
    li.querySelector('[data-a=play]').onclick = () => (playing ? stopPlayback() : play(rec));
    li.querySelector('[data-a=dl]').onclick = () => download(rec);
    li.querySelector('[data-a=del]').onclick = () => {
      if (!confirm('Delete this recording?')) return;
      if (playing) stopPlayback();
      recordings = recordings.filter((r) => r.id !== rec.id);
      save();
      render();
    };
    els.list.appendChild(li);
  }
}

render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
