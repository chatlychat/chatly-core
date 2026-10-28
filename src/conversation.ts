import { CardReporter, readNotice, type ConversationNotice } from './card-telemetry.js';
import { ChatlyError } from './errors.js';
import { fanOut, routeInvocation } from './fan-out.js';
import { readHostInvocation, type HostCapabilityInvocation } from './host-surface.js';
import {
  foldDeleted,
  foldReactionEvent,
  readTyping,
  foldReactions,
  foldUpdated,
  mergeMessages,
  parseMessage,
} from './message.js';
import { assertCardInMessage, pressMessage, type PressHooks } from './press.js';
import { connectRealtime, type RealtimeHandle } from './realtime.js';

import type { ConversationSnapshot, ConversationDeps } from './conversation-types.js';
import type { ConversationMessage, MessageAttachment, SocketFactory } from './types.js';
import type { PostbackInput, ReactionSummary, StepResult, VisitorApi } from './visitor-api.js';

/** The widget's own typing window (`use-conversation-realtime.tsx`), so a custom UI behaves like it. */
export const TYPING_STOP_AFTER_MS = 3_500;
const MIN_POLL_MS = 2_000;
const DEFAULT_POLL_MS = 6_000;

export type {
  ConnectionState,
  ConversationSnapshot,
  ConversationDeps,
} from './conversation-types.js';

type Listener = () => void;

/**
 * One conversation: its messages, its typing indicator, its connection, and
 * the verbs a visitor has on it.
 *
 * ── The state machine a renderer must not have to write ──────────────────
 *
 *  - History is read first (`loaded`), then the live channel opens.
 *  - **Push when a socket factory was supplied, polling otherwise**, and
 *    polling is also the fallback when push cannot be set up (no realtime
 *    host, the mint failed) -- the same choice the widget makes when its
 *    engine chunk is blocked: a slower thread rather than a dead one.
 *  - A reconnect re-reads the thread, because events published while the
 *    socket was down are not replayed to a visitor.
 *  - A sent message appears at once as a `pending` row and is replaced, not
 *    duplicated, by the server's copy. A failed send removes it and throws.
 *
 * The object is a plain external store (`subscribe` / `getSnapshot`), which
 * is what a React hook, a Unity/Unreal binding or a game loop each want and
 * what none of them has to adapt.
 */
export class Conversation {
  public readonly conversationId: string;
  private readonly d: ConversationDeps;
  private readonly now: () => number;
  private readonly listeners = new Set<Listener>();
  private readonly invoked = new Set<(inv: HostCapabilityInvocation) => void>();
  private unpromptedOk = true;
  private readonly noticed = new Set<(n: ConversationNotice) => void>();
  private readonly cardReports: CardReporter;
  private pressHooks: PressHooks = {};
  private state: ConversationSnapshot;
  private realtime: RealtimeHandle | null = null;
  private pollTimer: unknown = null;
  private typingTimer: unknown = null;
  private lastReadEmitted: string | null = null;
  private everConnected = false;
  private closed = false;
  private started: Promise<void> | null = null;

  public constructor(deps: ConversationDeps) {
    this.d = deps;
    this.cardReports = new CardReporter(
      deps.conversationId,
      deps.api,
      deps.session,
      () => this.state.messages,
    );
    this.conversationId = deps.conversationId;
    this.now = deps.now ?? ((): number => Date.now());
    this.state = {
      conversationId: deps.conversationId,
      messages: [],
      typing: null,
      connection: 'idle',
      loaded: false,
      error: null,
      agentReadUpTo: null,
    };
  }

  /* ───────────────────────── external store ───────────────────────── */

  public getSnapshot = (): ConversationSnapshot => this.state;

  public subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * A bot asking this host to act without a press (ADR 0063). An event, not
   * snapshot state: it happens once, and a snapshot would replay it to every
   * late subscriber. Answer with `reportAction({ messageId, actionId:
   * invocationId, status })`; refuse with `status: 'failed', data: { refused:
   * true }`. Realtime only — a polling-only conversation never receives one.
   */
  /**
   * Whether a bot-fired capability may act on this host. Read by
   * `CapabilityRegistry.bind` in `@chatlychat/world` as a second wall.
   */
  public get acceptsUnprompted(): boolean {
    return this.unpromptedOk;
  }

  /**
   * The space's operator switch (migration 0675), applied: `false` means no
   * bot-fired capability is handed to any handler, so a world never renders
   * one. The SERVER already refuses to create one in a space that turned it
   * off; this is for the invocation already in flight when the operator
   * flipped it, and for a host that is wrong about which space it is in.
   * `applySpacePolicy` in `spaces.ts` is the normal caller.
   */
  public setUnpromptedAllowed = (allowed: boolean): void => {
    this.unpromptedOk = allowed;
  };

  /** An ephemeral toast answering a silent postback (ADR 0082). Not a message; live socket only. */
  public onNotice = (handler: (n: ConversationNotice) => void): (() => void) => {
    this.noticed.add(handler);
    return () => {
      this.noticed.delete(handler);
    };
  };

  public onCapability = (handler: (inv: HostCapabilityInvocation) => void): (() => void) => {
    this.invoked.add(handler);
    return () => {
      this.invoked.delete(handler);
    };
  };

  private set(patch: Partial<ConversationSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // One consumer's bug must not stop the others hearing the change.
      }
    }
  }

  /* ───────────────────────────── lifecycle ────────────────────────── */

  /** Read history, then go live. Idempotent; resolves when history is loaded. */
  public start(): Promise<void> {
    this.started ??= this.boot();
    return this.started;
  }

  private async boot(): Promise<void> {
    this.set({ connection: 'connecting' });
    try {
      await this.refresh(true);
    } catch (err: unknown) {
      this.set({ error: err });
    }
    if (this.closed) {
      return;
    }
    if (this.d.socket === undefined) {
      this.startPolling();
      return;
    }
    try {
      await this.goLive(this.d.socket);
    } catch (err: unknown) {
      this.set({ error: err });
      this.startPolling();
    }
  }

  private async goLive(factory: SocketFactory): Promise<void> {
    await this.d.session.ensure();
    const url = this.d.session.realtimeUrl;
    if (url === null) {
      throw new ChatlyError(
        'no_realtime_host',
        'chatly: no realtime host — init reported none; set `realtimeUrl` in createChatlyCore()',
      );
    }
    if (this.closed) {
      return;
    }
    this.realtime = connectRealtime({
      factory,
      url,
      mintToken: () => this.d.api.realtimeToken(this.conversationId),
      onEnvelope: (raw) => this.onEnvelope(raw),
      onConnect: () => {
        this.stopPolling();
        const reconnect = this.everConnected;
        this.everConnected = true;
        this.set({ connection: 'live', error: null });
        if (reconnect) {
          void this.refresh(false).catch((err: unknown) => this.set({ error: err }));
        }
      },
      onDisconnect: () => {
        if (!this.closed) {
          this.set({ connection: 'reconnecting' });
        }
      },
      onError: (err) => this.set({ error: err }),
      ...(this.d.now === undefined ? {} : { now: this.d.now }),
    });
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopPolling();
    this.clearTypingTimer();
    this.realtime?.disconnect();
    this.realtime = null;
    this.set({ connection: 'closed', typing: null });
    this.listeners.clear();
    this.invoked.clear();
    this.noticed.clear();
  }

  /* ─────────────────────────────── reading ────────────────────────── */

  /** Re-read the thread. `authoritative` rows replace what the store holds. */
  public async refresh(authoritative = true): Promise<void> {
    const rows = await this.d.api.listMessages(this.conversationId);
    if (this.closed) {
      return;
    }
    const parsed: ConversationMessage[] = [];
    for (const raw of rows) {
      const m = parseMessage(raw, this.conversationId, this.d.readBlocks);
      if (m !== null) {
        parsed.push(m);
      }
    }
    this.set({
      messages: mergeMessages(this.state.messages, parsed, authoritative),
      loaded: true,
      error: null,
    });
  }

  private startPolling(): void {
    if (this.closed || this.pollTimer !== null) {
      return;
    }
    const interval = Math.max(MIN_POLL_MS, this.d.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.set({ connection: 'polling' });
    this.pollTimer = setInterval(() => {
      this.refresh(true).catch((err: unknown) => this.set({ error: err }));
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /* ─────────────────────────── incoming events ────────────────────── */

  private onEnvelope(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const env = raw as { type?: unknown; payload?: unknown };
    const payload = env.payload;
    if (typeof payload !== 'object' || payload === null) {
      return;
    }
    const p = payload as Record<string, unknown>;
    // A socket is conversation-scoped by its token, but the check costs one
    // comparison and a switch that reused a socket would otherwise deliver
    // the old thread's events here.
    if (typeof p['conversationId'] === 'string' && p['conversationId'] !== this.conversationId) {
      return;
    }
    switch (env.type) {
      case 'message.created': {
        const m = parseMessage(p, this.conversationId, this.d.readBlocks);
        if (m === null) {
          return;
        }
        if (m.authorType === 'agent' || m.authorType === 'bot') {
          this.clearTyping();
        }
        const merged = mergeMessages(this.state.messages, [m], false);
        // A duplicate delivery changes nothing, so it tells nobody anything.
        if (merged !== this.state.messages) {
          this.set({ messages: merged });
        }
        return;
      }
      case 'message.updated':
        this.set({ messages: foldUpdated(this.state.messages, p, this.d.readBlocks) });
        return;
      case 'message.deleted':
        this.set({
          messages: foldDeleted(this.state.messages, p, new Date(this.now()).toISOString()),
        });
        return;
      case 'message.reaction_changed':
        this.set({ messages: foldReactionEvent(this.state.messages, p) });
        return;
      case 'typing.start':
      case 'typing.stop':
        this.onTyping(env.type, p);
        return;
      case 'message.notice': {
        const notice = readNotice(p, this.conversationId);
        if (notice !== null) {
          fanOut(this.noticed, notice);
        }
        return;
      }
      case 'host.capability_invoked': {
        const inv = readHostInvocation(p, this.now());
        if (inv !== null) {
          routeInvocation(inv, this.unpromptedOk, this.invoked, this.d.api, this.conversationId);
        }
        return;
      }
      case 'message.read':
        if (p['readerType'] === 'agent') {
          this.set({
            agentReadUpTo: typeof p['upToMessageId'] === 'string' ? p['upToMessageId'] : '*',
          });
        }
        return;
      default:
        // Anything else is filtered at the gateway for a visitor.
        return;
    }
  }

  private onTyping(type: 'typing.start' | 'typing.stop', p: Record<string, unknown>): void {
    const typing = readTyping(p);
    if (typing === null) {
      return;
    }
    if (type === 'typing.stop') {
      this.clearTyping();
      return;
    }
    this.clearTypingTimer();
    this.set({ typing });
    // `typing.stop` is best-effort: a closed laptop sends nothing. The core
    // owns the timeout so no consumer ships a stuck "is typing…".
    this.typingTimer = setTimeout(() => this.clearTyping(), TYPING_STOP_AFTER_MS);
  }

  private clearTypingTimer(): void {
    if (this.typingTimer !== null) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
  }

  private clearTyping(): void {
    this.clearTypingTimer();
    if (this.state.typing !== null) {
      this.set({ typing: null });
    }
  }

  /* ─────────────────────────────── verbs ──────────────────────────── */

  private assertOpen(): void {
    if (this.closed) {
      throw new ChatlyError('closed', 'chatly: this conversation is closed');
    }
  }

  /**
   * Send a message. Appears immediately as `pending: true` and is replaced by
   * the server's copy. If the request fails the row is removed and the error
   * thrown, so a renderer never keeps a bubble the server does not have.
   */
  public async send(
    body: string,
    opts: { attachments?: readonly MessageAttachment[]; idempotencyKey?: string } = {},
  ): Promise<void> {
    await this.deliver(body, opts, undefined);
  }

  /**
   * A postback or quick reply: `payload` is the structured half the bot
   * reads. `silent` keeps the turn out of the visitor's own thread (and so
   * draws no optimistic row); the server requires a non-empty `body` then.
   */
  public async postback(input: PostbackInput): Promise<void> {
    await this.deliver(
      input.body,
      {},
      {
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        ...(input.silent === true ? { silent: true } : {}),
      },
    );
  }

  private async deliver(
    body: string,
    opts: { attachments?: readonly MessageAttachment[]; idempotencyKey?: string },
    postback: { payload?: Record<string, unknown>; silent?: boolean } | undefined,
  ): Promise<void> {
    this.assertOpen();
    const silent = postback?.silent === true;
    const localId = `local-${this.d.randomId()}`;
    if (!silent) {
      const row: ConversationMessage = {
        id: localId,
        conversationId: this.conversationId,
        body,
        authorType: 'contact',
        createdAt: new Date(this.now()).toISOString(),
        kind: 'text',
        bodyHtml: null,
        blocks: null,
        canvas: null,
        attachments: opts.attachments ?? [],
        authorId: null,
        streamState: null,
        hiddenFromContact: false,
        replyToMessageId: null,
        metadata: {},
        deletedAt: null,
        reactions: [],
        pending: true,
      };
      this.set({ messages: mergeMessages(this.state.messages, [row], false) });
    }
    try {
      await this.d.api.send(this.conversationId, body, {
        ...(opts.attachments === undefined ? {} : { attachments: opts.attachments }),
        ...(opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
        ...(postback === undefined ? {} : { postback }),
      });
    } catch (err: unknown) {
      this.set({ messages: this.state.messages.filter((m) => m.id !== localId) });
      throw err;
    }
    // With no live socket nothing will echo the message back for seconds;
    // read the thread now so the pending row resolves.
    if (!silent && this.state.connection !== 'live') {
      await this.refresh(true).catch((err: unknown) => this.set({ error: err }));
    }
  }

  /**
   * Toggle an emoji on a message. Not optimistic: the server's answer comes
   * in the same round trip and carries the viewer's own `reacted`, so a
   * refused tap (an emoji the workspace stopped offering, a message an agent
   * just deleted) never leaves a phantom pill.
   */
  public async react(messageId: string, emoji: string): Promise<ReactionSummary> {
    this.assertOpen();
    const summary = await this.d.api.toggleReaction(this.conversationId, messageId, emoji);
    this.set({
      messages: foldReactions(this.state.messages, summary.messageId, summary.entries, true),
    });
    return summary;
  }

  /** Where `press` sends host_event / url / navigate presses unless it is given hooks of its own. */
  public setPressHooks = (hooks: PressHooks): void => {
    this.pressHooks = hooks;
  };

  /** Press an action by id or index; the semantics and refusals are `pressMessage`'s (`press.ts`). */
  public press(
    messageId: string,
    action: string | number,
    hooks: PressHooks = this.pressHooks,
  ): Promise<boolean> {
    this.assertOpen();
    return pressMessage(this, this.state.messages, messageId, action, hooks);
  }

  /** Like or dislike a card, or `null` to take it back; see `assertCardInMessage` (`press.ts`). */
  public async reactToCard(
    messageId: string,
    cardId: string,
    reaction: 'like' | 'dislike' | null,
  ): Promise<void> {
    this.assertOpen();
    assertCardInMessage(this.state.messages, messageId, cardId);
    await this.postback({
      body: 'card.reaction',
      silent: true,
      payload: { card: cardId, reaction },
    });
  }

  /** `card.viewed`, once per card; needs `setAnalyticsConsent(true)` (ADR 0082). Resolves whether it went out. */
  public reportCardView = (messageId: string, cardId: string): Promise<boolean> => {
    this.assertOpen();
    return this.cardReports.view(messageId, cardId);
  };

  /** `card.action` per press (`actionIndex`; `-1` = the card's own tap); consent-gated. */
  public reportCardAction = (
    messageId: string,
    cardId: string,
    actionIndex: number,
  ): Promise<boolean> => {
    this.assertOpen();
    return this.cardReports.action(messageId, cardId, actionIndex);
  };

  /** Submit a Tier 2 step (a form / confirm card). */
  public async submitStep(
    messageId: string,
    actionId: string,
    values: Record<string, unknown>,
  ): Promise<StepResult> {
    this.assertOpen();
    return this.d.api.submitStep(this.conversationId, messageId, actionId, values);
  }

  /** A card's `step` action: ask for the first step of a flow. */
  public async requestStep(canvasId: string, params?: Record<string, unknown>) {
    this.assertOpen();
    return this.d.api.requestStep(this.conversationId, canvasId, params);
  }

  /** A card's `cards` action. The server posts the blocks into the thread. */
  public async requestCards(cardKey: string) {
    this.assertOpen();
    return this.d.api.requestCards(this.conversationId, cardKey);
  }

  /** Report the host's outcome of a card action into the thread. */
  public async reportAction(input: Parameters<VisitorApi['reportAction']>[1]) {
    this.assertOpen();
    return this.d.api.reportAction(this.conversationId, input);
  }

  public async upload(file: Parameters<VisitorApi['upload']>[0]): Promise<MessageAttachment> {
    this.assertOpen();
    return this.d.api.upload(file);
  }

  /**
   * Persist how far this visitor has read AND tell the agent live.
   *
   * REST first (persist, then publish): the socket emit alone reaches the
   * agent's receipt and writes nothing, which is how `unread_contact_count`
   * once only ever grew. With no `upToMessageId` the last server message
   * from someone else is used; with none, nothing is sent.
   */
  public async markRead(upToMessageId?: string): Promise<void> {
    this.assertOpen();
    const target =
      upToMessageId ??
      [...this.state.messages]
        .reverse()
        .find((m) => !m.pending && m.authorType !== 'contact' && !m.id.startsWith('local-'))?.id;
    if (target === undefined || target === this.lastReadEmitted) {
      return;
    }
    this.lastReadEmitted = target;
    await this.d.api.markRead(this.conversationId, target);
    const contactId = this.d.session.contactId;
    if (contactId !== null) {
      // The gateway drops a read whose readerId is not the token's contact.
      this.realtime?.emit('message.read', {
        conversationId: this.conversationId,
        upToMessageId: target,
        readAt: new Date(this.now()).toISOString(),
        readerType: 'contact',
        readerId: contactId,
      });
    }
  }

  /**
   * Tell the agent this visitor is typing. Push only -- typing is a socket
   * event with no HTTP route -- so on the polling path this is a no-op.
   */
  public setTyping(isTyping: boolean): void {
    this.realtime?.emit(isTyping ? 'typing.start' : 'typing.stop', {
      conversationId: this.conversationId,
      actorType: 'contact',
      // The gateway requires a non-empty actorId (and overwrites it from the JWT).
      actorId: this.d.session.contactId ?? 'unknown',
    });
  }

  /** Remove this conversation from the visitor's list (the workspace keeps it). */
  public async dismiss(): Promise<void> {
    this.assertOpen();
    await this.d.api.dismiss(this.conversationId);
  }
}
