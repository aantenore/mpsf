/**
 * The "no messaging" adapter. Choosing it turns messaging off: the settings
 * resolve as disabled, so send, read, listen and the automatic notices do
 * nothing and make no call, exactly as on a computer that never set
 * messaging up. Every flow keeps working, because coordination state lives in
 * the record store, not in messages.
 *
 * The object below exists so the port contract holds for every registered
 * id: publishing is accepted and dropped, reading returns nothing.
 */
import { NONE_PROVIDER_ID } from "../../adapters/messaging/ids.mjs";
export { NONE_PROVIDER_ID };

export function createNoneProvider() {
  return Object.freeze({
    id: NONE_PROVIDER_ID,
    guarantees: Object.freeze([]),
    async ensureChannel() {
      return { issue: null, created: false, url: null };
    },
    async publish() {
      return { id: null, time: null, dropped: true };
    },
    async poll() {
      return [];
    },
    async subscribe({ signal } = {}) {
      if (signal?.aborted) return;
      await new Promise((resolve) => signal?.addEventListener?.("abort", resolve, { once: true }) ?? resolve());
    },
    async whoami() {
      return null;
    },
  });
}
