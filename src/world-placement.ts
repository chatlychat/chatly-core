/**
 * Resolving a world-space placement REQUEST against what a host can actually
 * do — and the point of the file is that it always resolves.
 *
 * ── Requests, never guarantees ───────────────────────────────────────────
 *
 * `target: 'self'` on a url action is honoured only on the embedding page's
 * own origin; the host decides and Chatly asks. A world is the same contract
 * with much more at stake, because a world owns its comfort rules, its
 * collision, its camera, its accessibility settings and possibly a seated
 * player who cannot turn round. A protocol that let a remote service place
 * geometry in somebody else's scene would be one that could ruin it.
 *
 * So this function takes the author's request plus the host's own declaration
 * of what it can do, and returns a COMPLETE placement the host can honour,
 * together with a list of what it had to change and why. Every field of the
 * result is filled; a host never has to guess, and nothing it is handed is
 * something it said it could not do.
 *
 * ── An ABSENT ability means unknown, not unsupported ─────────────────────
 *
 * `resolveWorldPlacement(request, {})` returns the request, filled with
 * defaults and otherwise untouched. That is the only safe reading: most hosts
 * will declare nothing at first, and treating silence as "supports nothing"
 * would downgrade every request on every host that had not yet got round to
 * describing itself — a feature that works worse the less you configure it.
 * A host that genuinely cannot billboard says `billboard: ['none']`, and an
 * empty array is a real declaration (it means "none of them") rather than an
 * absent one.
 *
 * ── There is no result that shows nothing ────────────────────────────────
 *
 * `ifUnsupported` is `nearest` or `hud`, and the shared schema explains at
 * length why `omit` is not on offer: a conversation surface that vanishes
 * because a host could not place it as asked is a visitor who can no longer
 * reach support. Every path here returns a placement, and a host that can
 * honour neither the anchor nor a HUD still gets one and still shows the
 * ordinary conversation.
 *
 * Parity: the vocabulary is declared as zod in
 * `packages/shared/src/spatial/placement.ts` and restated here because a
 * published zero-dependency package cannot import an internal one.
 * `core-parity.spec.ts` in that directory fails on drift.
 */

export const PLACEMENT_ANCHORS = ['viewer', 'agent', 'place', 'world'] as const;
export type PlacementAnchor = (typeof PLACEMENT_ANCHORS)[number];

export const PLACEMENT_FOLLOWS = ['none', 'lazy', 'locked'] as const;
export type PlacementFollow = (typeof PLACEMENT_FOLLOWS)[number];

export const PLACEMENT_BILLBOARDS = ['none', 'yaw', 'full'] as const;
export type PlacementBillboard = (typeof PLACEMENT_BILLBOARDS)[number];

export const PLACEMENT_FALLBACKS = ['nearest', 'hud'] as const;
export type PlacementFallback = (typeof PLACEMENT_FALLBACKS)[number];

export interface WorldPlacementRequest {
  readonly anchor?: PlacementAnchor;
  readonly ref?: string;
  readonly follow?: PlacementFollow;
  readonly billboard?: PlacementBillboard;
  readonly distanceMetres?: number;
  readonly heightMetres?: number;
  readonly widthMetres?: number;
  readonly ifUnsupported?: PlacementFallback;
}

/**
 * What the host says it can do. Every field optional; see the header on why
 * absent is "unknown" and an empty array is "none".
 */
export interface WorldHostAbilities {
  readonly anchors?: readonly PlacementAnchor[];
  readonly follow?: readonly PlacementFollow[];
  readonly billboard?: readonly PlacementBillboard[];
  /** The host's own comfort range. A request outside it is clamped, not refused. */
  readonly minDistanceMetres?: number;
  readonly maxDistanceMetres?: number;
  readonly maxWidthMetres?: number;
  /** Whether the host has a flat overlay to fall back to. */
  readonly hud?: boolean;
}

/**
 * One thing that was asked for and not done. `requested` is kept verbatim so
 * a host can log what the author wanted, which is the only way an author ever
 * finds out: this resolution happens in the visitor's client, where no
 * server-side validation error could reach them. Same posture as
 * `surfaceRejected` on a host surface.
 */
export interface PlacementChange {
  readonly field: 'anchor' | 'ref' | 'follow' | 'billboard' | 'distanceMetres' | 'widthMetres';
  readonly requested: string | number;
  readonly honoured: string | number | null;
  readonly reason: string;
}

export interface ResolvedWorldPlacement {
  /** `world` placed in the scene, `hud` as a flat overlay. */
  readonly mode: 'world' | 'hud';
  readonly anchor: PlacementAnchor;
  readonly ref: string | null;
  readonly follow: PlacementFollow;
  readonly billboard: PlacementBillboard;
  readonly distanceMetres: number;
  readonly heightMetres: number;
  readonly widthMetres: number;
  readonly changed: readonly PlacementChange[];
}

/**
 * What Chatly asks for when the author says nothing.
 *
 * `viewer` + `lazy` + `yaw` is the conventional comfortable arrangement in
 * every XR design guideline, and each part earns its place: a conversation
 * must stay REACHABLE, because a panel left behind in a scene is a
 * conversation the visitor loses; `lazy` rather than `locked` because a
 * surface welded to the head is nauseating within seconds; `yaw` rather than
 * `full` because yaw-only keeps text upright and readable from anywhere on
 * the floor, where full billboarding tilts it the moment the viewer is above
 * or below.
 *
 * 1.0m at 10cm below the anchor's reference height is arm's length and
 * slightly down — where a person holds something they are reading — and 0.6m
 * wide is about 40 characters of body text at a comfortable size, which is
 * the line length typography has agreed on for a century.
 */
export const PLACEMENT_DEFAULTS = {
  anchor: 'viewer',
  follow: 'lazy',
  billboard: 'yaw',
  distanceMetres: 1,
  heightMetres: -0.1,
  widthMetres: 0.6,
} as const;

/**
 * Where each anchor goes when the host cannot honour it, in order.
 *
 * Each step gives up SPECIFICITY rather than usefulness. A named place
 * becomes "somewhere in the scene" becomes "with the person"; an agent-bound
 * surface goes to the person first, because the thing an agent anchor was
 * really asking for is that the conversation be where the visitor is looking.
 * `viewer` is last in every chain because it is the one a host with nothing
 * else can always do: it needs no scene knowledge at all.
 */
const ANCHOR_FALLBACKS: { readonly [A in PlacementAnchor]: readonly PlacementAnchor[] } = {
  place: ['world', 'viewer'],
  agent: ['viewer', 'world'],
  world: ['viewer'],
  viewer: ['world'],
};

/** Absent means unknown: a host that declared nothing supports everything. */
function supports<T>(declared: readonly T[] | undefined, value: T): boolean {
  return declared === undefined || declared.includes(value);
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let out = value;
  if (min !== undefined && out < min) {
    out = min;
  }
  if (max !== undefined && out > max) {
    out = max;
  }
  return out;
}

export function resolveWorldPlacement(
  request: WorldPlacementRequest = {},
  host: WorldHostAbilities = {},
): ResolvedWorldPlacement {
  const changed: PlacementChange[] = [];
  const wantAnchor = request.anchor ?? PLACEMENT_DEFAULTS.anchor;
  const fallbackMode = request.ifUnsupported ?? 'nearest';

  /*
   * The anchor, and the HUD branch is taken before the chain is walked.
   *
   * An author who said `ifUnsupported: 'hud'` has told us they would rather
   * have a flat overlay than a surface in the wrong place — that is a real
   * preference for an author whose request was about a specific spot, and
   * second-guessing it by walking the chain anyway would make the field
   * decorative. A host with no HUD still gets the chain, and a change record
   * saying its own `hud: false` is why.
   */
  let anchor = wantAnchor;
  let mode: 'world' | 'hud' = 'world';
  if (!supports(host.anchors, wantAnchor)) {
    if (fallbackMode === 'hud' && host.hud === true) {
      mode = 'hud';
      changed.push({
        field: 'anchor',
        requested: wantAnchor,
        honoured: null,
        reason: 'the host does not support this anchor; shown as a HUD overlay as requested',
      });
    } else {
      const next = ANCHOR_FALLBACKS[wantAnchor].find((a) => supports(host.anchors, a));
      anchor = next ?? wantAnchor;
      changed.push({
        field: 'anchor',
        requested: wantAnchor,
        honoured: anchor,
        reason:
          next === undefined
            ? 'the host supports none of the anchors; honoured as asked rather than showing nothing'
            : fallbackMode === 'hud'
              ? 'the host does not support this anchor and has no HUD; fell back to the nearest it does'
              : 'the host does not support this anchor; fell back to the nearest it does',
      });
    }
  }

  /*
   * `ref` survives only as long as the `place` anchor it belongs to. It is
   * kept in the change record rather than merely deleted, because a host that
   * logs it is the only way an author learns their destination went nowhere —
   * the shared schema refuses a `ref` without `anchor: 'place'` at the write
   * boundary, but a fallback can take the anchor away afterwards.
   */
  let ref: string | null = null;
  if (request.ref !== undefined) {
    if (anchor === 'place' && mode === 'world') {
      ref = request.ref;
    } else {
      changed.push({
        field: 'ref',
        requested: request.ref,
        honoured: null,
        reason: 'the place anchor was not honoured, so there is no place to resolve the ref in',
      });
    }
  }

  const wantFollow = request.follow ?? PLACEMENT_DEFAULTS.follow;
  let follow = wantFollow;
  if (!supports(host.follow, wantFollow)) {
    /*
     * `locked` degrades to `lazy` before `none`, which is the whole reason
     * this is a chain and not a flat "unsupported means off". An author who
     * asked for a surface that tracks the viewer exactly wants it to TRACK;
     * `lazy` is that request, made comfortable, and `none` is a different
     * answer to a different question.
     */
    const chain: readonly PlacementFollow[] =
      wantFollow === 'locked' ? ['lazy', 'none'] : wantFollow === 'lazy' ? ['none'] : ['lazy'];
    const next = chain.find((f) => supports(host.follow, f));
    follow = next ?? wantFollow;
    changed.push({
      field: 'follow',
      requested: wantFollow,
      honoured: follow,
      reason: 'the host does not support this follow behaviour',
    });
  }

  const wantBillboard = request.billboard ?? PLACEMENT_DEFAULTS.billboard;
  let billboard = wantBillboard;
  if (!supports(host.billboard, wantBillboard)) {
    /* `full` degrades to `yaw` for the same reason `locked` degrades to `lazy`. */
    const chain: readonly PlacementBillboard[] =
      wantBillboard === 'full' ? ['yaw', 'none'] : wantBillboard === 'yaw' ? ['none'] : ['yaw'];
    const next = chain.find((b) => supports(host.billboard, b));
    billboard = next ?? wantBillboard;
    changed.push({
      field: 'billboard',
      requested: wantBillboard,
      honoured: billboard,
      reason: 'the host does not support this billboard behaviour',
    });
  }

  const wantDistance = request.distanceMetres ?? PLACEMENT_DEFAULTS.distanceMetres;
  const distanceMetres = clamp(wantDistance, host.minDistanceMetres, host.maxDistanceMetres);
  if (distanceMetres !== wantDistance) {
    changed.push({
      field: 'distanceMetres',
      requested: wantDistance,
      honoured: distanceMetres,
      reason: "clamped into the host's own comfort range",
    });
  }

  const wantWidth = request.widthMetres ?? PLACEMENT_DEFAULTS.widthMetres;
  const widthMetres = clamp(wantWidth, undefined, host.maxWidthMetres);
  if (widthMetres !== wantWidth) {
    changed.push({
      field: 'widthMetres',
      requested: wantWidth,
      honoured: widthMetres,
      reason: 'wider than the host allows',
    });
  }

  return {
    mode,
    anchor,
    ref,
    follow,
    billboard,
    distanceMetres,
    /*
     * `heightMetres` is never changed and has no host bound, and that is a
     * decision rather than an oversight: it is signed and relative to the
     * anchor's own reference height, so the schema's own ±1.5m is already
     * inside every plausible scene, and a host that dislikes it moves the
     * surface itself. Adding a bound nobody would set would be a field
     * offered and never honoured.
     */
    heightMetres: request.heightMetres ?? PLACEMENT_DEFAULTS.heightMetres,
    widthMetres,
    changed,
  };
}
