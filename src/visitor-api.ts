import { ChatlyError } from './errors.js';

import type { HostSurface, SurfaceResult } from './host-surface.js';
import type { VisitorSession } from './session.js';
import type { MessageSpeech, SpeechFormat } from './speech.js';
import type { ConversationSummary, MessageAttachment } from './types.js';

/** Raw wire rows. Parsed into `ConversationMessage` by `message.ts`. */
export interface RawMessage {
  readonly [key: string]: unknown;
}

export interface PostbackInput {
  /** The text the bot reads (and, unless `silent`, the visitor sees). */
  readonly body: string;
  /** The structured half. Keys 1-40 chars; the server rejects more. */
  readonly payload?: Record<string, unknown>;
  /** Hide the turn from the visitor's own thread. The server requires non-empty `body`. */
  readonly silent?: boolean;
}

export interface SendOptions {
  readonly attachments?: readonly MessageAttachment[];
  readonly postback?: Omit<PostbackInput, 'body'>;
  /** Stable key, so a retry coalesces to one write. */
  readonly idempotencyKey?: string;
}

export interface StartOptions {
  readonly attachments?: readonly MessageAttachment[];
  readonly preChat?: Record<string, string>;
  readonly pageContext?: Record<string, unknown>;
  readonly locale?: string;
  readonly timezone?: string;
}

export interface ContextInput {
  /** Unsigned shorthand claim (`context.unverified.audience`). */
  readonly audience?: string;
  /** HS256 JWT your server signs with the channel IDV secret; the server verifies it. */
  readonly contextToken?: string;
  readonly surface?: HostSurface;
}

export interface ContextResult extends SurfaceResult {
  /** What the server verified from `contextToken`; null when nothing was. */
  readonly verified: Record<string, unknown> | null;
}

export interface PresignedUpload {
  readonly uploadId: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly publicUrl: string;
}

export interface StepResult {
  readonly canvas: unknown;
  readonly errors: Record<string, string>;
  readonly hostEvent?: { event?: unknown; data?: unknown };
  readonly messageId?: string;
}

export interface StepRequestResult {
  readonly messageId: string;
  readonly canvas: unknown;
  readonly hostEvent?: unknown;
}

export interface ActionResult {
  readonly blocks: unknown;
  readonly deliveredMessageId: string;
}

export interface ReactionSummary {
  readonly messageId: string;
  readonly entries: ReadonlyArray<{ emoji: string; count: number; reacted: boolean }>;
}

/** What the visitor's matched audience profile resolves to (`POST /v1/widget/profile/resolve`). */
export interface ProfileView {
  /** The matched profile's name; null when none matched or the match is unnamed. */
  readonly profile: string | null;
  readonly matched: boolean;
  readonly starterPrompts: readonly string[];
  /** Left loose, like blocks: `label` plus `href` or `startConversation`, `description?`, `icon?`. */
  readonly quickLinks: ReadonlyArray<Record<string, unknown> & { readonly label: string }>;
  /** Every copy key, defaults filled in. */
  readonly copy: Readonly<Record<string, string>>;
}

function expectObject(path: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    throw new ChatlyError('invalid_response', `chatly: ${path} answered a non-object`);
  }
  return raw as Record<string, unknown>;
}

/**
 * Every visitor REST call, over a `VisitorSession`.
 *
 * Request shapes are the measured contract in
 * `docs/prompts/5/mobile-sdk-visitor-contract.md` and the reference
 * implementation in `apps/widget/src/client*.ts`, restated rather than
 * imported (a published package cannot import internals). The request bodies
 * are pinned by `visitor-api.spec.ts`, which asserts on what was SENT.
 *
 * Every method awaits `session.ensure()` first, so the first call from a
 * fresh process bootstraps the visitor instead of sending an empty token.
 */
export class VisitorApi {
  public constructor(private readonly session: VisitorSession) {}

  private async call(path: string, body: Record<string, unknown>, idem?: string): Promise<unknown> {
    await this.session.ensure();
    const res = await this.session.post(path, { ...this.session.identity(), ...body }, idem);
    return res.json();
  }

  public async listConversations(limit = 20): Promise<ConversationSummary[]> {
    const path = '/v1/widget/conversations/list';
    const body = expectObject(path, await this.call(path, { limit }));
    return Array.isArray(body['conversations'])
      ? (body['conversations'] as ConversationSummary[])
      : [];
  }

  public async listMessages(conversationId: string, limit = 50): Promise<RawMessage[]> {
    const path = '/v1/widget/messages/list';
    const body = expectObject(path, await this.call(path, { conversationId, limit }));
    return Array.isArray(body['messages']) ? (body['messages'] as RawMessage[]) : [];
  }

  /** Open a NEW conversation with a first message. `send` replies to one that exists. */
  public async start(body: string, opts: StartOptions = {}): Promise<{ conversationId: string }> {
    const path = '/v1/widget/conversations';
    const parsed = expectObject(
      path,
      await this.call(path, {
        body,
        attachments: opts.attachments ?? [],
        ...(opts.locale === undefined ? {} : { locale: opts.locale }),
        ...(opts.timezone === undefined ? {} : { timezone: opts.timezone }),
        ...(opts.preChat === undefined ? {} : { preChat: opts.preChat }),
        ...(opts.pageContext === undefined ? {} : { pageContext: opts.pageContext }),
      }),
    );
    const conv = parsed['conversation'] as { id?: unknown } | undefined;
    if (typeof conv?.id !== 'string' || conv.id.length === 0) {
      throw new ChatlyError('invalid_response', 'chatly: start answered no conversation id');
    }
    return { conversationId: conv.id };
  }

  /**
   * Reply in an existing conversation. A postback is a reply with `payload`
   * and optionally `silent`; both are OMITTED when unset, never sent as
   * `undefined`/`false`, because the server treats presence as meaning.
   */
  public async send(
    conversationId: string,
    body: string,
    opts: SendOptions = {},
  ): Promise<unknown> {
    return this.call(
      '/v1/widget/messages',
      {
        conversationId,
        body,
        attachments: opts.attachments ?? [],
        ...(opts.postback?.silent === true ? { silent: true } : {}),
        ...(opts.postback?.payload === undefined ? {} : { payload: opts.postback.payload }),
      },
      opts.idempotencyKey,
    );
  }

  public async toggleReaction(
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<ReactionSummary> {
    return (await this.call(`/v1/widget/conversations/${conversationId}/reactions`, {
      conversationId,
      messageId,
      emoji,
    })) as ReactionSummary;
  }

  /** The DURABLE read. The socket `message.read` is the delivery half, in `conversation.ts`. */
  public async markRead(conversationId: string, upToMessageId?: string): Promise<void> {
    await this.call(`/v1/widget/conversations/${conversationId}/read`, {
      ...(upToMessageId === undefined ? {} : { upToMessageId }),
    });
  }

  /** Remove from THIS visitor's list. Not a delete: the workspace keeps the record. */
  public async dismiss(conversationId: string): Promise<void> {
    await this.call(
      `/v1/widget/conversations/${conversationId}/dismiss`,
      {},
      `dismiss:${conversationId}`,
    );
  }

  /**
   * Submit a Tier 2 step. No `state` is sent (the server reads it off the
   * stored row, which is why a visitor cannot edit a quoted total) and NO
   * idempotency key is pinned: a second press of "Buy" is a second purchase,
   * and a stable key would hand a RETRY the first response.
   */
  public async submitStep(
    conversationId: string,
    messageId: string,
    actionId: string,
    values: Record<string, unknown>,
  ): Promise<StepResult> {
    return (await this.call(`/v1/widget/conversations/${conversationId}/canvas`, {
      messageId,
      actionId,
      values,
    })) as StepResult;
  }

  /** A card's `step` action: ask for the first step of a flow. Key bound to (conversation, step, params). */
  public async requestStep(
    conversationId: string,
    canvasId: string,
    params?: Record<string, unknown>,
  ): Promise<StepRequestResult> {
    return (await this.call(
      `/v1/widget/conversations/${conversationId}/canvas-step`,
      { canvasId, ...(params === undefined ? {} : { params }) },
      `canvas-step:${conversationId}:${canvasId}:${params === undefined ? '' : JSON.stringify(params)}`,
    )) as StepRequestResult;
  }

  /**
   * A card's `cards` action: ask the operator's own backend for this
   * visitor's data. Key bound to (conversation, card) — a card takes no
   * arguments, so two presses are always the same request.
   */
  public async requestCards(
    conversationId: string,
    cardKey: string,
  ): Promise<{ messageId: string | null; state: string }> {
    return (await this.call(
      `/v1/widget/conversations/${conversationId}/cards`,
      { cardKey },
      `cards:${conversationId}:${cardKey}`,
    )) as { messageId: string | null; state: string };
  }

  /** The host's outcome of a card action, into the thread. */
  public async reportAction(
    conversationId: string,
    input: {
      messageId: string;
      actionId: string;
      status: 'done' | 'failed';
      text?: string;
      blocks?: unknown;
      data?: Record<string, unknown>;
    },
  ): Promise<ActionResult> {
    return (await this.call(
      `/v1/widget/conversations/${conversationId}/action-result`,
      { ...input },
      `action-result:${conversationId}:${input.messageId}:${input.actionId}:${input.status}`,
    )) as ActionResult;
  }

  /**
   * Presign, PUT the raw bytes, return the attachment record.
   *
   * The presign route takes `contentType`, the attachment calls the same
   * string `mimeType`; sending `mimeType` to presign gets the key stripped by
   * zod and a 400. The PUT is the bytes verbatim (not multipart, not base64)
   * with every header the presign returned.
   */
  public async upload(file: {
    readonly name: string;
    readonly type: string;
    readonly size: number;
    readonly bytes: unknown;
  }): Promise<MessageAttachment> {
    const contentType = file.type.length > 0 ? file.type : 'application/octet-stream';
    const presigned = (await this.call('/v1/widget/uploads/presign', {
      filename: file.name,
      contentType,
      sizeBytes: file.size,
    })) as PresignedUpload;
    const put = await this.session.getFetch()(presigned.url, {
      method: presigned.method,
      headers: presigned.headers,
      body: file.bytes,
    });
    if (!put.ok) {
      throw new ChatlyError('upload_failed', `chatly: upload failed (${put.status})`, {
        httpStatus: put.status,
      });
    }
    return {
      id: presigned.uploadId,
      filename: file.name,
      mimeType: contentType,
      sizeBytes: file.size,
      url: presigned.publicUrl,
    };
  }

  /**
   * Declare this client as a host surface: what kind of place it is, what it
   * can do, and where the visitor is in names. `POST /v1/widget/context` with
   * `surface` alone, so the page and claims stored beside it are untouched.
   */
  public async setSurface(surface: HostSurface): Promise<SurfaceResult> {
    const { surfaceRejected } = await this.setContext({ surface });
    return { surfaceRejected };
  }

  /** `POST /v1/widget/context`, the body the widget's `setContext` sends. */
  public async setContext(input: ContextInput): Promise<ContextResult> {
    const path = '/v1/widget/context';
    const body = expectObject(path, await this.call(path, { ...input }));
    const verified = body['verified'];
    return {
      surfaceRejected: Array.isArray(body['surfaceRejected'])
        ? (body['surfaceRejected'] as SurfaceResult['surfaceRejected'])
        : [],
      verified:
        typeof verified === 'object' && verified !== null
          ? (verified as Record<string, unknown>)
          : null,
    };
  }

  /**
   * The profile this visitor matches now, resolved by the server with the
   * widget's own matcher against the session's identity and stored context.
   * Nothing but `locale` comes from the caller.
   */
  public async profile(locale?: string): Promise<ProfileView> {
    const path = '/v1/widget/profile/resolve';
    const body = expectObject(path, await this.call(path, locale === undefined ? {} : { locale }));
    if (typeof body['matched'] !== 'boolean' || typeof body['copy'] !== 'object') {
      throw new ChatlyError('invalid_response', `chatly: ${path} answered no profile`);
    }
    return body as unknown as ProfileView;
  }

  /** A visitor event for the CDP. */
  public async track(name: string, properties?: Record<string, unknown>): Promise<void> {
    await this.call('/v1/widget/events', { name, properties: properties ?? {} });
  }

  /**
   * A short-lived URL to HEAR a bot message, or `null` when it is not a bot's
   * or its bot has no voice (ADR 0073). Ask per message you mean to voice; a
   * 2D surface never needs to. The URL is good for ten minutes and needs no
   * header, so the host's own audio client can stream it — see `speech.ts`.
   */
  public async speech(
    conversationId: string,
    messageId: string,
    format: SpeechFormat = 'ndjson',
  ): Promise<MessageSpeech | null> {
    const path = `/v1/widget/messages/${encodeURIComponent(messageId)}/speech`;
    const body = expectObject(path, await this.call(path, { conversationId, format }));
    const speech = body['speech'];
    if (speech === null || speech === undefined) {
      return null;
    }
    const s = expectObject(path, speech);
    if (typeof s['path'] !== 'string' || !s['path'].startsWith('/')) {
      throw new ChatlyError('invalid_response', 'chatly: speech answered no path');
    }
    return {
      url: `${this.session.apiBase}${s['path']}`,
      expiresAt: typeof s['expiresAt'] === 'string' ? s['expiresAt'] : '',
      format: s['format'] === 'audio' ? 'audio' : 'ndjson',
      visemeTiming:
        s['visemeTiming'] === 'aligned' || s['visemeTiming'] === 'endpoint'
          ? s['visemeTiming']
          : 'estimated',
    };
  }

  /**
   * Mint the conversation-scoped realtime credential. NOT `session.token`:
   * the gateway accepts only this one. 404s when the conversation is not the
   * caller's own.
   */
  public async realtimeToken(
    conversationId: string,
  ): Promise<{ token: string; expiresAt: string | null }> {
    const path = '/v1/widget/realtime/token';
    const body = expectObject(path, await this.call(path, { conversationId }));
    if (typeof body['token'] !== 'string' || body['token'].length === 0) {
      throw new ChatlyError('invalid_response', 'chatly: realtime/token answered no token');
    }
    return {
      token: body['token'],
      expiresAt: typeof body['expiresAt'] === 'string' ? body['expiresAt'] : null,
    };
  }
}
