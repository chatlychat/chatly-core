/**
 * `onNotice`, `reportCardView`, `reportCardAction` (ADR 0082).
 *
 * Asserted on what the core SENT (the recorded `POST /v1/widget/events`
 * bodies) and what it handed a handler, never on a canned answer. The consent
 * cases are the point of the second half: with analytics not granted the
 * recording must be empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatlyCore } from './core.js';
import { fakeSocketFactory, flush, msg, recordingFetch } from './test/harness.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const BLOCKS = {
  v: 1,
  blocks: [
    {
      type: 'card',
      id: 'solo',
      title: 'Solo',
      actions: [{ kind: 'postback', label: 'Buy', value: 'buy' }],
    },
    {
      type: 'card_grid',
      cards: [
        {
          id: 'sku-1',
          title: 'Boot',
          actions: [{ kind: 'navigate', label: 'Go', path: '/boots' }],
        },
        {
          id: 'sku-2',
          title: 'Hat',
          actions: [
            { kind: 'url', label: 'Open', href: 'https://x.test/h' },
            { kind: 'host_event', label: 'Save', id: 'save', event: 'wish.add' },
          ],
        },
      ],
    },
  ],
};

async function thread(opts: { analytics?: boolean } = {}) {
  const rec = recordingFetch((r) =>
    r.path === '/v1/widget/messages/list'
      ? { body: { messages: [msg('m1', { blocks: BLOCKS })] } }
      : undefined,
  );
  const sock = fakeSocketFactory();
  const core = createChatlyCore({
    publicId: 'pub-1',
    apiUrl: 'https://api.test',
    fetch: rec.fetch,
    socket: sock.factory,
    ...(opts.analytics === undefined ? {} : { analytics: opts.analytics }),
  });
  const conv = await core.openConversation('conv-1');
  await flush();
  return { rec, conv, core, sock };
}

const event = (payload: Record<string, unknown>) => ({
  v: 1,
  type: 'message.notice',
  id: 'e',
  ts: 't',
  workspace_id: 'w',
  payload,
});

describe('conversation.onNotice', () => {
  it('hands a notice for this conversation to the handler, once, and does not store it', async () => {
    const { conv, sock } = await thread();
    const heard: unknown[] = [];
    conv.onNotice((n) => heard.push(n));
    const before = conv.getSnapshot().messages.length;
    sock.sockets[0]?.fire(
      'event',
      event({ conversationId: 'conv-1', replyTo: 'm9', body: 'Added to cart' }),
    );
    expect(heard).toEqual([{ replyTo: 'm9', body: 'Added to cart' }]);
    // Not a message: the thread is untouched.
    expect(conv.getSnapshot().messages).toHaveLength(before);
    conv.close();
  });

  it('ignores another conversation, a malformed payload and an empty body', async () => {
    const { conv, sock } = await thread();
    const heard = vi.fn();
    conv.onNotice(heard);
    for (const payload of [
      { conversationId: 'other', replyTo: 'm', body: 'x' },
      { conversationId: 'conv-1', replyTo: 'm' },
      { conversationId: 'conv-1', replyTo: 'm', body: '' },
      { conversationId: 'conv-1', replyTo: 7, body: 'x' },
    ]) {
      sock.sockets[0]?.fire('event', event(payload));
    }
    expect(heard).not.toHaveBeenCalled();
    conv.close();
  });

  it('unsubscribes, and a throwing handler does not stop the next one', async () => {
    const { conv, sock } = await thread();
    const second = vi.fn();
    conv.onNotice(() => {
      throw new Error('boom');
    });
    const off = conv.onNotice(second);
    const fire = () =>
      sock.sockets[0]?.fire('event', event({ conversationId: 'conv-1', replyTo: 'm', body: 'x' }));
    fire();
    expect(second).toHaveBeenCalledTimes(1);
    off();
    fire();
    expect(second).toHaveBeenCalledTimes(1);
    conv.close();
  });
});

describe('card analytics, consent granted', () => {
  it('reportCardView sends card.viewed with the widget’s property names, once per card', async () => {
    const { rec, conv } = await thread({ analytics: true });
    expect(await conv.reportCardView('m1', 'sku-2')).toBe(true);
    expect(await conv.reportCardView('m1', 'sku-2')).toBe(false);
    const sent = rec.to('/v1/widget/events');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      name: 'card.viewed',
      properties: {
        conversationId: 'conv-1',
        messageId: 'm1',
        cardId: 'sku-2',
        position: { block: 1, card: 1 },
      },
    });
    conv.close();
  });

  it('reportCardAction sends card.action with index, the id reportAction uses, and the kind', async () => {
    const { rec, conv } = await thread({ analytics: true });
    await conv.reportCardAction('m1', 'sku-2', 0);
    await conv.reportCardAction('m1', 'sku-2', 1);
    await conv.reportCardAction('m1', 'solo', 0);
    await conv.reportCardAction('m1', 'sku-1', -1);
    const props = rec.to('/v1/widget/events').map((c) => c.body?.['properties']);
    expect(props).toEqual([
      expect.objectContaining({ actionIndex: 0, actionId: 'b1.c1.a0', kind: 'url' }),
      expect.objectContaining({ actionIndex: 1, actionId: 'save', kind: 'host_event' }),
      expect.objectContaining({
        cardId: 'solo',
        position: { block: 0, card: 0 },
        actionId: 'b0.a0',
      }),
      expect.objectContaining({ actionIndex: -1, actionId: 'b1.c0.a-1' }),
    ]);
    conv.close();
  });

  it('is not deduplicated for presses: every press is a press', async () => {
    const { rec, conv } = await thread({ analytics: true });
    await conv.reportCardAction('m1', 'sku-2', 0);
    await conv.reportCardAction('m1', 'sku-2', 0);
    expect(rec.to('/v1/widget/events')).toHaveLength(2);
    conv.close();
  });

  it('refuses a card the message does not hold, and sends nothing', async () => {
    const { rec, conv } = await thread({ analytics: true });
    await expect(conv.reportCardView('m1', 'ghost')).rejects.toMatchObject({
      code: 'unknown_action',
    });
    await expect(conv.reportCardAction('nope', 'sku-1', 0)).rejects.toMatchObject({
      code: 'unknown_action',
    });
    expect(rec.to('/v1/widget/events')).toHaveLength(0);
    conv.close();
  });
});

describe('card analytics, consent NOT granted (the default)', () => {
  it('sends nothing for a view or an action, and says so', async () => {
    const { rec, conv } = await thread();
    expect(await conv.reportCardView('m1', 'sku-1')).toBe(false);
    expect(await conv.reportCardAction('m1', 'sku-1', 0)).toBe(false);
    expect(rec.to('/v1/widget/events')).toHaveLength(0);
    conv.close();
  });

  it('an explicit analytics:false is the same as the default', async () => {
    const { rec, conv } = await thread({ analytics: false });
    await conv.reportCardView('m1', 'sku-1');
    expect(rec.to('/v1/widget/events')).toHaveLength(0);
    conv.close();
  });

  it('a later grant starts sending, and a withdrawal stops it; a view dropped while denied is not queued', async () => {
    const { rec, conv, core } = await thread();
    await conv.reportCardView('m1', 'sku-1');
    core.setAnalyticsConsent(true);
    expect(await conv.reportCardView('m1', 'sku-1')).toBe(true);
    expect(rec.to('/v1/widget/events')).toHaveLength(1);
    core.setAnalyticsConsent(false);
    expect(await conv.reportCardAction('m1', 'sku-1', 0)).toBe(false);
    expect(rec.to('/v1/widget/events')).toHaveLength(1);
    conv.close();
  });

  it('the host’s own track() is never gated', async () => {
    const { rec, core, conv } = await thread();
    await core.track('my.event', { a: 1 });
    expect(rec.to('/v1/widget/events')).toHaveLength(1);
    conv.close();
  });
});
