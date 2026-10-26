/**
 * The voice session, asserted on WHAT IT SENT.
 *
 * A fake transport that echoes whatever it was handed agrees with any bug —
 * that is how four mobile SDKs shipped unable to connect, with green suites,
 * twice over. So the fake here RECORDS: every connect input, every
 * data-channel string, every microphone call. The canned answers exist only
 * to keep the flow moving, and every assertion that matters is about a
 * request or a payload this package produced.
 *
 * That recording fake, the grant responder and `setup()` are in
 * `./test/voice-harness.ts` — fixtures with their own state, split from the
 * assertions that read it. This file is the assertions.
 */
import { describe, expect, it, vi } from 'vitest';

import { ChatlyError } from './errors.js';
import { VisitorSession } from './session.js';
import { API, recordingFetch } from './test/harness.js';
import { END_PATH, GOLDEN, TOKEN_PATH, grantResponder, setup } from './test/voice-harness.js';
import { VoiceSession } from './voice.js';

import type { VoiceActivity, VoiceTransportConnectInput } from './voice-types.js';

/* ─────────────────────────── the token exchange ─────────────────────────── */

describe('requesting a session', () => {
  it('posts the visitor identity to video-calls/token, with an idempotency key', async () => {
    const { voice, rec } = setup();
    await voice.start();

    const calls = rec.to(TOKEN_PATH);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'session-token-1',
      conversationId: 'conv-9',
    });
    expect((calls[0]?.headers['idempotency-key'] ?? '').length).toBeGreaterThan(0);
  });

  it('bootstraps the visitor first — it never sends an empty token', async () => {
    const { voice, rec } = setup();
    await voice.start();
    expect(rec.to('/v1/widget/init')).toHaveLength(1);
    expect(rec.calls[0]?.path).toBe('/v1/widget/init');
    expect(rec.calls[1]?.path).toBe(TOKEN_PATH);
  });

  it('hands the transport the MINTED LiveKit token, not the visitor session token', async () => {
    const { voice, fake } = setup();
    await voice.start();
    expect(fake.inputs).toHaveLength(1);
    expect(fake.inputs[0]?.grant.token).toBe('lk-token-1');
    // The whole class of bug: the session token is not a join credential.
    expect(fake.inputs[0]?.grant.token).not.toBe('session-token-1');
    expect(fake.inputs[0]?.grant).toEqual({
      url: 'wss://lk.test',
      room: 'ws_conv-9',
      token: 'lk-token-1',
      expiresAt: null,
    });
  });

  it('asks for audio only, and honours a muted start before a syllable can leak', async () => {
    const { voice, fake } = setup();
    await voice.start();
    expect(fake.inputs[0]?.audioOnly).toBe(true);
    expect(fake.inputs[0]?.microphoneEnabled).toBe(false);
    expect(fake.inputs[0]?.conversationId).toBe('conv-9');

    const hot = setup({ startMuted: false });
    await hot.voice.start();
    expect(hot.fake.inputs[0]?.microphoneEnabled).toBe(true);
  });

  it('refuses a grant that is missing a field rather than connecting to nothing', async () => {
    const { voice, fake } = setup({
      responder: (r) => (r.path === TOKEN_PATH ? { body: { url: 'wss://lk.test' } } : undefined),
    });
    await voice.start();
    expect(fake.inputs).toHaveLength(0);
    expect(voice.getSnapshot().connection).toBe('failed');
    expect((voice.getSnapshot().error as ChatlyError).code).toBe('invalid_response');
  });

  it('a refused grant is final and tells the server nothing — there was no call', async () => {
    const { voice, rec } = setup({
      responder: (r) =>
        r.path === TOKEN_PATH
          ? {
              status: 400,
              body: {
                error: { code: 'validation', message: 'Video calling is turned off for this chat' },
              },
            }
          : undefined,
    });
    await voice.start();
    expect(voice.getSnapshot().connection).toBe('failed');
    expect((voice.getSnapshot().error as ChatlyError).message).toBe(
      'Video calling is turned off for this chat',
    );
    expect(rec.to(END_PATH)).toHaveLength(0);
  });

  it('is idempotent while a session is up', async () => {
    const { voice, rec } = setup();
    await voice.start();
    voice.getSnapshot();
    await voice.start();
    expect(rec.to(TOKEN_PATH)).toHaveLength(1);
  });

  it('never puts the join token in the snapshot a host might log', async () => {
    const { voice, fake } = setup();
    await voice.start();
    fake.hooks().onConnected();
    const serialised = JSON.stringify(voice.getSnapshot());
    expect(serialised).not.toContain('lk-token-1');
    expect(serialised).not.toContain('session-token-1');
    expect(voice.getSnapshot().room).toBe('ws_conv-9');
    expect(voice.getSnapshot().url).toBe('wss://lk.test');
  });
});

/* ──────────────────────── the credential is never frozen ─────────────────── */

describe('every attempt re-requests the grant', () => {
  it('a reconnect carries a FRESH token, not the one the first attempt used', async () => {
    vi.useFakeTimers();
    try {
      const { voice, fake, rec } = setup();
      await voice.start();
      fake.hooks().onConnected();
      expect(voice.getSnapshot().connection).toBe('live');

      fake.hooks().onDisconnected();
      expect(voice.getSnapshot().connection).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(rec.to(TOKEN_PATH)).toHaveLength(2);
      expect(fake.inputs).toHaveLength(2);
      expect(fake.inputs[1]?.grant.token).toBe('lk-token-2');
      expect(fake.inputs[1]?.grant.token).not.toBe(fake.inputs[0]?.grant.token);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after maxAttempts and tells the server the call ERRORED, not hung up', async () => {
    vi.useFakeTimers();
    try {
      const { voice, fake, rec } = setup({ maxAttempts: 2 });
      await voice.start();
      fake.hooks().onDisconnected();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.inputs).toHaveLength(2);
      fake.hooks().onDisconnected();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(fake.inputs).toHaveLength(2);
      expect(voice.getSnapshot().connection).toBe('failed');
      expect(rec.to(END_PATH)).toHaveLength(1);
      expect(rec.to(END_PATH)[0]?.body).toEqual({
        publicId: 'pub-1',
        visitorToken: 'session-token-1',
        conversationId: 'conv-9',
        reason: 'error',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a transport factory that throws is a failed attempt, not an unhandled rejection', async () => {
    const { voice } = setup({ throwOnAttempt: 1, maxAttempts: 1 });
    await voice.start();
    const err = voice.getSnapshot().error;
    expect(voice.getSnapshot().connection).toBe('failed');
    expect(err).toBeInstanceOf(ChatlyError);
    expect((err as ChatlyError).code).toBe('no_socket');
    expect((err as ChatlyError).cause).toBeInstanceOf(Error);
  });

  it('announces mute even when the transport connected before it returned a handle', async () => {
    // A transport already in a room fires onConnected synchronously. The
    // announcement has nothing to publish on at that moment, and a session
    // that assumed delivery would leave the room uninformed and look fine.
    const rec = recordingFetch(grantResponder());
    const session = new VisitorSession({ publicId: 'pub-1', apiUrl: API, fetch: rec.fetch });
    const sent: string[] = [];
    let seen: VoiceTransportConnectInput | null = null;
    const voice = new VoiceSession({
      session,
      conversationId: 'conv-9',
      startMuted: false,
      transport: (input) => {
        seen = input;
        input.hooks.onConnected(); // before the handle exists
        return {
          setMicrophoneEnabled: () => undefined,
          send: (p) => {
            sent.push(p);
          },
          disconnect: () => undefined,
        };
      },
    });
    await voice.start();
    expect(seen).not.toBeNull();
    expect(voice.getSnapshot().connection).toBe('live');
    expect(sent).toEqual([GOLDEN.muteOff]);
  });

  it('replays a mute that landed while the factory was still in flight', async () => {
    // The window is between the factory being CALLED and it returning a
    // handle. A push-to-talk release in there reaches no transport, and the
    // session would otherwise believe it had been delivered.
    const rec = recordingFetch(grantResponder());
    const session = new VisitorSession({ publicId: 'pub-1', apiUrl: API, fetch: rec.fetch });
    const mic: boolean[] = [];
    let ref: VoiceSession | null = null;
    const voice: VoiceSession = new VoiceSession({
      session,
      conversationId: 'conv-9',
      startMuted: false,
      transport: async (input) => {
        expect(input.microphoneEnabled).toBe(true);
        ref?.mute(); // mid-flight: there is no handle to drive yet
        await Promise.resolve();
        return {
          setMicrophoneEnabled: (on) => {
            mic.push(on);
          },
          send: () => undefined,
          disconnect: () => undefined,
        };
      },
    });
    ref = voice;
    await voice.start();
    expect(voice.getSnapshot().muted).toBe(true);
    expect(mic).toEqual([false]);
  });

  it('a hook from a superseded attempt changes nothing', async () => {
    const { voice, fake } = setup();
    await voice.start();
    const stale = fake.hooks();
    await voice.leave();
    expect(voice.getSnapshot().connection).toBe('ended');

    stale.onConnected();
    stale.onActivity([{ identity: 'me', local: true, speaking: true, level: 1 }]);
    stale.onMicrophone(true);
    expect(voice.getSnapshot().connection).toBe('ended');
    expect(voice.getSnapshot().turn.localSpeaking).toBe(false);
    expect(voice.getSnapshot().microphone).toBe('unknown');
  });
});

/* ──────────────────────────── measurable states ──────────────────────────── */

describe('timings, measured rather than promised', () => {
  it('reports the token exchange and the transport connect off the injected clock', async () => {
    const { voice, fake, clock } = setup();
    clock.t = 1_000;
    const started = voice.start();
    clock.t = 1_120; // the grant came back
    await started;
    clock.t = 1_430; // media started flowing
    fake.hooks().onConnected();

    const t = voice.getSnapshot().timings;
    expect(t.requestedAt).toBe(1_000);
    expect(t.grantMs).toBe(120);
    expect(t.connectMs).toBe(310);
    expect(t.attempts).toBe(1);
  });

  it('counts attempts across a reconnect', async () => {
    vi.useFakeTimers();
    try {
      const { voice, fake } = setup();
      await voice.start();
      fake.hooks().onConnected();
      fake.hooks().onDisconnected();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(voice.getSnapshot().timings.attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ───────────────────────────────── the mic ───────────────────────────────── */

describe('mute and unmute', () => {
  it('drives the transport AND announces it to the room', async () => {
    const { voice, fake } = setup({ startMuted: false });
    await voice.start();
    fake.hooks().onConnected();
    expect(fake.sent).toEqual([GOLDEN.muteOff]); // on connect, so a peer that joined first knows

    voice.mute();
    expect(fake.mic).toEqual([false]);
    expect(fake.sent).toEqual([GOLDEN.muteOff, GOLDEN.muteOn]);
    expect(voice.getSnapshot().muted).toBe(true);
    expect(voice.getSnapshot().listening).toBe(false);

    voice.unmute();
    expect(fake.mic).toEqual([false, true]);
    expect(fake.sent[2]).toBe(GOLDEN.muteOff);
    expect(voice.getSnapshot().listening).toBe(true);
  });

  it('does nothing when the state already matches', async () => {
    const { voice, fake } = setup({ startMuted: true });
    await voice.start();
    fake.hooks().onConnected();
    const before = fake.sent.length;
    voice.mute();
    expect(fake.sent).toHaveLength(before);
    expect(fake.mic).toEqual([]);
  });

  it('separates what the visitor asked for from what the device is doing', async () => {
    const { voice, fake } = setup({ startMuted: false });
    await voice.start();
    fake.hooks().onConnected();
    expect(voice.getSnapshot().microphone).toBe('unknown');
    expect(voice.getSnapshot().listening).toBe(true);

    // A browser revoking permission mid-call: not muted, and not heard.
    fake.hooks().onMicrophone(false);
    expect(voice.getSnapshot().muted).toBe(false);
    expect(voice.getSnapshot().microphone).toBe('off');
    expect(voice.getSnapshot().listening).toBe(false);
  });
});

/* ──────────────────────────── turn-taking, live ──────────────────────────── */

describe('turn-taking', () => {
  const speaking = (identity: string, local: boolean): VoiceActivity => ({
    identity,
    local,
    speaking: true,
    level: 0.5,
  });

  it('declares the local floor on the data channel and in the snapshot', async () => {
    const { voice, fake } = setup();
    await voice.start();
    fake.hooks().onConnected();

    voice.declareFloor('preparing', 'thinking…');
    expect(fake.sent.at(-1)).toBe(GOLDEN.floorPreparing);
    expect(voice.getSnapshot().turn.floor).toBe('open');
    expect(voice.getSnapshot().turn.preparing).toEqual(['local']);

    voice.declareFloor('taken');
    expect(fake.sent.at(-1)).toBe(GOLDEN.floorTaken);
    expect(voice.getSnapshot().turn.floor).toBe('local');

    voice.declareFloor('yielded');
    expect(fake.sent.at(-1)).toBe(GOLDEN.floorYielded);
    expect(voice.getSnapshot().turn.floor).toBe('open');
  });

  it('expires a local claim nobody restated, so a crash does not pin the floor', async () => {
    vi.useFakeTimers();
    try {
      const { voice, fake } = setup({ claimTtlMs: 5_000 });
      await voice.start();
      fake.hooks().onConnected();
      voice.declareFloor('taken');
      expect(voice.getSnapshot().turn.floor).toBe('local');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(voice.getSnapshot().turn.floor).toBe('open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('attributes a peer claim to the sender the transport named', async () => {
    const { voice, fake } = setup();
    await voice.start();
    fake.hooks().onConnected();
    fake.hooks().onData(GOLDEN.floorTaken, 'agent:1');
    expect(voice.getSnapshot().turn.floor).toBe('remote');
    expect(voice.getSnapshot().lastRefusal).toBeNull();

    fake.hooks().onData(GOLDEN.floorYielded, 'agent:1');
    expect(voice.getSnapshot().turn.floor).toBe('open');
  });

  it('refuses a signal with no sender rather than guessing whose it is', async () => {
    const { voice, fake } = setup();
    await voice.start();
    fake.hooks().onConnected();
    fake.hooks().onData(GOLDEN.floorTaken, null);
    expect(voice.getSnapshot().turn.floor).toBe('open');
    expect(voice.getSnapshot().lastRefusal?.refused).toBe('bad-field');
    expect(voice.getSnapshot().lastRefusal?.detail).toContain('no sender identity');
  });

  it('surfaces a misspelled key instead of silently doing nothing', async () => {
    const { voice, fake } = setup();
    await voice.start();
    fake.hooks().onConnected();
    fake.hooks().onData('{"v":1,"kind":"voice.floor","stat":"taken"}', 'agent:1');
    expect(voice.getSnapshot().lastRefusal?.refused).toBe('unknown-key');
    expect(voice.getSnapshot().turn.floor).toBe('open');
  });

  it('records which peers have muted themselves', async () => {
    const { voice, fake } = setup();
    await voice.start();
    fake.hooks().onConnected();
    fake.hooks().onData(GOLDEN.muteOn, 'agent:1');
    expect(voice.getSnapshot().remoteMuted).toEqual(['agent:1']);
    fake.hooks().onData(GOLDEN.muteOff, 'agent:1');
    expect(voice.getSnapshot().remoteMuted).toEqual([]);
  });

  it('expires a peer claim on the same clock', async () => {
    vi.useFakeTimers();
    try {
      const { voice, fake } = setup({ claimTtlMs: 4_000 });
      await voice.start();
      fake.hooks().onConnected();
      fake.hooks().onData(GOLDEN.floorTaken, 'agent:1');
      await vi.advanceTimersByTimeAsync(3_999);
      expect(voice.getSnapshot().turn.floor).toBe('remote');
      await vi.advanceTimersByTimeAsync(2);
      expect(voice.getSnapshot().turn.floor).toBe('open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('audible speech beats a claim: a `taken` peer plus local speech is contested', async () => {
    const { voice, fake } = setup();
    await voice.start();
    fake.hooks().onConnected();
    fake.hooks().onData(GOLDEN.floorTaken, 'agent:1');
    fake.hooks().onActivity([speaking('me', true)]);
    expect(voice.getSnapshot().turn.floor).toBe('contested');
  });

  it('does not notify subscribers for an unchanged activity report', async () => {
    const { voice, fake, changes } = setup();
    await voice.start();
    fake.hooks().onConnected();
    const report: VoiceActivity[] = [speaking('agent:1', false)];
    fake.hooks().onActivity(report);
    const after = changes.n;
    fake.hooks().onActivity([speaking('agent:1', false)]);
    fake.hooks().onActivity([speaking('agent:1', false)]);
    expect(changes.n).toBe(after);
    fake.hooks().onActivity([]);
    expect(changes.n).toBeGreaterThan(after);
  });
});

/* ──────────────────────────────── hanging up ─────────────────────────────── */

describe('leaving', () => {
  it('disconnects the transport and tells the server it was a hang-up', async () => {
    const { voice, fake, rec } = setup();
    await voice.start();
    fake.hooks().onConnected();
    await voice.leave();

    expect(fake.disconnects).toBe(1);
    expect(voice.getSnapshot().connection).toBe('ended');
    expect(voice.getSnapshot().listening).toBe(false);
    expect(rec.to(END_PATH)[0]?.body).toMatchObject({
      conversationId: 'conv-9',
      reason: 'hangup',
    });
  });

  it('before start() it tells the server nothing', async () => {
    const { voice, rec } = setup();
    await voice.leave();
    expect(rec.to(END_PATH)).toHaveLength(0);
    expect(voice.getSnapshot().connection).toBe('ended');
  });

  it('a failed end-call is recorded, not thrown at a visitor whose call is over', async () => {
    const { voice, fake } = setup({
      responder: (r) => (r.path === END_PATH ? { status: 500, body: {} } : undefined),
    });
    await voice.start();
    fake.hooks().onConnected();
    await expect(voice.leave()).resolves.toBeUndefined();
    expect(voice.getSnapshot().connection).toBe('ended');
    expect((voice.getSnapshot().error as ChatlyError).code).toBe('request_failed');
  });

  it('cancels a pending reconnect', async () => {
    vi.useFakeTimers();
    try {
      const { voice, fake, rec } = setup();
      await voice.start();
      fake.hooks().onDisconnected();
      expect(voice.getSnapshot().connection).toBe('reconnecting');
      await voice.leave();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fake.inputs).toHaveLength(1);
      expect(rec.to(TOKEN_PATH)).toHaveLength(1);
      expect(voice.getSnapshot().connection).toBe('ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts again after a hang-up', async () => {
    const { voice, fake, rec } = setup();
    await voice.start();
    await voice.leave();
    await voice.start();
    expect(rec.to(TOKEN_PATH)).toHaveLength(2);
    expect(fake.inputs[1]?.grant.token).toBe('lk-token-2');
    expect(voice.getSnapshot().timings.attempts).toBe(1);
  });
});
