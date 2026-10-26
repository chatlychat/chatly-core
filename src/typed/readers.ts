/**
 * Typed readers over a message's parsed blocks.
 *
 * `readBlockEnvelope` (blocks.ts) is deliberately loose: it guarantees the
 * envelope and leaves block interiors alone, so an unknown key or a block
 * from a newer server survives. These helpers are for a host that wants the
 * typed union to switch on. They trust the shape (the server validated it on
 * write) and check only the `type` tag, so a block type this version does not
 * know is OMITTED from the typed view rather than mistyped. The loose
 * `message.blocks` still holds it.
 */
import type { Action, Block, BlockEnvelope, CardBody } from './block-types.js';
import type { ConversationMessage } from '../types.js';

type WithBlocks = Pick<ConversationMessage, 'blocks'>;

const KNOWN_TYPES: ReadonlySet<string> = new Set<Block['type']>([
  'text',
  'media',
  'fields',
  'card',
  'card_grid',
  'actions',
  'quick_replies',
  'status',
  'order_status',
  'table',
  'place',
  'divider',
]);

/** The message's blocks as the typed union, or `null` when it has none. */
export function readBlockEnvelopeTyped(message: WithBlocks): BlockEnvelope | null {
  const envelope = message.blocks;
  if (envelope === null || envelope === undefined || envelope.v !== 1) {
    return null;
  }
  const blocks = envelope.blocks.filter((b) => KNOWN_TYPES.has(b.type)) as unknown as Block[];
  return blocks.length > 0 ? { v: 1, blocks } : null;
}

/** Every card in the message, standalone cards and a grid's cards, in document order. */
export function cardsOf(message: WithBlocks): CardBody[] {
  const out: CardBody[] = [];
  for (const block of readBlockEnvelopeTyped(message)?.blocks ?? []) {
    if (block.type === 'card') {
      out.push(block);
    } else if (block.type === 'card_grid') {
      out.push(...block.cards);
    }
  }
  return out;
}

function cardActions(card: CardBody): Action[] {
  return [...(card.action ? [card.action] : []), ...(card.actions ?? [])];
}

/**
 * Every action the message offers, in document order: an `actions` block's
 * buttons, each card's tap action then its buttons, and a grid's "more" tile.
 * Quick replies are not actions and are not included.
 */
export function actionsOf(message: WithBlocks): Action[] {
  const out: Action[] = [];
  for (const block of readBlockEnvelopeTyped(message)?.blocks ?? []) {
    if (block.type === 'actions') {
      out.push(...block.actions);
    } else if (block.type === 'card') {
      out.push(...cardActions(block));
    } else if (block.type === 'card_grid') {
      for (const card of block.cards) {
        out.push(...cardActions(card));
      }
      if (block.more) {
        out.push(block.more.action);
      }
    }
  }
  return out;
}

export interface ActionQuery<K extends Action['kind'] = Action['kind']> {
  readonly kind?: K;
  /** A `host_event` name. Implies `kind: 'host_event'`. */
  readonly event?: string;
}

/** The first action matching `kind` and/or `event`, or `undefined`. Narrows by `kind`. */
export function findAction<K extends Action['kind'] = Action['kind']>(
  message: WithBlocks,
  query: ActionQuery<K>,
): Extract<Action, { kind: K }> | undefined {
  return actionsOf(message).find(
    (a) =>
      (query.kind === undefined || a.kind === query.kind) &&
      (query.event === undefined || (a.kind === 'host_event' && a.event === query.event)),
  ) as Extract<Action, { kind: K }> | undefined;
}
