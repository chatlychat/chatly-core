// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChatlyCore } from '../core.js';
import { useConversation, useMessages, useTyping } from './index.js';
import { fakeSocketFactory, msg, recordingFetch } from '../test/harness.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function setup() {
  const rec = recordingFetch();
  const sock = fakeSocketFactory();
  const core = createChatlyCore({
    publicId: 'pub-1',
    apiUrl: 'https://api.test',
    fetch: rec.fetch,
    socket: sock.factory,
  });
  return { rec, sock, core };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) {
      await Promise.resolve();
    }
  });
};

const envelope = (type: string, payload: Record<string, unknown>) => ({
  type,
  payload: { conversationId: 'conv-1', ...payload },
});

describe('React hooks', () => {
  it('useConversation attaches, re-renders on pushed messages, and releases on unmount', async () => {
    const { core, sock } = setup();
    const renders: string[][] = [];
    function Probe(): ReactElement {
      const { conversation } = useConversation(core, 'conv-1');
      const messages = useMessages(conversation);
      renders.push(messages.map((m) => m.id));
      const typing = useTyping(conversation);
      return createElement('p', null, `${messages.length}:${typing?.displayName ?? '-'}`);
    }
    act(() => root.render(createElement(Probe)));
    await settle();
    expect(host.textContent).toBe('0:-');
    expect(sock.sockets).toHaveLength(1);

    await act(async () => {
      sock.sockets[0]!.fire('event', envelope('message.created', msg('11')));
      sock.sockets[0]!.fire(
        'event',
        envelope('typing.start', { actorType: 'agent', actorId: 'a', displayName: 'Sarah' }),
      );
    });
    expect(host.textContent).toBe('1:Sarah');

    act(() => root.unmount());
    expect(sock.sockets[0]?.disconnected).toBe(true);
    root = createRoot(host);
  });

  it('two components on one conversation share one socket; the last unmount closes it', async () => {
    const { core, sock } = setup();
    function A(): ReactElement {
      const { snapshot } = useConversation(core, 'conv-1');
      return createElement('i', null, snapshot.messages.length);
    }
    function Pair({ both }: { both: boolean }): ReactElement {
      return createElement('div', null, createElement(A), both ? createElement(A) : null);
    }
    act(() => root.render(createElement(Pair, { both: true })));
    await settle();
    expect(sock.sockets).toHaveLength(1);
    act(() => root.render(createElement(Pair, { both: false })));
    await settle();
    expect(sock.sockets[0]?.disconnected).toBe(false);
    act(() => root.render(createElement('div')));
    await settle();
    expect(sock.sockets[0]?.disconnected).toBe(true);
  });

  it('a null id attaches nothing, and an id change switches conversations (old socket closed)', async () => {
    const { core, sock } = setup();
    function P({ id }: { id: string | null }): ReactElement {
      const { conversation } = useConversation(core, id);
      return createElement('b', null, conversation?.conversationId ?? 'none');
    }
    act(() => root.render(createElement(P, { id: null })));
    await settle();
    expect(host.textContent).toBe('none');
    expect(sock.sockets).toHaveLength(0);
    act(() => root.render(createElement(P, { id: 'conv-1' })));
    await settle();
    expect(host.textContent).toBe('conv-1');
    act(() => root.render(createElement(P, { id: 'conv-2' })));
    await settle();
    expect(host.textContent).toBe('conv-2');
    expect(sock.sockets).toHaveLength(2);
    expect(sock.sockets[0]?.disconnected).toBe(true);
    expect(sock.sockets[1]?.disconnected).toBe(false);
  });

  it('server render opens nothing: no fetch, no socket', () => {
    const { core, rec, sock } = setup();
    function P(): ReactElement {
      const { snapshot } = useConversation(core, 'conv-1');
      return createElement('s', null, snapshot.connection);
    }
    expect(renderToString(createElement(P))).toContain('idle');
    expect(rec.calls).toHaveLength(0);
    expect(sock.sockets).toHaveLength(0);
  });
});
