/**
 * The embodied agent: who is standing in the world, and what they are doing
 * right now.
 *
 * ── Why this is in the core and not in the widget ─────────────────────────
 *
 * A 3D world host embeds THIS package, not the 2D DOM panel. The widget's
 * combined budget has under 200 gzipped bytes left and its first-paint
 * ceiling has never moved, and more to the point a world has no DOM to render
 * a panel into: it has a scene graph, a rig and an animation set. So the
 * conversation logic a world needs lives here, where it already is, and the
 * widget gains nothing and costs nothing. ADR 0064.
 *
 * ── The state is DERIVED. Nothing on the wire sets it ────────────────────
 *
 * There is no `presence.state` event and no field an author can set, and that
 * is the design rather than an omission. The four states are a function of
 * the live conversation — whether a message is streaming, whether anyone is
 * typing, whose turn it is — and every one of those facts is already in the
 * snapshot this core maintains. A server-sent state would be a second source
 * of truth that could disagree with the thread the visitor is looking at.
 *
 * The derivation is a PURE function of a snapshot, with no clock and no
 * timer, and that is a deliberate constraint rather than a simplification. A
 * state that decayed on a timeout ("speaking for 2 seconds after the last
 * token") would go stale between renders: a host drawing on a game loop reads
 * `getSnapshot()` and would see a state that should have changed with no
 * subscriber notification to tell it so. The one timeout this core does own —
 * the typing window, `TYPING_STOP_AFTER_MS` — already fires a notification
 * when it expires, so `thinking` falls away correctly without this function
 * needing to know the time.
 *
 * ── Parity with `@livechat/shared/spatial` ───────────────────────────────
 *
 * The state names, the clip map and the `Agent: name (description)` idiom are
 * declared as zod schemas in `packages/shared/src/spatial/`. This file
 * restates them as plain types and constants, because a published package
 * cannot import an internal one (an internal import typechecks, passes every
 * test and breaks at install) and because the core has zero dependencies, zod
 * included. `packages/shared/src/spatial/core-parity.spec.ts` reads this file
 * and fails on drift.
 */

import type { ConversationSnapshot } from './conversation.js';
import type { ConversationMessage } from './types.js';
import type { AgentExpression } from './world-embodiment.js';

/**
 * The four states, in the order `AGENT_PRESENCE_STATES` declares them. A host
 * switches on these; see the shared schema for what each one means.
 */
export const AGENT_PRESENCE_STATES = ['idle', 'listening', 'thinking', 'speaking'] as const;

export type AgentPresenceState = (typeof AGENT_PRESENCE_STATES)[number];

/** `gltf | usdz | vrm`. A HINT: a host that cannot use the format says so and falls back. */
export const AVATAR_FORMATS = ['gltf', 'usdz', 'vrm'] as const;
export type AvatarFormat = (typeof AVATAR_FORMATS)[number];

/** Named points on the model, never a vector. */
export const AVATAR_ANCHORS = ['center', 'base', 'top', 'back'] as const;
export type AvatarAnchor = (typeof AVATAR_ANCHORS)[number];

export const AVATAR_SCALE_MIN = 0.01;
export const AVATAR_SCALE_MAX = 100;

export interface AvatarAsset {
  readonly url: string;
  readonly format?: AvatarFormat;
  readonly scale?: number;
  readonly anchor?: AvatarAnchor;
}

/** A name in the HOST's own animation set. Chatly never interprets one. */
export type PresenceClips = { readonly [S in AgentPresenceState]?: string };

/** `stand` holds its spot, `wander` strolls its area, `follow` keeps near the visitor. */
export const PRESENCE_IDLE_BEHAVIOURS = ['stand', 'wander', 'follow'] as const;
export const PRESENCE_VOICE_RATE_MIN = 0.5;
export const PRESENCE_VOICE_RATE_MAX = 2;
export const PRESENCE_PERSONAL_SPACE_MIN_METRES = 0.3;
export const PRESENCE_PERSONAL_SPACE_MAX_METRES = 5;

export interface AgentWorldPresence {
  /** Required. The words are the substance; the geometry is the ornament. */
  readonly name: string;
  /** What the avatar looks like. Use it as the avatar's accessible name. */
  readonly description?: string;
  readonly avatar?: AvatarAsset;
  readonly clips?: PresenceClips;
  /** The host's clip for each `message.embodiment.expression`. Unmapped = not played. */
  readonly expressions?: { readonly [E in AgentExpression]?: string };
  /** The short label drawn over the avatar. Absent means `name`. */
  readonly nameTag?: string;
  /** A voice the host or its speech provider knows by id. Chatly synthesises speech separately (`api.speech()`); this id is a hint for your renderer. */
  readonly voice?: { readonly id: string; readonly rate?: number };
  readonly idle?: (typeof PRESENCE_IDLE_BEHAVIOURS)[number];
  /** Metres the agent keeps from a visitor. */
  readonly personalSpaceMetres?: number;
}

/**
 * Presences by actor id, with `'*'` as the fallback for any actor.
 *
 * `'*'` is this core's existing idiom for "all of them" —
 * `ConversationSnapshot.agentReadUpTo` is already "a message id, or `'*'` for
 * everything" — rather than a second convention. One bot answering every
 * thread needs only `{ '*': … }`, and a workspace that embodies three agents
 * separately keys them by id and may still leave a `'*'` for the rest.
 */
export type PresenceMap = { readonly [actorId: string]: AgentWorldPresence };

export interface EmbodiedAgentOptions {
  readonly presences?: PresenceMap;
  /**
   * The visitor is composing. Only the host knows — there is no DOM here and
   * no input to watch — and it is the one fact that distinguishes a genuinely
   * attentive avatar from one that merely answered and stopped.
   */
  readonly visitorComposing?: boolean;
}

export interface EmbodiedAgent {
  readonly state: AgentPresenceState;
  readonly actorType: 'agent' | 'bot' | null;
  readonly actorId: string | null;
  /**
   * The server's label for the actor, when realtime supplied one. A world
   * shows `presence.name`; this is the fallback when no presence is
   * configured, and it is null outside a typing event because a
   * `ConversationMessage` carries an `authorId` and no name.
   */
  readonly displayName: string | null;
  readonly presence: AgentWorldPresence | null;
  /** The host's own clip for `state`, when the presence named one. */
  readonly clip: string | null;
  /**
   * The non-spatial equivalent: `Agent: Mia (a guide in a red jacket) —
   * thinking`. Null with no presence, because there is nothing to say that
   * the thread does not already say.
   *
   * This is not decoration. A sighted visitor WATCHES the avatar lean in,
   * pause and speak; a visitor using narration gets none of it unless a host
   * announces this. Announce it politely, not every frame.
   */
  readonly described: string | null;
}

/** `Agent: <name> (<description>)`. Mirrors `describePresence` in the shared package. */
export function describePresence(presence: AgentWorldPresence): string {
  return presence.description === undefined
    ? `Agent: ${presence.name}`
    : `Agent: ${presence.name} (${presence.description})`;
}

/** `Agent: <name> (<description>) — <state>`. Mirrors `describePresenceState`. */
export function describePresenceState(
  presence: AgentWorldPresence,
  state: AgentPresenceState,
): string {
  return `${describePresence(presence)} — ${state}`;
}

const isServing = (m: ConversationMessage): boolean =>
  m.authorType === 'agent' || m.authorType === 'bot';

/**
 * The state, and the precedence is the whole of the behaviour.
 *
 *  1. `idle` — the thread is closed, unread or empty. Nobody is attending it.
 *  2. `speaking` — the newest message is an agent's or bot's and is still
 *     streaming. It beats everything below, including a typing event: a
 *     streaming bot emits both and the mouth should win over the thought.
 *  3. `thinking` — someone is typing. The turn is the agent's and the answer
 *     has not arrived.
 *  4. `listening` — the visitor is composing. Checked AFTER typing, because
 *     if both are true the agent really is mid-thought; checked BEFORE the
 *     turn test below, because a visitor typing a second message has taken
 *     the turn back.
 *  5. `thinking` — the newest message is the visitor's. The turn is the
 *     agent's and nothing has come yet, which is the same thing as (3)
 *     without a typing event to prove it — and polling visitors never get
 *     one, so without this rule they would never see `thinking` at all.
 *  6. `listening` — otherwise: answered, waiting, attentive.
 *
 * The last message is read INCLUDING a `pending` optimistic row, on purpose.
 * A visitor who has just pressed send has taken their turn whether or not the
 * server has acknowledged it, and skipping the row would leave the avatar
 * `listening` at the exact moment it should start thinking — the most visible
 * frame in the whole interaction.
 */
function deriveState(
  snapshot: ConversationSnapshot,
  opts: EmbodiedAgentOptions,
): AgentPresenceState {
  if (!snapshot.loaded || snapshot.connection === 'closed' || snapshot.messages.length === 0) {
    return 'idle';
  }
  const last = snapshot.messages[snapshot.messages.length - 1];
  if (last !== undefined && isServing(last) && last.streamState === 'streaming') {
    return 'speaking';
  }
  if (snapshot.typing !== null) {
    return 'thinking';
  }
  if (opts.visitorComposing === true) {
    return 'listening';
  }
  if (last !== undefined && last.authorType === 'contact') {
    return 'thinking';
  }
  return 'listening';
}

/**
 * Who is acting, so the right presence is chosen.
 *
 * The typing event is preferred over the transcript because it is the LIVE
 * fact: a human agent who has just taken over a bot's thread is typing now
 * while every message in the thread is still the bot's, and embodying the bot
 * at that moment would stand the wrong avatar in front of the visitor.
 */
function deriveActor(snapshot: ConversationSnapshot): {
  actorType: 'agent' | 'bot' | null;
  actorId: string | null;
  displayName: string | null;
} {
  if (snapshot.typing !== null) {
    return {
      actorType: snapshot.typing.actorType,
      actorId: snapshot.typing.actorId,
      displayName: snapshot.typing.displayName,
    };
  }
  for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
    const m = snapshot.messages[i];
    if (m !== undefined && isServing(m)) {
      return { actorType: m.authorType as 'agent' | 'bot', actorId: m.authorId, displayName: null };
    }
  }
  return { actorType: null, actorId: null, displayName: null };
}

/**
 * The embodied agent for one conversation snapshot. Pure: call it in a render,
 * in a game loop, in a `subscribe` callback.
 *
 *   const conv = await chatly.openConversation(id);
 *   conv.subscribe(() => {
 *     const agent = embodiedAgent(conv.getSnapshot(), { presences });
 *     rig.play(agent.clip ?? agent.state);
 *     label.setAccessibleName(agent.described);
 *   });
 */
export function embodiedAgent(
  snapshot: ConversationSnapshot,
  opts: EmbodiedAgentOptions = {},
): EmbodiedAgent {
  const state = deriveState(snapshot, opts);
  const { actorType, actorId, displayName } = deriveActor(snapshot);
  const byId = actorId === null ? undefined : opts.presences?.[actorId];
  const presence = byId ?? opts.presences?.['*'] ?? null;
  return {
    state,
    actorType,
    actorId,
    displayName,
    presence,
    clip: presence?.clips?.[state] ?? null,
    described: presence === null ? null : describePresenceState(presence, state),
  };
}
