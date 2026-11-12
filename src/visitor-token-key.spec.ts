/**
 * The visitor-token storage key, and the migration off the legacy one.
 *
 * `chatly:vt:<publicId>` is canonical: it is what the widget writes and the
 * ONLY key the published storage declaration names. This package wrote
 * `livechat:vt:` until 2026-11-11, which cost two things that were invisible
 * from inside this package — a visitor could not carry one session between a
 * world host and the widget on the same site, and a consent manager blocking
 * the declared key did not block the real one.
 */
import { describe, expect, it } from 'vitest';

import { createChatlyCore } from './core.js';
import { recordingFetch } from './test/harness.js';

import type { KeyValueStorage } from './types.js';

const PUBLIC_ID = 'pub-1';
const CANONICAL = `chatly:vt:${PUBLIC_ID}`;
const LEGACY = `livechat:vt:${PUBLIC_ID}`;

/** A storage that records what was asked of it, not just what it holds. */
function mapStorage(seed: Record<string, string> = {}) {
  const items = new Map<string, string>(Object.entries(seed));
  const writes: string[] = [];
  const removals: string[] = [];
  const storage: KeyValueStorage = {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => {
      writes.push(k);
      items.set(k, v);
    },
    removeItem: (k) => {
      removals.push(k);
      items.delete(k);
    },
  };
  return { storage, items, writes, removals };
}

function setup(storage: KeyValueStorage) {
  const rec = recordingFetch((req) =>
    req.path === '/v1/widget/init'
      ? { body: { session: { token: 'fresh-token', contactId: 'c-1' } } }
      : undefined,
  );
  const core = createChatlyCore({
    publicId: PUBLIC_ID,
    apiUrl: 'https://api.test',
    fetch: rec.fetch,
    storage,
  });
  return { rec, core };
}

describe('visitor token key', () => {
  it('reads the canonical key', () => {
    const { storage } = mapStorage({ [CANONICAL]: 'tok-canonical' });
    const { core } = setup(storage);
    expect(core.session.visitorToken).toBe('tok-canonical');
  });

  it('writes the canonical key, never the legacy one', async () => {
    const { storage, items, writes } = mapStorage();
    const { core } = setup(storage);
    await core.session.ensure();
    expect(items.get(CANONICAL)).toBe('fresh-token');
    expect(items.has(LEGACY)).toBe(false);
    expect(writes).not.toContain(LEGACY);
  });
});

describe('migration off `livechat:vt:`', () => {
  it('adopts a legacy token so an existing visitor is NOT signed out', () => {
    const { storage } = mapStorage({ [LEGACY]: 'tok-legacy' });
    const { core } = setup(storage);
    expect(core.session.visitorToken).toBe('tok-legacy');
  });

  it('moves it forward on the spot, so the fallback is paid once', () => {
    const { storage, items } = mapStorage({ [LEGACY]: 'tok-legacy' });
    setup(storage);
    expect(items.get(CANONICAL)).toBe('tok-legacy');
    expect(items.has(LEGACY)).toBe(false);
  });

  it('prefers the canonical key when a browser holds both', () => {
    const { storage, items } = mapStorage({
      [CANONICAL]: 'tok-canonical',
      [LEGACY]: 'tok-stale',
    });
    const { core } = setup(storage);
    expect(core.session.visitorToken).toBe('tok-canonical');
    // The stale legacy value must not overwrite the live one.
    expect(items.get(CANONICAL)).toBe('tok-canonical');
  });

  it('does not touch storage at all for a browser with neither key', () => {
    const { storage, writes, removals } = mapStorage();
    const { core } = setup(storage);
    expect(core.session.visitorToken).toBeNull();
    expect(writes).toEqual([]);
    expect(removals).toEqual([]);
  });
});

describe('clearing', () => {
  /**
   * The bug a one-key clear would introduce: `reset()` removes the canonical
   * key, the next read falls back to the legacy key, and the visitor the
   * host just signed out is signed straight back in.
   */
  it('reset() removes BOTH keys, so a legacy token cannot resurrect', () => {
    const { storage, items } = mapStorage({ [CANONICAL]: 'a', [LEGACY]: 'b' });
    const { core } = setup(storage);
    core.session.reset();
    expect(items.has(CANONICAL)).toBe(false);
    expect(items.has(LEGACY)).toBe(false);
  });

  it('a reset browser reads back as a brand-new visitor', () => {
    const { storage } = mapStorage({ [CANONICAL]: 'a', [LEGACY]: 'b' });
    const first = setup(storage);
    first.core.session.reset();
    // A fresh session over the SAME storage is what a page reload is.
    const second = setup(storage);
    expect(second.core.session.visitorToken).toBeNull();
  });
});
