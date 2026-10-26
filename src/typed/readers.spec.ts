import { describe, expect, it } from 'vitest';

import { actionsOf, cardsOf, findAction, readBlockEnvelopeTyped } from './readers.js';

import type { BlockEnvelope } from '../types.js';

const msg = (blocks: unknown[] | null, v = 1): { blocks: BlockEnvelope | null } => ({
  blocks: blocks === null ? null : ({ v, blocks } as unknown as BlockEnvelope),
});

const buy = { kind: 'postback', label: 'Buy', value: 'buy' };
const add = { kind: 'host_event', label: 'Add', event: 'cart.add' };
const open = { kind: 'url', label: 'Open', href: 'https://example.com/' };
const message = msg([
  { type: 'text', markdown: 'hi' },
  { type: 'card', title: 'A', action: open, actions: [buy] },
  {
    type: 'card_grid',
    cards: [{ title: 'B', actions: [add] }, { title: 'C' }],
    more: { label: 'More', action: { kind: 'postback', label: 'More', value: 'more' } },
  },
  { type: 'actions', actions: [{ kind: 'copy', label: 'Code', text: 'X' }] },
  { type: 'quick_replies', options: [{ label: 'l', value: 'v' }] },
  { type: 'from_the_future', x: 1 },
]);

describe('readBlockEnvelopeTyped', () => {
  it('is null without blocks, on another protocol version, or with nothing known', () => {
    expect(readBlockEnvelopeTyped(msg(null))).toBeNull();
    expect(readBlockEnvelopeTyped(msg([{ type: 'divider' }], 2))).toBeNull();
    expect(readBlockEnvelopeTyped(msg([{ type: 'from_the_future' }]))).toBeNull();
  });
  it('keeps known blocks in order and omits unknown types', () => {
    expect(readBlockEnvelopeTyped(message)?.blocks.map((b) => b.type)).toEqual([
      'text',
      'card',
      'card_grid',
      'actions',
      'quick_replies',
    ]);
  });
  it('narrows on type', () => {
    const second = readBlockEnvelopeTyped(message)?.blocks[1];
    if (second?.type !== 'card') {
      throw new Error('expected a card');
    }
    expect(second.title).toBe('A');
  });
});

describe('cardsOf', () => {
  it('flattens standalone and grid cards in order', () => {
    expect(cardsOf(message).map((c) => c.title)).toEqual(['A', 'B', 'C']);
  });
  it('is empty with no blocks', () => {
    expect(cardsOf(msg(null))).toEqual([]);
  });
});

describe('actionsOf', () => {
  it('lists tap action then buttons per card, grid more, and actions blocks, in document order', () => {
    expect(actionsOf(message).map((a) => a.label)).toEqual(['Open', 'Buy', 'Add', 'More', 'Code']);
  });
  it('is empty with no blocks', () => {
    expect(actionsOf(msg(null))).toEqual([]);
  });
});

describe('findAction', () => {
  it('finds by kind, narrowing the type', () => {
    expect(findAction(message, { kind: 'host_event' })?.event).toBe('cart.add');
  });
  it('finds by event name, and only host events match', () => {
    expect(findAction(message, { event: 'cart.add' })?.label).toBe('Add');
    expect(findAction(message, { event: 'nope' })).toBeUndefined();
    expect(findAction(message, { kind: 'postback', event: 'cart.add' })).toBeUndefined();
  });
  it('with no query returns the first action', () => {
    expect(findAction(message, {})?.label).toBe('Open');
  });
  it('returns undefined when nothing matches', () => {
    expect(findAction(msg(null), { kind: 'url' })).toBeUndefined();
    expect(findAction(message, { kind: 'step' })).toBeUndefined();
  });
});
