/**
 * The two HTTP calls a voice session makes — the server contract, split from
 * the state machine that drives it.
 *
 * ── Why this is a real seam ─────────────────────────────────────────────
 *
 * `voice.ts` is a state machine: epochs, backoff, claim timers, a snapshot
 * and a subscriber set. These two functions are the ENTIRE part of it that
 * speaks to the API, and they are the only part that holds no state at all.
 * They take a `VisitorSession` and a conversation id, they return or throw,
 * and they never read or write a field of `VoiceSession` — so the dependency
 * runs one way only, from the machine to the contract. Nothing here needs to
 * know whether the session is connecting, reconnecting or giving up, and
 * nothing in the machine needs to know what shape the route answers in.
 *
 * That is also why the route documentation moved here rather than staying
 * behind: it describes `POST /v1/widget/video-calls/token` — which flags
 * admit it, what the server signs into the grant, and which consequences are
 * deliberate — and none of it describes the state machine. The section below
 * is `voice.ts`'s own, carried over word for word.
 *
 * ── The token exchange, and why there is no new route ───────────────────
 *
 * `start()` posts to `POST /v1/widget/video-calls/token`, which already does
 * every part of this correctly and is the route the DOM widget's camera
 * button uses: it refuses unless the channel has the feature on, proves the
 * caller is a party to the conversation, forwards to the voice service so
 * `LIVEKIT_API_SECRET` stays in one process, derives the room name from
 * (workspace, conversation) so a visitor cannot name someone else's, and
 * rings the agents. A spatial session wants all of that and nothing else, so
 * it adds no route — which also means no eleventh SDK surface to catch up and
 * no idempotency posture to classify.
 *
 * Two consequences, both real and neither hidden:
 *
 *  1. **It rides the channel's call flags, and since 2026-10-23 there are
 *     two.** `voiceCalls` means "a microphone is allowed", `videoCalls` means
 *     "a camera is allowed", so an operator CAN now allow audio and refuse
 *     video — which is what a spatial session wanted all along. The route
 *     admits on either flag and forwards the resolved media to the voice
 *     service, which signs it into the grant: on a `voiceCalls`-only channel
 *     `canPublishSources` is `['microphone']`, so a camera is refused by the
 *     SFU rather than merely not sent. Both halves are enforced server-side,
 *     which is what makes them a gate rather than a hidden button.
 *
 *     On a `videoCalls` channel the grant still permits a camera this session
 *     will never publish, and that is CORRECT rather than a leftover: a
 *     narrowing the CLIENT asked for would not be a control, because the same
 *     client is free not to ask and the server cannot tell an audio-only
 *     visitor from one that lied. The channel's policy is the authority;
 *     `audioOnly` in `voice-types.ts` is the intent the transport honours.
 *  2. **The agent answers in the video-call surface**, in the same LiveKit
 *     room. An audio-only visitor simply publishes no camera track — and the
 *     agent's own grant is NOT narrowed to match, so on a `voiceCalls`-only
 *     channel the answering agent may publish a camera the visitor may not.
 *     Open, with the reason it is not a one-line fix, in
 *     `docs/outstanding-work.md`.
 */
import { ChatlyError } from './errors.js';

import type { VisitorSession } from './session.js';
import type { VoiceGrant } from './voice-types.js';

/**
 * Mint a join credential for one attempt.
 *
 * Throws rather than returning a partial grant: a transport handed a grant
 * with a missing field connects to nothing, and the failure would surface as
 * a transport error with no hint of where it came from.
 */
export async function requestVoiceGrant(
  session: VisitorSession,
  conversationId: string,
): Promise<VoiceGrant> {
  const path = '/v1/widget/video-calls/token';
  await session.ensure();
  const res = await session.post(path, {
    ...session.identity(),
    conversationId,
  });
  const raw: unknown = await res.json();
  if (typeof raw !== 'object' || raw === null) {
    throw new ChatlyError('invalid_response', `chatly: ${path} answered a non-object`);
  }
  const body = raw as Record<string, unknown>;
  const url = body['url'];
  const token = body['token'];
  const room = body['room'];
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    typeof token !== 'string' ||
    token.length === 0 ||
    typeof room !== 'string' ||
    room.length === 0
  ) {
    throw new ChatlyError(
      'invalid_response',
      `chatly: ${path} answered no usable grant (url/token/room)`,
    );
  }
  return {
    url,
    token,
    room,
    expiresAt: typeof body['expiresAt'] === 'string' ? body['expiresAt'] : null,
  };
}

/**
 * Tell the server the call is over.
 *
 * `reason` is the whole of the difference that route's enum offers, and it
 * throws on failure: whether a visitor whose call has already ended should
 * see that error is the session's decision, not this function's.
 */
export async function postVoiceCallEnded(
  session: VisitorSession,
  conversationId: string,
  reason: 'hangup' | 'error',
): Promise<void> {
  await session.ensure();
  await session.post('/v1/widget/video-calls/end', {
    ...session.identity(),
    conversationId,
    reason,
  });
}
