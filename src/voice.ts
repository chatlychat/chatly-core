/**
 * Voice in and out, for a surface that is not a web page.
 *
 * A `VoiceSession` is to a voice call what `Conversation` is to a thread: an
 * external store (`subscribe` / `getSnapshot`) a game loop or a React hook
 * can read every frame, plus the verbs a visitor has on it. It holds no
 * WebRTC, no DOM and no LiveKit — the transport is injected
 * (`voice-types.ts`) — so the whole state machine is testable in Node with
 * nothing installed.
 *
 * ── It is constructed, not reached for ──────────────────────────────────
 *
 * Deliberately NOT a method on `ChatlyCore`. A host that never imports
 * `voice.js` links none of this, which is the only way a voice feature costs
 * a text-only consumer nothing:
 *
 *     const voice = new VoiceSession({
 *       session: core.session,
 *       conversationId: conv.conversationId,
 *       transport: myLiveKitTransport,
 *     });
 *     voice.subscribe(() => drawAvatar(voice.getSnapshot()));
 *     await voice.start();
 *
 * ── The token exchange, and why there is no new route ───────────────────
 *
 * In `voice-grant.ts`, with the two HTTP calls it documents. `start()` adds
 * no route: it posts to `POST /v1/widget/video-calls/token`, the route the
 * DOM widget's camera button already uses, and the channel flags that admit
 * it — plus the two consequences that are deliberate rather than hidden —
 * are written up there.
 *
 * ── No latency number appears anywhere in this file ─────────────────────
 *
 * Voice latency on a spatial surface depends on the host's audio pipeline,
 * the SFU region, the visitor's network and the agent's — none of which this
 * package can see, and none of which a sentence in a docblock can promise.
 * What it gives instead is `timings`: the token exchange and the transport
 * connect, measured per attempt off the injected clock, for a world to log
 * and an operator to read. A measured figure is worth more than an asserted
 * one, and this is the half that can be measured here.
 *
 * ── The credential is never frozen ──────────────────────────────────────
 *
 * Every connection attempt re-requests a grant. A LiveKit token is signed
 * with a fixed TTL and the visitor-facing route does not even return its
 * expiry (`VoiceGrant.expiresAt` is always null today), so there is no
 * expiry to check and no way to be careful about it other than this. The
 * transport is told not to reconnect on its own for the same reason; this
 * session owns the retry. The shape of the bug being avoided is the one that
 * left four mobile SDKs unable to hold a socket for an hour: a credential
 * captured once and replayed on every reconnect, failing silently for the
 * rest of the session.
 */
import { ChatlyError } from './errors.js';
import { postVoiceCallEnded, requestVoiceGrant } from './voice-grant.js';
import {
  encodeVoiceSignal,
  readVoiceSignal,
  type VoiceFloorState,
  type VoiceSignalInput,
} from './voice-signals.js';
import { foldVoiceTurn, IDLE_TURN, sameActivity } from './voice-turn.js';

import type {
  VoiceActivity,
  VoiceGrant,
  VoiceSessionOptions,
  VoiceSnapshot,
  VoiceTransportHandle,
} from './voice-types.js';

/** How long a peer's floor claim is honoured without being restated. */
export const FLOOR_CLAIM_TTL_MS = 10_000;
/** Attempt backoff. The last value repeats. */
const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 10_000];
const DEFAULT_MAX_ATTEMPTS = 5;

type Listener = () => void;

export class VoiceSession {
  public readonly conversationId: string;
  private readonly o: VoiceSessionOptions;
  private readonly now: () => number;
  private readonly claimTtlMs: number;
  private readonly maxAttempts: number;
  private readonly listeners = new Set<Listener>();

  private state: VoiceSnapshot;
  /** The whole current speaker set, as the transport last reported it. */
  private activity: readonly VoiceActivity[] = [];
  private localClaim: VoiceFloorState | null = null;
  private localClaimTimer: unknown = null;
  private readonly remoteClaims = new Map<string, VoiceFloorState>();
  private readonly remoteClaimTimers = new Map<string, unknown>();
  private readonly mutedPeers = new Set<string>();

  private handle: VoiceTransportHandle | null = null;
  private retryTimer: unknown = null;
  /**
   * Bumped on every attempt and on teardown. A hook closure captures the
   * value it was created with and does nothing when it no longer matches —
   * the transport from a superseded attempt is free to keep calling back, and
   * an `onDisconnected` from the previous one must not schedule a retry over
   * the top of the current one.
   */
  private epoch = 0;
  private finished = false;

  public constructor(opts: VoiceSessionOptions) {
    this.o = opts;
    this.conversationId = opts.conversationId;
    this.now = opts.now ?? ((): number => Date.now());
    this.claimTtlMs = opts.claimTtlMs ?? FLOOR_CLAIM_TTL_MS;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.state = {
      conversationId: opts.conversationId,
      connection: 'idle',
      room: null,
      url: null,
      muted: opts.startMuted !== false,
      microphone: 'unknown',
      listening: false,
      turn: IDLE_TURN,
      remoteMuted: [],
      timings: {
        requestedAt: null,
        grantedAt: null,
        connectedAt: null,
        grantMs: null,
        connectMs: null,
        attempts: 0,
      },
      error: null,
      lastRefusal: null,
    };
  }

  /* ───────────────────────── external store ───────────────────────── */

  public getSnapshot = (): VoiceSnapshot => this.state;

  public subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<VoiceSnapshot>): void {
    const next = { ...this.state, ...patch };
    this.state = {
      ...next,
      turn: foldVoiceTurn({
        activity: this.activity,
        localClaim: this.localClaim,
        remoteClaims: this.remoteClaims,
      }),
      remoteMuted: [...this.mutedPeers],
      listening: next.connection === 'live' && !next.muted && next.microphone !== 'off',
    };
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // One consumer's bug must not stop the others hearing the change.
      }
    }
  }

  /* ───────────────────────────── lifecycle ────────────────────────── */

  /**
   * Request a session and connect. Resolves when the first attempt has either
   * handed the grant to the transport or failed; a reconnect after that
   * happens in the background and is visible in `connection`.
   *
   * Idempotent while a session is up. After `leave()` it starts a new one.
   */
  public async start(): Promise<void> {
    if (
      this.state.connection === 'requesting' ||
      this.state.connection === 'connecting' ||
      this.state.connection === 'live' ||
      this.state.connection === 'reconnecting'
    ) {
      return;
    }
    this.finished = false;
    this.set({
      error: null,
      timings: { ...this.state.timings, attempts: 0 },
    });
    await this.attempt();
  }

  private async attempt(): Promise<void> {
    const epoch = ++this.epoch;
    const requestedAt = this.now();
    this.set({
      connection: 'requesting',
      timings: {
        ...this.state.timings,
        requestedAt,
        grantedAt: null,
        connectedAt: null,
        grantMs: null,
        connectMs: null,
        attempts: this.state.timings.attempts + 1,
      },
    });

    let grant: VoiceGrant;
    try {
      grant = await requestVoiceGrant(this.o.session, this.conversationId);
    } catch (err: unknown) {
      /*
       * A refused grant is a decision, not a blip, so it is NOT retried: the
       * reachable causes are BOTH call flags off for the channel (`voiceCalls`
       * alone is enough to be admitted), a conversation that is not this
       * visitor's, and no voice service in the deployment —
       * none of which five attempts improve. The host sees `failed` with the
       * server's own message and can call `start()` again when something has
       * changed.
       */
      if (epoch === this.epoch) {
        this.failed(err, false);
      }
      return;
    }
    if (epoch !== this.epoch || this.finished) {
      return;
    }
    const grantedAt = this.now();
    this.set({
      connection: 'connecting',
      room: grant.room,
      url: grant.url,
      timings: {
        ...this.state.timings,
        grantedAt,
        grantMs: grantedAt - requestedAt,
      },
    });

    let handle: VoiceTransportHandle;
    const microphoneEnabledAtConnect = !this.state.muted;
    try {
      handle = await this.o.transport({
        grant,
        conversationId: this.conversationId,
        audioOnly: true,
        microphoneEnabled: microphoneEnabledAtConnect,
        hooks: {
          onConnected: () => this.onConnected(epoch),
          onDisconnected: (reason?: unknown) => this.onDisconnected(epoch, reason),
          onFailed: (error: unknown) => this.onDisconnected(epoch, error),
          onActivity: (active) => this.onActivity(epoch, active),
          onData: (raw, from) => this.onData(epoch, raw, from ?? null),
          onMicrophone: (enabled) => this.onMicrophone(epoch, enabled),
        },
      });
    } catch (cause) {
      if (epoch === this.epoch) {
        this.failed(
          new ChatlyError('no_socket', 'chatly: the voice transport factory threw', { cause }),
          true,
        );
      }
      return;
    }
    if (epoch !== this.epoch || this.finished) {
      // Superseded or torn down while the factory was in flight. The handle
      // is live and nothing else will ever hold it.
      void Promise.resolve(handle.disconnect()).catch(() => undefined);
      return;
    }
    this.handle = handle;

    /*
     * ── Reconcile what happened WHILE the factory was in flight ──────────
     *
     * A factory is async, and two things can land in that window. A
     * transport that was already in a room can call `onConnected()`
     * synchronously, before it has returned the handle — and the mute
     * announcement `onConnected` makes would have had nothing to publish on.
     * And a visitor can press push-to-talk, so `setMuted` runs with
     * `this.handle` still null and the transport keeps the microphone state
     * it was given at connect time.
     *
     * Both are silent: the session looks right, the snapshot looks right, and
     * the room has not been told. So the state is replayed once here rather
     * than assumed to have been delivered.
     */
    if (!this.state.muted !== microphoneEnabledAtConnect) {
      void Promise.resolve(handle.setMicrophoneEnabled(!this.state.muted)).catch((err: unknown) => {
        this.set({ error: err });
      });
    }
    if (this.state.connection === 'live') {
      this.publishSignal({ kind: 'voice.mute', muted: this.state.muted });
    }
  }

  private onConnected(epoch: number): void {
    if (epoch !== this.epoch || this.finished) {
      return;
    }
    const connectedAt = this.now();
    const grantedAt = this.state.timings.grantedAt;
    this.set({
      connection: 'live',
      error: null,
      timings: {
        ...this.state.timings,
        connectedAt,
        connectMs: grantedAt === null ? null : connectedAt - grantedAt,
      },
    });
    // Tell the room what this side's microphone is doing. A peer that joined
    // first has no other way to know, and silence is ambiguous.
    this.publishSignal({ kind: 'voice.mute', muted: this.state.muted });
  }

  private onDisconnected(epoch: number, reason?: unknown): void {
    if (epoch !== this.epoch || this.finished) {
      return;
    }
    this.handle = null;
    this.activity = [];
    if (reason !== undefined && reason !== null) {
      this.set({ error: reason });
    }
    if (this.state.timings.attempts >= this.maxAttempts) {
      this.failed(
        reason ??
          new ChatlyError(
            'no_socket',
            `chatly: voice gave up after ${String(this.maxAttempts)} attempts`,
          ),
        true,
      );
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.state.timings.attempts - 1, BACKOFF_MS.length - 1)] ?? 0;
    this.set({ connection: 'reconnecting' });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.finished) {
        void this.attempt();
      }
    }, delay);
  }

  /**
   * Give up.
   *
   * `notifyServer` is false when no grant was ever issued: a
   * `video-calls/end` for a call that never existed is noise at best, and a
   * 404 the host would have to explain at worst. When there WAS a room, the
   * server is told with `reason: 'error'` rather than `'hangup'` — the whole
   * of the difference that route's enum offers, and the only way a workspace
   * can tell a dropped call from a hung-up one.
   */
  private failed(err: unknown, notifyServer: boolean): void {
    this.teardown();
    this.set({ connection: 'failed', error: err, microphone: 'unknown' });
    if (notifyServer) {
      void this.tellServerEnded('error');
    }
  }

  /** Hang up. Safe to call at any time, including before `start()`. */
  public async leave(): Promise<void> {
    const wasUp = this.state.connection !== 'idle' && this.state.connection !== 'failed';
    this.teardown();
    this.set({ connection: 'ended', microphone: 'unknown' });
    if (wasUp) {
      await this.tellServerEnded('hangup');
    }
  }

  private teardown(): void {
    this.finished = true;
    this.epoch += 1;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.localClaimTimer !== null) {
      clearTimeout(this.localClaimTimer);
      this.localClaimTimer = null;
    }
    for (const timer of this.remoteClaimTimers.values()) {
      clearTimeout(timer);
    }
    this.remoteClaimTimers.clear();
    this.remoteClaims.clear();
    this.mutedPeers.clear();
    this.localClaim = null;
    this.activity = [];
    const handle = this.handle;
    this.handle = null;
    if (handle !== null) {
      void Promise.resolve(handle.disconnect()).catch(() => undefined);
    }
  }

  /**
   * `POST /v1/widget/video-calls/end`. Recorded, not awaited by the caller's
   * UI: the call is already over on this side, and a failure to tell the
   * server is not a reason to show the visitor an error about a hang-up that
   * worked.
   */
  private async tellServerEnded(reason: 'hangup' | 'error'): Promise<void> {
    try {
      await postVoiceCallEnded(this.o.session, this.conversationId, reason);
    } catch (err: unknown) {
      this.set({ error: err });
    }
  }

  /* ──────────────────────────── microphone ────────────────────────── */

  /**
   * Ask for the microphone on or off.
   *
   * The intent lands in the snapshot at once, because a push-to-talk key must
   * light up on the frame it was pressed, and the transport's own
   * `onMicrophone` corrects it afterwards if the device disagrees. The two are
   * separate fields for that reason.
   */
  public setMuted(muted: boolean): void {
    if (this.state.muted === muted) {
      return;
    }
    this.set({ muted });
    this.publishSignal({ kind: 'voice.mute', muted });
    const handle = this.handle;
    if (handle !== null) {
      void Promise.resolve(handle.setMicrophoneEnabled(!muted)).catch((err: unknown) => {
        this.set({ error: err });
      });
    }
  }

  public mute(): void {
    this.setMuted(true);
  }

  public unmute(): void {
    this.setMuted(false);
  }

  private onMicrophone(epoch: number, enabled: boolean): void {
    if (epoch !== this.epoch || this.finished) {
      return;
    }
    this.set({ microphone: enabled ? 'live' : 'off' });
  }

  /* ─────────────────────────── turn-taking ────────────────────────── */

  /**
   * Say what this side is about to do. `'preparing'` on a push-to-talk press,
   * `'taken'` while holding it, `'yielded'` on release.
   *
   * A claim is an announcement, not a lock: `voice-turn.ts` lets audible
   * speech override it in one direction only, so a peer cannot use this to
   * tell your world that nothing is being said.
   */
  public declareFloor(state: VoiceFloorState, label?: string | null): void {
    if (this.localClaimTimer !== null) {
      clearTimeout(this.localClaimTimer);
      this.localClaimTimer = null;
    }
    this.localClaim = state === 'yielded' ? null : state;
    if (this.localClaim !== null) {
      this.localClaimTimer = setTimeout(() => {
        this.localClaimTimer = null;
        this.localClaim = null;
        this.set({});
      }, this.claimTtlMs);
    }
    this.set({});
    this.publishSignal({ kind: 'voice.floor', state, label: label ?? null });
  }

  private onActivity(epoch: number, active: readonly VoiceActivity[]): void {
    if (epoch !== this.epoch || this.finished) {
      return;
    }
    /*
     * A transport reports the whole speaker set on a timer — LiveKit's is
     * every few hundred milliseconds — and almost all of those reports say
     * the same thing. A `set()` replaces the snapshot, so forwarding an
     * unchanged report would re-render every subscriber several times a
     * second for nothing.
     */
    if (sameActivity(this.activity, active)) {
      return;
    }
    this.activity = active;
    this.set({});
  }

  private onData(epoch: number, raw: unknown, from: string | null): void {
    if (epoch !== this.epoch || this.finished) {
      return;
    }
    const read = readVoiceSignal(raw);
    if (read.signal === undefined) {
      this.set({ lastRefusal: { refused: read.refused, detail: read.detail } });
      return;
    }
    // A signal with no sender cannot be attributed, and attributing it to a
    // guess would let one peer's claim move another's avatar. LiveKit always
    // names the sender; a transport that does not is told so here.
    if (from === null || from.length === 0) {
      this.set({
        lastRefusal: {
          refused: 'bad-field',
          detail: `a ${read.signal.kind} arrived with no sender identity and cannot be attributed`,
        },
      });
      return;
    }
    if (read.signal.kind === 'voice.mute') {
      if (read.signal.muted) {
        this.mutedPeers.add(from);
      } else {
        this.mutedPeers.delete(from);
      }
      this.set({ lastRefusal: null });
      return;
    }
    const existing = this.remoteClaimTimers.get(from);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.remoteClaimTimers.delete(from);
    }
    if (read.signal.state === 'yielded') {
      this.remoteClaims.delete(from);
    } else {
      this.remoteClaims.set(from, read.signal.state);
      this.remoteClaimTimers.set(
        from,
        setTimeout(() => {
          this.remoteClaimTimers.delete(from);
          this.remoteClaims.delete(from);
          this.set({});
        }, this.claimTtlMs),
      );
    }
    this.set({ lastRefusal: null });
  }

  /** Publish a signal, if there is a transport to publish it on. */
  private publishSignal(signal: VoiceSignalInput): void {
    const handle = this.handle;
    if (handle === null) {
      return;
    }
    try {
      void Promise.resolve(handle.send(encodeVoiceSignal(signal))).catch((err: unknown) => {
        this.set({ error: err });
      });
    } catch (err: unknown) {
      this.set({ error: err });
    }
  }
}
