/**
 * Embodiment cues — the gesture and gaze an agent's reply asks its body for.
 *
 * A bot sends `embodiment: { expression, lookAt }` beside a message; the
 * server validates it and stores it at `metadata.embodiment`, and it arrives
 * live on `message.created`. This reads it back off a `ConversationMessage`.
 *
 * FORGIVING, unlike the server: an unknown expression or a malformed target
 * is dropped, never thrown, because a newer server may send a cue this build
 * has no clip for, and a cue is ornament — the message's `body` is the
 * message. The authoritative refusal is at the write boundary.
 *
 * A cue is a MOMENT: play it when the message lands. `metadata` is not in the
 * visitor's message-list read, so a thread reloaded from history carries no
 * cues, which is the behaviour wanted — replaying every old gesture on reload
 * would be a body twitching through a transcript.
 *
 * Parity: the lists are zod in `packages/shared/src/spatial/embodiment.ts`;
 * `core-parity.spec.ts` there fails on drift.
 */
import type { ConversationMessage } from './types.js';
import type { AgentWorldPresence } from './world-presence.js';

export const AGENT_EXPRESSIONS = [
  'smile',
  'laugh',
  'nod',
  'shake_head',
  'point',
  'wave',
  'shrug',
  'think',
  'surprised',
  'concerned',
] as const;
export type AgentExpression = (typeof AGENT_EXPRESSIONS)[number];

export const LOOK_AT_TARGETS = ['visitor', 'item', 'place'] as const;

export type LookAt =
  | { readonly target: 'visitor' }
  | { readonly target: 'item' | 'place'; readonly ref: string };

export interface MessageEmbodiment {
  readonly expression: AgentExpression | null;
  readonly lookAt: LookAt | null;
}

/** The cue on a message, or null when it carries none this build can read. */
export function messageEmbodiment(message: ConversationMessage): MessageEmbodiment | null {
  const raw = message.metadata['embodiment'];
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const expression = (AGENT_EXPRESSIONS as readonly unknown[]).includes(r['expression'])
    ? (r['expression'] as AgentExpression)
    : null;
  const lookAt = readLookAt(r['lookAt']);
  return expression === null && lookAt === null ? null : { expression, lookAt };
}

function readLookAt(raw: unknown): LookAt | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const { target, ref } = raw as Record<string, unknown>;
  if (target === 'visitor') {
    return { target };
  }
  if ((target === 'item' || target === 'place') && typeof ref === 'string' && ref.length > 0) {
    return { target, ref };
  }
  return null;
}

/** The host's clip for a cue's expression, or null: an unmapped cue is not played. */
export function expressionClip(
  presence: AgentWorldPresence | null,
  embodiment: MessageEmbodiment | null,
): string | null {
  if (presence === null || embodiment === null || embodiment.expression === null) {
    return null;
  }
  return presence.expressions?.[embodiment.expression] ?? null;
}
