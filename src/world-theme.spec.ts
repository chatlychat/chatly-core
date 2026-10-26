import { describe, expect, it } from 'vitest';

import {
  WORLD_THEME_DARK_DEFAULTS,
  WORLD_THEME_LIGHT_DEFAULTS,
  resolveWorldTheme,
  type ResolvedWorldTheme,
} from './world-theme.js';

const TOKENS = [
  'panelMaterial',
  'panelColor',
  'panelOpacity',
  'panelEmissive',
  'textColor',
  'textEmissive',
  'accentColor',
  'accentTextColor',
] as const;

describe('a host is handed a COMPLETE token set', () => {
  it('every token is filled with no theme at all', () => {
    const t = resolveWorldTheme();
    for (const key of TOKENS) {
      expect(t[key]).toBeDefined();
    }
    expect(t.textScale).toBe(1);
    expect(t.scheme).toBe('light');
  });

  it('no token is ever undefined, whatever the caller passes', () => {
    const cases = [
      {},
      { colorScheme: 'dark' as const },
      { colorScheme: 'auto' as const, darkTheme: {} },
      { panelColor: '#f0fff4', darkTheme: { textColor: '#ffffff' } },
    ];
    for (const theme of cases) {
      for (const scene of ['light', 'dark'] as const) {
        const t = resolveWorldTheme(theme, { scene });
        for (const key of TOKENS) {
          expect({ theme, scene, key, value: t[key] }).not.toMatchObject({ value: undefined });
        }
      }
    }
  });
});

describe('auto asks the host; an explicit scheme does not', () => {
  it('absent colorScheme follows the scene', () => {
    expect(resolveWorldTheme({}, { scene: 'dark' }).scheme).toBe('dark');
    expect(resolveWorldTheme({}, { scene: 'light' }).scheme).toBe('light');
  });

  it('auto follows the scene', () => {
    expect(resolveWorldTheme({ colorScheme: 'auto' }, { scene: 'dark' }).scheme).toBe('dark');
  });

  it('an explicit dark stays dark in a bright scene: a brand decision, not an observation', () => {
    expect(resolveWorldTheme({ colorScheme: 'dark' }, { scene: 'light' }).scheme).toBe('dark');
  });

  it('an explicit light stays light in a dark scene', () => {
    const t = resolveWorldTheme({ colorScheme: 'light' }, { scene: 'dark' });
    expect(t.scheme).toBe('light');
    expect(t.panelColor).toBe(WORLD_THEME_LIGHT_DEFAULTS.panelColor);
  });

  it('no scene reported defaults to light', () => {
    expect(resolveWorldTheme({ colorScheme: 'auto' }).scheme).toBe('light');
  });
});

describe('layering: defaults, then the theme, then darkTheme', () => {
  it('the dark defaults apply in a dark scheme with no darkTheme', () => {
    const t = resolveWorldTheme({}, { scene: 'dark' });
    expect(t.panelColor).toBe(WORLD_THEME_DARK_DEFAULTS.panelColor);
    expect(t.textColor).toBe(WORLD_THEME_DARK_DEFAULTS.textColor);
    expect(t.panelEmissive).toBe(WORLD_THEME_DARK_DEFAULTS.panelEmissive);
  });

  it('the base theme beats the defaults', () => {
    const t = resolveWorldTheme({ accentColor: '#00a86b' });
    expect(t.accentColor).toBe('#00a86b');
  });

  it('darkTheme beats the base theme in a dark scheme', () => {
    const t = resolveWorldTheme(
      { panelColor: '#f0fff4', darkTheme: { panelColor: '#04210f' } },
      { scene: 'dark' },
    );
    expect(t.panelColor).toBe('#04210f');
  });

  it('darkTheme is IGNORED in a light scheme', () => {
    const t = resolveWorldTheme(
      { panelColor: '#f0fff4', darkTheme: { panelColor: '#04210f' } },
      { scene: 'light' },
    );
    expect(t.panelColor).toBe('#f0fff4');
  });

  it('a darkTheme token the author did not set falls to the DARK default, not the base', () => {
    const t = resolveWorldTheme(
      { accentColor: '#00a86b', darkTheme: { panelColor: '#04210f' } },
      { scene: 'dark' },
    );
    expect(t.panelColor).toBe('#04210f');
    // The base accent still wins over the dark default -- see the next block.
    expect(t.accentColor).toBe('#00a86b');
    expect(t.textColor).toBe(WORLD_THEME_DARK_DEFAULTS.textColor);
  });

  it('an explicit BASE setting outranks the dark default -- the widget bug, preserved on purpose', () => {
    const t = resolveWorldTheme({ panelColor: '#f0fff4' }, { scene: 'dark' });
    expect(t.panelColor).toBe('#f0fff4');
    expect(t.textColor).toBe(WORLD_THEME_DARK_DEFAULTS.textColor);
  });
});

describe('an undefined member must not wipe the layer below it', () => {
  it('a JS host writing `panelColor: someVar` with someVar undefined gets the default', () => {
    const theme = { panelColor: undefined } as { panelColor?: string };
    expect(resolveWorldTheme(theme).panelColor).toBe(WORLD_THEME_LIGHT_DEFAULTS.panelColor);
  });

  it('an undefined in darkTheme falls to the BASE value, not past it to the default', () => {
    const theme = {
      panelColor: '#f0fff4',
      darkTheme: { panelColor: undefined } as { panelColor?: string },
    };
    expect(resolveWorldTheme(theme, { scene: 'dark' }).panelColor).toBe('#f0fff4');
  });
});

describe('textScale is not scheme-sensitive', () => {
  it('is read from the base theme in either scheme', () => {
    expect(resolveWorldTheme({ textScale: 1.4 }, { scene: 'light' }).textScale).toBe(1.4);
    expect(resolveWorldTheme({ textScale: 1.4 }, { scene: 'dark' }).textScale).toBe(1.4);
  });

  it('is not a key the overlay even has', () => {
    const dark = WORLD_THEME_DARK_DEFAULTS as Record<string, unknown>;
    expect(dark['textScale']).toBeUndefined();
  });
});

describe('the dark defaults are readable, which is the whole reason they differ', () => {
  it('both emissives rise in the dark', () => {
    expect(WORLD_THEME_DARK_DEFAULTS.panelEmissive).toBeGreaterThan(
      WORLD_THEME_LIGHT_DEFAULTS.panelEmissive,
    );
    expect(WORLD_THEME_DARK_DEFAULTS.textEmissive).toBeGreaterThan(
      WORLD_THEME_LIGHT_DEFAULTS.textEmissive,
    );
  });

  it('the accent lightens and its ink flips', () => {
    expect(WORLD_THEME_DARK_DEFAULTS.accentColor).not.toBe(WORLD_THEME_LIGHT_DEFAULTS.accentColor);
    expect(WORLD_THEME_DARK_DEFAULTS.accentTextColor).not.toBe(
      WORLD_THEME_LIGHT_DEFAULTS.accentTextColor,
    );
  });

  it('every default is a hex colour where a colour is expected', () => {
    for (const set of [WORLD_THEME_LIGHT_DEFAULTS, WORLD_THEME_DARK_DEFAULTS]) {
      for (const key of ['panelColor', 'textColor', 'accentColor', 'accentTextColor'] as const) {
        expect(set[key]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe('it is pure', () => {
  it('does not mutate the theme it is given', () => {
    const theme = { panelColor: '#f0fff4', darkTheme: { textColor: '#ffffff' } };
    const before = JSON.stringify(theme);
    resolveWorldTheme(theme, { scene: 'dark' });
    expect(JSON.stringify(theme)).toBe(before);
  });

  it('two calls agree', () => {
    const a: ResolvedWorldTheme = resolveWorldTheme({ textScale: 2 }, { scene: 'dark' });
    const b: ResolvedWorldTheme = resolveWorldTheme({ textScale: 2 }, { scene: 'dark' });
    expect(a).toEqual(b);
  });
});

describe('the token groups beyond colour (2026-10-25)', () => {
  it('fills every group quietly when nothing is set: no font, no sound, no pedestal', () => {
    const r = resolveWorldTheme();
    expect(r.fontUrl).toBeNull();
    expect(r.soundSend).toBeNull();
    expect(r.cardPedestal).toBe('none');
    expect(r.cardBeam).toBe(false);
    expect(r.motionEntrance).toBe('fade');
    expect(r.bubbleColor).toBe(WORLD_THEME_LIGHT_DEFAULTS.bubbleColor);
  });

  it('the new colours follow darkTheme like the old ones', () => {
    const r = resolveWorldTheme(
      { bubbleColor: '#eeeeee', darkTheme: { bubbleColor: '#222222' } },
      { scene: 'dark' },
    );
    expect(r.bubbleColor).toBe('#222222');
    expect(r.cardHighlightColor).toBe(WORLD_THEME_DARK_DEFAULTS.cardHighlightColor);
  });
});

describe('layers: a room over the channel', () => {
  const channel = { panelColor: '#ffffff', cardPedestal: 'plinth', textScale: 1.2 } as const;

  it('takes each token from the most specific layer that sets it', () => {
    const r = resolveWorldTheme(channel, { layers: [{ panelColor: '#ffe4e6' }] });
    expect(r.panelColor).toBe('#ffe4e6');
    expect(r.cardPedestal).toBe('plinth');
    expect(r.textScale).toBe(1.2);
  });

  it("a room's explicit undefined does not wipe the channel below it", () => {
    const r = resolveWorldTheme(channel, { layers: [{ cardPedestal: undefined }] });
    expect(r.cardPedestal).toBe('plinth');
  });

  it("the room's colorScheme wins, and its darkTheme beats the channel's", () => {
    const r = resolveWorldTheme(
      { colorScheme: 'light', darkTheme: { panelColor: '#000001' } },
      { layers: [{ colorScheme: 'dark', darkTheme: { panelColor: '#000002' } }] },
    );
    expect(r.scheme).toBe('dark');
    expect(r.panelColor).toBe('#000002');
  });
});

describe('reduced motion always wins', () => {
  it('turns every motion token off, whatever any layer asks', () => {
    const r = resolveWorldTheme(
      { motionEntrance: 'slide', motionPick: 'rise', cardTrail: true },
      { layers: [{ motionEntrance: 'scale' }], reducedMotion: true },
    );
    expect([r.motionEntrance, r.motionPick, r.cardTrail]).toEqual(['none', 'none', false]);
  });
});
