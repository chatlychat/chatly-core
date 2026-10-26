import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TYPING_STOP_AFTER_MS } from './conversation.js';
import { createChatlyCore } from './core.js';
import { fakeSocketFactory, flush, msg, recordingFetch, type Responder } from './test/harness.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function build(opts: { push?: boolean; responder?: Responder; realtimeUrl?: null } = {}) {
  const rec = recordingFetch(opts.responder);
  const sock = fakeSocketFactory();
  const core = createChatlyCore({
    publicId: 'pub-1',
    apiUrl: 'https://api.test',
    fetch: rec.fetch,
    ...(opts.push === false ? {} : { socket: sock.factory }),
    pollIntervalMs: 2_000,
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

describe('Conversation', () => {
  it('loads history first, parsed and ordered oldest-first', async () => {
    const { core } = build({
      responder: (r) =>
        r.path === '/v1/widget/messages/list'
          ? { body: { messages: [msg('20'), msg('10'), { nope: true }] } }
          : undefined,
    });
    const conv = await core.openConversation('conv-1');
    const snap = conv.getSnapshot();
    expect(snap.loaded).toBe(true);
    expect(snap.messages.map((m) => m.id)).toEqual(['10', '20']);
    expect(snap.messages[0]?.conversationId).toBe('conv-1');
  });

  it('a pushed message.created appears once, however many times it is delivered', async () => {
    const { core, sock } = build();
    const conv = await core.openConversation('conv-1');
    const seen: number[] = [];
    conv.subscribe(() => seen.push(conv.getSnapshot().messages.length));
    sock.sockets[0]!.fire('event', envelope('message.created', msg('11')));
    sock.sockets[0]!.fire('event', envelope('message.created', msg('11')));
    expect(conv.getSnapshot().messages.map((m) => m.id)).toEqual(['11']);
    expect(seen).toEqual([1]);
  });

  it("ignores another conversation's events", async () => {
    const { core, sock } = build();
    const conv = await core.openConversation('conv-1');
    sock.sockets[0]!.fire('event', {
      ...envelope('message.created', msg('12')),
      payload: { ...msg('12'), conversationId: 'conv-OTHER' },
    });
    expect(conv.getSnapshot().messages).toHaveLength(0);
  });

  it('parses blocks into typed data and falls back to null for an unknown version', async () => {
    const { core, sock } = build();
    const conv = await core.openConversation('conv-1');
    const s = sock.sockets[0]!;
    s.fire(
      'event',
      envelope(
        'message.created',
        msg('13', {
          blocks: { v: 1, blocks: [{ type: 'card', title: 'T', extra: 1 }, 'junk', { nope: 1 }] },
        }),
      ),
    );
    s.fire(
      'event',
      envelope('message.created', msg('14', { blocks: { v: 99, blocks: [{ type: 'card' }] } })),
    );
    const [a, b] = conv.getSnapshot().messages;
    expect(a?.blocks).toEqual({ v: 1, blocks: [{ type: 'card', title: 'T', extra: 1 }] });
    expect(b?.blocks).toBeNull();
  });

  it('message.updated applies only the fields present; deleted tombstones in place', async () => {
    const { core, sock } = build();
    const conv = await core.openConversation('conv-1');
    const s = sock.sockets[0]!;
    s.fire('event', envelope('message.created', msg('15', { canvas: { step: 1 } })));
    s.fire('event', envelope('message.updated', { id: '15', canvas: { step: 2 } }));
    const m = conv.getSnapshot().messages[0]!;
    expect(m.canvas).toEqual({ step: 2 });
    expect(m.body).toBe('body 15');
    s.fire('event', envelope('message.deleted', { id: '15' }));
    const gone = conv.getSnapshot().messages[0]!;
    expect(gone.id).toBe('15');
    expect(gone.body).toBe('');
    expect(gone.canvas).toBeNull();
    expect(gone.deletedAt).not.toBeNull();
  });

  it("reaction_changed keeps the viewer's own reacted flag; the toggle response sets it", async () => {
    const { core, sock, rec } = build({
      responder: (r) =>
        r.path.endsWith('/reactions')
          ? { body: { messageId: '16', entries: [{ emoji: '👍', count: 2, reacted: true }] } }
          : undefined,
    });
    const conv = await core.openConversation('conv-1');
    const s = sock.sockets[0]!;
    s.fire('event', envelope('message.created', msg('16')));
    await conv.react('16', '👍');
    expect(rec.to('/v1/widget/conversations/conv-1/reactions')).toHaveLength(1);
    expect(conv.getSnapshot().messages[0]?.reactions).toEqual([
      { emoji: '👍', count: 2, reacted: true },
    ]);
    s.fire(
      'event',
      envelope('message.reaction_changed', {
        messageId: '16',
        entries: [
          { emoji: '👍', count: 3 },
          { emoji: '🎉', count: 1 },
        ],
      }),
    );
    expect(conv.getSnapshot().messages[0]?.reactions).toEqual([
      { emoji: '👍', count: 3, reacted: true },
      { emoji: '🎉', count: 1, reacted: false },
    ]);
  });

  describe('sending', () => {
    it('shows a pending row at once and replaces it with the server copy, not a duplicate', async () => {
      const { core, sock } = build();
      const conv = await core.openConversation('conv-1');
      await conv.send('hello there');
      let rows = conv.getSnapshot().messages;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pending: true, body: 'hello there', authorType: 'contact' });
      sock.sockets[0]!.fire(
        'event',
        envelope('message.created', msg('30', { authorType: 'contact', body: 'hello there' })),
      );
      rows = conv.getSnapshot().messages;
      expect(rows.map((m) => [m.id, m.pending])).toEqual([['30', false]]);
    });

    it('a failed send removes its pending row and rethrows', async () => {
      const { core } = build({
        responder: (r) => (r.path === '/v1/widget/messages' ? { status: 500 } : undefined),
      });
      const conv = await core.openConversation('conv-1');
      await expect(conv.send('x')).rejects.toMatchObject({
        code: 'request_failed',
        httpStatus: 500,
      });
      expect(conv.getSnapshot().messages).toHaveLength(0);
    });

    it('a silent postback draws no row and sends silent + payload', async () => {
      const { core, rec } = build();
      const conv = await core.openConversation('conv-1');
      await conv.postback({ body: 'chose red', payload: { colour: 'red' }, silent: true });
      expect(conv.getSnapshot().messages).toHaveLength(0);
      expect(rec.to('/v1/widget/messages')[0]?.body).toMatchObject({
        conversationId: 'conv-1',
        body: 'chose red',
        silent: true,
        payload: { colour: 'red' },
      });
    });

    it('a visible postback draws a row and sends the payload without silent', async () => {
      const { core, rec } = build();
      const conv = await core.openConversation('conv-1');
      await conv.postback({ body: 'Yes', payload: { a: 1 } });
      expect(conv.getSnapshot().messages).toHaveLength(1);
      const body = rec.to('/v1/widget/messages')[0]?.body;
      expect(body).toMatchObject({ payload: { a: 1 } });
      expect(body).not.toHaveProperty('silent');
    });

    it('with polling only, a sent message resolves on the immediate refresh', async () => {
      let sent = false;
      const { core } = build({
        push: false,
        responder: (r) => {
          if (r.path === '/v1/widget/messages') {
            sent = true;
          }
          if (r.path === '/v1/widget/messages/list' && sent) {
            return { body: { messages: [msg('31', { authorType: 'contact', body: 'yo' })] } };
          }
          return undefined;
        },
      });
      const conv = await core.openConversation('conv-1');
      await conv.send('yo');
      expect(conv.getSnapshot().messages.map((m) => [m.id, m.pending])).toEqual([['31', false]]);
    });
  });

  describe('typing', () => {
    const start = { actorType: 'agent', actorId: 'a1', displayName: 'Sarah' };

    it('shows the indicator, and the CORE clears it after the window with no stop', async () => {
      const { core, sock } = build();
      const conv = await core.openConversation('conv-1');
      sock.sockets[0]!.fire('event', envelope('typing.start', start));
      expect(conv.getSnapshot().typing).toMatchObject({ actorId: 'a1', displayName: 'Sarah' });
      vi.advanceTimersByTime(TYPING_STOP_AFTER_MS - 1);
      expect(conv.getSnapshot().typing).not.toBeNull();
      vi.advanceTimersByTime(2);
      expect(conv.getSnapshot().typing).toBeNull();
    });

    it('another start extends the window; stop and an agent message clear it', async () => {
      const { core, sock } = build();
      const conv = await core.openConversation('conv-1');
      const s = sock.sockets[0]!;
      s.fire('event', envelope('typing.start', start));
      vi.advanceTimersByTime(3_000);
      s.fire('event', envelope('typing.start', start));
      vi.advanceTimersByTime(3_000);
      expect(conv.getSnapshot().typing).not.toBeNull();
      s.fire('event', envelope('typing.stop', start));
      expect(conv.getSnapshot().typing).toBeNull();
      s.fire('event', envelope('typing.start', start));
      s.fire('event', envelope('message.created', msg('40')));
      expect(conv.getSnapshot().typing).toBeNull();
    });

    it('ignores collaborative-cursor frames published as typing, and non-agent actors', async () => {
      const { core, sock } = build();
      const conv = await core.openConversation('conv-1');
      const s = sock.sockets[0]!;
      s.fire('event', envelope('typing.start', { ...start, kind: 'viewing' }));
      s.fire('event', envelope('typing.start', { ...start, actorType: 'contact' }));
      expect(conv.getSnapshot().typing).toBeNull();
    });
  });

  describe('connection', () => {
    it('goes live on connect, reconnecting on disconnect, and RE-READS the thread on reconnect', async () => {
      const { core, sock, rec } = build();
      const conv = await core.openConversation('conv-1');
      const s = sock.sockets[0]!;
      s.fire('connect');
      expect(conv.getSnapshot().connection).toBe('live');
      expect(rec.to('/v1/widget/messages/list')).toHaveLength(1);
      s.fire('disconnect');
      expect(conv.getSnapshot().connection).toBe('reconnecting');
      s.fire('connect');
      await flush();
      expect(rec.to('/v1/widget/messages/list')).toHaveLength(2);
    });

    it('no socket factory: polls, and stops on close', async () => {
      const { core, rec } = build({ push: false });
      const conv = await core.openConversation('conv-1');
      expect(conv.getSnapshot().connection).toBe('polling');
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(rec.to('/v1/widget/messages/list')).toHaveLength(3);
      conv.close();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rec.to('/v1/widget/messages/list')).toHaveLength(3);
    });

    it('a poll interval below the floor is raised to 2s', async () => {
      const rec = recordingFetch();
      const core = createChatlyCore({
        publicId: 'p',
        apiUrl: 'https://api.test',
        fetch: rec.fetch,
        pollIntervalMs: 10,
      });
      await core.openConversation('c');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(rec.to('/v1/widget/messages/list')).toHaveLength(1);
    });

    it('push requested but init reports no realtime host: reports it and falls back to polling', async () => {
      const { core, sock } = build({
        responder: (r) =>
          r.path === '/v1/widget/init'
            ? { body: { session: { token: 't', contactId: 'c' } } }
            : undefined,
      });
      const conv = await core.openConversation('conv-1');
      expect(sock.sockets).toHaveLength(0);
      expect(conv.getSnapshot().connection).toBe('polling');
      expect(conv.getSnapshot().error).toMatchObject({ code: 'no_realtime_host' });
    });

    it('close() disconnects the socket, clears typing and refuses further verbs', async () => {
      const { core, sock } = build();
      const conv = await core.openConversation('conv-1');
      conv.close();
      expect(sock.sockets[0]?.disconnected).toBe(true);
      expect(conv.getSnapshot().connection).toBe('closed');
      await expect(conv.send('x')).rejects.toMatchObject({ code: 'closed' });
    });
  });

  describe('reads', () => {
    it('persists over REST FIRST, then emits message.read with the contact as reader', async () => {
      const { core, sock, rec } = build();
      const conv = await core.openConversation('conv-1');
      sock.sockets[0]!.fire('event', envelope('message.created', msg('50')));
      await conv.markRead();
      expect(rec.to('/v1/widget/conversations/conv-1/read')[0]?.body).toMatchObject({
        upToMessageId: '50',
      });
      const emitted = sock.sockets[0]!.emitted.find((e) => e.event === 'message.read');
      expect(emitted?.payload).toMatchObject({
        conversationId: 'conv-1',
        upToMessageId: '50',
        readerType: 'contact',
        readerId: 'contact-1',
      });
    });

    it('does not re-send the same read, and sends nothing when there is nothing from others', async () => {
      const { core, sock, rec } = build();
      const conv = await core.openConversation('conv-1');
      await conv.markRead();
      expect(rec.to('/v1/widget/conversations/conv-1/read')).toHaveLength(0);
      sock.sockets[0]!.fire('event', envelope('message.created', msg('51')));
      await conv.markRead();
      await conv.markRead();
      expect(rec.to('/v1/widget/conversations/conv-1/read')).toHaveLength(1);
    });

    it('tracks the agent read pointer', async () => {
      const { core, sock } = build();
      const conv = await core.openConversation('conv-1');
      sock.sockets[0]!.fire(
        'event',
        envelope('message.read', { readerType: 'agent', upToMessageId: 'm7' }),
      );
      expect(conv.getSnapshot().agentReadUpTo).toBe('m7');
      sock.sockets[0]!.fire('event', envelope('message.read', { readerType: 'agent' }));
      expect(conv.getSnapshot().agentReadUpTo).toBe('*');
    });
  });

  describe('the core', () => {
    it('shares one conversation per id and closes it only when the last holder releases', async () => {
      const { core, sock } = build();
      const a = await core.openConversation('conv-1');
      const b = await core.openConversation('conv-1');
      expect(a).toBe(b);
      expect(sock.sockets).toHaveLength(1);
      core.releaseConversation('conv-1');
      expect(a.getSnapshot().connection).not.toBe('closed');
      core.releaseConversation('conv-1');
      expect(a.getSnapshot().connection).toBe('closed');
      expect(sock.sockets[0]?.disconnected).toBe(true);
    });

    it('startConversation creates, then opens the new thread live', async () => {
      const { core, rec, sock } = build();
      const conv = await core.startConversation('first words');
      expect(conv.conversationId).toBe('conv-1');
      expect(rec.to('/v1/widget/conversations')[0]?.body).toMatchObject({ body: 'first words' });
      expect(sock.sockets).toHaveLength(1);
    });

    it('unreadCount sums the per-thread counts', async () => {
      const { core } = build({
        responder: (r) =>
          r.path === '/v1/widget/conversations/list'
            ? {
                body: {
                  conversations: [
                    { id: 'a', unreadContactCount: 2 },
                    { id: 'b' },
                    { id: 'c', unreadContactCount: 3 },
                  ],
                },
              }
            : undefined,
      });
      expect(await core.unreadCount()).toBe(5);
    });

    it('a throwing subscriber does not stop the others hearing the change', async () => {
      const { core, sock } = build();
      const conv = await core.openConversation('conv-1');
      const heard: number[] = [];
      conv.subscribe(() => {
        throw new Error('consumer bug');
      });
      conv.subscribe(() => heard.push(1));
      sock.sockets[0]!.fire('event', envelope('message.created', msg('60')));
      expect(heard).toEqual([1]);
    });

    it('the snapshot is identity-stable until something changes', async () => {
      const { core } = build({ push: false });
      const conv = await core.openConversation('conv-1');
      const a = conv.getSnapshot();
      expect(conv.getSnapshot()).toBe(a);
      await vi.advanceTimersByTimeAsync(2_000);
      // A poll that told us nothing new still sets error: null / loaded, so
      // identity may change; what must hold is that the messages array does not.
      expect(conv.getSnapshot().messages).toBe(a.messages);
    });
  });
});
