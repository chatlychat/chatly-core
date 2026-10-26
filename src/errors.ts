/**
 * Errors the core throws.
 *
 * `new Error('string')` is banned by CLAUDE.md §4, and a published package
 * cannot import `AppError` from `@livechat/shared`, so these are the
 * package's own: a `code` to switch on, the HTTP status when there is one,
 * and `cause`.
 */

export type ChatlyErrorCode =
  | 'request_failed'
  | 'invalid_response'
  | 'no_fetch'
  | 'no_socket'
  | 'no_realtime_host'
  | 'no_session'
  | 'upload_failed'
  | 'closed'
  | 'unknown_message'
  | 'unknown_action';

export class ChatlyError extends Error {
  public readonly code: ChatlyErrorCode;
  public readonly httpStatus: number | null;
  /** The server's own `error.code`, when it sent one (`visitor_session_expired`...). */
  public readonly serverCode: string | null;
  public override readonly cause: unknown;

  public constructor(
    code: ChatlyErrorCode,
    message: string,
    extra: { httpStatus?: number; serverCode?: string | null; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ChatlyError';
    this.code = code;
    this.httpStatus = extra.httpStatus ?? null;
    this.serverCode = extra.serverCode ?? null;
    this.cause = extra.cause;
  }
}

/** The failure body, read ONCE: `res.json()` is single-use. */
export interface ErrorBody {
  readonly code: string | null;
  readonly message: string | null;
}

/**
 * Both envelopes: `{ error: { code, message } }`, which is what
 * `app-exception.filter.ts` sends, and a flat `{ code, message }`. The
 * sdk-js stale-session check read only the flat one for months and so never
 * fired.
 */
export async function readErrorBody(res: { json(): Promise<unknown> }): Promise<ErrorBody> {
  try {
    const raw = (await res.json()) as {
      error?: { code?: unknown; message?: unknown };
      code?: unknown;
      message?: unknown;
    } | null;
    const code = raw?.error?.code ?? raw?.code;
    const message = raw?.error?.message ?? raw?.message;
    return {
      code: typeof code === 'string' ? code : null,
      message: typeof message === 'string' ? message : null,
    };
  } catch {
    return { code: null, message: null };
  }
}
