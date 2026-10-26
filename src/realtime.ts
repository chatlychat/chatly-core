import { ChatlyError } from './errors.js';

import type { SocketFactory, SocketLike } from './types.js';

/** Refresh a token this long before it expires, so a reconnect never carries a stale one. */
const EXPIRY_SKEW_MS = 60_000;
/** When the mint reports no `expiresAt`: the server's TTL is 1h; assume less. */
const ASSUMED_TTL_MS = 50 * 60_000;

export interface RealtimeConnectOptions {
  readonly factory: SocketFactory;
  readonly url: string;
  /** `POST /v1/widget/realtime/token` for ONE conversation. Never `session.token`. */
  readonly mintToken: () => Promise<{ token: string; expiresAt: string | null }>;
  readonly onEnvelope: (raw: unknown) => void;
  readonly onConnect?: () => void;
  readonly onDisconnect?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
}

export interface RealtimeHandle {
  emit(event: string, payload: unknown): void;
  disconnect(): void;
}

/**
 * Open the visitor socket for one conversation.
 *
 * ── Why the transport is INJECTED and not imported ───────────────────────
 *
 * The decision: realtime is in the core as a PROTOCOL (this file — the
 * handshake, the credential lifecycle, the envelope) and NOT as a
 * DEPENDENCY. `socket.io-client` is not imported anywhere in this package;
 * the host passes `io` (or any `SocketFactory`) and omits it to get polling.
 *
 * The byte argument. `socket.io-client` is ~12.9KB gzipped. The widget pays
 * for it exactly once, in `widget-engine.js`, which is fetched the first time
 * a visitor starts a conversation — that deferral is why first paint
 * (`widget.js`) is under its 44,000-byte ceiling at all (43,200 when this
 * was written; read `node scripts/check-bundle-size.mjs`, not this
 * sentence). If this package imported it, then whichever way the widget
 * later consumed the core — statically, which would put 12.9KB into first
 * paint on every page view of every customer site, or dynamically, which
 * would need a second copy of the client in the engine chunk — either the
 * deferral or the dependency count would regress. An injected factory makes
 * the widget's existing engine loader the ONLY place the client is ever
 * fetched: `engine-loader.ts` already hands the widget an `io` of nearly
 * this shape (`IoFactory`), which is what would be passed in.
 *
 * The other consumers argue the same way: a React Native app already has
 * its own socket.io-client pinned to its own React Native-compatible
 * version, a Node worker may want `ws`, a game engine has its own
 * networking, and a consumer that wants polling must not ship any of them.
 * CLAUDE.md §2 forbids a dependency nobody approved; an injected interface
 * needs none, and the zero-dependency claim on the package stays true.
 *
 * ── The credential, and `auth` as a CALLBACK ─────────────────────────────
 *
 * The gateway's `handshakeAuthSchema` makes `kind` optional and DEFAULTS IT
 * TO AGENT. A handshake without `kind: 'visitor'` is verified as an RS256
 * agent token, a visitor's HS256 token fails that, and the answer is a bare
 * `Unauthorized` that names neither credential. Every handshake here carries
 * `kind: 'visitor'`.
 *
 * The token is minted per conversation (1h TTL) and `auth` is a function,
 * not an object. socket.io evaluates a function on every connection
 * ATTEMPT; an object is captured once and replayed verbatim on every
 * reconnect, so a visitor whose socket dropped after the token's lifetime
 * would reconnect with an expired credential and be refused silently for the
 * rest of the session. The widget's callback re-reads a field; this one goes
 * further and RE-MINTS when the held token is within a minute of expiry
 * (socket.io's `cb` may be called asynchronously), so a long-lived 3D scene
 * that never reloads keeps working past the first hour.
 *
 * The callback ALWAYS calls `cb`. An attempt whose mint fails reports the
 * error and offers the stale token (or an empty one) so the server refuses
 * it and socket.io's own backoff schedules the next attempt — never a
 * callback that is silently not called, which stalls the attempt forever.
 */
export function connectRealtime(opts: RealtimeConnectOptions): RealtimeHandle {
  const now = opts.now ?? ((): number => Date.now());
  let held: { token: string; expiresAtMs: number } | null = null;
  let minting: Promise<string> | null = null;
  let closed = false;

  const freshToken = (): Promise<string> => {
    if (held !== null && held.expiresAtMs - EXPIRY_SKEW_MS > now()) {
      return Promise.resolve(held.token);
    }
    minting ??= opts
      .mintToken()
      .then((minted) => {
        const parsed = minted.expiresAt === null ? Number.NaN : Date.parse(minted.expiresAt);
        held = {
          token: minted.token,
          expiresAtMs: Number.isFinite(parsed) ? parsed : now() + ASSUMED_TTL_MS,
        };
        return minted.token;
      })
      .finally(() => {
        minting = null;
      });
    return minting;
  };

  let socket: SocketLike;
  try {
    socket = opts.factory(opts.url, {
      path: '/socket.io',
      transports: ['websocket'],
      auth: (cb) => {
        freshToken().then(
          (token) => cb({ token, kind: 'visitor' }),
          (err: unknown) => {
            opts.onError?.(err);
            cb({ token: held?.token ?? '', kind: 'visitor' });
          },
        );
      },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
      timeout: 10_000,
    });
  } catch (cause) {
    throw new ChatlyError('no_socket', 'chatly: the socket factory threw', { cause });
  }
  socket.on('connect', () => opts.onConnect?.());
  socket.on('disconnect', () => opts.onDisconnect?.());
  socket.on('connect_error', (err) => opts.onError?.(err));
  socket.on('event', (raw) => opts.onEnvelope(raw));

  return {
    emit(event, payload): void {
      if (!closed) {
        socket.emit(event, payload);
      }
    },
    disconnect(): void {
      closed = true;
      socket.disconnect();
    },
  };
}
