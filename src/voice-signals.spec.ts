import { describe, expect, it } from 'vitest';

import {
  VOICE_SIGNAL_VERSION,
  decodeVoiceSignal,
  encodeVoiceSignal,
  readVoiceSignal,
} from './voice-signals.js';

/**
 * GOLDEN WIRE VECTORS.
 *
 * Frozen literals, not `encodeVoiceSignal(...)` fed back into
 * `readVoiceSignal(...)`. A round-trip test compares the encoder to the
 * decoder and passes whatever they agree on, which is a tautology: rename a
 * field in both and it stays green while every peer on the old vocabulary
 * stops understanding this client. The strings below are the contract.
 *
 * The other end of the wire is `apps/voice/src/agent-control.ts`, which
 * decodes base64 → UTF-8 → JSON, and the worker's `sendData`, which
 * base64-encodes `JSON.stringify(payload)`. The JSON here is what sits inside
 * that base64; bytes belong to the transport (see `voice-signals.ts`).
 */
const GOLDEN = {
  floorTaken: '{"v":1,"kind":"voice.floor","state":"taken","label":null}',
  floorPreparing: '{"v":1,"kind":"voice.floor","state":"preparing","label":"thinking…"}',
  floorYielded: '{"v":1,"kind":"voice.floor","state":"yielded","label":null}',
  muteOn: '{"v":1,"kind":"voice.mute","muted":true}',
  muteOff: '{"v":1,"kind":"voice.mute","muted":false}',
} as const;

describe('the wire form is the one written down', () => {
  it('encodes each signal to its golden string, byte for byte', () => {
    expect(encodeVoiceSignal({ kind: 'voice.floor', state: 'taken' })).toBe(GOLDEN.floorTaken);
    expect(encodeVoiceSignal({ kind: 'voice.floor', state: 'preparing', label: 'thinking…' })).toBe(
      GOLDEN.floorPreparing,
    );
    expect(encodeVoiceSignal({ kind: 'voice.floor', state: 'yielded', label: null })).toBe(
      GOLDEN.floorYielded,
    );
    expect(encodeVoiceSignal({ kind: 'voice.mute', muted: true })).toBe(GOLDEN.muteOn);
    expect(encodeVoiceSignal({ kind: 'voice.mute', muted: false })).toBe(GOLDEN.muteOff);
  });

  it('decodes each golden string', () => {
    expect(decodeVoiceSignal(GOLDEN.floorTaken)).toEqual({
      v: 1,
      kind: 'voice.floor',
      state: 'taken',
      label: null,
    });
    expect(decodeVoiceSignal(GOLDEN.floorPreparing)).toEqual({
      v: 1,
      kind: 'voice.floor',
      state: 'preparing',
      label: 'thinking…',
    });
    expect(decodeVoiceSignal(GOLDEN.muteOn)).toEqual({ v: 1, kind: 'voice.mute', muted: true });
  });

  it('the encoder stamps its OWN version, so a caller cannot publish a version it does not speak', () => {
    const encoded = encodeVoiceSignal({ kind: 'voice.mute', muted: true });
    expect(JSON.parse(encoded)).toMatchObject({ v: VOICE_SIGNAL_VERSION });
    // `VoiceSignalInput` has no `v`; this proves the type's intent at runtime.
    expect(encoded.includes('"v":1')).toBe(true);
  });

  it('accepts an object a transport parsed itself, not only a string', () => {
    expect(decodeVoiceSignal({ v: 1, kind: 'voice.mute', muted: false })).toEqual({
      v: 1,
      kind: 'voice.mute',
      muted: false,
    });
  });
});

describe('a payload it cannot read is REFUSED, with the reason', () => {
  it('a misspelled key is refused and named — not stripped', () => {
    const read = readVoiceSignal('{"v":1,"kind":"voice.floor","stat":"taken"}');
    expect(read.signal).toBeUndefined();
    expect(read.refused).toBe('unknown-key');
    expect(read.detail).toContain('stat');
  });

  it('an unknown key on a mute signal is refused too', () => {
    const read = readVoiceSignal('{"v":1,"kind":"voice.mute","muted":true,"until":5}');
    expect(read.refused).toBe('unknown-key');
    expect(read.detail).toContain('until');
  });

  it('a version this client does not speak is refused as a version problem', () => {
    const read = readVoiceSignal('{"v":2,"kind":"voice.mute","muted":true}');
    expect(read.refused).toBe('version');
    expect(read.detail).toContain('v=2');
  });

  it('a missing version is a version problem, not a field problem', () => {
    expect(readVoiceSignal('{"kind":"voice.mute","muted":true}').refused).toBe('version');
  });

  it.each([
    ['not JSON at all', 'hello', 'not-json'],
    ['an array', '[1,2]', 'not-an-object'],
    ['null', 'null', 'not-an-object'],
    ['an unknown kind', '{"v":1,"kind":"voice.wave"}', 'unknown-kind'],
    ['a bad floor state', '{"v":1,"kind":"voice.floor","state":"grab"}', 'bad-field'],
    ['a missing floor state', '{"v":1,"kind":"voice.floor"}', 'bad-field'],
    ['a non-boolean muted', '{"v":1,"kind":"voice.mute","muted":"yes"}', 'bad-field'],
    ['a numeric label', '{"v":1,"kind":"voice.floor","state":"taken","label":7}', 'bad-field'],
  ])('refuses %s as %s', (_name, raw, expected) => {
    const read = readVoiceSignal(raw);
    expect(read.signal).toBeUndefined();
    expect(read.refused).toBe(expected);
    expect((read.detail ?? '').length).toBeGreaterThan(0);
  });

  it('never throws on hostile input', () => {
    for (const raw of [undefined, null, 0, '', '{', '{"v":1}', Symbol.iterator, () => 1]) {
      expect(() => readVoiceSignal(raw)).not.toThrow();
    }
  });

  it('truncates a long label instead of refusing it', () => {
    const long = 'x'.repeat(500);
    const signal = decodeVoiceSignal(
      JSON.stringify({ v: 1, kind: 'voice.floor', state: 'taken', label: long }),
    );
    expect(signal).not.toBeNull();
    expect(signal?.kind === 'voice.floor' ? signal.label?.length : -1).toBe(120);
  });
});
