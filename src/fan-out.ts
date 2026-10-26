/**
 * Delivering one event to every subscribed handler, and the unprompted-
 * capability routing that uses it. Out of `conversation.ts` (650 lines); no
 * behaviour changed.
 */
import type { HostCapabilityInvocation } from './host-surface.js';
import type { VisitorApi } from './visitor-api.js';

/** One handler's bug must not stop the others hearing it. */
export function fanOut<T>(handlers: ReadonlySet<(value: T) => void>, value: T): void {
  for (const h of [...handlers]) {
    try {
      h(value);
    } catch {
      // Swallowed on purpose: see above.
    }
  }
}

/**
 * A bot-fired capability reaches the handlers, unless the space refused
 * unprompted ones (`setUnpromptedAllowed`). Refused, not ignored: answering
 * closes the server's ledger row now instead of leaving the capability "in
 * flight" until it expires. Best-effort: the announcement already stands.
 */
export function routeInvocation(
  inv: HostCapabilityInvocation,
  allowed: boolean,
  handlers: ReadonlySet<(inv: HostCapabilityInvocation) => void>,
  api: VisitorApi,
  conversationId: string,
): void {
  if (!allowed) {
    api
      .reportAction(conversationId, {
        messageId: inv.messageId,
        actionId: inv.invocationId,
        status: 'failed',
        data: { refused: true },
      })
      .catch(() => undefined);
    return;
  }
  fanOut(handlers, inv);
}
