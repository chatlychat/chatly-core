import { readBlockEnvelope } from './blocks.js';
import { Conversation } from './conversation.js';
import { defaultRandomId } from './ids.js';
import { VisitorSession, type SessionOptions } from './session.js';
import {
  VisitorApi,
  type ContextInput,
  type ContextResult,
  type ProfileView,
  type StartOptions,
} from './visitor-api.js';

import type { HostSurface, SurfaceResult } from './host-surface.js';
import type { BlocksReader } from './message.js';
import type {
  BlockEnvelope,
  ConversationSummary,
  IdentifyResult,
  SocketFactory,
  VisitorIdentity,
} from './types.js';
import type { WorldTheme } from './world-theme.js';

export interface ChatlyCoreOptions extends SessionOptions {
  /**
   * `socket.io-client`'s `io`, or any `SocketFactory`. OMIT for polling. The
   * core never imports a socket library: see `realtime.ts` for the argument.
   */
  readonly socket?: SocketFactory;
  /** Poll interval when there is no socket. Floored at 2s. */
  readonly pollIntervalMs?: number;
  /**
   * Parse `blocks`. Defaults to the envelope-level reader in `blocks.ts`;
   * pass `@livechat/shared`'s `readBlocksEnvelope` for per-block typing.
   */
  readonly readBlocks?: (raw: unknown) => BlockEnvelope | null;
  /** Clock, in epoch ms. Defaults to `Date.now`; injectable for token-expiry tests and engines with their own time. */
  readonly now?: () => number;
}

/**
 * The headless conversation core.
 *
 * Construction touches nothing: no storage read of a global, no fetch, no
 * timer, no socket. The first network call is the first method you await.
 */
export class ChatlyCore {
  public readonly session: VisitorSession;
  public readonly api: VisitorApi;
  private readonly socket: SocketFactory | undefined;
  private readonly pollIntervalMs: number | undefined;
  private readonly readBlocks: BlocksReader;
  private readonly randomId: () => string;
  private readonly now: (() => number) | undefined;
  private readonly open = new Map<string, { conv: Conversation; refs: number }>();

  public constructor(opts: ChatlyCoreOptions) {
    this.randomId = opts.randomId ?? defaultRandomId;
    this.session = new VisitorSession({ ...opts, randomId: this.randomId });
    this.api = new VisitorApi(this.session);
    this.socket = opts.socket;
    this.now = opts.now;
    this.pollIntervalMs = opts.pollIntervalMs;
    this.readBlocks = opts.readBlocks ?? readBlockEnvelope;
  }

  /** Bootstrap the visitor. Optional: every other method does it on first use. */
  public init(identity?: VisitorIdentity): Promise<IdentifyResult> {
    return this.session.init(identity);
  }

  /**
   * Attach a known identity (re-inits; there is no identify route). The
   * verdict is the server's, exactly as for the web widget: check
   * `identityVerified` before relying on it.
   */
  public identify(identity: VisitorIdentity): Promise<IdentifyResult> {
    return this.session.init(identity);
  }

  /** Listen for the result of every init/identify. Returns an unsubscribe. */
  public on(event: 'identified', handler: (r: IdentifyResult) => void): () => void {
    return this.session.onIdentified(handler);
  }

  /**
   * Forget the visitor: closes open conversations, drops the session token,
   * contact and remembered identity, and clears the stored token. The next
   * call mints a fresh anonymous visitor. Does not touch the server.
   */
  public reset(): void {
    this.close();
    this.session.reset();
  }

  /** `POST /v1/widget/context`: the page/world's audience claim and signed `contextToken`. */
  public setContext(input: ContextInput): Promise<ContextResult> {
    return this.api.setContext(input);
  }

  /** The audience profile this visitor matches: starter prompts, quick links, copy. */
  public profile(opts: { locale?: string } = {}): Promise<ProfileView> {
    return this.api.profile(opts.locale);
  }

  public listConversations(limit?: number): Promise<ConversationSummary[]> {
    return this.api.listConversations(limit);
  }

  public async unreadCount(): Promise<number> {
    const all = await this.api.listConversations();
    return all.reduce((n, c) => n + (c.unreadContactCount ?? 0), 0);
  }

  /**
   * Tell the core whether the visitor agreed to analytics. Gates only the
   * telemetry the core itself originates (`reportCardView` / `reportCardAction`);
   * `track` is the host's own call and is not gated. Default: not granted.
   */
  public setAnalyticsConsent(granted: boolean): void {
    this.session.setAnalytics(granted);
  }

  public track(name: string, properties?: Record<string, unknown>): Promise<void> {
    return this.api.track(name, properties);
  }

  /**
   * Tell the bot what kind of place this is and what it can do (ADR 0063).
   * Fired capabilities arrive on `conversation.onCapability`.
   */
  public setSurface(surface: HostSurface): Promise<SurfaceResult> {
    return this.api.setSurface(surface);
  }

  /** The channel's `worldTheme` after `init`, or null. Feed it to `resolveWorldTheme`. */
  public get worldTheme(): WorldTheme | null {
    return this.session.worldTheme;
  }

  /**
   * A live controller for an existing conversation. One per id: asking twice
   * returns the same object, so two components cannot open two sockets for
   * one thread. Resolves once history is loaded.
   *
   * Reference-counted: each call must be matched by `releaseConversation`
   * (the React hook does this), and the conversation closes when the last
   * holder lets go. `conversation.close()` closes it for everyone at once.
   */
  public async openConversation(conversationId: string): Promise<Conversation> {
    let entry = this.open.get(conversationId);
    if (entry === undefined) {
      const conv = new Conversation({
        conversationId,
        session: this.session,
        api: this.api,
        readBlocks: this.readBlocks,
        randomId: this.randomId,
        ...(this.socket === undefined ? {} : { socket: this.socket }),
        ...(this.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.pollIntervalMs }),
        ...(this.now === undefined ? {} : { now: this.now }),
      });
      entry = { conv, refs: 0 };
      this.open.set(conversationId, entry);
      const unsubscribe = conv.subscribe(() => {
        if (conv.getSnapshot().connection === 'closed') {
          if (this.open.get(conversationId)?.conv === conv) {
            this.open.delete(conversationId);
          }
          unsubscribe();
        }
      });
    }
    entry.refs += 1;
    await entry.conv.start();
    return entry.conv;
  }

  /** Let go of one `openConversation`. Closes the conversation at zero holders. */
  public releaseConversation(conversationId: string): void {
    const entry = this.open.get(conversationId);
    if (entry === undefined) {
      return;
    }
    entry.refs -= 1;
    if (entry.refs <= 0) {
      this.open.delete(conversationId);
      entry.conv.close();
    }
  }

  /** Create a conversation with a first message and return it live. */
  public async startConversation(body: string, opts: StartOptions = {}): Promise<Conversation> {
    const { conversationId } = await this.api.start(body, opts);
    return this.openConversation(conversationId);
  }

  /** Close every open conversation and forget nothing else. */
  public close(): void {
    for (const { conv } of [...this.open.values()]) {
      conv.close();
    }
    this.open.clear();
  }
}

export function createChatlyCore(opts: ChatlyCoreOptions): ChatlyCore {
  return new ChatlyCore(opts);
}
