import { crypto, Date } from "../runtime/host.mjs";
import { storyPriority } from "../engine/story-priority.mjs";
import { storyOpen } from "./project.mjs";

/**
 * The coordinator's digest: one short summary of the project for every
 * computer, sent only when its content changed and at most once per
 * DIGEST_MIN_GAP_MS. It replaces the periodic presence heartbeat: one
 * message from one computer instead of one per computer.
 */
export const DIGEST_PREFIX = "digest:";
export const DIGEST_MIN_GAP_MS = 15 * 60_000;
const LISTED = 6;

function list(items) {
  if (items.length === 0) return "none";
  const shown = items.slice(0, LISTED).join(", ");
  return items.length > LISTED ? `${shown} +${items.length - LISTED}` : shown;
}

/**
 * Pure digest from what this clone already knows:
 *   live      host ids alive on the remote
 *   recap     { in_progress, parked, waiting } as recapStatus returns it
 *   stories   local story records (priority, status)
 */
export function buildDigest({ live = [], recap = {}, stories = [] }) {
  const urgent = stories.filter((story) => storyOpen(story) && storyPriority(story) === "P1").map((story) => story.id).sort();
  const parts = [
    `${live.length} computer${live.length === 1 ? "" : "s"} alive${live.length ? ` (${list([...live].sort())})` : ""}`,
    `in progress ${list(recap.in_progress ?? [])}`,
    `waiting ${list(recap.waiting ?? [])}`,
    `parked ${list(recap.parked ?? [])}`,
    `open P1 ${list(urgent)}`,
  ];
  const text = `${DIGEST_PREFIX} ${parts.join("; ")}`;
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  return { text, hash, key: `digest:${hash}`, live: [...live].sort(), recap, open_p1: urgent };
}

/** Whether a digest goes out now: skipped when unchanged or too soon after the last one. */
export function digestDue(digest, state = {}, { now = Date.now(), minGapMs = DIGEST_MIN_GAP_MS, force = false } = {}) {
  if (force) return { due: true };
  if (state.digest_hash === digest.hash) return { due: false, reason: "unchanged" };
  const last = Number(state.digest_at);
  if (Number.isFinite(last) && now - last < minGapMs) return { due: false, reason: "too_soon" };
  return { due: true };
}
