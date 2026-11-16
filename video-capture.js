// Frame-accurate camera capture (WebCodecs) and MP4 muxing with piano audio rendered
// from MIDI afterwards. Video frames and MIDI events share the performance.now() clock,
// so the audio is placed exactly against the video and cannot drift.

export const rawCaptureSupported = () =>
  'MediaStreamTrackProcessor' in window && 'VideoEncoder' in window &&
  'AudioEncoder' in window && 'AudioData' in window;

const H264 = ['avc1.42001f', 'avc1.4d0028', 'avc1.640028']; // baseline 3.1, main 4.0, high 4.0
const KEYFRAME_EVERY = 60;

async function videoConfig(width, height) {
  for (const codec of H264) {
    const cfg = { codec, width, height, bitrate: 2_500_000, framerate: 30, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
  }
  throw new Error('This device cannot encode H.264 video');
}

const copyBytes = (src) => {
  if (!src) return undefined;
  const view = ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : new Uint8Array(src);
  return view.slice().buffer;
};

/**
 * Start encoding frames from a camera track. Returns { stop() } where stop() resolves to
 * { chunks, decoderConfig, width, height, rotation, startWall } (startWall: performance.now() ms
 * of the first frame; chunk ts/dur in microseconds from that frame).
 */
export function startCapture(track) {
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const chunks = [];
  let encoder = null;
  let decoderConfig = null;
  let error = null;
  let firstTs = null;
  let startWall = null;
  let width = 0;
  let height = 0;
  let rotation = 0;
  let count = 0;
  let stopped = false;

  const loop = (async () => {
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      try {
        if (!encoder) {
          startWall = performance.now();
          firstTs = frame.timestamp;
          width = frame.displayWidth & ~1;
          height = frame.displayHeight & ~1;
          rotation = [90, 180, 270].includes(frame.rotation) ? frame.rotation : 0;
          encoder = new VideoEncoder({
            output: (chunk, meta) => {
              if (meta?.decoderConfig && !decoderConfig) {
                decoderConfig = { ...meta.decoderConfig, description: copyBytes(meta.decoderConfig.description) };
              }
              const data = new Uint8Array(chunk.byteLength);
              chunk.copyTo(data);
              chunks.push({ type: chunk.type, ts: chunk.timestamp - firstTs, dur: chunk.duration ?? 0, data });
            },
            error: (e) => { error = e; },
          });
          encoder.configure(await videoConfig(width, height));
        }
        // If the encoder falls behind, drop frames rather than build up delay.
        if (encoder.encodeQueueSize < 5 && frame.timestamp >= firstTs) {
          encoder.encode(frame, { keyFrame: count++ % KEYFRAME_EVERY === 0 });
        }
      } catch (e) {
        error = e;
      } finally {
        frame.close();
      }
      if (error) break;
    }
  })();

  return {
    async stop() {
      stopped = true;
      await reader.cancel().catch(() => {});
      await loop;
      if (encoder && encoder.state !== 'closed') {
        await encoder.flush().catch((e) => { error ??= e; });
        encoder.close();
      }
      if (error) throw error;
      if (!chunks.length || !decoderConfig) throw new Error('No video frames were captured');
      return { chunks, decoderConfig, width, height, rotation, startWall };
    },
  };
}

// ---------- muxing ----------
let muxerLoad = null;
function loadMuxer() {
  if (window.Mp4Muxer) return Promise.resolve();
  muxerLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'mp4-muxer.js';
    s.onload = resolve;
    s.onerror = () => { muxerLoad = null; reject(new Error('Could not load mp4-muxer.js')); };
    document.head.appendChild(s);
  });
  return muxerLoad;
}

async function encodeAudio(buffer) {
  const base = { sampleRate: buffer.sampleRate, numberOfChannels: 1, bitrate: 128_000 };
  let cfg = null;
  let muxCodec = null;
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    try {
      if ((await AudioEncoder.isConfigSupported({ ...base, codec })).supported) {
        cfg = { ...base, codec };
        muxCodec = mux;
        break;
      }
    } catch { /* next */ }
  }
  if (!cfg) throw new Error('This device cannot encode AAC or Opus audio');

  const chunks = [];
  let meta = null;
  let error = null;
  const enc = new AudioEncoder({
    output: (chunk, m) => {
      if (m?.decoderConfig && !meta) {
        meta = { decoderConfig: { ...m.decoderConfig, description: copyBytes(m.decoderConfig.description) } };
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ type: chunk.type, ts: chunk.timestamp, dur: chunk.duration ?? 0, data });
    },
    error: (e) => { error = e; },
  });
  enc.configure(cfg);

  const pcm = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const STEP = 1024;
  for (let i = 0; i < pcm.length; i += STEP) {
    const slice = pcm.slice(i, i + STEP);
    const ad = new AudioData({
      format: 'f32-planar', sampleRate: sr, numberOfFrames: slice.length,
      numberOfChannels: 1, timestamp: Math.round((i / sr) * 1e6), data: slice,
    });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  if (error) throw error;
  return { chunks, meta, muxCodec, sampleRate: sr };
}

/** Combine captured video with a rendered AudioBuffer (both starting at the first frame). */
export async function buildMp4(cap, audioBuffer) {
  await loadMuxer();
  const audio = await encodeAudio(audioBuffer);
  const M = window.Mp4Muxer;
  const muxer = new M.Muxer({
    target: new M.ArrayBufferTarget(),
    video: { codec: 'avc', width: cap.width, height: cap.height, rotation: cap.rotation },
    audio: { codec: audio.muxCodec, sampleRate: audio.sampleRate, numberOfChannels: 1 },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'cross-track-offset',
  });

  // Interleave both tracks in timestamp order.
  const v = cap.chunks;
  const a = audio.chunks;
  let i = 0;
  let j = 0;
  while (i < v.length || j < a.length) {
    if (j >= a.length || (i < v.length && v[i].ts <= a[j].ts)) {
      const c = v[i];
      muxer.addVideoChunkRaw(c.data, c.type, c.ts, c.dur || 33_333,
        i === 0 ? { decoderConfig: cap.decoderConfig } : undefined);
      i++;
    } else {
      const c = a[j];
      muxer.addAudioChunkRaw(c.data, c.type, c.ts, c.dur || 21_333, j === 0 ? audio.meta : undefined);
      j++;
    }
  }
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
