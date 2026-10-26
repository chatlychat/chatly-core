import { describe, expect, it } from 'vitest';

import { foldVoiceTurn, sameActivity, type VoiceTurnInput } from './voice-turn.js';

import type { VoiceActivity } from './voice-types.js';

const act = (
  identity: string,
  local: boolean,
  speaking: boolean,
  level: number | null = null,
): VoiceActivity => ({ identity, local, speaking, level });

const fold = (over: Partial<VoiceTurnInput> = {}): ReturnType<typeof foldVoiceTurn> =>
  foldVoiceTurn({
    activity: [],
    localClaim: null,
    remoteClaims: new Map(),
    ...over,
  });

describe('the floor', () => {
  it('is open when nobody speaks and nobody claims', () => {
    expect(fold().floor).toBe('open');
    expect(fold({ activity: [act('a', false, false), act('me', true, false)] }).floor).toBe('open');
  });

  it('is local when this client is speaking', () => {
    const s = fold({ activity: [act('me', true, true, 0.4)] });
    expect(s.floor).toBe('local');
    expect(s.localSpeaking).toBe(true);
    expect(s.localLevel).toBe(0.4);
    expect(s.remoteSpeaking).toEqual([]);
  });

  it('is remote when a peer is speaking, and reports who with what level', () => {
    const s = fold({ activity: [act('agent:1', false, true, 0.9), act('me', true, false)] });
    expect(s.floor).toBe('remote');
    expect(s.remoteSpeaking).toEqual([{ identity: 'agent:1', level: 0.9 }]);
  });

  it('is contested when both speak — not collapsed into either side', () => {
    const s = fold({ activity: [act('me', true, true), act('agent:1', false, true)] });
    expect(s.floor).toBe('contested');
    expect(s.localSpeaking).toBe(true);
    expect(s.remoteSpeaking).toHaveLength(1);
  });

  it('keeps a null level when the transport measures only on/off', () => {
    expect(fold({ activity: [act('me', true, true)] }).localLevel).toBeNull();
  });
});

describe('a claim can only ADD to the floor', () => {
  it('a `taken` claim with no audio still takes the floor', () => {
    expect(fold({ localClaim: 'taken' }).floor).toBe('local');
    expect(fold({ remoteClaims: new Map([['agent:1', 'taken']]) }).floor).toBe('remote');
  });

  it('a peer that says `yielded` while still audible does NOT release the floor', () => {
    // `yielded` reaches the fold as an ABSENT claim; the audio is what decides.
    const s = fold({ activity: [act('agent:1', false, true)], remoteClaims: new Map() });
    expect(s.floor).toBe('remote');
  });

  it('a `taken` peer claim plus local speech is contested, not local', () => {
    const s = fold({
      activity: [act('me', true, true)],
      remoteClaims: new Map([['agent:1', 'taken']]),
    });
    expect(s.floor).toBe('contested');
  });
});

describe('`preparing` is a lean-in, never a turn', () => {
  it('does not take the floor on either side', () => {
    expect(fold({ localClaim: 'preparing' }).floor).toBe('open');
    expect(fold({ remoteClaims: new Map([['agent:1', 'preparing']]) }).floor).toBe('open');
  });

  it('reports the preparers, local first', () => {
    const s = fold({
      localClaim: 'preparing',
      remoteClaims: new Map([
        ['agent:1', 'preparing'],
        ['agent:2', 'taken'],
      ]),
    });
    expect(s.preparing).toEqual(['local', 'agent:1']);
    expect(s.floor).toBe('remote');
  });

  it('drops a preparer who has started speaking — it is a turn now, not an intent', () => {
    expect(fold({ activity: [act('me', true, true)], localClaim: 'preparing' }).preparing).toEqual(
      [],
    );
    expect(
      fold({
        activity: [act('agent:1', false, true)],
        remoteClaims: new Map([['agent:1', 'preparing']]),
      }).preparing,
    ).toEqual([]);
  });
});

describe('sameActivity', () => {
  it('is true for two reports a renderer cannot tell apart', () => {
    expect(sameActivity([act('a', false, true, 0.5)], [act('a', false, true, 0.5)])).toBe(true);
    expect(sameActivity([], [])).toBe(true);
  });

  it('is false on every field that changes what is drawn', () => {
    expect(sameActivity([act('a', false, true)], [act('b', false, true)])).toBe(false);
    expect(sameActivity([act('a', false, true)], [act('a', true, true)])).toBe(false);
    expect(sameActivity([act('a', false, true)], [act('a', false, false)])).toBe(false);
    expect(sameActivity([act('a', false, true, 0.1)], [act('a', false, true, 0.2)])).toBe(false);
    expect(sameActivity([act('a', false, true)], [])).toBe(false);
  });
});
