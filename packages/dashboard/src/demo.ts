/**
 * The public demo answers from recorded responses: one JSON file per request,
 * named by a hash of the method, path, sorted query and body.
 * `scripts/site-assets.ts` records them with the same function.
 */
export function fixtureName(method: string, pathAndQuery: string, body?: string | null): string {
  const url = new URL(pathAndQuery, 'http://x');
  url.searchParams.sort();
  const key = `${method} ${url.pathname}${url.search}${body ? ` ${body}` : ''}`;
  // FNV-1a, 64-bit: short, stable names with no collisions at demo sizes.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}
