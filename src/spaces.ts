/**
 * Spaces — talking to a Chatly agent from inside a world.
 *
 *   const space = createSpaceClient({ publicId, fetch });
 *   const joined = await space.join({ slug: 'flagship-lobby', grant });
 *   if (joined.space.withheld.includes('display_names')) { … }
 *   await space.send('is the jacket in blue?');
 *   await space.reportOutcome({ kind: 'reached', target: 'flagship-shop' });
 *
 * ── Why this is in the core and not the widget ──────────────────────────
 *
 * A world host embeds the headless core: there is no launcher in a 3D scene,
 * no panel, and no byte of the widget's first-paint budget to spend on one.
 * Nothing in `apps/widget` changed to add spaces and nothing needs to.
 *
 * ── Why a separate client and not a method on `VisitorSession` ──────────
 *
 * A visitor session is bound to a channel and speaks for a
 * `contacts.external_id`, and on a channel with identity verification off it
 * believes whatever identity the host asserts. A space membership is a
 * different credential with a different authority: the SERVER minted it,
 * after checking either a grant the customer's own server signed or an `open`
 * policy. Hanging it off the visitor session would invite the two to be used
 * in each other's place.
 *
 * ── What a host must read before building an affordance ────────────────
 *
 * `joined.space.withheld` and `joined.space.structurallyRefused`. A shared
 * space refuses personal surfaces by default — an order status, a name, an
 * identity-gated action, an announced outcome — and a world that builds a
 * "mail me this transcript" button for a shared space has built something the
 * server will always refuse. The lists are returned so that is discoverable
 * from the API rather than from a support ticket.
 */
import { ChatlyError, readErrorBody } from './errors.js';

import type { FetchLike } from './types.js';

export const SPACES_DEFAULT_API_URL = 'https://api.chatlychat.com';

export interface SpaceClientOptions {
  /** The widget public id of the channel the space sits on. */
  readonly publicId: string;
  readonly fetch: FetchLike;
  readonly apiUrl?: string;
  /** A credential from an earlier session, to resume without re-joining. */
  readonly memberToken?: string;
}

export interface JoinSpaceOptions {
  readonly slug: string;
  /** A grant signed by your own server. Required by a `grant` space. */
  readonly grant?: string;
  /** Honoured by an `open` space; a `grant` space uses the signed name. */
  readonly displayName?: string;
}

export interface JoinedSpace {
  readonly memberToken: string;
  readonly expiresAt: string;
  readonly space: {
    readonly slug: string;
    readonly name: string;
    readonly mode: 'private' | 'shared';
    /** Surfaces this space withholds as it stands. Opt-in, per workspace. */
    readonly withheld: readonly string[];
    /** Surfaces a shared space cannot offer however it is configured. */
    readonly structurallyRefused: readonly string[];
    /**
     * May the bot fire a host capability here WITHOUT a press? An operator's
     * switch: off by default in a `shared` space, on in a `private` one.
     * When false the server will not create one and the core drops any it is
     * handed — call `applySpacePolicy(conversation, joined)` so it does.
     */
    readonly unpromptedCapabilities: boolean;
    /** Whether what members say is screened by the operator's moderation. */
    readonly moderated: boolean;
  };
  readonly member: {
    readonly id: string;
    readonly displayName: string | null;
    readonly identityVerified: boolean;
    /** An operator muted you: you can read the room, and `send` answers 403 `space_member_muted`. */
    readonly muted: boolean;
  };
  readonly conversationId: string | null;
  readonly memberCount: number;
}

export interface SpaceTurn {
  readonly id: string;
  readonly authorType: 'visitor' | 'agent' | 'bot' | 'system';
  /**
   * A name when the space discloses names, an ordinal (`Visitor 2`) when it
   * does not, and null for an agent, a bot, or your own turn with names
   * withheld — use `mine` for that case and render your own word, so it is
   * translated by you rather than by us.
   */
  readonly authorLabel: string | null;
  readonly mine: boolean;
  readonly body: string;
  readonly blocks: unknown;
  /**
   * How many blocks on this turn the space withheld. Render "1 item not
   * shown" rather than nothing: an undecorated reply looks like a broken one.
   */
  readonly withheldBlocks: number;
  readonly createdAt: string;
  /**
   * Hidden FROM YOU by moderation: `body` is a neutral placeholder and nothing
   * of the author or content is present. Render your own translated word.
   * A turn you had on screen that arrives `hidden` is a RETRACTION — take it
   * down (`retractedTurnIds` finds them). A space member has no socket, so
   * this is how a retraction reaches you: on the next `thread()` read.
   */
  readonly hidden: boolean;
  /**
   * YOUR OWN turn, which the room cannot see. You still get your words;
   * render it marked, so a hide is never a silent shadow-ban.
   */
  readonly hiddenFromOthers: boolean;
}

export interface SpaceThread {
  readonly conversationId: string | null;
  readonly mode: 'private' | 'shared';
  readonly turns: readonly SpaceTurn[];
  readonly nextCursor: string | null;
  /** YOUR state, never anybody else's. */
  readonly you: {
    readonly memberId: string;
    readonly readThroughAt: string | null;
    readonly dismissed: readonly string[];
  };
}

export interface SpatialOutcome {
  readonly kind:
    | 'reached'
    | 'looked_at'
    | 'picked_up'
    | 'tried_on'
    | 'completed'
    | 'abandoned'
    | 'failed';
  /** The place reached or the thing tried on. A NAME, never coordinates. */
  readonly target?: string;
  /** The step completed, abandoned or failed. */
  readonly step?: string;
  readonly flow?: string;
  readonly surfaceId?: string;
  readonly text?: string;
  readonly blocks?: unknown;
  readonly data?: Record<string, unknown>;
  /** Your own handle, so a re-report from another worker is not a second row. */
  readonly ref?: string;
  readonly occurredAt?: string;
}

export interface RecordedOutcome {
  readonly id: string;
  readonly kind: SpatialOutcome['kind'];
  readonly created: boolean;
  /**
   * False with `withheldBy` set means the space withheld it: the row exists
   * and nothing in the conversation was told, including the agent. It is not
   * a failure.
   */
  readonly announced: boolean;
  readonly withheldBy: string | null;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly occurredAt: string;
}

/**
 * Ids visible in `previous` and hidden in `next`: what a polling client must
 * take off the screen. Pure — keep the last read and diff it against each
 * new one.
 */
export function retractedTurnIds(
  previous: ReadonlyArray<Pick<SpaceTurn, 'id' | 'hidden'>>,
  next: ReadonlyArray<Pick<SpaceTurn, 'id' | 'hidden'>>,
): string[] {
  const wasVisible = new Set(previous.filter((t) => !t.hidden).map((t) => t.id));
  return next.filter((t) => t.hidden && wasVisible.has(t.id)).map((t) => t.id);
}

/**
 * Carry the space's operator switch onto the conversation that receives bot
 * actions. After `join`, call this once with the conversation your world is
 * bound to; if the space turned bot-fired capabilities off, the conversation
 * drops (and refuses to the server) any it is handed, so no handler — and no
 * world — ever acts on one.
 */
export function applySpacePolicy(
  conversation: { setUnpromptedAllowed(allowed: boolean): void },
  joined: Pick<JoinedSpace, 'space'>,
): void {
  conversation.setUnpromptedAllowed(joined.space.unpromptedCapabilities);
}

export class SpaceClient {
  private readonly apiUrl: string;
  private token: string | null;
  private slug: string | null = null;

  public constructor(private readonly options: SpaceClientOptions) {
    this.apiUrl = (options.apiUrl ?? SPACES_DEFAULT_API_URL).replace(/\/+$/, '');
    this.token = options.memberToken ?? null;
  }

  /** The credential, so a host can persist it and resume without re-joining. */
  public get memberToken(): string | null {
    return this.token;
  }

  public async join(options: JoinSpaceOptions): Promise<JoinedSpace> {
    const joined = (await this.post(`/v1/spaces/${encodeURIComponent(options.slug)}/join`, {
      ...(options.grant === undefined ? {} : { grant: options.grant }),
      ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
      /*
       * The credential we already hold, if any. The server RENEWS that
       * membership rather than creating a second one, which is what makes a
       * retried join idempotent on an `open` space — where a second join
       * would otherwise mint a second key and leave a ghost in the roster.
       */
      ...(this.token === null ? {} : { memberToken: this.token }),
    })) as JoinedSpace;
    this.token = joined.memberToken;
    this.slug = options.slug;
    return joined;
  }

  public async thread(options: { limit?: number; cursor?: string } = {}): Promise<SpaceThread> {
    return (await this.post(`/v1/spaces/${this.slugSegment()}/thread`, {
      memberToken: this.require(),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    })) as SpaceThread;
  }

  public async send(body: string): Promise<{ conversationId: string; messageId: string }> {
    return (await this.post(`/v1/spaces/${this.slugSegment()}/messages`, {
      memberToken: this.require(),
      body,
    })) as { conversationId: string; messageId: string };
  }

  /**
   * Your own read cursor and dismissals.
   *
   * `dismissed` REPLACES, so you can undismiss; `readThroughAt` only ever
   * moves forward, so a second slower view cannot resurrect a cleared badge.
   */
  public async setMyState(state: {
    readThroughAt?: string;
    dismissed?: readonly string[];
  }): Promise<SpaceThread['you']> {
    return (await this.post(`/v1/spaces/${this.slugSegment()}/me`, {
      memberToken: this.require(),
      ...(state.readThroughAt === undefined ? {} : { readThroughAt: state.readThroughAt }),
      ...(state.dismissed === undefined ? {} : { dismissed: [...state.dismissed] }),
    })) as SpaceThread['you'];
  }

  public async reportOutcome(outcome: SpatialOutcome): Promise<RecordedOutcome> {
    return (await this.post(`/v1/spaces/${this.slugSegment()}/outcomes`, {
      memberToken: this.require(),
      outcome,
    })) as RecordedOutcome;
  }

  public async leave(): Promise<void> {
    const token = this.require();
    await this.post(`/v1/spaces/${this.slugSegment()}/leave`, { memberToken: token });
    this.token = null;
  }

  /**
   * The slug segment, encoded — NOT the whole path.
   *
   * This used to be a `path(suffix)` helper that returned the whole path with
   * both the slug and the suffix interpolated, and the suffix being a
   * variable is what made every route this client calls invisible to a reader
   * and to `check-api-route-callers`. That gate flattens an interpolation to
   * a wildcard, so the helper offered one mention with a wildcard in BOTH
   * dynamic positions -- and its segment-wise compare treats either side's
   * wildcard as a match, so that single mention vouched for every one-segment
   * route under `/v1/spaces/:id`, including the three operator-only ones
   * (grant-secret, members, outcomes) that this client must never be taken to
   * call. Measured, not assumed: with the helper in place the gate dropped
   * from 14 uncalled routes to 5, and 3 of the 9 it absolved were operator
   * routes with no caller at all.
   *
   * So each call site below writes its own full literal. The cost is six
   * repetitions of a prefix; what it buys is that grepping this package for
   * the route prefix answers "what does this client call", which is the
   * question both the gate and the next reader are asking.
   *
   * Do NOT write that two-wildcard path literally in a comment here. The
   * first draft did, the trailing wildcard-slash closed this very block
   * comment 13 lines early, and the leaked prose became two PHANTOM caller
   * mentions -- `/v1/spaces/:id` and the bare collection path -- which the
   * gate used to absolve three real routes. A comment that silences the gate
   * is worse than one that is merely wrong.
   */
  private slugSegment(): string {
    if (this.slug === null) {
      throw new ChatlyError('no_session', 'join a space first');
    }
    return encodeURIComponent(this.slug);
  }

  private require(): string {
    if (this.token === null) {
      throw new ChatlyError('no_session', 'join a space first');
    }
    return this.token;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await this.options.fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicId: this.options.publicId, ...body }),
    });
    if (!res.ok) {
      /*
       * Read ONCE: `res.json()` is single-use, so the error body cannot be
       * read again for a retry decision. The server's own `error.code`
       * travels on `serverCode` — `space_grant_required` and
       * `space_grant_invalid` are different problems with different fixes, and
       * a host that cannot tell them apart will blame the wrong half of its
       * own integration.
       */
      const error = await readErrorBody(res);
      throw new ChatlyError('request_failed', error.message ?? `POST ${path} failed`, {
        httpStatus: res.status,
        serverCode: error.code,
      });
    }
    return res.json();
  }
}

/**
 * The host resuming a session passes `memberToken`.
 *
 * Deliberately not read from storage here: `localStorage` access THROWS in a
 * private window, with blocked site data and on an opaque origin, and a world
 * client may have no storage at all. Where to keep a credential is the host's
 * decision and the core does not guess — `createSafeStorage` is there for a
 * host that wants the browser's.
 */
export function createSpaceClient(options: SpaceClientOptions): SpaceClient {
  return new SpaceClient(options);
}
