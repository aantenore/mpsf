import { childProcess } from "../../runtime/host.mjs";

/**
 * GitHub forge adapter for the coordinator, through the gh CLI the person
 * is already signed in with. Every call is bounded and returns plain data;
 * the runner is injectable so tests never reach GitHub.
 */
export const GITHUB_FORGE_ID = "github";
const TIMEOUT_MS = 30_000;
const PR_FIELDS = "number,title,url,headRefName,headRefOid,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,createdAt";
const RED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const MERGE_STATES = Object.freeze({ CLEAN: "clean", HAS_HOOKS: "clean", BEHIND: "behind", DIRTY: "conflicting", BLOCKED: "blocked", UNSTABLE: "unstable", DRAFT: "draft" });
const REVIEWS = Object.freeze({ APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "required" });
// Markers in a commit message that make GitHub Actions skip the push.
const SKIP_CI = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks:\s*true$/imu;
export const MERGE_METHODS = Object.freeze(["merge", "squash", "rebase"]);

function defaultRunner(root) {
  return (args) => {
    const result = childProcess.spawnSync("gh", args, { cwd: root, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
  };
}

function run(runner, args) {
  const result = runner(args);
  if (result.status !== 0) {
    const error = new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${String(result.stderr || "").trim().split("\n")[0] || `exit ${result.status}`}`);
    error.code = "FORGE_COMMAND_FAILED";
    throw error;
  }
  return result.stdout;
}

function runJson(runner, args) {
  return JSON.parse(run(runner, args) || "null");
}

/** One state for a list of checks: green, red, pending or none. */
export function checksState(checks = []) {
  if (!Array.isArray(checks) || checks.length === 0) return "none";
  let pending = false;
  for (const check of checks) {
    // CheckRun: status + conclusion; StatusContext: state.
    const conclusion = String(check?.conclusion ?? check?.state ?? "").toUpperCase();
    const status = String(check?.status ?? "COMPLETED").toUpperCase();
    if (RED.has(conclusion)) return "red";
    if (status !== "COMPLETED" || !GREEN.has(conclusion)) {
      if (conclusion !== "CANCELLED") pending = true;
    }
  }
  return pending ? "pending" : "green";
}

function failingNames(checks = []) {
  return checks
    .filter((check) => RED.has(String(check?.conclusion ?? check?.state ?? "").toUpperCase()))
    .map((check) => ({ name: String(check?.name ?? check?.context ?? "check"), url: check?.html_url ?? check?.detailsUrl ?? check?.targetUrl ?? null }));
}

export function normalizePullRequest(item) {
  return {
    number: item.number,
    title: String(item.title ?? ""),
    url: item.url ?? null,
    head_branch: String(item.headRefName ?? ""),
    head_sha: String(item.headRefOid ?? ""),
    draft: item.isDraft === true,
    mergeable: item.isDraft === true ? "draft" : MERGE_STATES[String(item.mergeStateStatus ?? "").toUpperCase()] ?? "unknown",
    checks: checksState(item.statusCheckRollup ?? []),
    review: REVIEWS[String(item.reviewDecision ?? "").toUpperCase()] ?? "none",
    created_at: item.createdAt ?? null,
  };
}

export function createGitHubForge({ root, runner = defaultRunner(root) } = {}) {
  return Object.freeze({
    id: GITHUB_FORGE_ID,
    /**
     * Check runs of the newest commit of `branch` that CI can run on. Commits
     * pushed with a skip marker (the plugin's own record commits) get no check
     * runs, so the tip alone would hide a red base behind them. A commit that
     * merely has no runs yet is still judged by its own state, not by an older one.
     */
    baseStatus(branch) {
      const recent = runJson(runner, ["api", `repos/{owner}/{repo}/commits?sha=${encodeURIComponent(branch)}&per_page=30`, "--jq", "[.[] | {sha: .sha, url: .html_url, message: .commit.message}]"]) ?? [];
      const commit = recent.find((item) => !SKIP_CI.test(String(item?.message ?? ""))) ?? recent[0];
      if (!commit?.sha) throw new Error(`no commits found on ${branch}`);
      const runs = runJson(runner, ["api", `repos/{owner}/{repo}/commits/${commit.sha}/check-runs?per_page=100`, "--jq", ".check_runs"]) ?? [];
      const checks = runs.map((item) => ({ name: item.name, status: item.status, conclusion: item.conclusion, html_url: item.html_url }));
      const state = checksState(checks);
      return { branch, sha: commit.sha, url: commit.url ?? null, state: state === "none" ? "unknown" : state, failing: failingNames(checks) };
    },
    listPullRequests(base) {
      const items = runJson(runner, ["pr", "list", "--base", base, "--state", "open", "--limit", "50", "--json", PR_FIELDS]) ?? [];
      return items.map(normalizePullRequest);
    },
    mergePullRequest({ number, headSha, method = "squash" }) {
      if (!MERGE_METHODS.includes(method)) throw new Error(`merge method must be one of ${MERGE_METHODS.join(", ")}`);
      // --match-head-commit: GitHub refuses when the branch moved after it was checked.
      run(runner, ["pr", "merge", String(number), `--${method}`, "--match-head-commit", headSha]);
      return { merged: true };
    },
    updateBranch({ number }) {
      run(runner, ["pr", "update-branch", String(number)]);
      return { updated: true };
    },
  });
}
