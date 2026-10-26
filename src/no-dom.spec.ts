import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { fakeSocketFactory, msg, recordingFetch } from './test/harness.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Every shipped (non-spec, non-test, non-react) module in the core. */
const coreModules = readdirSync(here).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'),
);

/**
 * Names that exist in a browser and not in a 3D world / game engine / worker.
 * Each is replaced by a getter that THROWS when touched, so an access of any
 * kind -- a read, a `typeof` guard, a destructure -- fails the test, instead
 * of passing because the name happened to be undefined.
 */
const DOM_NAMES = [
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator',
  'location',
  'self',
  'XMLHttpRequest',
  'WebSocket',
  'indexedDB',
  'Event',
  'CustomEvent',
  'EventTarget',
  'BroadcastChannel',
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const name of DOM_NAMES) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        throw new Error(`the core touched the DOM global \`${name}\``);
      },
    });
  }
});

afterAll(() => {
  for (const name of DOM_NAMES) {
    const d = saved.get(name);
    if (d === undefined) {
      Reflect.deleteProperty(globalThis, name);
    } else {
      Object.defineProperty(globalThis, name, d);
    }
  }
});

describe('the core runs with NO DOM present', () => {
  it('the guard itself works: touching a DOM name throws', () => {
    expect(() => (globalThis as Record<string, unknown>)['window']).toThrowError(
      /DOM global `window`/,
    );
    expect(() => typeof (globalThis as Record<string, unknown>)['localStorage']).toThrowError(
      /DOM global `localStorage`/,
    );
  });

  /*
   * SPLIT-TOLERANCE, AND WHY THE FLOOR IS NOT ENOUGH.
   *
   * This enumerates the directory rather than a path list, so a module split
   * out of another is picked up with no edit here — which is the whole point,
   * and also the trap. A floor of 11 against 21 modules means a file could be
   * renamed out of the scan, or a split could land its new half somewhere
   * this `readdirSync` never looks (`src/test/`, a subdirectory), and both
   * anti-vacuity assertions below would still pass while the moved code went
   * unchecked for DOM references.
   *
   * So the named list is an ANCHOR, not a sample. `voice.ts` and
   * `voice-grant.ts` are on it because they are the one pair here that was
   * split (2026-10-24) — if the grant half ever stops being a sibling module
   * in this directory, this test says so by name instead of shrugging at a
   * count.
   */
  it('found the modules (a glob that matched nothing would pass vacuously)', () => {
    expect(coreModules.length).toBeGreaterThanOrEqual(11);
    expect(coreModules).toEqual(
      expect.arrayContaining([
        'core.ts',
        'conversation.ts',
        'realtime.ts',
        'session.ts',
        'storage.ts',
        'voice.ts',
        'voice-grant.ts',
      ]),
    );
  });

  it('every module imports at module scope without touching a DOM name', async () => {
    for (const file of coreModules) {
      if (file === 'ambient.d.ts') {
        continue;
      }
      // Not the barrel's own import of itself: each is loaded by path.
      await expect(
        import(/* @vite-ignore */ `./${file.replace(/\.ts$/, '.js')}`),
      ).resolves.toBeDefined();
    }
  });

  it('a full conversation -- init, start, push, send, postback, react, upload, typing, read, close -- runs', async () => {
    vi.useFakeTimers();
    try {
      const { createChatlyCore } = await import('./index.js');
      const rec = recordingFetch((r) =>
        r.path === '/v1/widget/uploads/presign'
          ? {
              body: {
                uploadId: 'u',
                url: 'https://s3.test/p',
                method: 'PUT',
                headers: {},
                publicUrl: 'https://cdn.test/u',
              },
            }
          : r.path.endsWith('/reactions')
            ? { body: { messageId: '1', entries: [] } }
            : undefined,
      );
      const sock = fakeSocketFactory();
      // No storage injected; the default must not reach for localStorage.
      const core = createChatlyCore({
        publicId: 'pub-1',
        apiUrl: 'https://api.test',
        fetch: rec.fetch,
        socket: sock.factory,
      });
      await core.identify({ email: 'a@b.c' });
      const conv = await core.startConversation('hello');
      sock.sockets[0]!.fire('connect');
      sock.sockets[0]!.fire('event', {
        type: 'message.created',
        payload: { ...msg('1'), conversationId: 'conv-1' },
      });
      sock.sockets[0]!.fire('event', {
        type: 'typing.start',
        payload: { conversationId: 'conv-1', actorType: 'agent', actorId: 'a' },
      });
      await conv.send('hi');
      await conv.postback({ body: 'go', payload: { a: 1 }, silent: true });
      await conv.react('1', '👍');
      await conv.upload({ name: 'a.txt', type: 'text/plain', size: 1, bytes: 'x' });
      await conv.markRead();
      conv.setTyping(true);
      conv.close();
      expect(conv.getSnapshot().connection).toBe('closed');
      expect(rec.calls.length).toBeGreaterThan(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the polling path is DOM-free too', async () => {
    vi.useFakeTimers();
    try {
      const { createChatlyCore } = await import('./index.js');
      const rec = recordingFetch();
      const core = createChatlyCore({
        publicId: 'p',
        apiUrl: 'https://api.test',
        fetch: rec.fetch,
      });
      const conv = await core.openConversation('c1');
      await vi.advanceTimersByTimeAsync(6_000);
      conv.close();
      expect(rec.to('/v1/widget/messages/list').length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the core does not import React, a socket library, or an internal package', () => {
  const IMPORT =
    /^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
  const specifiers = (src: string): string[] => {
    const out: string[] = [];
    for (const m of src.matchAll(IMPORT)) {
      out.push(m[1] ?? m[2] ?? '');
    }
    return out;
  };

  it('reads the import statements of every module (non-vacuous)', () => {
    const all = coreModules.flatMap((f) => specifiers(readFileSync(join(here, f), 'utf8')));
    expect(all.length).toBeGreaterThan(15);
    expect(all.every((s) => s.startsWith('./'))).toBe(true);
  });

  it('only relative imports in the core: no react, socket.io-client, @livechat/*', () => {
    for (const file of coreModules) {
      const bad = specifiers(readFileSync(join(here, file), 'utf8')).filter(
        (s) => !s.startsWith('./'),
      );
      expect({ file, bad }).toEqual({ file, bad: [] });
    }
  });

  it('only the react entry imports react, and it imports nothing else external', () => {
    const src = readFileSync(join(here, 'react', 'index.ts'), 'utf8');
    const external = specifiers(src).filter((s) => !s.startsWith('.'));
    expect(external).toEqual(['react']);
  });
});
