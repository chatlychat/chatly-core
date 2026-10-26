import { describe, expect, it } from 'vitest';

import { createChatlyCore } from './core.js';
import { recordingFetch } from './test/harness.js';

import type { KeyValueStorage } from './types.js';

function setup(verified = true, storage?: KeyValueStorage) {
  const rec = recordingFetch((req) =>
    req.path === '/v1/widget/init'
      ? {
          body: {
            session: {
              token: 'tok',
              contactId: 'c-1',
              identityVerified: verified,
              visitorKey: verified ? 'u_42' : 'vt_anon',
            },
          },
        }
      : undefined,
  );
  const core = createChatlyCore({
    publicId: 'pub-1',
    apiUrl: 'https://api.test',
    fetch: rec.fetch,
    ...(storage === undefined ? {} : { storage }),
  });
  return { rec, core };
}

describe('identify: what the core SENDS (same body as the widget)', () => {
  it('userHash path: nested `identity` with the widget field names', async () => {
    const { rec, core } = setup();
    const hash = 'a'.repeat(64);
    const r = await core.identify({
      externalId: 'u_42',
      userHash: hash,
      email: 'a@b.test',
      name: 'Ann',
      phone: '+100',
      attributes: { plan: 'pro' },
    });
    expect(rec.to('/v1/widget/init')[0]?.body).toEqual({
      publicId: 'pub-1',
      identity: {
        externalId: 'u_42',
        userHash: hash,
        email: 'a@b.test',
        name: 'Ann',
        phone: '+100',
        attributes: { plan: 'pro' },
      },
    });
    expect(r).toEqual({ contactId: 'c-1', identityVerified: true, externalId: 'u_42' });
  });

  it('token path: `userToken` (oidc/atlas) and `identityToken` (IDV v2) keep their own wire keys', async () => {
    const { rec, core } = setup();
    await core.identify({ userToken: 'jwt-a' });
    await core.identify({ externalId: 'u_42', identityToken: 'jwt-b' });
    const [a, b] = rec.to('/v1/widget/init');
    expect(a?.body?.['identity']).toEqual({ userToken: 'jwt-a' });
    expect(b?.body?.['identity']).toEqual({ externalId: 'u_42', identityToken: 'jwt-b' });
  });

  it('control: an unverified claim reports identityVerified false, not true', async () => {
    const { core } = setup(false);
    const r = await core.identify({ externalId: 'u_42' });
    expect(r.identityVerified).toBe(false);
    const anon = await core.init();
    expect(anon).toEqual({ contactId: 'c-1', identityVerified: false, externalId: null });
  });

  it('emits `identified` with the same result, and unsubscribes', async () => {
    const { core } = setup();
    const seen: unknown[] = [];
    const off = core.on('identified', (r) => seen.push(r));
    await core.identify({ externalId: 'u_42' });
    off();
    await core.identify({ externalId: 'u_42' });
    expect(seen).toEqual([{ contactId: 'c-1', identityVerified: true, externalId: 'u_42' }]);
  });
});

describe('reset', () => {
  it('clears the stored token, contact and identity; the next call is a fresh anonymous init', async () => {
    const data = new Map<string, string>();
    const store: KeyValueStorage = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
    const { rec, core } = setup(true, store);
    await core.identify({ externalId: 'u_42' });
    expect(data.get('livechat:vt:pub-1')).toBe('tok');
    core.reset();
    expect(data.size).toBe(0);
    expect(core.session.visitorToken).toBeNull();
    expect(core.session.contactId).toBeNull();
    await core.init();
    expect(rec.to('/v1/widget/init')[1]?.body).toEqual({ publicId: 'pub-1' });
  });
});

describe('setContext', () => {
  it('posts audience / contextToken to the widget context route with the visitor token', async () => {
    const { rec, core } = setup();
    await core.setContext({ audience: 'buyer', contextToken: 'ctx.jwt' });
    expect(rec.to('/v1/widget/context')[0]?.body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'tok',
      audience: 'buyer',
      contextToken: 'ctx.jwt',
    });
  });

  it('setSurface still sends only `surface`', async () => {
    const { rec, core } = setup();
    await core.setSurface({ kind: 'world', capabilities: [] } as never);
    expect(Object.keys(rec.to('/v1/widget/context')[0]?.body ?? {}).sort()).toEqual([
      'publicId',
      'surface',
      'visitorToken',
    ]);
  });
});
