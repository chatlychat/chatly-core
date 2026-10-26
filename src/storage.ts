import type { KeyValueStorage, StorageSource } from './types.js';

/**
 * Storage that never throws, for a script that runs where it was not invited.
 *
 * The lesson is `apps/widget/src/safe-storage.ts`'s and it is worth restating
 * because it is the failure that looks least like one: reading
 * `window.localStorage` THROWS (it does not return null) when the visitor has
 * blocked site data, when the document has an opaque origin (a sandboxed
 * iframe without `allow-same-origin`), on `file://` in some browsers, and on
 * write when the store is full. The widget shipped eleven unguarded accesses
 * and on those browsers it failed to boot rather than degrading to an
 * anonymous session.
 *
 * The contract here is the codebase's: a read that cannot happen is `null`, a
 * write that cannot happen is a no-op against the store, and NEITHER EVER
 * THROWS. What changes from the widget is the fallback. A failed or absent
 * store degrades to an in-memory map, so the session survives for the
 * lifetime of the object (a second call does not mint a second visitor) and
 * is simply not remembered across restarts.
 *
 * ── Three decisions ─────────────────────────────────────────────────────
 *
 *  1. **No storage is the DEFAULT, and it is memory.** The core persists
 *     nothing unless the host hands it a store. The widget learned
 *     (CHT-S-01) that writing a visitor token on page load, before any
 *     consent decision, is a defect on a site that must not store anything.
 *     A headless core has no business choosing for its host.
 *  2. **A thunk is accepted.** `storage: () => localStorage` puts the
 *     throwing getter inside this try/catch. See `StorageSource`.
 *  3. **The source is resolved lazily and re-resolved after a failure** —
 *     once, per operation. A host that grants consent later (or whose store
 *     was momentarily full) gets its store back without a restart.
 */
export function createSafeStorage(source?: StorageSource): KeyValueStorage {
  const memory = new Map<string, string>();

  const resolve = (): KeyValueStorage | null => {
    try {
      const s = typeof source === 'function' ? source() : source;
      return s ?? null;
    } catch {
      return null;
    }
  };

  return {
    getItem(key): string | null {
      const store = resolve();
      if (store !== null) {
        try {
          const v = store.getItem(key);
          if (typeof v === 'string') {
            return v;
          }
        } catch {
          // fall through to memory
        }
      }
      return memory.get(key) ?? null;
    },
    setItem(key, value): void {
      // Memory always holds the latest, so a store that rejects the write
      // (quota, blocked) still yields a coherent session in this process.
      memory.set(key, value);
      const store = resolve();
      if (store === null) {
        return;
      }
      try {
        store.setItem(key, value);
      } catch {
        // swallowed on purpose: see the contract above
      }
    },
    removeItem(key): void {
      memory.delete(key);
      const store = resolve();
      if (store === null) {
        return;
      }
      try {
        store.removeItem(key);
      } catch {
        // swallowed on purpose
      }
    },
  };
}
