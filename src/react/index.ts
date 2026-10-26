/**
 * React hooks over the headless core. A SEPARATE entry point
 * (`@chatlychat/core/react`) so that `react` is a peer dependency of this
 * file only: importing `@chatlychat/core` never loads, resolves or requires
 * React.
 *
 * The conversation is an external store (`subscribe` / `getSnapshot`, with a
 * snapshot that is replaced rather than mutated), which is exactly what
 * `useSyncExternalStore` wants, so these hooks hold no state of their own
 * beyond "which conversation am I attached to".
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { Conversation, ConversationSnapshot } from '../conversation.js';
import type { ChatlyCore } from '../core.js';
import type { ConversationMessage, TypingState } from '../types.js';

const noopSubscribe = (): (() => void) => () => undefined;

const EMPTY_SNAPSHOT: ConversationSnapshot = {
  conversationId: '',
  messages: [],
  typing: null,
  connection: 'idle',
  loaded: false,
  error: null,
  agentReadUpTo: null,
};

/** The live snapshot of a conversation, or an idle empty one while it is null. */
export function useConversationSnapshot(conversation: Conversation | null): ConversationSnapshot {
  return useSyncExternalStore(
    conversation?.subscribe ?? noopSubscribe,
    conversation?.getSnapshot ?? ((): ConversationSnapshot => EMPTY_SNAPSHOT),
    // Server render: nothing has connected, and must not, during SSR.
    () => EMPTY_SNAPSHOT,
  );
}

export interface UseConversationResult {
  /** The controller, for `send` / `postback` / `react` / `markRead`. Null until attached. */
  readonly conversation: Conversation | null;
  readonly snapshot: ConversationSnapshot;
  /** Failure to attach (a rejected open). Live failures are on `snapshot.error`. */
  readonly error: unknown;
}

/**
 * Attach to a conversation by id (`null` = none yet). Opens on mount and
 * releases on unmount or id change; two components on one id share one
 * socket, and the last one out closes it.
 */
export function useConversation(
  core: ChatlyCore,
  conversationId: string | null,
): UseConversationResult {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (conversationId === null) {
      return undefined;
    }
    let cancelled = false;
    let held = false;
    core.openConversation(conversationId).then(
      (conv) => {
        if (cancelled) {
          core.releaseConversation(conversationId);
          return;
        }
        held = true;
        setError(null);
        setConversation(conv);
      },
      (err: unknown) => {
        core.releaseConversation(conversationId);
        if (!cancelled) {
          setError(err);
        }
      },
    );
    return () => {
      cancelled = true;
      if (held) {
        core.releaseConversation(conversationId);
      }
      setConversation(null);
    };
  }, [core, conversationId]);

  return { conversation, snapshot: useConversationSnapshot(conversation), error };
}

/** Just the messages, oldest first, including `pending` rows. */
export function useMessages(conversation: Conversation | null): readonly ConversationMessage[] {
  return useConversationSnapshot(conversation).messages;
}

/** Who is typing, or null. */
export function useTyping(conversation: Conversation | null): TypingState | null {
  return useConversationSnapshot(conversation).typing;
}
