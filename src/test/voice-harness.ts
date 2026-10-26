/**
 * The voice spec's fixtures: a RECORDING fake transport, a grant responder,
 * and the one-line `setup()` that wires a `VoiceSession` to both.
 *
 * ── Why this is a real seam ─────────────────────────────────────────────
 *
 * This is the fixture half of `voice.spec.ts` — the half with its own mutable
 * state (`inputs`, `sent`, `mic`, `disconnects`, the per-call token counter)
 * and not one `expect`. The assertions read that state; the state never reads
 * an assertion, so the dependency runs one way. `src/test/harness.ts` is the
 * established home for exactly this (the recording `fetch` the responder here
 * is handed to), and a fixture in `src/test/` is excluded from
 * `tsconfig.build.json`, so none of it reaches `dist`.
 *
 * ── Two things about this file's NAME, both load-bearing ────────────────
 *
 * It is `-harness.ts`, not `voice-fixtures-for-tests.ts` or anything else:
 * `scripts/check-api-route-callers.mjs` decides what counts as a CALLER of a
 * route by filename, and `-(harness|fixtures?|double|mock|stub)` is one of
 * the patterns it excludes. `TOKEN_PATH` and `END_PATH` below name
 * `/v1/widget/video-calls/token` and `/v1/widget/video-calls/end`; in a file
 * that gate counted as product code, they would vouch for both routes having
 * a caller even if every real one were deleted. That is not hypothetical —
 * `listen-relay-harness.ts`, split out of a spec over the same 650-line
 * ceiling, made that gate report a caller for the relay long-poll within
 * minutes of existing.
 *
 * And it is under `src/test/` rather than beside `voice.ts`: `no-dom.spec.ts`
 * enumerates `src/*.ts` and asserts every module there imports only relative
 * paths and loads with no DOM global present. A fixture belongs outside that
 * set, which is where `harness.ts` already sits.
 */
import { API, recordingFetch, type Recorded, type Responder } from './harness.js';
import { VisitorSession } from '../session.js';
import { VoiceSession } from '../voice.js';

import type {
  VoiceTransportConnectInput,
  VoiceTransportFactory,
  VoiceTransportHandle,
} from '../voice-types.js';

export const TOKEN_PATH = '/v1/widget/video-calls/token';
export const END_PATH = '/v1/widget/video-calls/end';

/** The exact strings `voice-signals.ts` is pinned to. Restated, not imported. */
export const GOLDEN = {
  muteOn: '{"v":1,"kind":"voice.mute","muted":true}',
  muteOff: '{"v":1,"kind":"voice.mute","muted":false}',
  floorTaken: '{"v":1,"kind":"voice.floor","state":"taken","label":null}',
  floorPreparing: '{"v":1,"kind":"voice.floor","state":"preparing","label":"thinking…"}',
  floorYielded: '{"v":1,"kind":"voice.floor","state":"yielded","label":null}',
} as const;

export interface Fake {
  readonly factory: VoiceTransportFactory;
  readonly inputs: VoiceTransportConnectInput[];
  readonly sent: string[];
  readonly mic: boolean[];
  disconnects: number;
  /** The hooks of the most recent attempt. */
  hooks(): VoiceTransportConnectInput['hooks'];
}

export function fakeTransport(opts: { throwOnAttempt?: number } = {}): Fake {
  const fake: Fake = {
    inputs: [],
    sent: [],
    mic: [],
    disconnects: 0,
    hooks: () => {
      const last = fake.inputs[fake.inputs.length - 1];
      if (last === undefined) {
        throw new Error('spec bug: no attempt yet');
      }
      return last.hooks;
    },
    factory: (input) => {
      fake.inputs.push(input);
      if (opts.throwOnAttempt === fake.inputs.length) {
        throw new Error('no audio device');
      }
      const handle: VoiceTransportHandle = {
        setMicrophoneEnabled: (enabled) => {
          fake.mic.push(enabled);
        },
        send: (payload) => {
          fake.sent.push(payload);
        },
        disconnect: () => {
          fake.disconnects += 1;
        },
      };
      return handle;
    },
  };
  return fake;
}

/** `token` increments per call, so a replayed credential is visible. */
export function grantResponder(extra?: Responder): Responder {
  let n = 0;
  return (r: Recorded) => {
    const own = extra?.(r);
    if (own !== undefined) {
      return own;
    }
    if (r.path === TOKEN_PATH) {
      n += 1;
      return { body: { url: 'wss://lk.test', room: 'ws_conv-9', token: `lk-token-${String(n)}` } };
    }
    if (r.path === END_PATH) {
      return { body: { ended: true } };
    }
    return undefined;
  };
}

export function setup(
  opts: {
    responder?: Responder;
    startMuted?: boolean;
    maxAttempts?: number;
    claimTtlMs?: number;
    throwOnAttempt?: number;
  } = {},
): {
  voice: VoiceSession;
  fake: Fake;
  rec: ReturnType<typeof recordingFetch>;
  clock: { t: number };
  changes: { n: number };
} {
  const rec = recordingFetch(grantResponder(opts.responder));
  const session = new VisitorSession({ publicId: 'pub-1', apiUrl: API, fetch: rec.fetch });
  const fake = fakeTransport(
    opts.throwOnAttempt === undefined ? {} : { throwOnAttempt: opts.throwOnAttempt },
  );
  const clock = { t: 1_000 };
  const voice = new VoiceSession({
    session,
    conversationId: 'conv-9',
    transport: fake.factory,
    now: () => clock.t,
    ...(opts.startMuted === undefined ? {} : { startMuted: opts.startMuted }),
    ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
    ...(opts.claimTtlMs === undefined ? {} : { claimTtlMs: opts.claimTtlMs }),
  });
  const changes = { n: 0 };
  voice.subscribe(() => {
    changes.n += 1;
  });
  return { voice, fake, rec, clock, changes };
}
