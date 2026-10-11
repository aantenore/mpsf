import path from "node:path";

import { Date, fs, process } from "../runtime/host.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";

/**
 * Push budget of this computer for coordination records (channel messages,
 * presence, role leases). GitHub recommends about 6 pushes a minute per
 * repository, summed over every computer, so each computer spaces its own:
 *
 *   - at most one coordination push every MIN_INTERVAL_MS; what is written
 *     meanwhile (messages) waits and goes out together with the next one, in
 *     a single `git push` with several refspecs;
 *   - after a failed push, exponential backoff from BACKOFF_BASE_MS up to
 *     BACKOFF_MAX_MS (kept below the presence time to live).
 *
 * The state is per clone (<git-common-dir>/agentic-sdlc/push-budget.json).
 * AGENTIC_SDLC_PUSH_INTERVAL_SECONDS changes the interval (0 = no spacing,
 * backoff still applies). Code pushes (story branches, main) are not counted.
 */
export const PUSH_BUDGET_FILE = "push-budget.json";
export const PUSH_INTERVAL_ENV = "AGENTIC_SDLC_PUSH_INTERVAL_SECONDS";
export const MIN_INTERVAL_MS = 2 * 60_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 8 * 60_000;

function budgetPath(root) {
  const common = findGitCommonDir(root);
  return common ? path.join(common, "agentic-sdlc", PUSH_BUDGET_FILE) : null;
}

function readBudget(root) {
  const file = budgetPath(root);
  try {
    const parsed = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeBudget(root, budget) {
  const file = budgetPath(root);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(budget, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // Losing it only means one push sooner.
  }
}

/** The minimum spacing of coordination pushes, from the environment or the default. */
export function pushIntervalMs(env = process.env) {
  const raw = String(env?.[PUSH_INTERVAL_ENV] ?? "").trim();
  if (raw === "") return MIN_INTERVAL_MS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : MIN_INTERVAL_MS;
}

/**
 * Whether a coordination push may go now: { due, wait_ms, backoff }.
 * `urgent` skips the spacing (not the backoff): role leases and presence changes.
 */
export function pushWindow(root, { now = Date.now(), env = process.env, urgent = false } = {}) {
  const budget = readBudget(root);
  // A clock set back never holds pushes longer than the interval or the longest backoff.
  const spaced = urgent ? 0 : Math.min(Number(budget.last_push_ms || 0), now) + pushIntervalMs(env) - now;
  const backoff = Math.min(Number(budget.retry_at_ms || 0) - now, BACKOFF_MAX_MS);
  const wait = Math.max(0, spaced, backoff);
  return { due: wait <= 0, wait_ms: wait, backoff: backoff > 0 };
}

/**
 * Records one coordination push: "ok" (or a rejected ref, which still
 * reached the remote) resets the backoff; "temporary" or "failed" doubles it.
 */
export function notePush(root, outcome, { now = Date.now() } = {}) {
  const budget = readBudget(root);
  if (outcome === "temporary" || outcome === "failed") {
    const failures = Math.min(16, Number(budget.failures || 0) + 1);
    writeBudget(root, { ...budget, failures, retry_at_ms: now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)) });
    return;
  }
  writeBudget(root, { ...budget, last_push_ms: now, failures: 0, retry_at_ms: 0 });
}
