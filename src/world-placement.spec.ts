import { describe, expect, it } from 'vitest';

import { PLACEMENT_DEFAULTS, resolveWorldPlacement } from './world-placement.js';

describe('a host that declares nothing gets its request through', () => {
  it('an empty request and an empty host is the default placement, unchanged', () => {
    const r = resolveWorldPlacement();
    expect(r).toEqual({
      mode: 'world',
      anchor: 'viewer',
      ref: null,
      follow: 'lazy',
      billboard: 'yaw',
      distanceMetres: 1,
      heightMetres: -0.1,
      widthMetres: 0.6,
      changed: [],
    });
  });

  it('absent abilities mean UNKNOWN, not unsupported', () => {
    const r = resolveWorldPlacement(
      { anchor: 'place', ref: 'nike.door', follow: 'locked', billboard: 'full' },
      {},
    );
    expect(r.anchor).toBe('place');
    expect(r.ref).toBe('nike.door');
    expect(r.follow).toBe('locked');
    expect(r.billboard).toBe('full');
    expect(r.changed).toEqual([]);
  });

  it('an EMPTY array is a real declaration: none of them', () => {
    const r = resolveWorldPlacement({ billboard: 'yaw' }, { billboard: [] });
    expect(r.billboard).toBe('yaw');
    expect(r.changed.map((c) => c.field)).toEqual(['billboard']);
    expect(r.changed[0]?.honoured).toBe('yaw');
  });
});

describe('the anchor fallback chain gives up specificity, never usefulness', () => {
  it('place falls back to world', () => {
    const r = resolveWorldPlacement(
      { anchor: 'place', ref: 'nike.door' },
      { anchors: ['world', 'viewer'] },
    );
    expect(r.anchor).toBe('world');
    expect(r.mode).toBe('world');
  });

  it('place falls back past world to viewer when that is all there is', () => {
    const r = resolveWorldPlacement({ anchor: 'place', ref: 'x' }, { anchors: ['viewer'] });
    expect(r.anchor).toBe('viewer');
  });

  it('agent goes to the viewer first: the conversation stays with the person', () => {
    const r = resolveWorldPlacement({ anchor: 'agent' }, { anchors: ['viewer', 'world'] });
    expect(r.anchor).toBe('viewer');
  });

  it('a host supporting NOTHING still gets a placement, with the reason recorded', () => {
    const r = resolveWorldPlacement({ anchor: 'place', ref: 'x' }, { anchors: [] });
    expect(r.anchor).toBe('place');
    expect(r.mode).toBe('world');
    expect(r.changed[0]?.reason).toMatch(/none of the anchors/);
  });

  it('the ref is dropped with the place anchor, and kept in the record', () => {
    const r = resolveWorldPlacement({ anchor: 'place', ref: 'nike.door' }, { anchors: ['viewer'] });
    expect(r.ref).toBeNull();
    const dropped = r.changed.find((c) => c.field === 'ref');
    expect(dropped?.requested).toBe('nike.door');
    expect(dropped?.honoured).toBeNull();
  });
});

describe('ifUnsupported', () => {
  it("'hud' takes the overlay rather than the next-best place", () => {
    const r = resolveWorldPlacement(
      { anchor: 'place', ref: 'nike.door', ifUnsupported: 'hud' },
      { anchors: ['world', 'viewer'], hud: true },
    );
    expect(r.mode).toBe('hud');
    expect(r.anchor).toBe('place');
    expect(r.ref).toBeNull();
  });

  it("'hud' on a host with no HUD walks the chain and says the HUD was why not", () => {
    const r = resolveWorldPlacement(
      { anchor: 'place', ref: 'x', ifUnsupported: 'hud' },
      { anchors: ['world'], hud: false },
    );
    expect(r.mode).toBe('world');
    expect(r.anchor).toBe('world');
    expect(r.changed[0]?.reason).toMatch(/no HUD/);
  });

  it("'nearest' is the default and ignores a HUD the host does have", () => {
    const r = resolveWorldPlacement(
      { anchor: 'place', ref: 'x' },
      { anchors: ['world'], hud: true },
    );
    expect(r.mode).toBe('world');
    expect(r.anchor).toBe('world');
  });

  it('a supported anchor never reaches the HUD, whatever ifUnsupported says', () => {
    const r = resolveWorldPlacement(
      { anchor: 'viewer', ifUnsupported: 'hud' },
      { anchors: ['viewer'], hud: true },
    );
    expect(r.mode).toBe('world');
    expect(r.changed).toEqual([]);
  });
});

describe('follow and billboard degrade one step, not to off', () => {
  it('locked becomes lazy before none', () => {
    const r = resolveWorldPlacement({ follow: 'locked' }, { follow: ['lazy', 'none'] });
    expect(r.follow).toBe('lazy');
  });

  it('locked becomes none only when lazy is unavailable too', () => {
    const r = resolveWorldPlacement({ follow: 'locked' }, { follow: ['none'] });
    expect(r.follow).toBe('none');
  });

  it('full billboarding becomes yaw before none', () => {
    const r = resolveWorldPlacement({ billboard: 'full' }, { billboard: ['yaw', 'none'] });
    expect(r.billboard).toBe('yaw');
  });

  it("a host that can ONLY billboard gets 'none' upgraded to yaw", () => {
    const r = resolveWorldPlacement({ billboard: 'none' }, { billboard: ['yaw'] });
    expect(r.billboard).toBe('yaw');
    expect(r.changed.map((c) => c.field)).toEqual(['billboard']);
  });

  it("a host that cannot follow at all gets 'none'", () => {
    const r = resolveWorldPlacement({ follow: 'lazy' }, { follow: ['none'] });
    expect(r.follow).toBe('none');
  });
});

describe('comfort distances are clamped into the host range, not refused', () => {
  it('too close is pushed out', () => {
    const r = resolveWorldPlacement({ distanceMetres: 0.25 }, { minDistanceMetres: 0.6 });
    expect(r.distanceMetres).toBe(0.6);
    expect(r.changed[0]).toEqual({
      field: 'distanceMetres',
      requested: 0.25,
      honoured: 0.6,
      reason: "clamped into the host's own comfort range",
    });
  });

  it('too far is pulled in', () => {
    const r = resolveWorldPlacement({ distanceMetres: 8 }, { maxDistanceMetres: 3 });
    expect(r.distanceMetres).toBe(3);
  });

  it('inside the range is left exactly alone', () => {
    const r = resolveWorldPlacement(
      { distanceMetres: 1.2 },
      { minDistanceMetres: 0.5, maxDistanceMetres: 4 },
    );
    expect(r.distanceMetres).toBe(1.2);
    expect(r.changed).toEqual([]);
  });

  it('a width wider than the host allows is narrowed', () => {
    const r = resolveWorldPlacement({ widthMetres: 2 }, { maxWidthMetres: 0.8 });
    expect(r.widthMetres).toBe(0.8);
    expect(r.changed.map((c) => c.field)).toEqual(['widthMetres']);
  });

  it('height is passed through: it is signed, relative, and has no host bound', () => {
    const r = resolveWorldPlacement({ heightMetres: 0.4 }, { minDistanceMetres: 2 });
    expect(r.heightMetres).toBe(0.4);
    // Only the distance was clamped. `heightMetres` is not even a member of
    // `PlacementChange['field']` -- tsc refuses a comparison against it -- so
    // the absence is proved by the type as well as by this list.
    expect(r.changed.map((c) => c.field)).toEqual(['distanceMetres']);
  });
});

describe('every path returns something a host can draw', () => {
  const HOSTS = [
    {},
    { anchors: [] as const, follow: [] as const, billboard: [] as const },
    { anchors: ['viewer'] as const, hud: true },
    { anchors: ['world'] as const, follow: ['none'] as const, billboard: ['none'] as const },
    { minDistanceMetres: 2, maxDistanceMetres: 2, maxWidthMetres: 0.1 },
  ];
  const REQUESTS = [
    {},
    { anchor: 'place' as const, ref: 'a.b', ifUnsupported: 'hud' as const },
    { anchor: 'agent' as const, follow: 'locked' as const, billboard: 'full' as const },
    { distanceMetres: 10, widthMetres: 4, heightMetres: -1.5 },
  ];

  it('is complete and in range for every host x request pair', () => {
    for (const host of HOSTS) {
      for (const request of REQUESTS) {
        const r = resolveWorldPlacement(request, host);
        expect(['world', 'hud']).toContain(r.mode);
        expect(['viewer', 'agent', 'place', 'world']).toContain(r.anchor);
        expect(['none', 'lazy', 'locked']).toContain(r.follow);
        expect(['none', 'yaw', 'full']).toContain(r.billboard);
        expect(typeof r.distanceMetres).toBe('number');
        expect(typeof r.heightMetres).toBe('number');
        expect(typeof r.widthMetres).toBe('number');
        // Nothing is ever dropped to "do not show it": there is no such mode.
        expect(r).not.toHaveProperty('omit');
      }
    }
  });

  it('never hands a host something it declared it cannot do', () => {
    const host = {
      anchors: ['world'] as const,
      follow: ['none'] as const,
      billboard: ['none'] as const,
    };
    const r = resolveWorldPlacement({ anchor: 'agent', follow: 'locked', billboard: 'full' }, host);
    expect(host.anchors).toContain(r.anchor);
    expect(host.follow).toContain(r.follow);
    expect(host.billboard).toContain(r.billboard);
  });
});

describe('the defaults are the ones documented', () => {
  it('viewer, lazy, yaw, 1m, -0.1m, 0.6m', () => {
    expect(PLACEMENT_DEFAULTS).toEqual({
      anchor: 'viewer',
      follow: 'lazy',
      billboard: 'yaw',
      distanceMetres: 1,
      heightMetres: -0.1,
      widthMetres: 0.6,
    });
  });
});
