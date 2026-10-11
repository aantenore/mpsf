import { AsyncLocalStorage } from "node:async_hooks";

import { process } from "../runtime/host.mjs";

/**
 * A read snapshot lets one read-only report (status, the orchestration
 * snapshot, the Observatory model) ask Git the same question many times while
 * running it once. Inside the snapshot, identical Git queries return the
 * answer of the first call; outside it, every call runs as before. Commands
 * that write records or certify a story never open a snapshot, so their
 * checks always observe the repository live.
 */
const storage = new AsyncLocalStorage();

/**
 * Runs `callback` inside a read snapshot; a nested call joins the outer one.
 * `fastChecks` lets the report trust each story's sealed final receipt
 * instead of verifying it again against the repository.
 */
export function withReadSnapshot(
  callback,
  { fastChecks = false, memoize = true } = {},
) {
  if (storage.getStore()) return callback();
  const memo = new Map();
  memo.fastChecks = fastChecks === true;
  memo.memoize = memoize !== false;
  return storage.run(memo, callback);
}

/**
 * True inside a read-only report that trusts sealed final receipts: status
 * and the orchestration views, unless AGENTIC_SDLC_STATUS_CHECKS is "full".
 * A trusted receipt is labelled `verification: "not_rechecked"`. Gates,
 * claims, starts, story writes, and delivery actions never trust: every
 * receipt they depend on is verified in full.
 */
export function readSnapshotFastChecks() {
  return storage.getStore()?.fastChecks === true;
}

/**
 * False when AGENTIC_SDLC_STATUS_CHECKS is "full": every sealed receipt is
 * then verified again against the repository.
 */
export function sealedReceiptTrustEnabled(env = process.env) {
  return String(env.AGENTIC_SDLC_STATUS_CHECKS || "fast").trim().toLowerCase() !== "full";
}

/**
 * Runs the read-only checks that certify one story inside a read snapshot:
 * repeated Git questions run once, and every final receipt they depend on,
 * the story's own and its dependencies', is verified in full. A decision
 * that unblocks or certifies work never relies on a receipt it did not
 * re-check.
 */
export function withStoryCheckSnapshot(callback) {
  return withReadSnapshot(callback);
}

export function readSnapshotActive() {
  return storage.getStore()?.memoize === true;
}

/**
 * Runs a command that writes records with every Git query live. Each final
 * receipt it depends on is verified in full, with repeated answers memoized
 * only while one receipt check runs (see withScopedReadMemo).
 */
export function withLiveStoryChecks(callback) {
  return withReadSnapshot(callback, { memoize: false });
}

/**
 * The cached answer for `key` inside a read snapshot, computing it on first
 * use. Failures are cached too, so a query that failed once fails the same
 * way for every caller of the same report. Values must be immutable (strings,
 * booleans, frozen data).
 */
export function readSnapshotValue(key, compute) {
  const memo = storage.getStore();
  if (!memo || memo.memoize !== true) return compute();
  if (memo.has(key)) {
    const entry = memo.get(key);
    if (entry.failed) throw entry.error;
    return entry.value;
  }
  try {
    const value = compute();
    memo.set(key, { failed: false, value });
    return value;
  } catch (error) {
    memo.set(key, { failed: true, error });
    throw error;
  }
}

/**
 * Runs one read-only check with repeated answers memoized for its duration.
 * Inside a command that reads live (memoize: false), the answers kept while
 * the check runs are dropped when it returns, so the next check reads the
 * repository live again. A nested call joins the outer scope.
 */
export function withScopedReadMemo(callback) {
  const memo = storage.getStore();
  if (!memo) return withReadSnapshot(callback);
  if (memo.memoize === true) return callback();
  const before = new Set(memo.keys());
  memo.memoize = true;
  try {
    return callback();
  } finally {
    memo.memoize = false;
    for (const key of [...memo.keys()]) {
      if (!before.has(key)) memo.delete(key);
    }
  }
}
