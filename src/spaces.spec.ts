/**
 * The world host's client, asserted on WHAT IT SENT.
 *
 * ── Why every assertion here is about the request ──────────────────────
 *
 * All four mobile SDKs shipped a visitor contract the server does not speak,
 * with green suites, because a fake transport that echoes whatever the SDK
 * asked for agrees with the bug. So nothing below asserts on a canned
 * response shape: each test reads the body that went out.
 *
 * What is held here:
 *
 *  1. **`publicId` is on every request.** A slug is unique per workspace, not
 *     globally, so a call without it has not named a space at all.
 *  2. **A re-join sends the credential we already hold**, which is what makes
 *     a retried join a renewal rather than a second ghost member.
 *  3. **No call before `join` silently succeeds.** A host that forgot to join
 *     gets an error naming it, not a 403 from the server about a credential
 *     it never had.
 *  4. **A server `error.code` reaches the caller.** `space_grant_required`
 *     and `space_grant_invalid` are different problems with different fixes.
 */
import { describe, expect, it } from 'vitest';

import { ChatlyError } from './errors.js';
import { applySpacePolicy, createSpaceClient, retractedTurnIds } from './spaces.js';

import type { FetchLike } from './types.js';

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function harness(responses: Array<{ ok?: boolean; status?: number; json?: unknown }> = []): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = responses[i] ?? {};
    i += 1;
    return {
      ok: next.ok ?? true,
      status: next.status ?? 201,
      json: async () => next.json ?? JOINED,
    };
  };
  return { fetch, calls };
}

const JOINED = {
  memberToken: 'sm1.payload.mac',
  expiresAt: '2026-10-24T00:00:00.000Z',
  space: {
    slug: 'flagship-lobby',
    name: 'Flagship lobby',
    mode: 'shared',
    withheld: ['order_status', 'display_names', 'identity_actions', 'outcome_announce'],
    structurallyRefused: ['transcript_email', 'contact_attributes'],
  },
  member: { id: 'member-1', displayName: null, identityVerified: false },
  conversationId: null,
  memberCount: 1,
};

function client(fetch: FetchLike, memberToken?: string) {
  return createSpaceClient({
    publicId: 'pub_1',
    fetch,
    apiUrl: 'https://api.test/',
    ...(memberToken === undefined ? {} : { memberToken }),
  });
}

describe('join', () => {
  it('posts the public id, the grant and the name to the slug’s route', async () => {
    const { fetch, calls } = harness();
    const space = client(fetch);
    await space.join({ slug: 'flagship-lobby', grant: 'sg1.a.b', displayName: 'Dana' });

    expect(calls[0]?.url).toBe('https://api.test/v1/spaces/flagship-lobby/join');
    expect(calls[0]?.body).toEqual({
      publicId: 'pub_1',
      grant: 'sg1.a.b',
      displayName: 'Dana',
    });
  });

  it('omits what the host did not supply, rather than sending undefined', async () => {
    const { fetch, calls } = harness();
    await client(fetch).join({ slug: 'flagship-lobby' });
    expect(Object.keys(calls[0]?.body ?? {})).toEqual(['publicId']);
  });

  it('sends a credential it already holds, so a retry renews', async () => {
    const { fetch, calls } = harness();
    const space = client(fetch, 'sm1.old.mac');
    await space.join({ slug: 'flagship-lobby' });
    expect(calls[0]?.body['memberToken']).toBe('sm1.old.mac');
  });

  it('keeps the credential the server minted', async () => {
    const { fetch } = harness();
    const space = client(fetch);
    await space.join({ slug: 'flagship-lobby' });
    expect(space.memberToken).toBe('sm1.payload.mac');
  });

  it('returns the withheld and structurally-refused lists verbatim', async () => {
    const { fetch } = harness();
    const joined = await client(fetch).join({ slug: 'flagship-lobby' });
    expect(joined.space.withheld).toContain('display_names');
    expect(joined.space.structurallyRefused).toEqual(['transcript_email', 'contact_attributes']);
  });

  it('url-encodes the slug', async () => {
    const { fetch, calls } = harness();
    await client(fetch).join({ slug: 'a b' });
    expect(calls[0]?.url).toContain('/v1/spaces/a%20b/join');
  });
});

describe('every later call carries the credential and the public id', () => {
  async function joined() {
    const { fetch, calls } = harness([{ json: JOINED }, {}, {}, {}, {}]);
    const space = client(fetch);
    await space.join({ slug: 'flagship-lobby' });
    calls.length = 0;
    return { space, calls };
  }

  it('thread', async () => {
    const { space, calls } = await joined();
    await space.thread({ limit: 10, cursor: 'c1' });
    expect(calls[0]?.url).toBe('https://api.test/v1/spaces/flagship-lobby/thread');
    expect(calls[0]?.body).toEqual({
      publicId: 'pub_1',
      memberToken: 'sm1.payload.mac',
      limit: 10,
      cursor: 'c1',
    });
  });

  it('send', async () => {
    const { space, calls } = await joined();
    await space.send('is it in blue?');
    expect(calls[0]?.url).toBe('https://api.test/v1/spaces/flagship-lobby/messages');
    expect(calls[0]?.body['body']).toBe('is it in blue?');
  });

  it('setMyState, with a real array rather than a readonly reference', async () => {
    const { space, calls } = await joined();
    await space.setMyState({ dismissed: ['tip-1'], readThroughAt: '2026-10-23T12:00:00.000Z' });
    expect(calls[0]?.body['dismissed']).toEqual(['tip-1']);
    expect(calls[0]?.body['readThroughAt']).toBe('2026-10-23T12:00:00.000Z');
  });

  it('reportOutcome, nesting the outcome so the envelope stays the envelope', async () => {
    const { space, calls } = await joined();
    await space.reportOutcome({ kind: 'reached', target: 'flagship-shop', ref: 'r1' });
    expect(calls[0]?.url).toBe('https://api.test/v1/spaces/flagship-lobby/outcomes');
    expect(calls[0]?.body['outcome']).toEqual({
      kind: 'reached',
      target: 'flagship-shop',
      ref: 'r1',
    });
  });

  it('leave, and then forgets the credential', async () => {
    const { space, calls } = await joined();
    await space.leave();
    expect(calls[0]?.url).toBe('https://api.test/v1/spaces/flagship-lobby/leave');
    expect(space.memberToken).toBeNull();
  });
});

describe('a host that has not joined', () => {
  it('is told so, rather than sending a request with no credential', async () => {
    const { fetch, calls } = harness();
    const space = client(fetch);
    await expect(space.send('hello')).rejects.toBeInstanceOf(ChatlyError);
    await expect(space.thread()).rejects.toMatchObject({ code: 'no_session' });
    expect(calls).toHaveLength(0);
  });

  it('is told so even when it was given a credential but no slug', async () => {
    // A resumed credential is not a resumed space: the slug is in the path.
    const { fetch, calls } = harness();
    const space = client(fetch, 'sm1.old.mac');
    await expect(space.thread()).rejects.toMatchObject({ code: 'no_session' });
    expect(calls).toHaveLength(0);
  });
});

describe('errors', () => {
  it('carries the server’s own code through', async () => {
    const { fetch } = harness([
      {
        ok: false,
        status: 403,
        json: { error: { code: 'space_grant_required', message: 'mint one on your server' } },
      },
    ]);
    await expect(client(fetch).join({ slug: 'flagship-lobby' })).rejects.toMatchObject({
      code: 'request_failed',
      httpStatus: 403,
      serverCode: 'space_grant_required',
    });
  });

  it('survives an error body that is not JSON', async () => {
    const { fetch } = harness([
      {
        ok: false,
        status: 502,
        get json() {
          throw new Error('not json');
        },
      } as never,
    ]);
    await expect(client(fetch).join({ slug: 'flagship-lobby' })).rejects.toMatchObject({
      httpStatus: 502,
    });
  });
});

/**
 * Moderation and the unprompted switch, as a world host sees them
 * (migration 0675).
 */
describe('applySpacePolicy', () => {
  const joined = (unprompted: boolean) =>
    ({ space: { unpromptedCapabilities: unprompted } }) as never;

  it('hands the space’s switch to the conversation: off for a shared room', () => {
    const calls: boolean[] = [];
    applySpacePolicy({ setUnpromptedAllowed: (a) => calls.push(a) }, joined(false));
    expect(calls).toEqual([false]);
  });

  it('CONTROL: on for a space that allows them', () => {
    const calls: boolean[] = [];
    applySpacePolicy({ setUnpromptedAllowed: (a) => calls.push(a) }, joined(true));
    expect(calls).toEqual([true]);
  });
});

describe('retractedTurnIds', () => {
  const t = (id: string, hidden: boolean) => ({ id, hidden });

  it('names a turn that was on screen and now comes back hidden', () => {
    expect(retractedTurnIds([t('a', false), t('b', false)], [t('a', false), t('b', true)])).toEqual(
      ['b'],
    );
  });

  it('CONTROL: a turn that was never visible to you is not a retraction', () => {
    expect(retractedTurnIds([t('b', true)], [t('b', true)])).toEqual([]);
    expect(retractedTurnIds([], [t('b', true)])).toEqual([]);
  });
});
