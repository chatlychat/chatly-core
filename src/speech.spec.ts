import { describe, expect, it } from 'vitest';

import { createChatlyCore } from './core.js';
import { createSpeechFrameReader, visemeAt, type VisemeCue } from './speech.js';
import { recordingFetch } from './test/harness.js';

const MSG = '0193f0aa-0000-7000-8000-0000000000aa';
const SPEECH_PATH = `/v1/widget/messages/${MSG}/speech`;

function setup(speech: unknown) {
  const rec = recordingFetch((r) => (r.path === SPEECH_PATH ? { body: { speech } } : undefined));
  const core = createChatlyCore({
    publicId: 'pub-1',
    apiUrl: 'https://api.test',
    fetch: rec.fetch,
  });
  return { rec, api: core.api };
}

describe('VisitorApi.speech — what it SENDS and what it hands back', () => {
  it('posts the conversation and format with the visitor identity, and returns an ABSOLUTE url', async () => {
    const { rec, api } = setup({
      path: '/v1/widget/speech?t=abc.def',
      expiresAt: '2026-10-25T10:10:00.000Z',
      format: 'audio',
      visemeTiming: 'aligned',
    });
    const s = await api.speech('conv-1', MSG, 'audio');
    expect(rec.to(SPEECH_PATH)[0]?.body).toEqual({
      publicId: 'pub-1',
      visitorToken: 'session-token-1',
      conversationId: 'conv-1',
      format: 'audio',
    });
    expect(s).toEqual({
      url: 'https://api.test/v1/widget/speech?t=abc.def',
      expiresAt: '2026-10-25T10:10:00.000Z',
      format: 'audio',
      visemeTiming: 'aligned',
    });
  });

  it('null means this bot has no voice', async () => {
    expect(await setup(null).api.speech('conv-1', MSG)).toBeNull();
  });

  it('refuses an absolute path from the server rather than following it off the API origin', async () => {
    await expect(
      setup({ path: 'https://elsewhere.test/x' }).api.speech('conv-1', MSG),
    ).rejects.toThrow(/no path/);
  });
});

describe('createSpeechFrameReader', () => {
  const frames = [
    { type: 'audio', seq: 0, sentence: 0, mime: 'audio/mpeg', data: 'AAA=' },
    {
      type: 'visemes',
      sentence: 0,
      timing: 'estimated',
      visemes: [{ v: 'aa', startMs: 0, endMs: 90 }],
    },
    {
      type: 'end',
      sentences: 1,
      durationMs: 90,
      provider: 'openai',
      model: 'tts-1',
      chars: 3,
      firstAudioMs: 410,
    },
  ];
  const wire = frames.map((f) => JSON.stringify(f)).join('\n') + '\n';

  it('reads frames however the bytes were sliced', () => {
    for (const cut of [1, 7, 33, wire.length - 1]) {
      const r = createSpeechFrameReader();
      const got = [...r.push(wire.slice(0, cut)), ...r.push(wire.slice(cut)), ...r.flush()];
      expect(got).toEqual(frames);
    }
  });

  it('skips a frame type it does not know, and keeps going', () => {
    const r = createSpeechFrameReader();
    const got = r.push(`{"type":"prosody","x":1}\n${JSON.stringify(frames[0])}\n`);
    expect(got).toEqual([frames[0]]);
  });

  it('reads a last frame that has no trailing newline on flush', () => {
    const r = createSpeechFrameReader();
    expect(r.push(JSON.stringify(frames[2]))).toEqual([]);
    expect(r.flush()).toEqual([frames[2]]);
  });
});

describe('visemeAt', () => {
  const cues: VisemeCue[] = [
    { v: 'PP', startMs: 0, endMs: 50 },
    { v: 'aa', startMs: 50, endMs: 200 },
    { v: 'SS', startMs: 300, endMs: 350 },
  ];
  it('finds the shape at a playback position, silence in the gaps', () => {
    expect(visemeAt(cues, 10)).toBe('PP');
    expect(visemeAt(cues, 50)).toBe('aa');
    expect(visemeAt(cues, 250)).toBe('sil');
    expect(visemeAt(cues, 349)).toBe('SS');
    expect(visemeAt(cues, 1_000)).toBe('sil');
  });
});
