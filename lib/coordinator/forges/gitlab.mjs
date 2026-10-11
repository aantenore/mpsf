import { process } from "../../runtime/host.mjs";
import { checksState } from "./github.mjs";
import { createRestClient, forgeCredential, missingTokenError, parseRemote } from "./http.mjs";

/**
 * GitLab forge adapter (gitlab.com or self-managed) over the REST API v4:
 * merge requests are the pull requests, pipelines and commit statuses the
 * checks. Same four methods as the GitHub adapter; the HTTP runner is
 * injectable so tests never reach GitLab.
 */
export const GITLAB_FORGE_ID = "gitlab";
export const GITLAB_TOKEN_ENVS = Object.freeze(["GITLAB_TOKEN"]);
const LABEL = "GitLab";

// Pipeline and commit-status states in the GitHub check vocabulary checksState reads.
const STATES = Object.freeze({ success: "SUCCESS", skipped: "SKIPPED", manual: "NEUTRAL", failed: "FAILURE", canceled: "FAILURE", canceling: "FAILURE" });
function check(name, status, url, allowFailure = false) {
  const conclusion = STATES[String(status ?? "").toLowerCase()];
  if (conclusion === "FAILURE" && allowFailure) return { name, status: "COMPLETED", conclusion: "NEUTRAL", html_url: url };
  return conclusion ? { name, status: "COMPLETED", conclusion, html_url: url } : { name, status: "IN_PROGRESS", conclusion: "", html_url: url };
}

// detailed_merge_status (GitLab 15.6+), else the older merge_status.
const DETAILED = Object.freeze({
  mergeable: "clean",
  ci_must_pass: "clean",
  ci_still_running: "clean",
  not_approved: "clean",
  requested_changes: "clean",
  conflict: "conflicting",
  need_rebase: "behind",
  draft_status: "draft",
  discussions_not_resolved: "blocked",
  blocked_status: "blocked",
  not_open: "blocked",
  external_status_checks: "blocked",
  jira_association_missing: "blocked",
  merge_request_blocked: "blocked",
  security_policy_violations: "blocked",
});

export function normalizeMergeRequest(item, pipeline = item?.head_pipeline ?? null) {
  const detailed = String(item.detailed_merge_status ?? "").toLowerCase();
  const draft = item.draft === true || item.work_in_progress === true || detailed === "draft_status";
  let mergeable = DETAILED[detailed];
  if (!mergeable) {
    if (item.has_conflicts === true || item.merge_status === "cannot_be_merged") mergeable = "conflicting";
    else if (!detailed && item.merge_status === "can_be_merged") mergeable = "clean";
    else mergeable = "unknown";
  }
  return {
    number: item.iid,
    title: String(item.title ?? ""),
    url: item.web_url ?? null,
    head_branch: String(item.source_branch ?? ""),
    head_sha: String(item.sha ?? ""),
    draft,
    mergeable: draft ? "draft" : mergeable,
    checks: pipeline ? checksState([check("pipeline", pipeline.status, pipeline.web_url ?? null)]) : "none",
    review: detailed === "requested_changes" ? "changes_requested" : detailed === "not_approved" ? "required" : "none",
    created_at: item.created_at ?? null,
  };
}

export function createGitLabForge({ url = null, env = process.env, http, gitRunner } = {}) {
  const remote = parseRemote(url, env);
  if (!remote) throw Object.assign(new Error(`${LABEL}: cannot read the project from the remote URL; set it with git remote or AGENTIC_SDLC_FORGE_URL`), { code: "FORGE_REMOTE_UNKNOWN" });
  const project = `/projects/${encodeURIComponent(remote.path)}`;
  let credential;
  function headers() {
    credential ??= forgeCredential({ webUrl: remote.webUrl, envNames: GITLAB_TOKEN_ENVS, env, ...(gitRunner ? { gitRunner } : {}) });
    if (!credential) throw missingTokenError(LABEL, remote.webUrl, GITLAB_TOKEN_ENVS);
    // Personal, project and OAuth tokens all work as a bearer token.
    return { Authorization: `Bearer ${credential.token}` };
  }
  const rest = createRestClient({ label: LABEL, apiBase: `${remote.webUrl}/api/v4`, headers, ...(http ? { http } : {}) });
  return Object.freeze({
    id: GITLAB_FORGE_ID,
    baseStatus(branch) {
      const commit = rest.call("GET", `${project}/repository/commits/${encodeURIComponent(branch)}`);
      const statuses = rest.call("GET", `${project}/repository/commits/${commit.id}/statuses?per_page=100&all=false`) ?? [];
      const checks = statuses.map((item) => check(item.name, item.status, item.target_url ?? null, item.allow_failure === true));
      const failing = checks.filter((item) => item.conclusion === "FAILURE").map((item) => ({ name: String(item.name ?? "check"), url: item.html_url }));
      const state = checksState(checks);
      return { branch, sha: commit.id, url: commit.web_url ?? null, state: state === "none" ? "unknown" : state, failing };
    },
    listPullRequests(base) {
      const items = rest.call("GET", `${project}/merge_requests?state=opened&target_branch=${encodeURIComponent(base)}&per_page=50&order_by=created_at&sort=asc`) ?? [];
      // The list has no pipeline; one read per merge request brings head_pipeline.
      const details = rest.all(items.map((item) => ["GET", `${project}/merge_requests/${item.iid}`]));
      return details.map((item) => normalizeMergeRequest(item));
    },
    mergePullRequest({ number, headSha, method = "squash" }) {
      // GitLab sets rebase or fast-forward per project, not per merge.
      if (method === "rebase") throw new Error(`${LABEL} picks rebase or fast-forward from the project's merge method; use --method merge or squash`);
      if (method !== "merge" && method !== "squash") throw new Error("merge method must be one of merge, squash");
      // sha: GitLab refuses when the branch moved after it was checked.
      rest.call("PUT", `${project}/merge_requests/${number}/merge`, { sha: headSha, squash: method === "squash" });
      return { merged: true };
    },
    updateBranch({ number }) {
      rest.call("PUT", `${project}/merge_requests/${number}/rebase`);
      return { updated: true };
    },
  });
}
