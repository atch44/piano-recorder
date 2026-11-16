# Piano Recorder – Project Summary

A web app (PWA) that connects to a Roland FP-10 digital piano from an Android phone, records what you play, plays it back, and exports it.

- **Live site:** https://atch44.github.io/piano-recorder/
- **Repo:** https://github.com/atch44/piano-recorder (public, required for free GitHub Pages)
- **Use it in:** Chrome on Android. Brave does not work for Bluetooth (Web Bluetooth is restricted there).

## Decisions

| Question | Decision |
|---|---|
| Record MIDI or audio? | **MIDI** (notes, velocity, timing, pedal). Small, accurate, editable. Audio is rendered from it on export. |
| Native app or web app? | **Web app** first (fastest to build, no install friction). Native Kotlin remains an option if Web MIDI/Bluetooth proves limiting. |
| Hosting | **GitHub Pages** (HTTPS is required for Web MIDI and Web Bluetooth). |
| Bluetooth without helper apps | **Web Bluetooth** reading the standard BLE MIDI service directly. |
| Playback sound | **Sampled piano** (Tone.js + Salamander Grand Piano samples), bundled for offline use. |

## Features

- Connect over **USB** (Web MIDI) or **Bluetooth** (Web Bluetooth, BLE MIDI).
- Live note display and recording timer.
- Record / stop. Takes with no notes are not saved.
- Takes saved in the browser's local storage.
- Playback with a sampled grand piano and **sustain pedal** support.
- Export each take as **.mid**, **MP3** or **WAV** (audio is rendered offline with the same piano sound).
- **Video recording (optional):** tick "Record video too" to record the camera (front or back) together with the piano sound. The piano sound is rendered live from your MIDI (same sampled piano, sent to the recording only, not the speakers), so the video file already has the audio merged in. Download it with the **Video** button or preview it with **Watch**. Saved as MP4 where Chrome supports it, otherwise WebM. Videos are stored in IndexedDB.
- Installable (manifest + service worker), works offline after first load.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css` | UI, light/dark theme |
| `app.js` | USB/Bluetooth connection, recording, playback, recordings list, export buttons |
| `ble-midi.js` | Web Bluetooth connection and BLE MIDI packet parser |
| `midi-file.js` | Writes Standard MIDI Files (1 tick = 1 ms at 120 BPM) |
| `audio-render.js` | Notes + pedal logic, Tone.js playback, offline render, WAV and MP3 encoders |
| `video-store.js` | Stores recorded video blobs in IndexedDB |
| `tone.js`, `samples/` | Bundled Tone.js 14.7.77 and 30 Salamander piano samples (~2 MB) |
| `lame.min.js` | Bundled lamejs 1.2.1 MP3 encoder (LGPL, see `lame.LICENSE.txt`) |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | PWA offline caching and install |

## Hardware notes (Roland FP-10)

- USB port is **Type B**. A USB-A to USB-C cable will **not** fit. Needs a **USB-C to USB-B** cable, or a USB-A to USB-B printer cable plus a USB-C OTG adapter.
- Built-in **Bluetooth MIDI** (per retailer spec sheets; Roland's official sheet was not checked).
- Bluetooth works only in **Chrome**, with **Location** on and the Chrome **Nearby devices** permission allowed. The piano should not already be connected to another device.

## Status

**Done and working (confirmed by the user):** connecting over Bluetooth in Chrome.

**Written but not yet confirmed on a phone:**
- Sampled piano playback and sustain pedal.
- MP3 / WAV export.
- Offline caching of Tone.js and the samples.

**Verified only by code checks:** syntax checks on all JS files; BLE packet parser and note/pedal logic tested with sample data. Tone.js, the offline render and the MP3 encoder have not been run (running third-party code was blocked in the sandbox).

**Not tested:** USB connection (no cable yet).

## Known limitations

- Takes (and videos) live in browser storage; clearing site data deletes them. Download `.mid` and video files to keep them.
- Video is about 19 MB per minute (2.5 Mbps), so long takes use phone storage quickly.
- The video's audio is rendered live while recording and is baked in; later changes to the piano sound don't affect old videos. The MP3/WAV exports are rendered separately from the MIDI.
- The video feature is untested on a phone (camera permission, MP4 vs WebM support, live audio capture).
- After an update, the service worker can serve the old version until the page is reloaded or site data is cleared.
- Bluetooth timing is slightly looser than USB.
- Exports are mono, 44.1 kHz; MP3 at 128 kbps.

## Deploying changes

```
git add -A
git commit -m "message"
git push
```

GitHub Pages rebuilds in about a minute. Bump the `CACHE` version in `sw.js` when app files change, so phones pick up the update.

## Possible next steps

- Test and fix playback and export on the phone.
- Buy the USB-C to USB-B cable and test USB.
- Metronome / count-in before recording.
- Rename takes; share or import `.mid` files.
- Hide the USB device dropdown unless a USB device is connected.
- Better sound options (reverb, different sample set).
- Native Kotlin app if Web MIDI/Bluetooth limits become a problem.
