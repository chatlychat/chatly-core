/**
 * The turn-taking vocabulary, on the voice transport's own data channel.
 *
 * ── Why a data channel and not the Chatly realtime socket ────────────────
 *
 * A turn signal is about the next half-second of audio. It belongs on the
 * same pipe as the audio, with the same participants and the same lifetime:
 * a room that has gone away cannot still be taking the floor. Putting it on
 * the conversation's socket would mean a second path that outlives the call,
 * a second ordering to reason about, and a gateway change — and the gateway
 * is owned elsewhere.
 *
 * The grant the API already asks for carries `canPublishData: true`, so this
 * needs nothing new server-side.
 *
 * ── The wire form, and what owns which half ──────────────────────────────
 *
 * A signal is **JSON in a string**. This package compiles with `lib: ES2022`
 * and `types: []` — there is no `Buffer`, no `TextEncoder`, no `btoa` — so
 * bytes are the transport's half of the job, and the string is this file's.
 * That also lines up with what the server side already speaks: the worker's
 * `sendData` helper base64-encodes `JSON.stringify(payload)` into LiveKit's
 * Twirp `RoomService/SendData`, and `apps/voice/src/agent-control.ts` decodes
 * base64 → UTF-8 → JSON on the way in. Same JSON, each end encoding bytes the
 * way its own runtime can.
 *
 * ── Strict, and why that is worth a refusal ──────────────────────────────
 *
 * An unknown key is REFUSED, not dropped. zod's default is strip and this is
 * not zod, but the trap is the same one: a host author who writes `{ kind:
 * 'voice.floor', stat: 'taken' }` would otherwise publish a signal that
 * validates, carries no state, and silently does nothing. `readVoiceSignal`
 * says which key it could not place, and `VoiceSession` keeps the last
 * refusal in its snapshot so it is visible without a debugger.
 *
 * Forward compatibility is `v`, not laxity: a signal whose `v` is not this
 * file's version is refused with `'version'`. Adding a field means bumping
 * `v`, which is a decision somebody makes rather than a key that slips
 * through.
 */

/** Bumped when a field is added or a meaning changes. Never silently widened. */
export const VOICE_SIGNAL_VERSION = 1;

/**
 * Who intends to speak.
 *
 *  - `preparing` — about to. A push-to-talk key is down, a bot is composing,
 *    a mic is warming. It does NOT take the floor (see `voice-turn.ts`): an
 *    avatar can lean in, and a speaker who actually speaks still wins.
 *  - `taken` — holding it.
 *  - `yielded` — done. Equivalent to having said nothing: the fold stores a
 *    `yielded` claim as the absence of a claim.
 */
export type VoiceFloorState = 'preparing' | 'taken' | 'yielded';

export interface VoiceFloorSignal {
  readonly v: number;
  readonly kind: 'voice.floor';
  readonly state: VoiceFloorState;
  /** A short thing an avatar may show ("thinking…"). `null` when the sender gave none. */
  readonly label: string | null;
}

/**
 * The sender's microphone intent.
 *
 * Not derivable from activity: a muted participant and a silent one produce
 * the same silence, and an embodied agent that cannot tell them apart either
 * waits for a reply that is never coming or talks over one that is.
 */
export interface VoiceMuteSignal {
  readonly v: number;
  readonly kind: 'voice.mute';
  readonly muted: boolean;
}

export type VoiceSignal = VoiceFloorSignal | VoiceMuteSignal;

/**
 * What a caller passes to `encodeVoiceSignal`: the same thing without `v`.
 *
 * The version is stamped by the encoder rather than accepted from the
 * caller, so a host cannot publish a version this client does not implement
 * and then wonder why the peer refused it.
 */
export type VoiceSignalInput =
  | {
      readonly kind: 'voice.floor';
      readonly state: VoiceFloorState;
      readonly label?: string | null;
    }
  | { readonly kind: 'voice.mute'; readonly muted: boolean };

/** Why a payload was not accepted. Reported, never guessed at. */
export type VoiceSignalRefusal =
  | 'not-json'
  | 'not-an-object'
  | 'version'
  | 'unknown-kind'
  | 'bad-field'
  | 'unknown-key';

/**
 * `detail` is declared `undefined` on the success branch rather than left off
 * it, so `read.detail` narrows instead of failing to compile at a call site
 * that only wants to log whatever came back.
 */
export type VoiceSignalRead =
  | { readonly signal: VoiceSignal; readonly refused?: undefined; readonly detail?: undefined }
  | { readonly signal?: undefined; readonly refused: VoiceSignalRefusal; readonly detail: string };

const FLOOR_STATES: readonly string[] = ['preparing', 'taken', 'yielded'];
const FLOOR_KEYS: readonly string[] = ['v', 'kind', 'state', 'label'];
const MUTE_KEYS: readonly string[] = ['v', 'kind', 'muted'];

const MAX_LABEL = 120;

function refuse(refused: VoiceSignalRefusal, detail: string): VoiceSignalRead {
  return { refused, detail };
}

/** The first key on the object that the member does not declare, or null. */
function strayKey(obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      return key;
    }
  }
  return null;
}

/**
 * Turn whatever the transport handed us into a signal, or say why not.
 *
 * Accepts a JSON string (the usual case — a `TextDecoder` run over the
 * data-channel bytes) or an object a transport parsed itself. Never throws:
 * a malformed payload from a peer is ordinary, and a call that can throw on
 * untrusted input ends up wrapped in a `catch` that hides the reason.
 */
export function readVoiceSignal(raw: unknown): VoiceSignalRead {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return refuse('not-json', `${raw.slice(0, 40)} is not JSON`);
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('not-an-object', `a signal must be an object, got ${typeof value}`);
  }
  const obj = value as Record<string, unknown>;
  if (obj['v'] !== VOICE_SIGNAL_VERSION) {
    return refuse(
      'version',
      `signal v=${String(obj['v'])}, this client speaks v=${String(VOICE_SIGNAL_VERSION)}`,
    );
  }
  switch (obj['kind']) {
    case 'voice.floor': {
      const stray = strayKey(obj, FLOOR_KEYS);
      if (stray !== null) {
        return refuse('unknown-key', `voice.floor has no \`${stray}\``);
      }
      const state = obj['state'];
      if (typeof state !== 'string' || !FLOOR_STATES.includes(state)) {
        return refuse('bad-field', `voice.floor.state must be one of ${FLOOR_STATES.join(' | ')}`);
      }
      const label = obj['label'];
      if (label !== undefined && label !== null && typeof label !== 'string') {
        return refuse('bad-field', 'voice.floor.label must be a string or null');
      }
      return {
        signal: {
          v: VOICE_SIGNAL_VERSION,
          kind: 'voice.floor',
          state: state as VoiceFloorState,
          label: typeof label === 'string' ? label.slice(0, MAX_LABEL) : null,
        },
      };
    }
    case 'voice.mute': {
      const stray = strayKey(obj, MUTE_KEYS);
      if (stray !== null) {
        return refuse('unknown-key', `voice.mute has no \`${stray}\``);
      }
      if (typeof obj['muted'] !== 'boolean') {
        return refuse('bad-field', 'voice.mute.muted must be a boolean');
      }
      return { signal: { v: VOICE_SIGNAL_VERSION, kind: 'voice.mute', muted: obj['muted'] } };
    }
    default:
      return refuse('unknown-kind', `no such signal kind: ${String(obj['kind'])}`);
  }
}

/** `readVoiceSignal` without the reason. Kept thin: the reason is usually the point. */
export function decodeVoiceSignal(raw: unknown): VoiceSignal | null {
  return readVoiceSignal(raw).signal ?? null;
}

/**
 * The string a transport publishes. Stamped with this file's version so the
 * receiver's refusal names a version mismatch rather than a bad field.
 */
export function encodeVoiceSignal(signal: VoiceSignalInput): string {
  if (signal.kind === 'voice.mute') {
    return JSON.stringify({ v: VOICE_SIGNAL_VERSION, kind: 'voice.mute', muted: signal.muted });
  }
  const label = signal.label;
  return JSON.stringify({
    v: VOICE_SIGNAL_VERSION,
    kind: 'voice.floor',
    state: signal.state,
    label: typeof label === 'string' ? label.slice(0, MAX_LABEL) : null,
  });
}
