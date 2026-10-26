import { ChatlyError, readErrorBody } from './errors.js';
import { defaultRandomId } from './ids.js';
import { createSafeStorage } from './storage.js';

import type {
  FetchLike,
  FetchResponseLike,
  KeyValueStorage,
  StorageSource,
  IdentifyResult,
  VisitorIdentity,
} from './types.js';
import type { WorldTheme } from './world-theme.js';

export const DEFAULT_API_URL = 'https://api.chatlychat.com';

export interface SessionOptions {
  readonly publicId: string;
  readonly apiUrl?: string;
  readonly fetch?: FetchLike;
  readonly storage?: StorageSource;
  readonly randomId?: () => string;
  /** Sent on init only. A host with no `navigator` supplies these itself. */
  readonly locale?: string;
  readonly timezone?: string;
  /** Realtime host override, for a deployment `init` cannot describe. */
  readonly realtimeUrl?: string;
  /**
   * The visitor has agreed to analytics. Default `false`: telemetry is opt-in
   * (ADR 0081), so `reportCardView` / `reportCardAction` send nothing until
   * the host says so here or through `setAnalyticsConsent`.
   */
  readonly analytics?: boolean;
}

interface InitBody {
  session?: {
    token?: string;
    contactId?: string | null;
    identityVerified?: boolean;
    visitorKey?: string;
  };
  realtimeUrl?: string | null;
  worldTheme?: WorldTheme | null;
}

/**
 * The visitor's session and the one place a request is made.
 *
 * Owns the three things every call shares: the base URL, the visitor token
 * (and where it is remembered), and the 403 recovery. Everything else is a
 * free function in `visitor-api.ts` over `post` and `identity`, so this file
 * holds state and the rest holds protocol.
 *
 * ── Two credentials, never confused ─────────────────────────────────────
 *
 * `visitorToken` is what `POST /v1/widget/init` returns as `session.token`:
 * long-lived, identifies the visitor, and rides every REST body. It is NOT
 * accepted by the realtime gateway. The realtime credential is minted per
 * conversation by `POST /v1/widget/realtime/token` and lives in
 * `realtime.ts`; nothing in this file ever hands the visitor token to a
 * socket.
 */
export class VisitorSession {
  public readonly publicId: string;
  private readonly base: string;
  private readonly storage: KeyValueStorage;
  private readonly randomId: () => string;
  private readonly fetchOpt: FetchLike | undefined;
  private readonly locale: string | undefined;
  private readonly timezone: string | undefined;
  private readonly realtimeOverride: string | undefined;

  private token: string | null = null;
  private contact: string | null = null;
  private realtime: string | null = null;
  private theme: WorldTheme | null = null;
  private remembered: VisitorIdentity | undefined;
  private verified = false;
  private analytics: boolean;
  private xid: string | null = null;
  private readonly identifiedListeners = new Set<(r: IdentifyResult) => void>();
  /** One in-flight bootstrap, so concurrent first calls mint ONE visitor. */
  private booting: Promise<void> | null = null;

  public constructor(opts: SessionOptions) {
    this.publicId = opts.publicId;
    this.base = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.storage = createSafeStorage(opts.storage);
    this.randomId = opts.randomId ?? defaultRandomId;
    this.fetchOpt = opts.fetch;
    this.locale = opts.locale;
    this.timezone = opts.timezone;
    this.realtimeOverride = opts.realtimeUrl;
    this.analytics = opts.analytics === true;
    // Key kept as `livechat:vt:` -- the internal scope name sdk-js and the
    // widget use -- so a browser that already has a token keeps its visitor.
    this.token = this.storage.getItem(this.storageKey());
  }

  private storageKey(): string {
    return `livechat:vt:${this.publicId}`;
  }

  /** The API origin every call goes to; a minted media path is relative to it. */
  /** Whether the host has said the visitor agreed to analytics (default no). */
  public get analyticsGranted(): boolean {
    return this.analytics;
  }

  public setAnalytics(granted: boolean): void {
    this.analytics = granted;
  }

  public get apiBase(): string {
    return this.base;
  }

  public get visitorToken(): string | null {
    return this.token;
  }
  public get contactId(): string | null {
    return this.contact;
  }
  /** The channel's `worldTheme` from the last init, or null. Pass to `resolveWorldTheme`. */
  public get worldTheme(): WorldTheme | null {
    return this.theme;
  }

  public get realtimeUrl(): string | null {
    return this.realtimeOverride ?? this.realtime;
  }

  /** `publicId` + `visitorToken`, on every visitor-side body. */
  public identity(): { publicId: string; visitorToken: string } {
    // `?? ''` is deliberate and safe: callers `ensure()` first, and the
    // server refuses an empty token with a 400 rather than treating it as
    // anonymous.
    return { publicId: this.publicId, visitorToken: this.token ?? '' };
  }

  /** Mint or confirm a visitor token. Idempotent; concurrent calls share one request. */
  public ensure(): Promise<void> {
    if (this.token !== null) {
      return Promise.resolve();
    }
    this.booting ??= this.init().then(
      () => {
        this.booting = null;
      },
      (err: unknown) => {
        this.booting = null;
        throw err;
      },
    );
    return this.booting;
  }

  /**
   * `POST /v1/widget/init`. Also the identify route: there has never been a
   * dedicated identify endpoint, and routing identity through init keeps
   * identification and `userHash` verification from drifting apart.
   */
  public async init(identity?: VisitorIdentity): Promise<IdentifyResult> {
    if (identity !== undefined) {
      this.remembered = identity;
    }
    const res = await this.post('/v1/widget/init', {
      publicId: this.publicId,
      ...(this.token === null ? {} : { visitorToken: this.token }),
      ...(this.locale === undefined ? {} : { locale: this.locale }),
      ...(this.timezone === undefined ? {} : { timezone: this.timezone }),
      ...(identity === undefined ? {} : { identity }),
    });
    const body = (await res.json()) as InitBody;
    const token = body.session?.token;
    if (typeof token === 'string' && token.length > 0) {
      // init ROTATES the token on every call; the response's is the only valid one.
      this.setToken(token);
    }
    const contactId = body.session?.contactId;
    if (typeof contactId === 'string' && contactId.length > 0) {
      this.contact = contactId;
    }
    if (typeof body.realtimeUrl === 'string' && body.realtimeUrl.length > 0) {
      this.realtime = body.realtimeUrl;
    }
    // Validated on write by the server; an object or nothing.
    this.theme =
      typeof body.worldTheme === 'object' && body.worldTheme !== null ? body.worldTheme : null;
    if (this.token === null) {
      throw new ChatlyError('no_session', 'chatly: init returned no session token');
    }
    this.verified = body.session?.identityVerified === true;
    // visitorKey is the anonymous `vt_` key unless the visitor identified, so it names someone only then.
    this.xid = this.verified
      ? (body.session?.visitorKey ?? identity?.externalId ?? null)
      : (identity?.externalId ?? null);
    const result = this.identified();
    for (const l of [...this.identifiedListeners]) {
      l(result);
    }
    return result;
  }

  private identified(): IdentifyResult {
    return { contactId: this.contact, identityVerified: this.verified, externalId: this.xid };
  }

  /** Fires after every successful init/identify. Returns an unsubscribe. */
  public onIdentified(handler: (r: IdentifyResult) => void): () => void {
    this.identifiedListeners.add(handler);
    return () => {
      this.identifiedListeners.delete(handler);
    };
  }

  private setToken(token: string): void {
    this.token = token;
    this.storage.setItem(this.storageKey(), token);
  }

  /** Forget the visitor (sign-out). Does not touch the server. */
  public reset(): void {
    this.token = null;
    this.contact = null;
    this.remembered = undefined;
    this.verified = false;
    this.xid = null;
    this.storage.removeItem(this.storageKey());
  }

  public getFetch(): FetchLike {
    if (this.fetchOpt !== undefined) {
      return this.fetchOpt;
    }
    const g = (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof g !== 'function') {
      throw new ChatlyError(
        'no_fetch',
        'chatly: no fetch available — pass `fetch` to createChatlyCore()',
      );
    }
    return g;
  }

  /**
   * POST JSON, with an Idempotency-Key (production requires one on every
   * write), typed errors, and ONE transparent recovery from a dead session.
   *
   * A `visitor_session_*` 403 means the stored token predates signed
   * sessions or expired. From the visitor's side nothing is wrong, so the
   * token is dropped, a fresh one fetched against the remembered identity,
   * and the call replayed once.
   */
  public async post(
    path: string,
    body: unknown,
    idempotencyKey?: string,
    isRetry = false,
  ): Promise<FetchResponseLike> {
    const res = await this.getFetch()(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key':
          idempotencyKey !== undefined && idempotencyKey.length > 0
            ? idempotencyKey
            : this.randomId(),
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      return res;
    }
    const failure = await readErrorBody(res);
    if (
      res.status === 403 &&
      !isRetry &&
      failure.code !== null &&
      failure.code.startsWith('visitor_session_')
    ) {
      return this.recover(path, body, idempotencyKey);
    }
    throw new ChatlyError('request_failed', failure.message ?? `chatly: ${path} → ${res.status}`, {
      httpStatus: res.status,
      serverCode: failure.code,
    });
  }

  private async recover(
    path: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<FetchResponseLike> {
    const retry = { ...(body as Record<string, unknown>) };
    this.token = null;
    this.storage.removeItem(this.storageKey());
    if (path === '/v1/widget/init') {
      delete retry['visitorToken'];
      if (retry['identity'] === undefined && this.remembered !== undefined) {
        retry['identity'] = this.remembered;
      }
    } else {
      await this.init(this.remembered);
      retry['visitorToken'] = this.visitorToken ?? '';
    }
    return this.post(path, retry, idempotencyKey, true);
  }
}
