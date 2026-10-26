import { describe, expect, it } from 'vitest';

import { createChatlyCore } from './core.js';
import { connectRealtime } from './realtime.js';
import { fakeSocketFactory, flush, recordingFetch, runAuth } from './test/harness.js';

describe('the realtime handshake contract', () => {
  async function liveCore(mint?: Parameters<typeof recordingFetch>[0]) {
    const rec = recordingFetch(mint);
    const sock = fakeSocketFactory();
    const core = createChatlyCore({
      publicId: 'pub-1',
      apiUrl: 'https://api.test',
      fetch: rec.fetch,
      socket: sock.factory,
    });
    const conv = await core.openConversation('conv-1');
    return { rec, sock, core, conv };
  }

  it('connects to the host init reported, on /socket.io over websocket only', async () => {
    const { sock } = await liveCore();
    expect(sock.urls).toEqual(['wss://rt.test']);
    expect(sock.options[0]).toMatchObject({ path: '/socket.io', transports: ['websocket'] });
  });

  it("the handshake carries kind: 'visitor' (the gateway defaults a missing kind to AGENT)", async () => {
    const { sock } = await liveCore();
    const auth = await runAuth(sock.options[0]!);
    expect(auth.kind).toBe('visitor');
  });

  it('the token is the one minted by /realtime/token, NOT init session.token', async () => {
    const { sock, rec } = await liveCore();
    const auth = await runAuth(sock.options[0]!);
    expect(auth.token).toBe('rt-token-1-abcdefgh');
    expect(auth.token).not.toBe('session-token-1');
    const mint = rec.to('/v1/widget/realtime/token');
    expect(mint).toHaveLength(1);
    expect(mint[0]?.body).toMatchObject({
      conversationId: 'conv-1',
      visitorToken: 'session-token-1',
    });
  });

  it('auth is a FUNCTION (evaluated per attempt), never a frozen object', async () => {
    const { sock } = await liveCore();
    expect(typeof sock.options[0]?.auth).toBe('function');
  });

  it('auth is re-read per connect attempt: an expired token is re-minted, a live one is reused', async () => {
    let n = 0;
    let clock = Date.parse('2026-10-23T10:00:00.000Z');
    const rec = recordingFetch((req) => {
      if (req.path !== '/v1/widget/realtime/token') {
        return undefined;
      }
      n += 1;
      return {
        body: {
          token: `rt-token-${n}-abcdefgh`,
          // Valid for one hour from the fake clock.
          expiresAt: new Date(clock + 3_600_000).toISOString(),
        },
      };
    });
    const sock = fakeSocketFactory();
    const handle = connectRealtime({
      factory: sock.factory,
      url: 'wss://rt.test',
      mintToken: async () => {
        const res = await rec.fetch('https://api.test/v1/widget/realtime/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        return (await res.json()) as { token: string; expiresAt: string };
      },
      onEnvelope: () => undefined,
      now: () => clock,
    });
    const opts = sock.options[0]!;
    const first = await runAuth(opts);
    clock += 10 * 60_000; // 10 min later, a reconnect: still valid -> reused
    const second = await runAuth(opts);
    expect(second.token).toBe(first.token);
    expect(n).toBe(1);

    clock += 55 * 60_000; // past the 1h TTL (minus skew): the next attempt must re-mint
    const third = await runAuth(opts);
    expect(third.token).toBe('rt-token-2-abcdefgh');
    expect(third.token).not.toBe(first.token);
    expect(n).toBe(2);
    handle.disconnect();
  });

  it('concurrent attempts share one mint', async () => {
    let n = 0;
    const sock = fakeSocketFactory();
    connectRealtime({
      factory: sock.factory,
      url: 'u',
      mintToken: async () => {
        n += 1;
        await flush();
        return { token: `t${n}-abcdefgh`, expiresAt: null };
      },
      onEnvelope: () => undefined,
    });
    const opts = sock.options[0]!;
    const [a, b] = await Promise.all([runAuth(opts), runAuth(opts)]);
    expect(n).toBe(1);
    expect(a.token).toBe(b.token);
  });

  it('a failed mint still ANSWERS the attempt (never stalls it) and reports the error', async () => {
    const errors: unknown[] = [];
    const sock = fakeSocketFactory();
    connectRealtime({
      factory: sock.factory,
      url: 'u',
      mintToken: () => Promise.reject(new Error('404 not your conversation')),
      onEnvelope: () => undefined,
      onError: (e) => errors.push(e),
    });
    const auth = await runAuth(sock.options[0]!);
    expect(auth).toEqual({ token: '', kind: 'visitor' });
    expect(errors).toHaveLength(1);
  });

  it('through the Conversation: past the TTL, the next attempt mints a SECOND token from the route', async () => {
    let clock = Date.parse('2026-10-23T10:00:00.000Z');
    let n = 0;
    const rec = recordingFetch((req) =>
      req.path === '/v1/widget/realtime/token'
        ? {
            body: {
              token: `rt-token-${(n += 1)}-abcdefgh`,
              expiresAt: new Date(clock + 3_600_000).toISOString(),
            },
          }
        : undefined,
    );
    const sock = fakeSocketFactory();
    const core = createChatlyCore({
      publicId: 'pub-1',
      apiUrl: 'https://api.test',
      fetch: rec.fetch,
      socket: sock.factory,
      now: () => clock,
    });
    await core.openConversation('conv-1');
    const first = await runAuth(sock.options[0]!);
    clock += 2 * 3_600_000;
    const second = await runAuth(sock.options[0]!);
    expect([first.token, second.token]).toEqual(['rt-token-1-abcdefgh', 'rt-token-2-abcdefgh']);
    expect(rec.to('/v1/widget/realtime/token')).toHaveLength(2);
  });

  it('visitor typing / reads are the only things emitted, and only with the right identity', async () => {
    const { sock, conv } = await liveCore();
    conv.setTyping(true);
    expect(sock.sockets[0]?.emitted).toEqual([
      {
        event: 'typing.start',
        payload: { conversationId: 'conv-1', actorType: 'contact', actorId: 'contact-1' },
      },
    ]);
  });
});
