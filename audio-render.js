// Sampled piano playback (Tone.js + Salamander Grand Piano), offline rendering,
// and WAV/MP3 encoding. Tone.js and the samples are bundled for offline use.

const SAMPLE_NAMES = {
  A0: 'A0', C1: 'C1', 'D#1': 'Ds1', 'F#1': 'Fs1', A1: 'A1',
  C2: 'C2', 'D#2': 'Ds2', 'F#2': 'Fs2', A2: 'A2',
  C3: 'C3', 'D#3': 'Ds3', 'F#3': 'Fs3', A3: 'A3',
  C4: 'C4', 'D#4': 'Ds4', 'F#4': 'Fs4', A4: 'A4',
  C5: 'C5', 'D#5': 'Ds5', 'F#5': 'Fs5', A5: 'A5',
  C6: 'C6', 'D#6': 'Ds6', 'F#6': 'Fs6', A6: 'A6',
  C7: 'C7', 'D#7': 'Ds7', 'F#7': 'Fs7', A7: 'A7', C8: 'C8',
};
const SAMPLE_RATE = 44100;
const TAIL = 3; // seconds of ring-out after the last event

// ---------- loading ----------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

let ready = null;
let buffers = null;

/** Load Tone.js and decode the piano samples once. */
export function loadPiano() {
  ready ??= (async () => {
    if (!window.Tone) await loadScript('tone.js');
    const urls = {};
    for (const [note, file] of Object.entries(SAMPLE_NAMES)) urls[note] = `samples/${file}.mp3`;
    buffers = new window.Tone.ToneAudioBuffers({ urls });
    await window.Tone.loaded();
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

function makeSampler() {
  const urls = {};
  for (const note of Object.keys(SAMPLE_NAMES)) urls[note] = buffers.get(note);
  return new window.Tone.Sampler({ urls, release: 1 });
}

// ---------- events -> notes (with sustain pedal) ----------
/** Turn raw MIDI events into notes with start/end times in seconds. */
export function buildNotes(events) {
  const notes = [];
  const active = new Map(); // midi note -> note object still sounding
  const held = new Set(); // keys physically down
  let pedal = false;
  const end = (n, t) => { n.end = Math.max(t, n.start + 0.05); };

  for (const ev of events) {
    const [status, d1, d2] = ev.data;
    const type = status & 0xf0;
    const t = ev.t / 1000;
    if (type === 0x90 && d2 > 0) {
      const prev = active.get(d1);
      if (prev) end(prev, t);
      const n = { midi: d1, start: t, end: null, vel: d2 / 127 };
      notes.push(n);
      active.set(d1, n);
      held.add(d1);
    } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
      held.delete(d1);
      const n = active.get(d1);
      if (n && !pedal) { end(n, t); active.delete(d1); }
    } else if (type === 0xb0 && d1 === 64) {
      const down = d2 >= 64;
      if (pedal && !down) {
        for (const [m, n] of active) if (!held.has(m)) { end(n, t); active.delete(m); }
      }
      pedal = down;
    }
  }
  const last = events.length ? events[events.length - 1].t / 1000 : 0;
  for (const n of active.values()) end(n, last);
  return notes;
}

function scheduleNotes(sampler, notes, offset) {
  const T = window.Tone;
  for (const n of notes) {
    sampler.triggerAttackRelease(
      T.Frequency(n.midi, 'midi').toNote(), n.end - n.start, offset + n.start, n.vel);
  }
}

// ---------- live playback ----------
/** Starts playing; resolves once samples are ready. Returns { stop }. */
export async function startPlayback(rec) {
  await loadPiano();
  const T = window.Tone;
  await T.start();
  const master = new T.Gain(1).toDestination();
  const sampler = makeSampler().connect(master);
  scheduleNotes(sampler, buildNotes(rec.events), T.now() + 0.15);
  return {
    stop() {
      master.gain.value = 0; // silences notes already scheduled
      setTimeout(() => { sampler.dispose(); master.dispose(); }, 100);
    },
  };
}

// ---------- offline render ----------
export async function renderToBuffer(rec) {
  await loadPiano();
  const T = window.Tone;
  const notes = buildNotes(rec.events);
  const seconds = rec.duration / 1000 + TAIL;
  const out = await T.Offline(() => {
    const sampler = makeSampler().toDestination();
    scheduleNotes(sampler, notes, 0.1);
  }, seconds, 1, SAMPLE_RATE);
  return out.get(); // AudioBuffer
}

// ---------- encoders ----------
function toInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function encodeWav(buffer) {
  const pcm = toInt16(buffer.getChannelData(0));
  const bytes = pcm.length * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, bytes, true);
  new Int16Array(view.buffer, 44).set(pcm);
  return new Blob([view], { type: 'audio/wav' });
}

let lamePromise = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve();
  lamePromise ??= loadScript('lame.min.js').catch((e) => { lamePromise = null; throw e; });
  return lamePromise;
}

export async function encodeMp3(buffer) {
  await loadLame();
  const pcm = toInt16(buffer.getChannelData(0));
  const enc = new window.lamejs.Mp3Encoder(1, buffer.sampleRate, 128);
  const parts = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const chunk = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (chunk.length) parts.push(chunk);
  }
  const end = enc.flush();
  if (end.length) parts.push(end);
  return new Blob(parts, { type: 'audio/mpeg' });
}
