/**
 * A host surface, for a host that embeds the core instead of the widget.
 *
 * The widget has had `Chatly('setContext', { surface })` and the `action`
 * event since ADR 0063; a world, a game or a headset running this package had
 * neither, so it could not tell the bot what it could do and never heard the
 * bot ask. Same route (`POST /v1/widget/context`), same realtime event
 * (`host.capability_invoked`), same answer (`reportAction`) — nothing new on
 * the server.
 *
 * Types only here, plus the one forgiving reader: the server is the
 * authority on every rule (an `equivalent` is required, no float arguments,
 * no position-named state), and a capability it drops comes back in
 * `surfaceRejected` with the reason.
 */

/** What a person or a screen reader gets instead of the world doing it. Required. */
export type CapabilityEquivalent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'url'; readonly href: string; readonly text?: string };

export interface HostCapabilityDeclaration {
  /** A dotted identifier naming an intent: `world.walk_to`, never a position. */
  readonly name: string;
  /** The button text when a bot puts it on a card. */
  readonly label: string;
  /** What the bot reads to decide when to offer it. */
  readonly description?: string;
  /** A small JSON-Schema subset: integers need both bounds, strings a length or enum. */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Opt in to the bot firing it WITHOUT a press. Off by default. */
  readonly unprompted?: boolean;
  readonly equivalent: CapabilityEquivalent;
}

/** Where the visitor is, in names. Five keys; anything else is dropped and reported. */
export interface HostSurfaceState {
  readonly room?: string;
  readonly zone?: string;
  readonly near?: readonly string[];
  readonly lookingAt?: string;
  readonly holding?: readonly string[];
}

export type HostSurface =
  | {
      /** The slot. Defaults to `kind`; two surfaces open at once need two ids. */
      readonly id?: string;
      /** `world`, `game`, `headset`, `app`, `web` — open, lower-case. */
      readonly kind: string;
      /** Omit to leave the stored list alone; a state-only call keeps it. */
      readonly capabilities?: readonly HostCapabilityDeclaration[];
      readonly state?: HostSurfaceState;
    }
  | { readonly id: string; readonly clear: true };

export interface SurfaceResult {
  /** What the server dropped and why: `capabilities[2]`, `state.position`, … */
  readonly surfaceRejected: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/** A bot asking this surface to act, without a press. Answer it with `reportAction`. */
export interface HostCapabilityInvocation {
  /** Pass as `actionId` to `reportAction`. */
  readonly invocationId: string;
  /** The visible announcement the bot posted; pass as `messageId`. */
  readonly messageId: string;
  readonly surfaceId: string;
  readonly capability: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
}

/**
 * Read a `host.capability_invoked` payload, or null. A stale one (a socket
 * that reconnected after the deadline) is null too: it is not acted on.
 * Mirrors `readHostCapability` in the widget.
 */
export function readHostInvocation(
  p: Readonly<Record<string, unknown>>,
  now: number,
): HostCapabilityInvocation | null {
  const { invocationId, messageId, surfaceId, capability, args, expiresAt } = p;
  if (
    typeof invocationId !== 'string' ||
    typeof messageId !== 'string' ||
    typeof surfaceId !== 'string' ||
    typeof capability !== 'string' ||
    typeof expiresAt !== 'string' ||
    typeof args !== 'object' ||
    args === null ||
    // NaN fails the comparison, so an unparseable deadline drops too.
    !(now <= Date.parse(expiresAt))
  ) {
    return null;
  }
  return {
    invocationId,
    messageId,
    surfaceId,
    capability,
    args: args as Record<string, unknown>,
    expiresAt,
  };
}
