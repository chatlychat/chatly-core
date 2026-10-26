/**
 * The seams. Everything the core needs from its host is declared here as a
 * structural type, so the core imports nothing and a host satisfies them with
 * whatever it has.
 *
 * Nothing in this package names a browser. A 3D world, a game engine, a
 * headset runtime, a Node worker and a web page all provide the same four
 * things: a `fetch`, somewhere to remember a token (optional), a socket
 * factory (optional) and a source of random ids (defaulted).
 */

/* ───────────────────────────── fetch ───────────────────────────── */

/** The slice of a fetch `Response` the core reads. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/**
 * The slice of `fetch` the core calls.
 *
 * `body` is `unknown` because the core hands the host's own `fetch` either a
 * JSON string (every API call) or the caller's opaque upload bytes (the
 * presigned PUT) untouched. Typing it as `BodyInit` would import a DOM type.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: unknown },
) => Promise<FetchResponseLike>;

/* ──────────────────────────── storage ──────────────────────────── */

/** `localStorage`-shaped, synchronous. Anything with these three methods. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * What a host passes as `storage`.
 *
 * Either the store itself or a THUNK returning it. The thunk is the point:
 * `window.localStorage` is a getter that throws on an opaque origin or with
 * site data blocked, so `storage: window.localStorage` throws in the HOST's
 * code before the core can protect anything. `storage: () => localStorage`
 * moves that read inside the core's try/catch. See `storage.ts`.
 */
export type StorageSource = KeyValueStorage | (() => KeyValueStorage | null | undefined);

/* ──────────────────────────── realtime ─────────────────────────── */

/**
 * The slice of a socket.io-client `Socket` the core uses.
 *
 * `off` is optional because the core never needs it: it disconnects the
 * whole socket on teardown.
 */
export interface SocketLike {
  on(event: string, handler: (payload: unknown) => void): unknown;
  emit(event: string, payload: unknown): unknown;
  disconnect(): unknown;
}

/**
 * The options the core hands the factory. This is socket.io-client's own
 * option shape, restricted to the keys the core sets, with `auth` as the
 * CALLBACK form — see `realtime.ts` for why it is never a plain object.
 */
export interface SocketOptions {
  readonly path: '/socket.io';
  readonly transports: ['websocket'];
  readonly auth: (cb: (data: { token: string; kind: 'visitor' }) => void) => void;
  readonly reconnection: true;
  readonly reconnectionDelay: number;
  readonly reconnectionDelayMax: number;
  readonly timeout: number;
}

/** `socket.io-client`'s `io`, or anything shaped like it. */
export type SocketFactory = (url: string, options: SocketOptions) => SocketLike;

/* ─────────────────────────── wire shapes ───────────────────────── */

export interface VisitorIdentity {
  externalId?: string;
  email?: string;
  phone?: string;
  name?: string;
  /** `HMAC-SHA256(<channel IDV secret>, externalId)`, computed by YOUR server. */
  userHash?: string;
  /**
   * OIDC / Atlas channels: the token your identity provider minted (wire key
   * `identity.userToken`). Its `sub` becomes the externalId. Short-lived, so
   * pass a fresh one per `identify`.
   */
  userToken?: string;
  /** IDV v2: a whole-identity JWT your SERVER signs with the channel secret (wire key `identity.identityToken`). */
  identityToken?: string;
  attributes?: Record<string, unknown>;
}

/** What `init` / `identify` resolve to. `identityVerified` is the SERVER's verdict. */
export interface IdentifyResult {
  /** Null until the visitor has a contact (an identified visitor always does). */
  contactId: string | null;
  identityVerified: boolean;
  /** The proven or claimed external id; null for an anonymous visitor. */
  externalId: string | null;
}

export interface MessageAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly url: string;
}

/** One block: a discriminator and whatever else the renderer understands. */
export type Block = { readonly type: string } & { readonly [key: string]: unknown };

/** A parsed rich-block envelope. */
export interface BlockEnvelope {
  readonly v: number;
  readonly blocks: readonly Block[];
}

export interface ReactionEntry {
  readonly emoji: string;
  readonly count: number;
  readonly reacted: boolean;
}

/**
 * One message, as the core hands it to a renderer.
 *
 * The union of the list projection and the push payload, with the fields that
 * only one of them carries optional — the same rule `@chatlychat/sdk-js`
 * documents on its `HeadlessMessage`. Differences from that type: `blocks` is
 * PARSED (`BlockEnvelope | null`, never `unknown`), and `reactions` is always
 * an array, so a renderer has one shape to draw.
 */
export interface ConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly body: string;
  readonly authorType: 'contact' | 'agent' | 'bot' | 'system';
  readonly createdAt: string;
  readonly kind: 'text' | 'rich' | 'attachment_only' | 'system_event';
  readonly bodyHtml: string | null;
  /** Parsed. `null` when absent, from an unknown protocol version, or empty. */
  readonly blocks: BlockEnvelope | null;
  /** A Tier 2/3 interactive step, opaque here: render it or ignore it. */
  readonly canvas: unknown;
  readonly attachments: readonly MessageAttachment[];
  readonly authorId: string | null;
  readonly streamState: 'streaming' | 'complete' | null;
  readonly hiddenFromContact: boolean;
  readonly replyToMessageId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Set on a deleted message; its body, blocks and canvas are emptied. */
  readonly deletedAt: string | null;
  readonly reactions: readonly ReactionEntry[];
  /**
   * `true` for an optimistic row the core inserted before the server had the
   * message. Replaced, not duplicated, when the server's copy arrives.
   */
  readonly pending: boolean;
}

export interface ConversationSummary {
  readonly id: string;
  readonly status?: string;
  readonly lastMessageAt?: string;
  readonly subject?: string | null;
  readonly lastMessagePreview?: string | null;
  readonly createdAt?: string;
  readonly unreadContactCount?: number;
}

export interface TypingState {
  readonly actorType: 'agent' | 'bot';
  readonly actorId: string;
  readonly displayName: string | null;
  readonly label: string | null;
}
