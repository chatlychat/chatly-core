import { describe, expect, it } from 'vitest';

import { VisitorSession } from './session.js';
import { createSafeStorage } from './storage.js';
import { recordingFetch } from './test/harness.js';

import type { KeyValueStorage } from './types.js';

const base = { publicId: 'pub-1', apiUrl: 'https://api.test' };

function memoryStore(
  seed: Record<string, string> = {},
): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('VisitorSession', () => {
  it('concurrent first calls mint ONE visitor', async () => {
    const rec = recordingFetch();
    const s = new VisitorSession({ ...base, fetch: rec.fetch });
    await Promise.all([s.ensure(), s.ensure(), s.ensure()]);
    expect(rec.to('/v1/widget/init')).toHaveLength(1);
  });

  it('stores the token init returned under the shared key and reuses it after a restart', async () => {
    const store = memoryStore();
    const rec = recordingFetch();
    const first = new VisitorSession({ ...base, fetch: rec.fetch, storage: store });
    await first.ensure();
    expect(store.data.get('livechat:vt:pub-1')).toBe('session-token-1');

    const rec2 = recordingFetch();
    const second = new VisitorSession({ ...base, fetch: rec2.fetch, storage: store });
    await second.ensure();
    expect(rec2.calls).toHaveLength(0);
    expect(second.visitorToken).toBe('session-token-1');
  });

  it('persists NOTHING when no storage is injected', async () => {
    const rec = recordingFetch();
    const s = new VisitorSession({ ...base, fetch: rec.fetch });
    await s.ensure();
    const again = new VisitorSession({ ...base, fetch: rec.fetch });
    expect(again.visitorToken).toBeNull();
  });

  it('init sends the stored token and identity, and adopts the ROTATED token', async () => {
    const store = memoryStore({ 'livechat:vt:pub-1': 'old' });
    const rec = recordingFetch();
    const s = new VisitorSession({
      ...base,
      fetch: rec.fetch,
      storage: store,
      locale: 'fr',
      timezone: 'Europe/Paris',
    });
    await s.init({ email: 'a@b.c', externalId: 'u1', userHash: 'h' });
    expect(rec.calls[0]?.body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'old',
      locale: 'fr',
      timezone: 'Europe/Paris',
      identity: { email: 'a@b.c', externalId: 'u1', userHash: 'h' },
    });
    expect(s.visitorToken).toBe('session-token-1');
    expect(store.data.get('livechat:vt:pub-1')).toBe('session-token-1');
    expect(s.contactId).toBe('contact-1');
    expect(s.realtimeUrl).toBe('wss://rt.test');
  });

  it('a realtimeUrl option wins over what init reported', async () => {
    const rec = recordingFetch();
    const s = new VisitorSession({ ...base, fetch: rec.fetch, realtimeUrl: 'wss://mine' });
    await s.ensure();
    expect(s.realtimeUrl).toBe('wss://mine');
  });

  it('strips a trailing slash from apiUrl', async () => {
    const rec = recordingFetch();
    const s = new VisitorSession({
      publicId: 'p',
      apiUrl: 'https://api.test///',
      fetch: rec.fetch,
    });
    await s.ensure();
    expect(rec.calls[0]?.url).toBe('https://api.test/v1/widget/init');
  });

  describe('a dead session (403 visitor_session_*)', () => {
    function flaky(shape: 'nested' | 'flat', times = 1) {
      let failed = 0;
      return recordingFetch((req) => {
        if (req.path === '/v1/widget/events' && failed < times) {
          failed += 1;
          return {
            status: 403,
            body:
              shape === 'nested'
                ? { error: { code: 'visitor_session_expired', message: 'expired' } }
                : { code: 'visitor_session_expired' },
          };
        }
        if (req.path === '/v1/widget/init' && req.body?.['visitorToken'] === undefined) {
          return { body: { session: { token: 'fresh-token', contactId: 'c' } } };
        }
        return undefined;
      });
    }

    for (const shape of ['nested', 'flat'] as const) {
      it(`re-inits once and replays with the NEW token (${shape} error body)`, async () => {
        const rec = flaky(shape);
        const store = memoryStore({ 'livechat:vt:pub-1': 'stale' });
        const s = new VisitorSession({ ...base, fetch: rec.fetch, storage: store });
        const res = await s.post('/v1/widget/events', { ...s.identity(), name: 'x' });
        expect(res.ok).toBe(true);
        const events = rec.to('/v1/widget/events');
        expect(events).toHaveLength(2);
        expect(events[0]?.body?.['visitorToken']).toBe('stale');
        expect(events[1]?.body?.['visitorToken']).toBe('fresh-token');
        // The re-init must not present the dead token.
        expect(rec.to('/v1/widget/init')[0]?.body).not.toHaveProperty('visitorToken');
        expect(store.data.get('livechat:vt:pub-1')).toBe('fresh-token');
      });
    }

    it('gives up after ONE replay and throws a typed error carrying the server code', async () => {
      const rec = flaky('nested', 5);
      const s = new VisitorSession({
        ...base,
        fetch: rec.fetch,
        storage: memoryStore({ 'livechat:vt:pub-1': 'stale' }),
      });
      await expect(s.post('/v1/widget/events', { ...s.identity() })).rejects.toMatchObject({
        name: 'ChatlyError',
        code: 'request_failed',
        httpStatus: 403,
        serverCode: 'visitor_session_expired',
      });
      expect(rec.to('/v1/widget/events')).toHaveLength(2);
    });

    it('a 403 for another reason (disallowed origin) is NOT recovered', async () => {
      const rec = recordingFetch((r) =>
        r.path === '/v1/widget/events'
          ? { status: 403, body: { error: { code: 'origin_not_allowed', message: 'no' } } }
          : undefined,
      );
      const s = new VisitorSession({ ...base, fetch: rec.fetch });
      await s.ensure();
      await expect(s.post('/v1/widget/events', {})).rejects.toMatchObject({
        serverCode: 'origin_not_allowed',
      });
      expect(rec.to('/v1/widget/init')).toHaveLength(1);
      expect(rec.to('/v1/widget/events')).toHaveLength(1);
    });
  });

  it('with no fetch injected and none global, fails with a typed error naming the fix', () => {
    const g = globalThis as { fetch?: unknown };
    const saved = g.fetch;
    delete g.fetch;
    try {
      const s = new VisitorSession(base);
      expect(() => s.getFetch()).toThrowError(/pass `fetch`/);
    } finally {
      g.fetch = saved;
    }
  });
});

describe('storage that throws', () => {
  it('a getter that throws (opaque origin / blocked site data) degrades to memory, never throws', () => {
    const store = createSafeStorage(() => {
      throw new DOMExceptionLike('The operation is insecure.');
    });
    expect(store.getItem('k')).toBeNull();
    expect(() => store.setItem('k', 'v')).not.toThrow();
    expect(store.getItem('k')).toBe('v');
    expect(() => store.removeItem('k')).not.toThrow();
    expect(store.getItem('k')).toBeNull();
  });

  it('methods that throw (quota full, blocked) are swallowed and memory still holds the value', () => {
    const boom = (): never => {
      throw new Error('QuotaExceededError');
    };
    const store = createSafeStorage({ getItem: boom, setItem: boom, removeItem: boom });
    expect(store.getItem('k')).toBeNull();
    store.setItem('k', 'v');
    expect(store.getItem('k')).toBe('v');
    expect(() => store.removeItem('k')).not.toThrow();
  });

  it('a session over throwing storage still bootstraps and works', async () => {
    const rec = recordingFetch();
    const s = new VisitorSession({
      ...base,
      fetch: rec.fetch,
      storage: () => {
        throw new DOMExceptionLike('insecure');
      },
    });
    await s.ensure();
    await s.ensure();
    expect(rec.to('/v1/widget/init')).toHaveLength(1);
    expect(s.visitorToken).toBe('session-token-1');
  });

  it('the thunk is re-resolved, so storage granted later takes writes', () => {
    let granted: KeyValueStorage | null = null;
    const store = createSafeStorage(() => granted);
    store.setItem('a', '1');
    const real = memoryStore();
    granted = real;
    store.setItem('b', '2');
    expect(real.data.get('b')).toBe('2');
    expect(real.data.has('a')).toBe(false);
  });
});

class DOMExceptionLike extends Error {}
