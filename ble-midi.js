// BLE MIDI over Web Bluetooth (Chrome on Android/desktop, HTTPS only).
const SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
const CHARACTERISTIC = '7772e5db-3868-4112-a1a9-f2669d106bf3';

/** Parse one BLE MIDI packet and call emit([status, d1, d2?]) per message. */
export function parsePacket(bytes, emit) {
  const n = bytes.length;
  let i = 1; // byte 0 is the packet header (timestamp high bits)
  let running = 0;
  while (i < n) {
    if (bytes[i] & 0x80) i++; // timestamp-low byte before each message
    if (i >= n) break;
    let status;
    if (bytes[i] & 0x80) {
      status = bytes[i++];
      if (status < 0xf0) running = status;
    } else {
      status = running;
    }
    if (!status) { i++; continue; }
    if (status >= 0xf0) { // system messages / sysex: skip
      while (i < n && !(bytes[i] & 0x80)) i++;
      continue;
    }
    const type = status & 0xf0;
    const len = type === 0xc0 || type === 0xd0 ? 1 : 2;
    const msg = [status];
    while (msg.length < len + 1 && i < n && !(bytes[i] & 0x80)) msg.push(bytes[i++]);
    if (msg.length === len + 1) emit(msg);
  }
}

export const bleSupported = () => !!navigator.bluetooth;

/** Opens the Bluetooth device chooser and starts streaming MIDI. */
export async function connectBle(onMessage, onDisconnect) {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE] }],
  });
  device.addEventListener('gattserverdisconnected', onDisconnect);
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE);
  const char = await service.getCharacteristic(CHARACTERISTIC);
  char.addEventListener('characteristicvaluechanged', (e) => {
    const bytes = new Uint8Array(e.target.value.buffer);
    const t = performance.now();
    parsePacket(bytes, (msg) => onMessage(msg, t));
  });
  await char.startNotifications();
  return { name: device.name || 'Bluetooth MIDI device', disconnect: () => device.gatt.disconnect() };
}
