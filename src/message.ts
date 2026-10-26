import { readBlockEnvelope } from './blocks.js';

import type {
  BlockEnvelope,
  ConversationMessage,
  MessageAttachment,
  ReactionEntry,
  TypingState,
} from './types.js';

export type BlocksReader = (raw: unknown) => BlockEnvelope | null;

const AUTHORS: ReadonlySet<string> = new Set(['contact', 'agent', 'bot', 'system']);
const KINDS: ReadonlySet<string> = new Set(['text', 'rich', 'attachment_only', 'system_event']);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function readAttachments(raw: unknown): MessageAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: MessageAttachment[] = [];
  for (const a of raw as unknown[]) {
    if (typeof a !== 'object' || a === null) {
      continue;
    }
    const r = a as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || typeof r['url'] !== 'string') {
      continue;
    }
    out.push({
      id: r['id'],
      filename: str(r['filename']) ?? '',
      mimeType: str(r['mimeType']) ?? '',
      sizeBytes: typeof r['sizeBytes'] === 'number' ? r['sizeBytes'] : 0,
      url: r['url'],
    });
  }
  return out;
}

function readReactions(raw: unknown): ReactionEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ReactionEntry[] = [];
  for (const e of raw as unknown[]) {
    const r = e as { emoji?: unknown; count?: unknown; reacted?: unknown } | null;
    if (typeof r?.emoji === 'string' && typeof r.count === 'number') {
      out.push({ emoji: r.emoji, count: r.count, reacted: r.reacted === true });
    }
  }
  return out;
}

/**
 * One wire row (list OR push) into a {@link ConversationMessage}.
 *
 * Returns `null` for a row that cannot be keyed: a row with no id would be
 * emitted again on every poll. `conversationId` is passed in because the list
 * projection does not repeat it.
 */
export function parseMessage(
  raw: unknown,
  conversationId: string,
  readBlocks: BlocksReader = readBlockEnvelope,
): ConversationMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const id = str(r['id']);
  if (id === null || id.length === 0) {
    return null;
  }
  const author = str(r['authorType']);
  const kind = str(r['kind']);
  const stream = r['streamState'];
  return {
    id,
    conversationId: str(r['conversationId']) ?? conversationId,
    body: str(r['body']) ?? '',
    authorType:
      author !== null && AUTHORS.has(author)
        ? (author as ConversationMessage['authorType'])
        : 'system',
    createdAt: str(r['createdAt']) ?? '',
    // The socket payload defaults an absent kind to text; so does this.
    kind: kind !== null && KINDS.has(kind) ? (kind as ConversationMessage['kind']) : 'text',
    bodyHtml: str(r['bodyHtml']),
    blocks: r['blocks'] === undefined || r['blocks'] === null ? null : readBlocks(r['blocks']),
    canvas: r['canvas'] ?? null,
    attachments: readAttachments(r['attachments']),
    authorId: str(r['authorId']),
    streamState: stream === 'streaming' || stream === 'complete' ? stream : null,
    hiddenFromContact: r['hiddenFromContact'] === true,
    replyToMessageId: str(r['replyToMessageId']),
    metadata:
      typeof r['metadata'] === 'object' && r['metadata'] !== null
        ? (r['metadata'] as Record<string, unknown>)
        : {},
    deletedAt: str(r['deletedAt']),
    reactions: readReactions(r['reactions']),
    pending: false,
  };
}

const byCreatedAt = (a: ConversationMessage, b: ConversationMessage): number => {
  // Pending rows have no server time yet and belong at the end.
  if (a.pending !== b.pending) {
    return a.pending ? 1 : -1;
  }
  return a.createdAt.localeCompare(b.createdAt);
};

/**
 * Fold server messages (a list page or a push) into the thread.
 *
 * - A known id is replaced in place by the incoming row ONLY when the
 *   incoming row is from the list (`authoritative`), because a list row
 *   carries `reactions.reacted` and a deletion tombstone that a push does
 *   not; a push for an id already present is a duplicate and is dropped.
 * - An incoming contact message replaces the first optimistic `pending` row
 *   with the same body, which is how the sender's echo does not draw twice.
 * - `hiddenFromContact` rows are kept in the data and left to the renderer.
 */
export function mergeMessages(
  current: readonly ConversationMessage[],
  incoming: readonly ConversationMessage[],
  authoritative: boolean,
): readonly ConversationMessage[] {
  const next = current.slice();
  let changed = false;
  for (const m of incoming) {
    const at = next.findIndex((x) => x.id === m.id);
    if (at >= 0) {
      if (authoritative) {
        next[at] = m;
        changed = true;
      }
      continue;
    }
    if (m.authorType === 'contact') {
      const pendingAt = next.findIndex(
        (x) => x.pending && x.authorType === 'contact' && x.body === m.body,
      );
      if (pendingAt >= 0) {
        next[pendingAt] = m;
        changed = true;
        continue;
      }
    }
    next.push(m);
    changed = true;
  }
  if (!changed) {
    // The SAME array, so a store comparing snapshots by identity does not
    // re-render a consumer for a poll that told it nothing new.
    return current;
  }
  return next.sort(byCreatedAt);
}

/** `message.updated`: a replaced body / blocks / canvas. Only the fields present are applied. */
export function foldUpdated(
  current: readonly ConversationMessage[],
  payload: Record<string, unknown>,
  readBlocks: BlocksReader = readBlockEnvelope,
): ConversationMessage[] {
  const id = str(payload['id']);
  return current.map((m) => {
    if (m.id !== id) {
      return m;
    }
    return {
      ...m,
      ...(typeof payload['body'] === 'string' ? { body: payload['body'] } : {}),
      ...(payload['bodyHtml'] !== undefined ? { bodyHtml: str(payload['bodyHtml']) } : {}),
      ...(payload['blocks'] !== undefined
        ? { blocks: payload['blocks'] === null ? null : readBlocks(payload['blocks']) }
        : {}),
      ...(payload['canvas'] !== undefined ? { canvas: payload['canvas'] } : {}),
    };
  });
}

/**
 * `message.deleted`: a tombstone in place, not a splice. Removing the row
 * would renumber the thread under the reader and hide that anything happened;
 * the visitor was there when it arrived.
 */
export function foldDeleted(
  current: readonly ConversationMessage[],
  payload: Record<string, unknown>,
  now: string,
): ConversationMessage[] {
  const id = str(payload['id']);
  return current.map((m) =>
    m.id === id
      ? {
          ...m,
          body: '',
          bodyHtml: null,
          blocks: null,
          canvas: null,
          attachments: [],
          deletedAt: now,
        }
      : m,
  );
}

/**
 * `message.reaction_changed` carries counts but not the viewer's own
 * `reacted` (it is viewer-relative, so it cannot be on a broadcast), so the
 * flag is KEPT from the existing row; an emoji new to the row is not reacted.
 * `fromServer` is a toggle response, which does carry it, and wins.
 */
export function foldReactions(
  current: readonly ConversationMessage[],
  messageId: string,
  entries: ReadonlyArray<{ emoji: string; count: number; reacted?: boolean }>,
  fromServer: boolean,
): ConversationMessage[] {
  return current.map((m) => {
    if (m.id !== messageId) {
      return m;
    }
    const kept = new Map(m.reactions.map((r) => [r.emoji, r.reacted]));
    return {
      ...m,
      reactions: entries
        .filter((e) => e.count > 0)
        .map((e) => ({
          emoji: e.emoji,
          count: e.count,
          reacted: fromServer ? e.reacted === true : (kept.get(e.emoji) ?? false),
        })),
    };
  });
}

/** A `message.reaction_changed` payload folded into the thread (counts only; `reacted` is viewer-relative). */
export function foldReactionEvent(
  messages: readonly ConversationMessage[],
  p: Record<string, unknown>,
): ConversationMessage[] {
  const entries = Array.isArray(p['entries'])
    ? (p['entries'] as Array<{ emoji: string; count: number }>)
    : [];
  return foldReactions(messages, String(p['messageId'] ?? ''), entries, false);
}

/**
 * A typing payload from an agent or a bot, or null. The dashboard publishes
 * room presence and collaborative-cursor frames AS typing.start (~10/s while
 * an agent moves the mouse): `kind: 'viewing'` is not typing, and neither is
 * anyone but an agent or a bot.
 */
export function readTyping(p: Record<string, unknown>): TypingState | null {
  if (p['kind'] === 'viewing' || (p['actorType'] !== 'agent' && p['actorType'] !== 'bot')) {
    return null;
  }
  return {
    actorType: p['actorType'],
    actorId: typeof p['actorId'] === 'string' ? p['actorId'] : '',
    displayName: typeof p['displayName'] === 'string' ? p['displayName'] : null,
    label: typeof p['label'] === 'string' ? p['label'] : null,
  };
}
