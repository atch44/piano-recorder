// Encode recorded events as a Standard MIDI File (format 0).
// Tempo is fixed at 120 BPM with 500 ticks per quarter note => 1 tick = 1 ms,
// so recorded millisecond timestamps map directly to ticks.

function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];

/** events: [{ t: ms, data: [status, d1, d2?] }] */
export function toMidiFile(events) {
  const track = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]; // tempo 500000 us/qn
  let last = 0;
  for (const ev of events) {
    const t = Math.round(ev.t);
    track.push(...vlq(Math.max(0, t - last)), ...ev.data);
    last = t;
  }
  track.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(0), ...u16(1), ...u16(500)];
  const trk = [0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track];
  return new Uint8Array([...header, ...trk]);
}
