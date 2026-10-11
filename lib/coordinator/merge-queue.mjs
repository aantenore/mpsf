import { compareStoriesByPriority } from "../engine/story-priority.mjs";

/**
 * Serial merges: one ready pull request at a time, in the project's
 * priority order (the story named by the head branch: P1 > P2 > P3 > none,
 * then the oldest). Ready means not a draft, mergeable without conflicts,
 * checks green (or none) and no review asking for changes or still
 * required. When nothing is ready but the head of the queue is only behind
 * its base, the coordinator asks the forge to update that one branch.
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The longest known story id named by `branch`, or null. */
export function storyOfBranch(branch, storyIds = []) {
  const text = String(branch ?? "");
  const ids = [...storyIds].sort((left, right) => right.length - left.length);
  return ids.find((id) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(id)}($|[^A-Za-z0-9])`, "iu").test(text)) ?? null;
}

export function readiness(pr) {
  if (pr.draft || pr.mergeable === "draft") return "draft";
  if (pr.checks === "red") return "checks_red";
  if (pr.checks === "pending") return "checks_pending";
  if (pr.review === "changes_requested") return "changes_requested";
  if (pr.review === "required") return "review_required";
  if (pr.mergeable === "behind") return "behind";
  if (pr.mergeable !== "clean") return pr.mergeable;
  return "ready";
}

/** Pure plan: { queue: [{ pr, story, state }], ready, behind } in merge order. */
export function planMergeQueue(prs = [], stories = []) {
  const byId = new Map(stories.map((story) => [String(story.id), story]));
  const ids = [...byId.keys()];
  const queue = prs
    .map((pr) => {
      const storyId = storyOfBranch(pr.head_branch, ids);
      const story = storyId ? byId.get(storyId) : null;
      return { pr, story: storyId, order: { id: storyId ?? `#${pr.number}`, priority: story?.priority ?? null, created_at: pr.created_at }, state: readiness(pr) };
    })
    .sort((left, right) => compareStoriesByPriority(left.order, right.order) || left.pr.number - right.pr.number)
    .map(({ pr, story, state }) => ({ pr, story, state }));
  return { queue, ready: queue.filter((item) => item.state === "ready"), behind: queue.filter((item) => item.state === "behind") };
}

/**
 * Runs the queue against `forge`: merges up to `max` ready pull requests,
 * one at a time, re-reading the list after each merge; with none ready,
 * updates the first one that is only behind. dryRun reports the plan only.
 */
export function runMergeQueue({ forge, base, stories = [], max = 1, method = "squash", dryRun = false }) {
  let plan = planMergeQueue(forge.listPullRequests(base), stories);
  const initial = plan;
  const merged = [];
  const failed = [];
  let updated = null;
  if (dryRun) return { plan: initial, merged, failed, updated };
  while (merged.length < max && plan.ready.length > 0) {
    const next = plan.ready.find((item) => !failed.some((failure) => failure.number === item.pr.number));
    if (!next) break;
    try {
      forge.mergePullRequest({ number: next.pr.number, headSha: next.pr.head_sha, method });
      merged.push({ number: next.pr.number, url: next.pr.url, story: next.story });
    } catch (error) {
      failed.push({ number: next.pr.number, url: next.pr.url, error: String(error?.message ?? error) });
    }
    if (merged.length >= max) break;
    plan = planMergeQueue(forge.listPullRequests(base), stories);
  }
  if (merged.length === 0 && plan.ready.length === 0 && plan.behind.length > 0) {
    const head = plan.behind[0];
    try {
      forge.updateBranch({ number: head.pr.number });
      updated = { number: head.pr.number, url: head.pr.url };
    } catch (error) {
      failed.push({ number: head.pr.number, url: head.pr.url, error: String(error?.message ?? error) });
    }
  }
  return { plan: initial, merged, failed, updated };
}
