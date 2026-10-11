import { process } from "../../runtime/host.mjs";
import { checksState, MERGE_METHODS } from "./github.mjs";
import { createRestClient, forgeCredential, missingTokenError, parseRemote } from "./http.mjs";

/**
 * Gitea and Forgejo (Codeberg included) forge adapter over their shared
 * REST API v1. Commit statuses (Actions included) are the checks, pull
 * request reviews the review state. Same four methods as the GitHub
 * adapter; the HTTP runner is injectable so tests never reach the forge.
 */
export const GITEA_FORGE_ID = "gitea";
export const FORGEJO_FORGE_ID = "forgejo";
export const GITEA_TOKEN_ENVS = Object.freeze(["GITEA_TOKEN", "FORGEJO_TOKEN"]);

// Commit-status states in the GitHub check vocabulary checksState reads.
const STATES = Object.freeze({ success: "SUCCESS", warning: "NEUTRAL", failure: "FAILURE", error: "ERROR" });
function toCheck(item) {
  const conclusion = STATES[String(item?.status ?? item?.state ?? "").toLowerCase()];
  const name = String(item?.context ?? "check");
  const url = item?.target_url ?? null;
  return conclusion ? { name, status: "COMPLETED", conclusion, html_url: url } : { name, status: "IN_PROGRESS", conclusion: "", html_url: url };
}

const WIP_TITLE = /^\s*(\[wip\]|wip:|\[draft\]|draft:)/iu;

/** Latest review per reviewer, dismissed and stale ones aside. */
export function reviewState(reviews = []) {
  const latest = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const state = String(review?.state ?? "").toUpperCase();
    if (review?.dismissed === true || review?.stale === true || !["APPROVED", "REQUEST_CHANGES"].includes(state)) continue;
    latest.set(String(review?.user?.login ?? review?.user?.id ?? review?.id), state);
  }
  const states = [...latest.values()];
  if (states.includes("REQUEST_CHANGES")) return "changes_requested";
  return states.includes("APPROVED") ? "approved" : "none";
}

export function normalizeGiteaPullRequest(item, status = null, reviews = []) {
  const draft = item.draft === true || WIP_TITLE.test(String(item.title ?? ""));
  const statuses = Array.isArray(status?.statuses) ? status.statuses : [];
  return {
    number: item.number,
    title: String(item.title ?? ""),
    url: item.html_url ?? null,
    head_branch: String(item.head?.ref ?? ""),
    head_sha: String(item.head?.sha ?? ""),
    draft,
    mergeable: draft ? "draft" : item.mergeable === true ? "clean" : item.mergeable === false ? "conflicting" : "unknown",
    checks: checksState(statuses.map(toCheck)),
    review: reviewState(reviews),
    created_at: item.created_at ?? null,
  };
}

export function createGiteaForge({ url = null, env = process.env, http, gitRunner, id = GITEA_FORGE_ID } = {}) {
  const label = id === FORGEJO_FORGE_ID ? "Forgejo" : "Gitea";
  const remote = parseRemote(url, env);
  if (!remote) throw Object.assign(new Error(`${label}: cannot read the repository from the remote URL; set it with git remote or AGENTIC_SDLC_FORGE_URL`), { code: "FORGE_REMOTE_UNKNOWN" });
  const repo = `/repos/${remote.path.split("/").map(encodeURIComponent).join("/")}`;
  let credential;
  function headers() {
    credential ??= forgeCredential({ webUrl: remote.webUrl, envNames: GITEA_TOKEN_ENVS, env, ...(gitRunner ? { gitRunner } : {}) });
    if (!credential) throw missingTokenError(label, remote.webUrl, GITEA_TOKEN_ENVS);
    if (credential.scheme === "basic" && credential.username) {
      return { Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString("base64")}` };
    }
    return { Authorization: `token ${credential.token}` };
  }
  const rest = createRestClient({ label, apiBase: `${remote.webUrl}/api/v1`, headers, ...(http ? { http } : {}) });
  return Object.freeze({
    id,
    baseStatus(branch) {
      const status = rest.call("GET", `${repo}/commits/${encodeURIComponent(branch)}/status`);
      const checks = (Array.isArray(status?.statuses) ? status.statuses : []).map(toCheck);
      const failing = checks.filter((item) => item.conclusion === "FAILURE" || item.conclusion === "ERROR").map((item) => ({ name: item.name, url: item.html_url }));
      const state = checksState(checks);
      const sha = String(status?.sha ?? "");
      return { branch, sha, url: sha ? `${remote.webUrl}/${remote.path}/commit/${sha}` : null, state: state === "none" ? "unknown" : state, failing };
    },
    listPullRequests(base) {
      const items = (rest.call("GET", `${repo}/pulls?state=open&limit=50&sort=oldest`) ?? []).filter((item) => String(item.base?.ref ?? "") === base);
      const extra = rest.all(items.flatMap((item) => [["GET", `${repo}/commits/${item.head?.sha}/status`], ["GET", `${repo}/pulls/${item.number}/reviews`]]));
      return items.map((item, index) => normalizeGiteaPullRequest(item, extra[index * 2], extra[index * 2 + 1]));
    },
    mergePullRequest({ number, headSha, method = "squash" }) {
      if (!MERGE_METHODS.includes(method)) throw new Error(`merge method must be one of ${MERGE_METHODS.join(", ")}`);
      // head_commit_id: the forge refuses when the branch moved after it was checked.
      rest.call("POST", `${repo}/pulls/${number}/merge`, { Do: method, head_commit_id: headSha });
      return { merged: true };
    },
    updateBranch({ number }) {
      rest.call("POST", `${repo}/pulls/${number}/update`);
      return { updated: true };
    },
  });
}
