import { storyOpen } from "./project.mjs";

/**
 * Keeping the base branch green: when its CI is red the coordinator opens
 * one P1 fix story, never a revert. The fix goes forward like any story,
 * first in the priority order (lib/engine/story-priority.mjs). One open
 * main-green story at a time: a later red commit while it is open adds
 * nothing.
 */
export const MAIN_GREEN_PREFIX = "ST-MAIN-GREEN-";

export function mainGreenStoryId(sha) {
  return `${MAIN_GREEN_PREFIX}${String(sha ?? "").slice(0, 8).toUpperCase() || "UNKNOWN"}`;
}

/**
 * Pure plan: `status` is { state: green|red|pending|unknown, branch, sha, failing: [{ name }] }.
 * Returns { action: "none"|"exists"|"create", ... }.
 */
export function planMainGreen({ status, stories = [] }) {
  if (status?.state !== "red") return { action: "none", state: status?.state ?? "unknown", branch: status?.branch ?? null, sha: status?.sha ?? null };
  const open = stories.find((story) => String(story.id ?? "").startsWith(MAIN_GREEN_PREFIX) && storyOpen(story));
  if (open) return { action: "exists", state: "red", branch: status.branch, sha: status.sha, story_id: open.id };
  const failing = (status.failing ?? []).map((item) => item.name).filter(Boolean);
  const names = failing.length ? failing.slice(0, 5).join(", ") : "CI";
  return {
    action: "create",
    state: "red",
    branch: status.branch,
    sha: status.sha,
    failing,
    story: {
      id: mainGreenStoryId(status.sha),
      title: `Restore green ${status.branch}: ${names} failing at ${String(status.sha ?? "").slice(0, 8)}`,
      acceptance: [
        `CI on ${status.branch} is green again (${names}).`,
        "The fix moves the branch forward with a new change; nothing is reverted.",
      ],
      priority: "P1",
    },
  };
}
