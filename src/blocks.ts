import type { Block, BlockEnvelope } from './types.js';

/** The block protocol version this reader understands. */
export const BLOCK_PROTOCOL_VERSION = 1;

/**
 * Read a rich-block envelope into typed data, forgivingly.
 *
 * ── Why this is a loose reader and not the real one ─────────────────────
 *
 * The authoritative reader is `readBlocksEnvelope` in
 * `@livechat/shared/widget-blocks`, which knows every block's fields. A
 * published package cannot import it (an internal import typechecks, passes
 * every test and breaks at install), and copying it here would create the
 * second hand-written reader of one format that file's header warns about:
 * two readers drift in silence.
 *
 * So the core guarantees the ENVELOPE and leaves the block interiors to the
 * renderer. It reads with the same posture the real reader has, for the same
 * reason — a renderer that refuses the whole envelope over one malformed
 * block shows nothing where it could have shown four good cards, and one that
 * refuses an unknown KEY blanks the screen on a forward rollout:
 *
 *  - unknown protocol version: `null` (the caller renders `body`)
 *  - a block that is not an object with a string `type`: dropped
 *  - unknown keys: passed through untouched
 *  - nothing survives: `null`
 *
 * A host that wants full per-block typing passes its own reader, e.g. the
 * shared one, as `readBlocks` in `createChatlyCore` — it only has to return
 * something assignable to {@link BlockEnvelope}.
 */
export function readBlockEnvelope(raw: unknown): BlockEnvelope | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const bag = raw as { v?: unknown; blocks?: unknown };
  if (bag.v !== BLOCK_PROTOCOL_VERSION || !Array.isArray(bag.blocks)) {
    return null;
  }
  const blocks: Block[] = [];
  for (const entry of bag.blocks as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const type = (entry as { type?: unknown }).type;
    if (typeof type !== 'string' || type.length === 0) {
      continue;
    }
    blocks.push(entry as Block);
  }
  return blocks.length > 0 ? { v: BLOCK_PROTOCOL_VERSION, blocks } : null;
}
