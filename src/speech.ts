/**
 * A bot message's VOICE, for a renderer with a mouth to move (ADR 0073).
 *
 * Optional end to end: a 2D surface never calls `VisitorApi.speech()` and
 * nothing here runs. A host that embodies a bot asks for each bot message it
 * wants spoken, gets a short-lived URL (or `null` — that bot has no voice),
 * and streams it with its OWN audio client. The core does not fetch the
 * audio: its injected `fetch` exposes `json()` only, and a host's audio stack
 * (Unity, Unreal, Web Audio, a headset runtime) is the thing that plays it.
 *
 * Two formats:
 *   `audio`  — plain `audio/mpeg`, sentence after sentence. Give it to any
 *              audio element. No mouth shapes.
 *   `ndjson` — one JSON frame per line, read with `createSpeechFrameReader`:
 *              `audio` (base64 MP3), `visemes`, `sentence`, `end`, `error`.
 *
 * Every `startMs` / `endMs` is on ONE clock: ms from the start of the
 * stream's audio. Schedule mouth shapes against the playback position and
 * sentence boundaries never matter.
 *
 * Fidelity (`visemeTiming`): `aligned` = the vendor's measured per-character
 * timings (ElevenLabs, or a custom endpoint that sends them); `estimated` =
 * derived from the text and stretched to the measured audio length of each
 * sentence (OpenAI) — starts and ends of sentences are right, the middle can
 * drift by about a syllable; `endpoint` = a custom endpoint, aligned if it
 * sends timings and estimated if it does not.
 */

/** The 15-shape set most avatar rigs already carry (Oculus/Meta lipsync names). */
export const VISEME_NAMES = [
  'sil',
  'PP',
  'FF',
  'TH',
  'DD',
  'kk',
  'CH',
  'SS',
  'nn',
  'RR',
  'aa',
  'E',
  'I',
  'O',
  'U',
] as const;
export type VisemeName = (typeof VISEME_NAMES)[number];

export interface VisemeCue {
  readonly v: VisemeName;
  readonly startMs: number;
  readonly endMs: number;
}

export type SpeechFormat = 'ndjson' | 'audio';
export type VisemeTiming = 'aligned' | 'estimated' | 'endpoint';

/** What `VisitorApi.speech()` returns for a voiced bot message. */
export interface MessageSpeech {
  /** Absolute. Needs no header and no body — hand it to any audio client. */
  readonly url: string;
  readonly expiresAt: string;
  readonly format: SpeechFormat;
  readonly visemeTiming: VisemeTiming;
}

export type SpeechFrame =
  | {
      readonly type: 'audio';
      readonly seq: number;
      readonly sentence: number;
      readonly mime: 'audio/mpeg';
      /** Base64 MP3 bytes. Append in `seq` order. */
      readonly data: string;
    }
  | {
      readonly type: 'visemes';
      readonly sentence: number;
      readonly timing: 'aligned' | 'estimated';
      readonly visemes: readonly VisemeCue[];
    }
  | {
      readonly type: 'sentence';
      readonly sentence: number;
      readonly text: string;
      readonly startMs: number;
      readonly durationMs: number;
    }
  | {
      readonly type: 'end';
      readonly sentences: number;
      readonly durationMs: number;
      readonly provider: string;
      readonly model: string;
      readonly chars: number;
      /** Server-measured ms from request to first audio byte. */
      readonly firstAudioMs: number | null;
    }
  | {
      readonly type: 'error';
      readonly sentence: number;
      readonly code: string;
      readonly message: string;
    };

const FRAME_TYPES: ReadonlySet<string> = new Set(['audio', 'visemes', 'sentence', 'end', 'error']);

export interface SpeechFrameReader {
  /** Feed text as it arrives, in any slicing. Returns the frames it completed. */
  push(text: string): SpeechFrame[];
  /** Call once the stream ends. Returns a final frame left without a newline. */
  flush(): SpeechFrame[];
}

/**
 * Incremental NDJSON reader. A frame type this version does not know is
 * SKIPPED, not thrown: the server may add a frame kind before a host
 * upgrades, and a voice that stops mid-sentence for that would be worse
 * than a mouth that ignores one new hint. A line that is not JSON at all
 * is a broken stream and throws.
 */
export function createSpeechFrameReader(): SpeechFrameReader {
  let buf = '';
  const parse = (line: string): SpeechFrame | null => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const value = JSON.parse(trimmed) as unknown;
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string' && FRAME_TYPES.has(type) ? (value as SpeechFrame) : null;
  };
  return {
    push(text) {
      buf += text;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      return lines.map(parse).filter((f): f is SpeechFrame => f !== null);
    },
    flush() {
      const last = parse(buf);
      buf = '';
      return last === null ? [] : [last];
    },
  };
}

/**
 * The cue a mouth should show at `ms` on the stream clock, or `sil`. Cues
 * from every `visemes` frame can be concatenated: they never overlap and
 * arrive in time order.
 */
export function visemeAt(cues: readonly VisemeCue[], ms: number): VisemeName {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (cue === undefined) {
      break;
    }
    if (ms < cue.startMs) {
      hi = mid - 1;
    } else if (ms >= cue.endMs) {
      lo = mid + 1;
    } else {
      return cue.v;
    }
  }
  return 'sil';
}
