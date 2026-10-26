/**
 * `card.viewed` / `card.action` for a host that draws its own cards (ADR 0082).
 *
 * The web widget measures these itself (an IntersectionObserver and a click
 * listener in `widget-commerce.js`). A 3D world, a game or a native shell has
 * no DOM to observe, so it calls `conversation.reportCardView` when ITS notion
 * of "half the card visible for a second" is met, and `reportCardAction` when
 * the visitor presses something on it. The events are the same `Chatly('track')`
 * path the widget uses (`POST /v1/widget/events`, a `cdp_events` row), with the
 * same property names, so audiences and the outcomes read see both alike.
 *
 * Consent is the host's to state and the default is NO: telemetry is opt-in
 * (ADR 0081). Until the host passes `analytics: true` (or calls
 * `setAnalyticsConsent(true)`), nothing here sends and the methods resolve
 * `false`. Pure over its inputs; the only effect is the `track` it is handed.
 */
import { ChatlyError } from './errors.js';

import type { VisitorSession } from './session.js';
import type { ConversationMessage } from './types.js';
import type { VisitorApi } from './visitor-api.js';

export interface CardLocation {
  readonly block: number;
  readonly card: number;
  /** `undefined` for a lone `card` block, which has no card index in an id. */
  readonly cardIndex: number | undefined;
  readonly actions: readonly Record<string, unknown>[];
}

/** Find a card by its `id` among a message's `card` blocks and `card_grid` cards. */
export function locateCard(message: ConversationMessage, cardId: string): CardLocation | null {
  const blocks = message.blocks?.blocks ?? [];
  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b] as Record<string, unknown> | undefined;
    if (block === undefined) {
      continue;
    }
    if (block['type'] === 'card' && block['id'] === cardId) {
      return { block: b, card: 0, cardIndex: undefined, actions: actionsOf(block) };
    }
    if (block['type'] === 'card_grid' && Array.isArray(block['cards'])) {
      const cards = block['cards'] as Array<Record<string, unknown>>;
      const c = cards.findIndex((card) => card['id'] === cardId);
      if (c >= 0) {
        return { block: b, card: c, cardIndex: c, actions: actionsOf(cards[c] ?? {}) };
      }
    }
  }
  return null;
}

function actionsOf(card: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(card['actions']) ? (card['actions'] as Record<string, unknown>[]) : [];
}

/** The id `reportAction` and the widget use: the action's own, else `b2.c3.a0`. */
export function cardActionId(loc: CardLocation, actionIndex: number): string {
  const own = (actionIndex < 0 ? undefined : loc.actions[actionIndex])?.['id'];
  if (typeof own === 'string' && own.length > 0) {
    return own;
  }
  const card = loc.cardIndex === undefined ? '' : `c${String(loc.cardIndex)}.`;
  return `b${String(loc.block)}.${card}a${String(actionIndex)}`;
}

export function cardEventBase(
  conversationId: string,
  messageId: string,
  cardId: string,
  loc: CardLocation,
): Record<string, unknown> {
  return {
    conversationId,
    messageId,
    cardId,
    position: { block: loc.block, card: loc.card },
  };
}

/**
 * An ephemeral one-line answer to this visitor's silent postback (ADR 0082).
 * Delivered once over the live socket and never stored: it is not in
 * `getSnapshot().messages`, and a host that was not subscribed when it fired
 * (or has no socket, only polling) never sees it. Show it as a toast.
 */
export interface ConversationNotice {
  /** The id of the visitor message (the press) this answers. */
  readonly replyTo: string;
  readonly body: string;
}

/** Read a `message.notice` payload for this conversation, or null. */
export function readNotice(raw: unknown, conversationId: string): ConversationNotice | null {
  const p = raw as { conversationId?: unknown; replyTo?: unknown; body?: unknown } | null;
  if (
    p === null ||
    typeof p !== 'object' ||
    p.conversationId !== conversationId ||
    typeof p.replyTo !== 'string' ||
    typeof p.body !== 'string' ||
    p.body === ''
  ) {
    return null;
  }
  return { replyTo: p.replyTo, body: p.body };
}

/** The `reportCardView` / `reportCardAction` logic, kept out of `conversation.ts` (650 lines). */
export class CardReporter {
  /** Cards already reported viewed in this conversation view. */
  private readonly viewed = new Set<string>();

  public constructor(
    private readonly conversationId: string,
    private readonly api: VisitorApi,
    private readonly session: VisitorSession,
    private readonly messages: () => readonly ConversationMessage[],
  ) {}

  public async view(messageId: string, cardId: string): Promise<boolean> {
    const loc = this.locate(messageId, cardId);
    const key = `${messageId}:${cardId}`;
    if (!this.session.analyticsGranted || this.viewed.has(key)) {
      return false;
    }
    this.viewed.add(key);
    await this.api.track('card.viewed', cardEventBase(this.conversationId, messageId, cardId, loc));
    return true;
  }

  public async action(messageId: string, cardId: string, actionIndex: number): Promise<boolean> {
    const loc = this.locate(messageId, cardId);
    if (!this.session.analyticsGranted) {
      return false;
    }
    const kind = (actionIndex < 0 ? undefined : loc.actions[actionIndex])?.['kind'];
    await this.api.track('card.action', {
      ...cardEventBase(this.conversationId, messageId, cardId, loc),
      actionIndex,
      actionId: cardActionId(loc, actionIndex),
      ...(typeof kind === 'string' ? { kind } : {}),
    });
    return true;
  }

  private locate(messageId: string, cardId: string): CardLocation {
    const message = this.messages().find((m) => m.id === messageId);
    const loc = message === undefined ? null : locateCard(message, cardId);
    if (loc === null) {
      throw new ChatlyError(
        'unknown_action',
        `chatly: message "${messageId}" has no card "${cardId}"`,
      );
    }
    return loc;
  }
}
