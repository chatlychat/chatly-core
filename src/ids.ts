/**
 * An idempotency key / local id, with no DOM and no assumption that
 * `crypto` exists.
 *
 * `globalThis.crypto.randomUUID` is in browsers, Node 19+ and Deno, but not
 * in every embedded JS runtime a world engine ships. The fallback is not
 * cryptographic and does not need to be: the key only has to be unique per
 * call so a stray retry does not collapse into the previous write.
 */
interface CryptoLike {
  randomUUID?: () => string;
}

export function defaultRandomId(): string {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  const hex = (n: number): string => {
    let out = '';
    for (let i = 0; i < n; i += 1) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
