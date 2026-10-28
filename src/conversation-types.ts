/**
 * The types `Conversation` is described in terms of.
 *
 * Split out of `conversation.ts` on 2026-10-28 only because that file reached
 * the repo's 650-line ceiling; this is a file split and not a surface split.
 * `conversation.ts` re-exports all three, so every existing
 * `from './conversation.js'` import keeps working and no consumer had to
 * change.
 */
import type { BlocksReader } from './message.js';
import type { VisitorSession } from './session.js';
import type { ConversationMessage, SocketFactory, TypingState } from './types.js';
import type { VisitorApi } from './visitor-api.js';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'polling'
  | 'closed';

/**
 * Everything a renderer draws, as one immutable value.
 *
 * Replaced, never mutated, so `getSnapshot()` is stable between changes and
 * the object is a valid `useSyncExternalStore` snapshot without the React
 * entry having to cache anything.
 */
export interface ConversationSnapshot {
  readonly conversationId: string;
  readonly messages: readonly ConversationMessage[];
  /** Who is typing, or null. Edge-triggered and self-expiring: see `TYPING_STOP_AFTER_MS`. */
  readonly typing: TypingState | null;
  readonly connection: ConnectionState;
  /** True once the first history page has been read. */
  readonly loaded: boolean;
  /** The most recent non-fatal failure (a poll, a socket error). Cleared by the next success. */
  readonly error: unknown;
  /** The agent's read pointer: a message id, or `'*'` for "everything". */
  readonly agentReadUpTo: string | null;
}

export interface ConversationDeps {
  readonly conversationId: string;
  readonly session: VisitorSession;
  readonly api: VisitorApi;
  readonly readBlocks: BlocksReader;
  readonly randomId: () => string;
  readonly socket?: SocketFactory;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
}
