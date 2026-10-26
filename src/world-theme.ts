/**
 * `worldTheme`, resolved: one complete token set for a host to draw with.
 *
 * ── What a host gets, and why it is complete ─────────────────────────────
 *
 * Every token comes back filled. A world renderer has no cascade, no
 * stylesheet and no `var(--cl-x, <fallback>)` to fall through, so "unset"
 * would mean each host inventing its own idea of a panel — and a surface that
 * looks different in every world is not a product with a theme. This function
 * is the last word: the defaults below are Chatly's, an operator's settings
 * layer over them, and the dark palette layers over that.
 *
 * ── The layering, and the trap it inherits ───────────────────────────────
 *
 * Built-in defaults for the resolved scheme, then the base theme, then
 * `darkTheme` when the scheme resolved to dark. That is `resolveWidgetTheme`'s
 * order, and it carries the same sharp edge, which is worth stating because
 * it has already cost this repo a release:
 *
 *   **an explicit base setting outranks the dark DEFAULT.** An operator who
 *   sets `panelColor: '#f0fff4'` and nothing else gets that mint panel in a
 *   dark scene too, with the dark TEXT default on it, which is unreadable.
 *   The widget shipped exactly this — a brand-green header on a Chatly-navy
 *   panel — because an explicit value is explicit and no default may silently
 *   win over one. `darkTheme` is the fix and the only fix, and it exists
 *   because of that bug rather than for completeness.
 *
 * `darkTheme` is read ONE level deep. An overlay has no `darkTheme` of its
 * own, so there is no recursion to bound.
 *
 * ── `auto` asks the host, because only the host knows ────────────────────
 *
 * A world has a time of day, interiors, weather and possibly a player
 * accessibility setting, and none of that is visible from here — exactly as
 * the widget cannot know `prefers-color-scheme` without asking the browser.
 * So `colorScheme: 'auto'` (and an absent one) defers to `scene`, which the
 * host reports; an operator who said `dark` means dark whatever the scene is,
 * because that is a brand decision rather than an observation.
 *
 * ── Layers above the channel's theme ─────────────────────────────────────
 *
 * The channel's `worldTheme` arrives on init (`ChatlyCore.worldTheme`); a
 * world that dresses one room differently passes that room's theme in
 * `layers`. Each token is taken from the most specific layer that sets it —
 * its `darkTheme` first in a dark scheme, then its base — before the layer
 * below is consulted. A per-room look is the host's to hold: Chatly stores no
 * rooms.
 *
 * ── Reduced motion always wins ───────────────────────────────────────────
 *
 * `reducedMotion: true` (the viewer's setting, which only the host can read)
 * resolves every motion token to `none` and the card trail off, whatever any
 * layer says. No token can turn motion back on for a viewer who asked for
 * less: that is an accessibility setting, not a style.
 *
 * Parity: the schemas are zod in `packages/shared/src/spatial/theme.ts` and
 * restated here because a published zero-dependency package cannot import an
 * internal one. `core-parity.spec.ts` there fails on drift.
 */

export const PANEL_MATERIALS = ['glass', 'matte', 'solid', 'none'] as const;
export type PanelMaterial = (typeof PANEL_MATERIALS)[number];

export const CARD_PEDESTALS = ['plinth', 'float', 'hanger', 'none'] as const;
export const BUBBLE_SHAPES = ['rounded', 'square', 'cloud', 'none'] as const;
export const TYPING_LOOKS = ['dots', 'pulse', 'avatar', 'none'] as const;
export const MOTION_ENTRANCES = ['fade', 'scale', 'slide', 'none'] as const;
export const MOTION_PICKS = ['rise', 'drop', 'fade', 'none'] as const;

export const TEXT_SCALE_MIN = 0.5;
export const TEXT_SCALE_MAX = 3;

/** The scheme-sensitive tokens. See the shared schema for why `textScale` is not one. */
export interface WorldThemeOverlay {
  readonly panelMaterial?: PanelMaterial;
  readonly panelColor?: string;
  readonly panelOpacity?: number;
  readonly panelEmissive?: number;
  readonly textColor?: string;
  readonly textEmissive?: number;
  readonly accentColor?: string;
  readonly accentTextColor?: string;
  readonly textOutlineColor?: string;
  readonly bubbleColor?: string;
  readonly cardHighlightColor?: string;
}

/** The scheme-independent token groups: panel shape, type, cards, speech, sound, motion. */
export interface WorldThemeBase {
  readonly panelRadiusMetres?: number;
  readonly fontUrl?: string;
  readonly fontWeight?: number;
  readonly textOutlineWidth?: number;
  readonly cardPedestal?: (typeof CARD_PEDESTALS)[number];
  readonly cardBeam?: boolean;
  readonly cardPriceLabel?: boolean;
  readonly cardTrail?: boolean;
  readonly cardSpacingMetres?: number;
  readonly bubbleShape?: (typeof BUBBLE_SHAPES)[number];
  readonly bubbleTail?: boolean;
  readonly bubbleMaxWidthMetres?: number;
  readonly bubbleDurationMs?: number;
  readonly typingLook?: (typeof TYPING_LOOKS)[number];
  readonly soundSend?: string;
  readonly soundReceive?: string;
  readonly soundPick?: string;
  readonly soundSelect?: string;
  readonly soundSpatial?: boolean;
  readonly soundVolume?: number;
  readonly motionEntrance?: (typeof MOTION_ENTRANCES)[number];
  readonly motionPick?: (typeof MOTION_PICKS)[number];
}

export interface WorldTheme extends WorldThemeOverlay, WorldThemeBase {
  readonly textScale?: number;
  readonly colorScheme?: 'light' | 'dark' | 'auto';
  readonly darkTheme?: WorldThemeOverlay;
}

/** Every token filled. A URL token the theme leaves unset is `null`: no font, no sound. */
export type ResolvedWorldTheme = {
  readonly scheme: 'light' | 'dark';
  readonly textScale: number;
} & { readonly [K in keyof WorldThemeOverlay]-?: NonNullable<WorldThemeOverlay[K]> } & {
  readonly [K in keyof WorldThemeBase]-?: K extends UrlToken
    ? string | null
    : NonNullable<WorldThemeBase[K]>;
};

type UrlToken = 'fontUrl' | 'soundSend' | 'soundReceive' | 'soundPick' | 'soundSelect';

/**
 * The light defaults. A matte panel rather than glass, because glass is the
 * prettier default and the worse one for text: a refractive surface puts the
 * scene behind the letters, and a conversation is read, not admired.
 * `panelEmissive: 0.15` is a small lift so a panel in shade is still legible
 * without reading as a lamp.
 */
export const WORLD_THEME_LIGHT_DEFAULTS = {
  panelMaterial: 'matte',
  panelColor: '#ffffff',
  panelOpacity: 0.96,
  panelEmissive: 0.15,
  textColor: '#111827',
  textEmissive: 0.1,
  accentColor: '#4f46e5',
  accentTextColor: '#ffffff',
  textOutlineColor: '#ffffff',
  bubbleColor: '#ffffff',
  cardHighlightColor: '#4f46e5',
} as const satisfies Required<WorldThemeOverlay>;

/**
 * The dark defaults, and the two that are not simply inverted.
 *
 * Both emissives roughly double, because in a dark scene the scene supplies
 * almost no light and an unlit surface is a black rectangle with black text
 * on it. And the accent LIGHTENS: `#4f46e5` is a good brand indigo on white
 * and about 2.3:1 on a near-black panel, which fails WCAG AA for anything,
 * so the dark default is the lighter indigo and `accentTextColor` flips to the
 * dark ink that is readable on it. An operator's own brand colour set in the
 * base theme will outrank this — see the header — which is the single most
 * likely way a world surface ends up unreadable.
 */
export const WORLD_THEME_DARK_DEFAULTS = {
  panelMaterial: 'matte',
  panelColor: '#111827',
  panelOpacity: 0.92,
  panelEmissive: 0.35,
  textColor: '#f9fafb',
  textEmissive: 0.35,
  accentColor: '#818cf8',
  accentTextColor: '#111827',
  textOutlineColor: '#000000',
  bubbleColor: '#1f2937',
  cardHighlightColor: '#818cf8',
} as const satisfies Required<WorldThemeOverlay>;

/** Scheme-independent: a type size is about the viewer, not the light. */
export const WORLD_THEME_TEXT_SCALE_DEFAULT = 1;

/**
 * The quiet defaults: no pedestal, beam, trail, font or sound unless an
 * operator asks. A world that has not been themed should look like a
 * conversation, not a fairground.
 */
export const WORLD_THEME_BASE_DEFAULTS: {
  readonly [K in keyof WorldThemeBase]-?: ResolvedWorldTheme[K];
} = {
  panelRadiusMetres: 0.02,
  fontUrl: null,
  fontWeight: 400,
  textOutlineWidth: 0,
  cardPedestal: 'none',
  cardBeam: false,
  cardPriceLabel: true,
  cardTrail: false,
  cardSpacingMetres: 0.35,
  bubbleShape: 'rounded',
  bubbleTail: true,
  bubbleMaxWidthMetres: 0.6,
  bubbleDurationMs: 8000,
  typingLook: 'dots',
  soundSend: null,
  soundReceive: null,
  soundPick: null,
  soundSelect: null,
  soundSpatial: true,
  soundVolume: 0.6,
  motionEntrance: 'fade',
  motionPick: 'rise',
};

export interface ResolveWorldThemeOptions {
  /**
   * What the host says the scene's light is. Consulted only when the theme's
   * `colorScheme` is `auto` or absent. Defaults to `light`.
   */
  readonly scene?: 'light' | 'dark';
  /**
   * More specific themes over `theme`, least specific first — a room's look
   * over the channel's. A host-held layer; Chatly stores no rooms.
   */
  readonly layers?: readonly WorldTheme[];
  /** The viewer asked for less motion. Beats every motion token in every layer. */
  readonly reducedMotion?: boolean;
}

/**
 * Pick the scheme, then layer. Pure, and safe to call every frame — though a
 * host should not: the result changes only when the theme or the scene does.
 */
export function resolveWorldTheme(
  theme: WorldTheme = {},
  opts: ResolveWorldThemeOptions = {},
): ResolvedWorldTheme {
  // Most specific first.
  const layers: readonly WorldTheme[] = [...(opts.layers ?? [])].reverse().concat(theme);
  const first = <T>(read: (layer: WorldTheme) => T | undefined): T | undefined => {
    for (const layer of layers) {
      const v = read(layer);
      if (v !== undefined) {
        return v;
      }
    }
    return undefined;
  };
  const declared = first((l) => l.colorScheme) ?? 'auto';
  const scheme: 'light' | 'dark' = declared === 'auto' ? (opts.scene ?? 'light') : declared;
  const defaults = scheme === 'dark' ? WORLD_THEME_DARK_DEFAULTS : WORLD_THEME_LIGHT_DEFAULTS;

  /*
   * A layer's `darkTheme` is read only in a dark scheme, and before that
   * layer's base, so it wins over it. An `undefined` member of any object
   * must not overwrite the layer below it, which is why each token is picked
   * with `??` rather than by spreading the objects together: with
   * `exactOptionalPropertyTypes: false`, `{ panelColor: undefined }` is a
   * shape a caller really can build (a JS host writing
   * `panelColor: someVar`), and a spread of it would wipe the default and
   * render whatever a renderer does with `undefined`. The widget's copy layer
   * learned this the expensive way: a filter over the MERGED object is the
   * subtly wrong fix, because by then a higher layer's `undefined` has
   * already overwritten a lower layer's real value. Picking per token per
   * layer is the only order that is right.
   */
  const pick = <K extends keyof WorldThemeOverlay>(key: K): NonNullable<WorldThemeOverlay[K]> =>
    (first((l) => (scheme === 'dark' ? l.darkTheme?.[key] : undefined) ?? l[key]) ??
      defaults[key]) as NonNullable<WorldThemeOverlay[K]>;
  const base = <K extends keyof WorldThemeBase>(key: K): ResolvedWorldTheme[K] =>
    (first((l) => l[key]) ?? WORLD_THEME_BASE_DEFAULTS[key]) as ResolvedWorldTheme[K];
  const still = opts.reducedMotion === true;

  return {
    scheme,
    panelMaterial: pick('panelMaterial'),
    panelColor: pick('panelColor'),
    panelOpacity: pick('panelOpacity'),
    panelEmissive: pick('panelEmissive'),
    textColor: pick('textColor'),
    textEmissive: pick('textEmissive'),
    accentColor: pick('accentColor'),
    accentTextColor: pick('accentTextColor'),
    textOutlineColor: pick('textOutlineColor'),
    bubbleColor: pick('bubbleColor'),
    cardHighlightColor: pick('cardHighlightColor'),
    textScale: first((l) => l.textScale) ?? WORLD_THEME_TEXT_SCALE_DEFAULT,
    panelRadiusMetres: base('panelRadiusMetres'),
    fontUrl: base('fontUrl'),
    fontWeight: base('fontWeight'),
    textOutlineWidth: base('textOutlineWidth'),
    cardPedestal: base('cardPedestal'),
    cardBeam: base('cardBeam'),
    cardPriceLabel: base('cardPriceLabel'),
    cardTrail: still ? false : base('cardTrail'),
    cardSpacingMetres: base('cardSpacingMetres'),
    bubbleShape: base('bubbleShape'),
    bubbleTail: base('bubbleTail'),
    bubbleMaxWidthMetres: base('bubbleMaxWidthMetres'),
    bubbleDurationMs: base('bubbleDurationMs'),
    typingLook: base('typingLook'),
    soundSend: base('soundSend'),
    soundReceive: base('soundReceive'),
    soundPick: base('soundPick'),
    soundSelect: base('soundSelect'),
    soundSpatial: base('soundSpatial'),
    soundVolume: base('soundVolume'),
    motionEntrance: still ? 'none' : base('motionEntrance'),
    motionPick: still ? 'none' : base('motionPick'),
  };
}
