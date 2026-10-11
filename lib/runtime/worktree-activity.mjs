import path from "node:path";

import { Date, fs, process } from "../runtime/host.mjs";
import { findGitCommonDir } from "./run-registry.mjs";

/**
 * When an agent last worked in each worktree of this clone: the host hook
 * notes the project folder of every tool call (at most once a minute per
 * folder) in <git common dir>/agentic-sdlc/worktree-activity.json. Editing
 * code does not touch git until a commit, so this is what renews the claim
 * of a story while its agent works (lib/messaging/presence.mjs).
 */
export const WORKTREE_ACTIVITY_FILE = "worktree-activity.json";
const NOTE_EVERY_MS = 60_000;
const KEEP_MS = 3 * 24 * 3600_000;

function activityFile(commonDir) {
  return commonDir ? path.join(commonDir, "agentic-sdlc", WORKTREE_ACTIVITY_FILE) : null;
}

/** Folder (resolved) -> ms of the last noted work; {} when unknown. */
export function readWorktreeActivity(commonDir) {
  const file = activityFile(commonDir);
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Notes work in `root` now; never throws. */
export function noteWorktreeActivity(root, now = Date.now()) {
  try {
    const commonDir = findGitCommonDir(root);
    const file = activityFile(commonDir);
    if (!file) return;
    const dir = path.resolve(root);
    const seen = readWorktreeActivity(commonDir);
    const last = now - Number(seen[dir]);
    if (last >= 0 && last < NOTE_EVERY_MS) return;
    const kept = Object.fromEntries(Object.entries(seen).filter(([, at]) => Math.abs(now - Number(at)) < KEEP_MS));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ ...kept, [dir]: now })}\n`);
    fs.renameSync(temp, file);
  } catch {
    // best effort
  }
}
