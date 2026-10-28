import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatlyCore } from './core.js';
import { dispatchPress } from './press.js';
import { msg, recordingFetch } from './test/harness.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const BLOCKS = {
  v: 1,
  blocks: [
    { type: 'text', text: 'hi' },
    {
      type: 'card_grid',
      cards: [
        {
          id: 'sku-1',
          title: 'Boot',
          actions: [
            { kind: 'postback', label: 'Buy', value: 'buy', payload: { sku: '1' }, silent: true },
            { kind: 'host_event', label: 'Cart', id: 'cart', event: 'cart.add', data: { n: 1 } },
          ],
        },
        {
          id: 'sku-2',
          title: 'Hat',
          actions: [{ kind: 'url', label: 'Open', href: 'https://x.test/h' }],
        },
      ],
    },
    {
      type: 'actions',
      actions: [
        { kind: 'step', label: 'Checkout', canvasId: 'checkout', params: { a: 1 } },
        { kind: 'navigate', label: 'Go', path: '/shop' },
      ],
    },
  ],
};

async function thread() {
  const rec = recordingFetch((r) =>
    r.path === '/v1/widget/messages/list'
      ? { body: { messages: [msg('m1', { blocks: BLOCKS })] } }
      : undefined,
  );
  const core = createChatlyCore({
    publicId: 'pub-1',
    apiUrl: 'https://api.test',
    fetch: rec.fetch,
  });
  const conv = await core.openConversation('conv-1');
  return { rec, conv };
}

describe('conversation.press', () => {
  it('a postback goes to the server exactly as the widget sends it', async () => {
    const { rec, conv } = await thread();
    expect(await conv.press('m1', 'b1.c0.a0')).toBe(true);
    const sent = rec.to('/v1/widget/messages')[0]?.body;
    expect(sent).toMatchObject({
      conversationId: 'conv-1',
      body: 'buy',
      silent: true,
      payload: { sku: '1' },
    });
    conv.close();
  });

  it('a step requests the canvas step with its params', async () => {
    const { rec, conv } = await thread();
    await conv.press('m1', 'b2.a0');
    expect(rec.to('/v1/widget/conversations/conv-1/canvas-step')[0]?.body).toMatchObject({
      canvasId: 'checkout',
      params: { a: 1 },
    });
    conv.close();
  });

  it('host_event, url and navigate reach their hooks with the ref; by id and by index', async () => {
    const { conv } = await thread();
    const seen: unknown[] = [];
    conv.setPressHooks({
      onHostEvent: (e, d, ref) => void seen.push(['host', e, d, ref]),
      onOpenUrl: (h, ref) => void seen.push(['url', h, ref]),
      onNavigate: (a, ref) => void seen.push(['nav', a['path'], ref]),
    });
    expect(await conv.press('m1', 'cart')).toBe(true); // explicit id
    expect(await conv.press('m1', 2)).toBe(true); // index: sku-2's url
    expect(await conv.press('m1', 4)).toBe(true); // index: navigate
    expect(seen).toEqual([
      ['host', 'cart.add', { n: 1 }, { messageId: 'm1', actionId: 'cart' }],
      ['url', 'https://x.test/h', { messageId: 'm1', actionId: 'b1.c1.a0' }],
      ['nav', '/shop', { messageId: 'm1', actionId: 'b2.a1' }],
    ]);
    conv.close();
  });

  it('is false, not an error, when no hook is set; and throws on an unknown target', async () => {
    const { rec, conv } = await thread();
    expect(await conv.press('m1', 'cart')).toBe(false);
    expect(await conv.press('m1', 4)).toBe(false);
    await expect(conv.press('m1', 'nope')).rejects.toMatchObject({ code: 'unknown_action' });
    await expect(conv.press('m1', 99)).rejects.toMatchObject({ code: 'unknown_action' });
    await expect(conv.press('zz', 0)).rejects.toMatchObject({ code: 'unknown_message' });
    expect(rec.to('/v1/widget/messages')).toHaveLength(0);
    conv.close();
  });

  it('an action kind it does not know is a no-op', async () => {
    const calls: string[] = [];
    const target = {
      postback: () => Promise.resolve(void calls.push('postback')),
      requestStep: () => Promise.resolve(void calls.push('step')),
      requestCards: () => Promise.resolve(void calls.push('cards')),
    };
    const ref = { messageId: 'm', actionId: 'a' };
    expect(await dispatchPress(target, { kind: 'teleport' }, ref, {})).toBe(false);
    expect(calls).toEqual([]);
  });

  /*
   * A `cards` press has to reach the target HERE as well as in the widget.
   * The server will author this kind into a thread a 3D world is rendering,
   * and `dispatchPress` returning false for it would draw a button that does
   * nothing — which is what the `if` chain did before the arm was added.
   */
  it('a cards press asks the target for the operator card', async () => {
    const calls: string[] = [];
    const target = {
      postback: () => Promise.resolve(void calls.push('postback')),
      requestStep: () => Promise.resolve(void calls.push('step')),
      requestCards: (key: string) => Promise.resolve(void calls.push(`cards:${key}`)),
    };
    const ref = { messageId: 'm', actionId: 'a' };
    expect(
      await dispatchPress(
        target,
        { kind: 'cards', label: 'My orders', cardKey: 'orders' },
        ref,
        {},
      ),
    ).toBe(true);
    expect(calls).toEqual(['cards:orders']);
  });
});

describe('conversation.reactToCard', () => {
  it('sends the widget’s card thumb: a silent card.reaction postback of { card, reaction }', async () => {
    const { rec, conv } = await thread();
    await conv.reactToCard('m1', 'sku-1', 'like');
    await conv.reactToCard('m1', 'sku-1', null);
    const [a, b] = rec.to('/v1/widget/messages');
    expect(a?.body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'session-token-1',
      conversationId: 'conv-1',
      body: 'card.reaction',
      attachments: [],
      silent: true,
      payload: { card: 'sku-1', reaction: 'like' },
    });
    expect((b?.body as { payload: unknown }).payload).toEqual({ card: 'sku-1', reaction: null });
    conv.close();
  });

  it('refuses a card the message does not hold, and sends nothing', async () => {
    const { rec, conv } = await thread();
    await expect(conv.reactToCard('m1', 'ghost', 'dislike')).rejects.toMatchObject({
      code: 'unknown_action',
    });
    expect(rec.to('/v1/widget/messages')).toHaveLength(0);
    conv.close();
  });

  it('enumerates a card tap and a grid more tile, and presses them as navigate', async () => {
    const rec = recordingFetch((r) =>
      r.path === '/v1/widget/messages/list'
        ? {
            body: {
              messages: [
                msg('m9', {
                  blocks: {
                    v: 1,
                    blocks: [
                      {
                        type: 'card_grid',
                        cards: [
                          { title: 'A', action: { kind: 'navigate', label: 'A', path: '/a' } },
                          {
                            title: 'B',
                            action: { kind: 'navigate', label: 'B', path: '//evil.test' },
                          },
                        ],
                        more: {
                          label: 'More',
                          action: { kind: 'navigate', label: 'M', path: '/all' },
                        },
                      },
                    ],
                  },
                }),
              ],
            },
          }
        : undefined,
    );
    const core = createChatlyCore({
      publicId: 'pub-1',
      apiUrl: 'https://api.test',
      fetch: rec.fetch,
    });
    const conv = await core.openConversation('conv-1');
    const seen: unknown[] = [];
    conv.setPressHooks({ onNavigate: (a, ref) => void seen.push([a['path'], ref.actionId]) });
    expect(await conv.press('m9', 'b0.c0.a-1')).toBe(true);
    expect(await conv.press('m9', 'b0.a0')).toBe(true);
    expect(await conv.press('m9', 'b0.c1.a-1')).toBe(false); // unsafe path refused at the sink
    expect(seen).toEqual([
      ['/a', 'b0.c0.a-1'],
      ['/all', 'b0.a0'],
    ]);
    conv.close();
  });
});
