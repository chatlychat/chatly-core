/**
 * The voice seam, and the shape of a voice session's state.
 *
 * A world, a game or a headset can already host a Chatly conversation
 * (`types.ts` declares the four things it must supply: a `fetch`, storage, a
 * socket factory, a source of ids). Voice adds a FIFTH, and it is declared
 * here as a structural type for exactly the reasons the other four are:
 *
 * ── Why the voice transport is INJECTED and not imported ─────────────────
 *
 * `livekit-client` is 93,734 gzipped in `widget-video.js` — larger than the
 * whole rest of the visitor widget put together, and only 2,835 of that file
 * is Chatly's own code. A core that imported it would make every consumer
 * carry a WebRTC stack: the headless core is the thing a 3D world embeds
 * INSTEAD of the DOM widget, and a Unity, Unreal or headset host already has
 * its own audio pipeline and its own LiveKit binding for its own platform.
 * It would also break the package's zero-dependency claim, which CLAUDE.md §2
 * does not let anyone do without approval.
 *
 * So this package owns the voice PROTOCOL — the grant, the state machine, the
 * turn-taking fold, the signal vocabulary — and owns no transport. A host
 * passes a factory. The same argument `realtime.ts` makes for
 * `socket.io-client`, with a much larger number attached.
 *
 * ── One attempt per factory call, and why that is not an accident ────────
 *
 * `VoiceTransportFactory` is called ONCE PER CONNECTION ATTEMPT and is handed
 * ONE `VoiceGrant`. A transport must NOT reconnect on its own: a LiveKit
 * token is signed with a fixed TTL (the voice service's default is 1h), so a
 * transport that reconnects by itself replays a credential it cannot refresh
 * and dies silently once that hour is out. That is the same defect that left
 * all four mobile SDKs unable to hold a realtime socket — a frozen `auth`
 * object replayed on every reconnect — and the fix here is the same one:
 * `VoiceSession` owns the retry, re-requests a grant per attempt, and calls
 * the factory again. `livekit-client`'s equivalent is `Room.connect(url,
 * token)` with `reconnect` left to the session, not `autoSubscribe`-style
 * self-healing.
 */
import type { VisitorSession } from './session.js';
import type { VoiceSignalRefusal } from './voice-signals.js';
import type { VoiceTurnState } from './voice-turn.js';

/**
 * A join credential for one voice session: where the SFU is, which room, and
 * the signed token that gets in.
 *
 * `expiresAt` is `string | null` and **today it is always null**, which is a
 * fact about the server rather than a nicety. `POST /v1/voice/tokens` mints
 * `expiresAt` and `sessionId`; the visitor-facing route in front of it
 * declares a return of `{ url, token, room }` and so narrows both away before
 * the client ever sees them. A client that cannot read an expiry has exactly
 * one correct strategy, which is the one above: never hold a grant across an
 * attempt.
 */
export interface VoiceGrant {
  /** The SFU's URL, as the server gave it. `wss://` in every deployment so far. */
  readonly url: string;
  /** The room name. Derived server-side from (workspace, conversation): a visitor cannot name someone else's. */
  readonly room: string;
  readonly token: string;
  /** ISO 8601 when the server sends one. See the note above: it does not. */
  readonly expiresAt: string | null;
}

/**
 * Who is making sound right now.
 *
 * `local` is reported by the TRANSPORT rather than computed here. The core
 * knows a contact id, not a participant identity — the identity string is
 * assembled server-side (`visitor:<contactId>`), and a client that rebuilt
 * that string would be duplicating a wire format it cannot see, which is how
 * a field name drifts and a complete-looking implementation does nothing.
 * The transport is holding the room; it knows which participant is itself.
 */
export interface VoiceActivity {
  readonly identity: string;
  readonly local: boolean;
  readonly speaking: boolean;
  /** 0..1 when the transport measures loudness. `null` when it only reports on/off. */
  readonly level: number | null;
}

/**
 * What the transport calls back into. Every one of these is optional for the
 * transport to ever call, and the session's state stays coherent if it does
 * not — a transport that never reports a microphone leaves `microphone:
 * 'unknown'`, which still counts as listening; a transport that never
 * reports activity leaves the floor `'open'`.
 */
export interface VoiceTransportHooks {
  /** Media is flowing. The session moves to `live`. */
  onConnected(): void;
  /**
   * This attempt is over. The session decides whether to re-grant and retry;
   * a transport must not retry by itself (see the file docblock).
   */
  onDisconnected(reason?: unknown): void;
  /** This attempt could not be established. Same retry rules. */
  onFailed(error: unknown): void;
  /** The current speakers, as a whole set each time — not a delta. */
  onActivity(active: readonly VoiceActivity[]): void;
  /**
   * A data-channel payload from a peer, as a UTF-8 string or an
   * already-parsed object. **The transport owns bytes**: it is the half that
   * holds a `TextDecoder`, and this package compiles with no DOM and no Node
   * types, so neither `Buffer` nor `atob` exists here. `voice-signals.ts`
   * accepts either form.
   */
  onData(raw: unknown, from?: string | null): void;
  /** The transport's own view of the microphone. A browser can revoke it mid-call. */
  onMicrophone(enabled: boolean): void;
}

/** One connection attempt's worth of instructions. */
export interface VoiceTransportConnectInput {
  readonly grant: VoiceGrant;
  readonly conversationId: string;
  /**
   * Always `true`. A voice session publishes a microphone and nothing else.
   *
   * It is a literal rather than a boolean because it is **not negotiable
   * here** — and that stays true now that the grant itself can be narrowed.
   * Both of the pieces this docblock used to report missing shipped on
   * 2026-10-23: `callVideoGrant` in `apps/voice/src/call-grant.ts` sets
   * `canPublishSources` from a `media` field on `POST /v1/voice/tokens`, and
   * the visitor-facing route passes it. But it passes what the CHANNEL's
   * flags resolve to, never what a client asked for, so:
   *
   *   - on a `voiceCalls`-only channel the token permits `['microphone']`
   *     and a camera track is refused by the SFU;
   *   - on a `videoCalls` channel the token permits a camera, and this field
   *     is the only thing that stops one being published.
   *
   * That split is the design rather than an unfinished edge. A narrowing the
   * CLIENT requested would not be a control — the same client is free not to
   * request it, so the server cannot tell an audio-only session from one
   * that lied — which is why the grant answers to the operator's policy and
   * this field answers for the session's intent. Honouring audio-only on a
   * video-capable channel is therefore still the transport's job, and is
   * stated here rather than implied.
   */
  readonly audioOnly: true;
  /** Honour this on connect, so a session that starts muted never leaks a syllable. */
  readonly microphoneEnabled: boolean;
  readonly hooks: VoiceTransportHooks;
}

/** What the session drives. Each method may be sync or async; the session awaits nothing. */
export interface VoiceTransportHandle {
  setMicrophoneEnabled(enabled: boolean): void | Promise<void>;
  /** Publish a data-channel payload to the room. The string is JSON; see `onData`. */
  send(payload: string): void | Promise<void>;
  disconnect(): void | Promise<void>;
}

/**
 * `livekit-client`'s `Room`, a Unity binding, a headset runtime's audio
 * session, or a stub in a test — anything that can answer this one call.
 */
export type VoiceTransportFactory = (
  input: VoiceTransportConnectInput,
) => VoiceTransportHandle | Promise<VoiceTransportHandle>;

/* ─────────────────── what a voice session reports ──────────────────── */

export type VoiceConnectionState =
  | 'idle'
  | 'requesting'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'ended'
  | 'failed';

/**
 * The microphone as the TRANSPORT sees it, which is not the same question as
 * `muted`. `muted` is what the visitor asked for; this is what the device is
 * doing. A browser revoking permission mid-call leaves `muted: false` and
 * `microphone: 'off'`, and a world that draws only `muted` would show a live
 * mic to somebody nobody can hear.
 */
export type VoiceMicrophoneState = 'unknown' | 'live' | 'off';

export interface VoiceTimings {
  /** Epoch ms, from the injected clock. */
  readonly requestedAt: number | null;
  readonly grantedAt: number | null;
  readonly connectedAt: number | null;
  /** The token exchange, for the attempt in flight or the last one. */
  readonly grantMs: number | null;
  /** The transport's connect, grant in hand to media flowing. */
  readonly connectMs: number | null;
  /** Connection attempts since `start()`. */
  readonly attempts: number;
}

export interface VoiceSnapshot {
  readonly conversationId: string;
  readonly connection: VoiceConnectionState;
  /**
   * The room and SFU the grant named, for logging and for a world that
   * renders its own diagnostics. **The token is deliberately absent**: a
   * snapshot is the thing a host serialises into a debug overlay or a crash
   * report, and a join credential has no business in either.
   */
  readonly room: string | null;
  readonly url: string | null;
  /** What the visitor asked for. */
  readonly muted: boolean;
  readonly microphone: VoiceMicrophoneState;
  /** Live, unmuted, and the device is not known to be off. */
  readonly listening: boolean;
  readonly turn: VoiceTurnState;
  /** Peers that published `voice.mute { muted: true }` and have not taken it back. */
  readonly remoteMuted: readonly string[];
  readonly timings: VoiceTimings;
  /** The last non-fatal failure. Cleared by the next success. */
  readonly error: unknown;
  /**
   * The last data-channel payload that could not be read, and why. Surfaced
   * rather than swallowed: a host author debugging a signal that "does
   * nothing" has no other way to find a misspelled key.
   */
  readonly lastRefusal: { readonly refused: VoiceSignalRefusal; readonly detail: string } | null;
}

export interface VoiceSessionOptions {
  readonly session: VisitorSession;
  readonly conversationId: string;
  readonly transport: VoiceTransportFactory;
  /**
   * Start with the microphone off. Defaults to TRUE: a visitor who asked a
   * world for a voice session has not thereby asked for a hot mic, and
   * push-to-talk is the common shape in a spatial surface.
   */
  readonly startMuted?: boolean;
  /** Connection attempts before the session gives up. Default 5. */
  readonly maxAttempts?: number;
  /** Default `FLOOR_CLAIM_TTL_MS`. */
  readonly claimTtlMs?: number;
  /** Epoch ms. Defaults to `Date.now`; injected so `timings` is testable. */
  readonly now?: () => number;
}
