/**
 * Pressing a block action: the ONE dispatch, used by `conversation.press` and
 * by `@chatlychat/world`'s card handlers, so a 3D host and a headless one
 * cannot disagree about what a `postback`, `step`, `cards`, `host_event`, `url` or
 * `navigate` press does.
 *
 * Actions are read loosely (a record with a `kind`), like blocks in
 * `blocks.ts`: this package cannot import the shared schema, and an action
 * kind it does not know is a no-op rather than a throw, so a newer server
 * does not break an older host.
 */
import { ChatlyError } from './errors.js';

import type { ConversationMessage } from './types.js';

export interface PressableAction {
  readonly kind: string;
  readonly id?: string;
  readonly value?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly silent?: boolean;
  readonly event?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly href?: string;
  readonly canvasId?: string;
  readonly params?: Record<string, unknown>;
  /** A `cards` action's operator-registered card key. */
  readonly cardKey?: string;
  readonly [key: string]: unknown;
}

/** Where a press happened, so a host can answer with `reportAction`. */
export interface PressRef {
  readonly messageId: string;
  readonly actionId: string;
}

export interface PressHooks {
  /** A `host_event` press. Resolve `true` when something claimed it. */
  readonly onHostEvent?: (
    event: string,
    data: Readonly<Record<string, unknown>>,
    ref: PressRef,
  ) => Promise<boolean> | boolean | void;
  /** A `url` press. The core never opens anything. */
  readonly onOpenUrl?: (href: string, ref: PressRef) => void;
  /** A `navigate` press: the whole action, because its fields belong to the host's router. */
  readonly onNavigate?: (action: PressableAction, ref: PressRef) => Promise<void> | void;
}

/** The slice of `Conversation` a press needs. */
export interface PressTarget {
  postback(input: {
    body: string;
    payload?: Record<string, unknown>;
    silent?: boolean;
  }): Promise<void>;
  requestStep(canvasId: string, params?: Record<string, unknown>): Promise<unknown>;
  requestCards(cardKey: string): Promise<unknown>;
}

const SINK_PATH = /^\/(?![\\/])[^\0-\x20\x7f\\]*$/;

/** Do what the action says. Resolves to whether anything acted. */
export async function dispatchPress(
  target: PressTarget,
  action: PressableAction,
  ref: PressRef,
  hooks: PressHooks,
): Promise<boolean> {
  if (action.kind === 'postback' && action.value !== undefined) {
    await target.postback({
      body: action.value,
      ...(action.payload === undefined ? {} : { payload: { ...action.payload } }),
      ...(action.silent === true ? { silent: true } : {}),
    });
    return true;
  }
  if (action.kind === 'step' && action.canvasId !== undefined) {
    await target.requestStep(action.canvasId, action.params);
    return true;
  }
  /*
   * Handled HERE and not left to fall through. These `if`s return false for
   * an unknown kind, which is right for a kind this build has never heard of
   * and wrong for one the server will happily author into a thread a world
   * is rendering: the button would draw and do nothing. Same shape as
   * `step`, which is the other kind whose work happens on our server.
   */
  if (action.kind === 'cards' && action.cardKey !== undefined) {
    await target.requestCards(action.cardKey);
    return true;
  }
  if (action.kind === 'host_event' && action.event !== undefined) {
    return (
      hooks.onHostEvent !== undefined &&
      (await hooks.onHostEvent(action.event, action.data ?? {}, ref)) !== false
    );
  }
  if (action.kind === 'url' && action.href !== undefined) {
    hooks.onOpenUrl?.(action.href, ref);
    return hooks.onOpenUrl !== undefined;
  }
  // The host's router receives this string: `//evil.example` would leave the site.
  if (
    action.kind === 'navigate' &&
    hooks.onNavigate !== undefined &&
    typeof action['path'] === 'string' &&
    SINK_PATH.test(action['path'])
  ) {
    await hooks.onNavigate(action, ref);
    return true;
  }
  return false;
}

/**
 * Every action a message offers, in document order, with the id the widget
 * gives it: the action's own `id`, else `b<block>[.c<card>].a<n>` (`a-1` for a
 * card's own tap, `a0` for a grid's "more" tile). Those are
 * the ids `reportAction` is keyed on, so a press and its result agree.
 */
export function messageActions(
  message: ConversationMessage,
): ReadonlyArray<{ readonly id: string; readonly action: PressableAction }> {
  const out: Array<{ id: string; action: PressableAction }> = [];
  const add = (list: unknown, prefix: string): void => {
    if (!Array.isArray(list)) {
      return;
    }
    (list as PressableAction[]).forEach((action, n) => {
      if (typeof action === 'object' && action !== null) {
        out.push({
          id:
            typeof action.id === 'string' && action.id.length > 0
              ? action.id
              : `${prefix}a${String(n)}`,
          action,
        });
      }
    });
  };
  // A card's own tap (`action`) is `a-1`, as in the widget, so it cannot collide with a button's id.
  const addOne = (action: unknown, id: string): void => {
    if (typeof action === 'object' && action !== null) {
      const own = (action as PressableAction).id;
      out.push({
        id: typeof own === 'string' && own.length > 0 ? own : id,
        action: action as PressableAction,
      });
    }
  };
  const card = (c: Record<string, unknown>, prefix: string): void => {
    addOne(c['action'], `${prefix}a-1`);
    add(c['actions'], prefix);
  };
  (message.blocks?.blocks ?? []).forEach((block, b) => {
    const at = `b${String(b)}.`;
    if (block.type === 'card_grid' && Array.isArray(block['cards'])) {
      (block['cards'] as Array<Record<string, unknown>>).forEach((c, n) =>
        card(c, `${at}c${String(n)}.`),
      );
      const more = block['more'] as { action?: unknown } | undefined;
      addOne(more?.action, `${at}a0`);
    } else if (block.type === 'card') {
      card(block, at);
    } else if (block.type === 'actions') {
      add(block['actions'], at);
    }
  });
  return out;
}

/**
 * Press an action on a message: by its id (its own `id`, else the widget's
 * positional `b0.a1` / `b0.c2.a0`) or by its index among the message's
 * actions in document order. Does exactly what the world's card handlers
 * do, because they call the same `dispatchPress`.
 *
 * Resolves to whether anything acted: a `host_event` with no `onHostEvent`
 * hook, or a `navigate` with no `onNavigate`, is `false`, not an error.
 * Throws `unknown_message` / `unknown_action` for a press that names
 * nothing, so a typo is not a silent no-op.
 */
export async function pressMessage(
  target: PressTarget,
  messages: readonly ConversationMessage[],
  messageId: string,
  action: string | number,
  hooks: PressHooks,
): Promise<boolean> {
  const message = messages.find((m) => m.id === messageId);
  if (message === undefined) {
    throw new ChatlyError('unknown_message', `chatly: no message "${messageId}" in this thread`);
  }
  const all = messageActions(message);
  const hit = typeof action === 'number' ? all[action] : all.find((a) => a.id === action);
  if (hit === undefined) {
    throw new ChatlyError(
      'unknown_action',
      `chatly: message "${messageId}" has no action "${String(action)}"`,
    );
  }
  return dispatchPress(target, hit.action, { messageId, actionId: hit.id }, hooks);
}

/**
 * `reactToCard`'s check. The reaction itself is a SILENT postback
 * `card.reaction` with `{ card, reaction }`, as the web widget's thumbs send;
 * the server finds the message carrying the card. `messageId` is checked, not
 * sent: if the thread holds it and it has no such card, that is
 * `unknown_action` rather than a reaction to nothing.
 */
export function assertCardInMessage(
  messages: readonly ConversationMessage[],
  messageId: string,
  cardId: string,
): void {
  const blocks = messages.find((m) => m.id === messageId)?.blocks?.blocks;
  if (
    blocks !== undefined &&
    !blocks.some(
      (b) =>
        b['id'] === cardId ||
        (Array.isArray(b['cards']) &&
          (b['cards'] as Array<{ id?: unknown }>).some((c) => c.id === cardId)),
    )
  ) {
    throw new ChatlyError(
      'unknown_action',
      `chatly: message "${messageId}" has no card "${cardId}"`,
    );
  }
}
