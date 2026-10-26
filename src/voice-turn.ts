/**
 * Turn-taking, as a pure function.
 *
 * An embodied agent needs one question answered every frame: whose turn is
 * it? A world reflects that in an avatar — a head that turns, a mouth that
 * moves, a listening pose — and it cannot do that from a list of socket
 * events. So the session folds two different kinds of evidence into one
 * value, and the fold lives here, with no clock, no state and no I/O, so it
 * can be tested exhaustively and read in one sitting.
 *
 * ── Measured beats declared, deliberately ───────────────────────────────
 *
 * There are two sources and they disagree all the time:
 *
 *  - **Activity** — who is audibly speaking, from the transport (LiveKit's
 *    active-speaker detection, or whatever the host's audio layer measures).
 *  - **Claims** — `voice.floor` signals a participant published about
 *    itself (`voice-signals.ts`).
 *
 * Audible speech is evidence; a claim is an assertion a peer makes about its
 * own intent. So a claim can only ADD to the floor, never subtract: a peer
 * that said `yielded` and then kept talking still holds the floor, because
 * the visitor can hear it. The inverse — trusting `yielded` over the
 * microphone — would have an avatar close its mouth mid-sentence, and would
 * make a sloppy or hostile peer able to tell your world that nothing is being
 * said while something is.
 *
 * `preparing` is the one state with no audio behind it, which is exactly why
 * it does not take the floor: it is a hint for a lean-in, not a turn.
 */
import type { VoiceFloorState } from './voice-signals.js';
import type { VoiceActivity } from './voice-types.js';

/**
 * Whose turn it is.
 *
 *  - `open` — nobody is speaking or claiming.
 *  - `local` — this client holds it.
 *  - `remote` — a peer holds it.
 *  - `contested` — both, which is a real and frequent state in voice and the
 *    one a world most wants to draw differently (a duck, a wince, a "go
 *    ahead"). Collapsing it into either side would hide the only case where
 *    an interface can usefully intervene.
 */
export type VoiceFloor = 'open' | 'local' | 'remote' | 'contested';

export interface VoiceSpeaker {
  readonly identity: string;
  /** 0..1 where the transport measures it; `null` where it reports only on/off. */
  readonly level: number | null;
}

export interface VoiceTurnInput {
  /** The whole current speaker set, as the transport last reported it. */
  readonly activity: readonly VoiceActivity[];
  /** What this client last declared about itself, or `null`. */
  readonly localClaim: VoiceFloorState | null;
  /** The live claim per peer identity. A `yielded` claim is stored as an absence. */
  readonly remoteClaims: ReadonlyMap<string, VoiceFloorState>;
}

export interface VoiceTurnState {
  readonly floor: VoiceFloor;
  readonly localSpeaking: boolean;
  readonly localLevel: number | null;
  /** Audibly speaking peers. Ordered as the transport reported them. */
  readonly remoteSpeaking: readonly VoiceSpeaker[];
  /**
   * Who is about to speak but is not yet: `'local'` plus any peer identity.
   * A world draws a lean-in from this and nothing else.
   */
  readonly preparing: readonly string[];
}

/** Does a claim take the floor? Only `taken` does; see the file docblock. */
function holds(claim: VoiceFloorState | null | undefined): boolean {
  return claim === 'taken';
}

export function foldVoiceTurn(input: VoiceTurnInput): VoiceTurnState {
  let localSpeaking = false;
  let localLevel: number | null = null;
  const remoteSpeaking: VoiceSpeaker[] = [];
  for (const a of input.activity) {
    if (!a.speaking) {
      continue;
    }
    if (a.local) {
      localSpeaking = true;
      localLevel = a.level;
    } else {
      remoteSpeaking.push({ identity: a.identity, level: a.level });
    }
  }

  let remoteClaimed = false;
  const preparing: string[] = [];
  if (input.localClaim === 'preparing' && !localSpeaking) {
    preparing.push('local');
  }
  for (const [identity, claim] of input.remoteClaims) {
    if (holds(claim)) {
      remoteClaimed = true;
    }
    if (claim === 'preparing' && !remoteSpeaking.some((s) => s.identity === identity)) {
      preparing.push(identity);
    }
  }

  const local = localSpeaking || holds(input.localClaim);
  const remote = remoteSpeaking.length > 0 || remoteClaimed;
  const floor: VoiceFloor =
    local && remote ? 'contested' : local ? 'local' : remote ? 'remote' : 'open';

  return { floor, localSpeaking, localLevel, remoteSpeaking, preparing };
}

/** The value a session that has never connected reports. */
export const IDLE_TURN: VoiceTurnState = {
  floor: 'open',
  localSpeaking: false,
  localLevel: null,
  remoteSpeaking: [],
  preparing: [],
};

/**
 * Two activity reports a renderer cannot tell apart.
 *
 * A transport reports the whole speaker set on a timer — LiveKit's is every
 * few hundred milliseconds — and almost all of those reports say the same
 * thing. `VoiceSession` replaces its snapshot on every change, so forwarding
 * an unchanged report would re-render every subscriber several times a second
 * for nothing.
 */
export function sameActivity(a: readonly VoiceActivity[], b: readonly VoiceActivity[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x === undefined ||
      y === undefined ||
      x.identity !== y.identity ||
      x.local !== y.local ||
      x.speaking !== y.speaking ||
      x.level !== y.level
    ) {
      return false;
    }
  }
  return true;
}
