/**
 * Id generation that works in browsers, Workers and Node without dependencies.
 */

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * RFC 9562 UUIDv7: 48-bit millisecond timestamp + randomness.
 * Time-ordered, so event ids sort roughly by creation time.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A URL-safe random token, e.g. for API keys. 32 bytes = 256 bits of entropy by default. */
export function randomToken(bytes = 32): string {
  return hex(randomBytes(bytes));
}
