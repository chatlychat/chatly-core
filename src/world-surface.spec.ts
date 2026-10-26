/**
 * What a core-only world host gets that it did not have: declaring a surface,
 * hearing a bot fire a capability, the channel's `worldTheme` from init, and a
 * message's embodiment cue. Asserted on what the core SENDS and on what it
 * hands the host — a fake that echoes would agree with any bug here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatlyCore } from './core.js';
import { fakeSocketFactory, msg, recordingFetch, type Responder } from './test/harness.js';
import { expressionClip, messageEmbodiment } from './world-embodiment.js';

import type { HostCapabilityInvocation } from './host-surface.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function build(responder?: Responder) {
  const rec = recordingFetch(responder);
  const sock = fakeSocketFactory();
  const core = createChatlyCore({
    publicId: 'pub-1',
    apiUrl: 'https://api.test',
    fetch: rec.fetch,
    socket: sock.factory,
  });
  return { rec, sock, core };
}

const envelope = (type: string, payload: Record<string, unknown>) => ({
  v: 1,
  type,
  id: 'e',
  ts: 't',
  workspace_id: 'w',
  payload: { conversationId: 'conv-1', ...payload },
});

describe('setSurface', () => {
  it('posts ONLY the surface to the context route, with the visitor identity', async () => {
    const { rec, core } = build((r) =>
      r.path === '/v1/widget/context'
        ? { body: { surfaceRejected: [{ path: 'state.position', reason: 'positions' }] } }
        : undefined,
    );
    const surface = {
      kind: 'world',
      capabilities: [
        {
          name: 'world.walk_to',
          label: 'Take me there',
          unprompted: true,
          equivalent: { kind: 'text' as const, text: 'The shop is on level 2.' },
        },
      ],
      state: { room: 'lobby', near: ['red-jacket'] },
    };
    const result = await core.setSurface(surface);
    const call = rec.to('/v1/widget/context')[0];
    // No `page`, `context` or `audience`: naming one would replace that facet.
    expect(call?.body).toEqual({ publicId: 'pub-1', visitorToken: 'session-token-1', surface });
    expect(result.surfaceRejected).toEqual([{ path: 'state.position', reason: 'positions' }]);
  });
});

describe('onCapability', () => {
  const invoked = {
    invocationId: 'inv-1',
    messageId: 'm-1',
    surfaceId: 'world',
    capability: 'world.walk_to',
    args: { place: 'shop' },
    expiresAt: '2026-10-25T12:02:00.000Z',
  };

  it('hands a live invocation to every handler, once, and not after unsubscribe', async () => {
    const { core, sock } = build();
    const conv = await core.openConversation('conv-1');
    const seen: HostCapabilityInvocation[] = [];
    const off = conv.onCapability((inv) => seen.push(inv));
    conv.onCapability(() => {
      throw new Error('one bad handler');
    });
    sock.sockets[0]!.fire('event', envelope('host.capability_invoked', invoked));
    expect(seen).toEqual([invoked]);
    off();
    sock.sockets[0]!.fire('event', envelope('host.capability_invoked', invoked));
    expect(seen).toHaveLength(1);
  });

  it('drops a stale or malformed invocation rather than acting on it', async () => {
    const { core, sock } = build();
    const conv = await core.openConversation('conv-1');
    const seen: unknown[] = [];
    conv.onCapability((inv) => seen.push(inv));
    const fire = (p: Record<string, unknown>) =>
      sock.sockets[0]!.fire('event', envelope('host.capability_invoked', p));
    fire({ ...invoked, expiresAt: '2026-10-25T11:59:59.000Z' });
    fire({ ...invoked, expiresAt: 'not a date' });
    fire({ ...invoked, args: null });
    expect(seen).toEqual([]);
  });

  it('is answered with the existing reportAction, invocationId as actionId', async () => {
    const { rec, core } = build();
    const conv = await core.openConversation('conv-1');
    await conv.reportAction({
      messageId: 'm-1',
      actionId: 'inv-1',
      status: 'failed',
      data: { refused: true },
    });
    expect(rec.to('/v1/widget/conversations/conv-1/action-result')[0]?.body).toMatchObject({
      messageId: 'm-1',
      actionId: 'inv-1',
      status: 'failed',
      data: { refused: true },
    });
  });
});

/**
 * The space operator's switch on bot-fired capabilities (migration 0675), as
 * the CORE applies it. Held: with it off, no handler is ever handed an
 * invocation and the server is told it was refused; with it on (the default
 * for a conversation outside any space) nothing changes.
 */
describe('setUnpromptedAllowed', () => {
  const invoked = {
    invocationId: 'inv-2',
    messageId: 'm-2',
    surfaceId: 'world',
    capability: 'world.walk_to',
    args: { place: 'shop' },
    expiresAt: '2026-10-25T12:02:00.000Z',
  };

  it('drops the invocation before any handler and refuses it to the server', async () => {
    const { rec, core, sock } = build();
    const conv = await core.openConversation('conv-1');
    const seen: unknown[] = [];
    conv.onCapability((inv) => seen.push(inv));
    conv.setUnpromptedAllowed(false);
    expect(conv.acceptsUnprompted).toBe(false);

    sock.sockets[0]!.fire('event', envelope('host.capability_invoked', invoked));
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([]);
    const reported = rec.to('/v1/widget/conversations/conv-1/action-result');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.body).toMatchObject({
      messageId: 'm-2',
      actionId: 'inv-2',
      status: 'failed',
      data: { refused: true },
    });
  });

  it('CONTROL: left on (the default), the same invocation reaches the handler and nothing is refused', async () => {
    const { rec, core, sock } = build();
    const conv = await core.openConversation('conv-1');
    const seen: unknown[] = [];
    conv.onCapability((inv) => seen.push(inv));
    expect(conv.acceptsUnprompted).toBe(true);

    sock.sockets[0]!.fire('event', envelope('host.capability_invoked', invoked));
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toHaveLength(1);
    expect(rec.to('/v1/widget/conversations/conv-1/action-result')).toHaveLength(0);
  });

  it('can be switched back on, and a refused report that fails does not throw', async () => {
    const { core, sock } = build((r) =>
      r.path.endsWith('/action-result') ? { status: 500, body: { error: 'x' } } : undefined,
    );
    const conv = await core.openConversation('conv-1');
    const seen: unknown[] = [];
    conv.onCapability((inv) => seen.push(inv));
    conv.setUnpromptedAllowed(false);
    expect(() =>
      sock.sockets[0]!.fire('event', envelope('host.capability_invoked', invoked)),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    conv.setUnpromptedAllowed(true);
    sock.sockets[0]!.fire('event', envelope('host.capability_invoked', invoked));
    expect(seen).toHaveLength(1);
  });
});

describe('worldTheme from init', () => {
  it('is null before init and the served object after', async () => {
    const theme = { panelMaterial: 'glass', cardPedestal: 'plinth' };
    const { core } = build((r) =>
      r.path === '/v1/widget/init'
        ? { body: { session: { token: 't-1', contactId: null }, worldTheme: theme } }
        : undefined,
    );
    expect(core.worldTheme).toBeNull();
    await core.init();
    expect(core.worldTheme).toEqual(theme);
  });

  it('a server that sends none, or null, leaves it null', async () => {
    const { core } = build((r) =>
      r.path === '/v1/widget/init'
        ? { body: { session: { token: 't-1' }, worldTheme: null } }
        : undefined,
    );
    await core.init();
    expect(core.worldTheme).toBeNull();
  });
});

describe('embodiment cues', () => {
  const cue = { expression: 'point', lookAt: { target: 'item', ref: 'sku-4471' } };

  it('arrive live on message.created, read off metadata', async () => {
    const { core, sock } = build();
    const conv = await core.openConversation('conv-1');
    sock.sockets[0]!.fire(
      'event',
      envelope('message.created', msg('21', { metadata: { embodiment: cue } })),
    );
    const m = conv.getSnapshot().messages[0]!;
    expect(messageEmbodiment(m)).toEqual(cue);
    expect(m.body).toBe('body 21');
  });

  it('read forgivingly: an unknown expression or a bad target is dropped, not thrown', () => {
    const at = (embodiment: unknown) => messageEmbodiment({ metadata: { embodiment } } as never);
    expect(at({ expression: 'moonwalk' })).toBeNull();
    expect(at({ expression: 'nod', lookAt: { target: 'item' } })).toEqual({
      expression: 'nod',
      lookAt: null,
    });
    expect(at({ lookAt: { target: 'visitor', ref: 'ignored' } })).toEqual({
      expression: null,
      lookAt: { target: 'visitor' },
    });
    expect(at(undefined)).toBeNull();
  });

  it("map to the presence's own clip, and an unmapped cue plays nothing", () => {
    const presence = { name: 'Mia', expressions: { point: 'Point_R' } };
    expect(expressionClip(presence, { expression: 'point', lookAt: null })).toBe('Point_R');
    expect(expressionClip(presence, { expression: 'wave', lookAt: null })).toBeNull();
    expect(expressionClip(null, { expression: 'point', lookAt: null })).toBeNull();
  });
});
