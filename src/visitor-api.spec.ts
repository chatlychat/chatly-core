import { describe, expect, it } from 'vitest';

import { createChatlyCore } from './core.js';
import { recordingFetch } from './test/harness.js';

function setup(responder?: Parameters<typeof recordingFetch>[0]) {
  const rec = recordingFetch(responder);
  const core = createChatlyCore({
    publicId: 'pub-1',
    apiUrl: 'https://api.test',
    fetch: rec.fetch,
    randomId: (() => {
      let n = 0;
      return () => `id-${(n += 1)}`;
    })(),
  });
  return { rec, core, api: core.api };
}

describe('what the core SENDS', () => {
  it('bootstraps with init before the first call and carries its token after', async () => {
    const { rec, api } = setup();
    await api.listConversations(7);
    expect(rec.calls.map((c) => c.path)).toEqual([
      '/v1/widget/init',
      '/v1/widget/conversations/list',
    ]);
    expect(rec.calls[0]?.body).toEqual({ publicId: 'pub-1' });
    expect(rec.calls[1]?.body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'session-token-1',
      limit: 7,
    });
  });

  it('POSTs JSON with a distinct Idempotency-Key on every write', async () => {
    const { rec, api } = setup();
    await api.track('a');
    await api.track('b');
    const keys = rec.to('/v1/widget/events').map((c) => c.headers['idempotency-key']);
    // id-1 went to the bootstrap init: every request mints its own.
    expect(keys).toEqual(['id-2', 'id-3']);
    expect(rec.calls[0]?.headers['idempotency-key']).toBe('id-1');
    for (const c of rec.calls) {
      expect(c.method).toBe('POST');
      expect(c.headers['content-type']).toBe('application/json');
      expect(c.url.startsWith('https://api.test/v1/widget/')).toBe(true);
    }
  });

  it('start() sends body + attachments to /conversations and returns the new id', async () => {
    const { rec, api } = setup();
    const r = await api.start('hi', { preChat: { name: 'A' } });
    expect(r).toEqual({ conversationId: 'conv-1' });
    expect(rec.to('/v1/widget/conversations')[0]?.body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'session-token-1',
      body: 'hi',
      attachments: [],
      preChat: { name: 'A' },
    });
  });

  it('send() omits silent and payload entirely when unset', async () => {
    const { rec, api } = setup();
    await api.send('c1', 'hello');
    const body = rec.to('/v1/widget/messages')[0]?.body;
    expect(body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'session-token-1',
      conversationId: 'c1',
      body: 'hello',
      attachments: [],
    });
    expect(body).not.toHaveProperty('silent');
    expect(body).not.toHaveProperty('payload');
  });

  it('a postback carries payload, and silent only when true', async () => {
    const { rec, api } = setup();
    await api.send('c1', 'Buy', { postback: { payload: { sku: 'x' }, silent: true } });
    await api.send('c1', 'Buy', { postback: { payload: { sku: 'y' }, silent: false } });
    const [a, b] = rec.to('/v1/widget/messages');
    expect(a?.body).toMatchObject({ silent: true, payload: { sku: 'x' } });
    expect(b?.body).toMatchObject({ payload: { sku: 'y' } });
    expect(b?.body).not.toHaveProperty('silent');
  });

  it('profile() posts only the token and an optional locale: the server supplies every fact', async () => {
    const view = {
      profile: 'buyer',
      matched: true,
      starterPrompts: ['Hi'],
      quickLinks: [],
      copy: {},
    };
    const { rec, core } = setup((r) =>
      r.path === '/v1/widget/profile/resolve' ? { body: view } : undefined,
    );
    expect(await core.profile({ locale: 'fr' })).toEqual(view);
    await core.profile();
    const [a, b] = rec.to('/v1/widget/profile/resolve');
    expect(a?.body).toEqual({ publicId: 'pub-1', visitorToken: 'session-token-1', locale: 'fr' });
    expect(b?.body).toEqual({ publicId: 'pub-1', visitorToken: 'session-token-1' });
  });

  it('reactions put the conversation id in the path AND the body', async () => {
    const { rec, api } = setup();
    await api.toggleReaction('c1', 'm1', '👍');
    const r = rec.to('/v1/widget/conversations/c1/reactions')[0];
    expect(r?.body).toMatchObject({ conversationId: 'c1', messageId: 'm1', emoji: '👍' });
  });

  it('markRead puts the id in the path only and omits an absent anchor', async () => {
    const { rec, api } = setup();
    await api.markRead('c1');
    await api.markRead('c1', 'm9');
    const [a, b] = rec.to('/v1/widget/conversations/c1/read');
    expect(a?.body).not.toHaveProperty('conversationId');
    expect(a?.body).not.toHaveProperty('upToMessageId');
    expect(b?.body).toMatchObject({ upToMessageId: 'm9' });
  });

  it('dismiss pins a stable key per conversation', async () => {
    const { rec, api } = setup();
    await api.dismiss('c1');
    await api.dismiss('c1');
    const keys = rec
      .to('/v1/widget/conversations/c1/dismiss')
      .map((c) => c.headers['idempotency-key']);
    expect(keys).toEqual(['dismiss:c1', 'dismiss:c1']);
  });

  it('a step submit sends no state and pins NO key (a second press is a second purchase)', async () => {
    const { rec, api } = setup();
    await api.submitStep('c1', 'm1', 'act', { qty: 2 });
    await api.submitStep('c1', 'm1', 'act', { qty: 2 });
    const calls = rec.to('/v1/widget/conversations/c1/canvas');
    expect(calls[0]?.body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'session-token-1',
      messageId: 'm1',
      actionId: 'act',
      values: { qty: 2 },
    });
    expect(calls[0]?.headers['idempotency-key']).not.toBe(calls[1]?.headers['idempotency-key']);
  });

  it('requestStep binds the key to conversation, step and params', async () => {
    const { rec, api } = setup();
    await api.requestStep('c1', 'buy', { sku: 'a' });
    await api.requestStep('c1', 'buy');
    const [a, b] = rec.to('/v1/widget/conversations/c1/canvas-step');
    expect(a?.headers['idempotency-key']).toBe('canvas-step:c1:buy:{"sku":"a"}');
    expect(b?.headers['idempotency-key']).toBe('canvas-step:c1:buy:');
    expect(a?.body).toMatchObject({ canvasId: 'buy', params: { sku: 'a' } });
    expect(b?.body).not.toHaveProperty('params');
  });

  it('reportAction binds its key to the action and status', async () => {
    const { rec, api } = setup();
    await api.reportAction('c1', { messageId: 'm1', actionId: 'a1', status: 'done', text: 'ok' });
    const r = rec.to('/v1/widget/conversations/c1/action-result')[0];
    expect(r?.headers['idempotency-key']).toBe('action-result:c1:m1:a1:done');
    expect(r?.body).toMatchObject({ messageId: 'm1', actionId: 'a1', status: 'done', text: 'ok' });
  });

  it('upload presigns with contentType (never mimeType), PUTs the raw bytes, returns mimeType', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { rec, api } = setup((req) =>
      req.path === '/v1/widget/uploads/presign'
        ? {
            body: {
              uploadId: 'up1',
              url: 'https://s3.test/put',
              method: 'PUT',
              headers: { 'x-amz-acl': 'private', 'content-type': 'image/png' },
              publicUrl: 'https://cdn.test/up1.png',
            },
          }
        : undefined,
    );
    const att = await api.upload({ name: 'a.png', type: 'image/png', size: 3, bytes });
    const presign = rec.to('/v1/widget/uploads/presign')[0];
    expect(presign?.body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'session-token-1',
      filename: 'a.png',
      contentType: 'image/png',
      sizeBytes: 3,
    });
    expect(presign?.body).not.toHaveProperty('mimeType');
    const put = rec.calls.at(-1);
    expect(put?.url).toBe('https://s3.test/put');
    expect(put?.method).toBe('PUT');
    expect(put?.headers).toEqual({ 'x-amz-acl': 'private', 'content-type': 'image/png' });
    expect(put?.rawBody).toBe(bytes);
    expect(att).toEqual({
      id: 'up1',
      filename: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      url: 'https://cdn.test/up1.png',
    });
  });

  it('a failed PUT is an upload_failed error, not a silent attachment', async () => {
    const { api } = setup((req) =>
      req.path === '/v1/widget/uploads/presign'
        ? {
            body: {
              uploadId: 'u',
              url: 'https://s3.test/p',
              method: 'PUT',
              headers: {},
              publicUrl: 'x',
            },
          }
        : req.url === 'https://s3.test/p'
          ? { status: 403 }
          : undefined,
    );
    await expect(api.upload({ name: 'a', type: '', size: 1, bytes: 'x' })).rejects.toMatchObject({
      code: 'upload_failed',
      httpStatus: 403,
    });
  });

  it('mints the realtime token from /realtime/token with the conversation id', async () => {
    const { rec, api } = setup();
    const t = await api.realtimeToken('c1');
    expect(rec.to('/v1/widget/realtime/token')[0]?.body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'session-token-1',
      conversationId: 'c1',
    });
    expect(t.token).toBe('rt-token-1-abcdefgh');
  });
});
