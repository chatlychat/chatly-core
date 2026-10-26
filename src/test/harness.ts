import type {
  FetchLike,
  FetchResponseLike,
  SocketFactory,
  SocketLike,
  SocketOptions,
} from '../types.js';

export interface Recorded {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  /** The body AS SENT, parsed back from the string the core handed to fetch. */
  readonly body: Record<string, unknown> | undefined;
  readonly rawBody: unknown;
}

export type Responder = (req: Recorded) => { status?: number; body?: unknown } | undefined;

const API = 'https://api.test';

/**
 * A fetch that RECORDS what it was asked to send. The tests assert on the
 * recording; the canned answers only keep the flow moving. A fake that
 * echoes whatever the SDK asked for agrees with any bug.
 */
export function recordingFetch(responder: Responder = () => undefined): {
  fetch: FetchLike;
  calls: Recorded[];
  to: (path: string) => Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const rawBody = init.body;
    let body: Record<string, unknown> | undefined;
    if (typeof rawBody === 'string' && init.headers['content-type'] === 'application/json') {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    }
    const rec: Recorded = {
      url,
      path: url.startsWith(API) ? url.slice(API.length) : url,
      method: init.method,
      headers: init.headers,
      body,
      rawBody,
    };
    calls.push(rec);
    const answer = responder(rec) ?? defaultAnswer(rec.path);
    const status = answer.status ?? 200;
    const res: FetchResponseLike = {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(answer.body ?? {}),
    };
    return Promise.resolve(res);
  };
  return { fetch: fetchImpl, calls, to: (path) => calls.filter((c) => c.path === path) };
}

/** Just enough of the server's shape to keep a flow going. */
function defaultAnswer(path: string): { status?: number; body?: unknown } {
  switch (path) {
    case '/v1/widget/init':
      return {
        body: {
          session: { token: 'session-token-1', contactId: 'contact-1' },
          realtimeUrl: 'wss://rt.test',
        },
      };
    case '/v1/widget/realtime/token':
      return { body: { token: 'rt-token-1-abcdefgh', expiresAt: '2099-01-01T00:00:00.000Z' } };
    case '/v1/widget/messages/list':
      return { body: { messages: [] } };
    case '/v1/widget/conversations/list':
      return { body: { conversations: [] } };
    case '/v1/widget/conversations':
      return { body: { conversation: { id: 'conv-1' } } };
    default:
      return { body: {} };
  }
}

export { API };

export interface FakeSocket extends SocketLike {
  readonly handlers: Map<string, Array<(payload: unknown) => void>>;
  readonly emitted: Array<{ event: string; payload: unknown }>;
  disconnected: boolean;
  /** Drive a server event / lifecycle event into the core. */
  fire(event: string, payload?: unknown): void;
}

export function fakeSocketFactory(): {
  factory: SocketFactory;
  sockets: FakeSocket[];
  options: SocketOptions[];
  urls: string[];
} {
  const sockets: FakeSocket[] = [];
  const options: SocketOptions[] = [];
  const urls: string[] = [];
  const factory: SocketFactory = (url, opts) => {
    urls.push(url);
    options.push(opts);
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const socket: FakeSocket = {
      handlers,
      emitted: [],
      disconnected: false,
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      emit(event, payload) {
        socket.emitted.push({ event, payload });
      },
      disconnect() {
        socket.disconnected = true;
      },
      fire(event, payload) {
        for (const h of handlers.get(event) ?? []) {
          h(payload);
        }
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets, options, urls };
}

/** Run socket.io's per-attempt `auth` callback once, as the client does on each attempt. */
export function runAuth(opts: SocketOptions): Promise<{ token: string; kind: 'visitor' }> {
  return new Promise((resolve) => {
    opts.auth((data) => resolve(data));
  });
}

export const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
};

export function msg(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    body: `body ${id}`,
    authorType: 'agent',
    createdAt: `2026-10-23T10:00:${id.padStart(2, '0').slice(-2)}.000Z`,
    ...extra,
  };
}
