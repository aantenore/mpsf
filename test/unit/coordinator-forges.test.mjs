import assert from "node:assert/strict";
import test from "node:test";

import { detectForge, resolveForge } from "../../lib/coordinator/forges/index.mjs";
import { forgeCredential, parseRemote } from "../../lib/coordinator/forges/http.mjs";
import { normalizeMergeRequest } from "../../lib/coordinator/forges/gitlab.mjs";
import { normalizeGiteaPullRequest, reviewState } from "../../lib/coordinator/forges/gitea.mjs";
import { runMergeQueue } from "../../lib/coordinator/merge-queue.mjs";

const noKeychain = () => ({ status: 1, stdout: "" });

/** Fake HTTP: answers by "METHOD path" (query dropped) and records each call. */
function fakeHttp(routes, calls = []) {
  return (requests) =>
    requests.map((request) => {
      const url = new URL(request.url);
      const key = `${request.method} ${url.pathname}`;
      calls.push({ key, query: url.search, headers: request.headers, body: request.body ? JSON.parse(request.body) : null });
      const answer = routes[key];
      if (answer === undefined) return { status: 404, text: JSON.stringify({ message: `no route ${key}` }) };
      return typeof answer === "number" ? { status: answer, text: "" } : { status: 200, text: JSON.stringify(answer) };
    });
}

test("forge detection and remote parsing", () => {
  assert.equal(detectForge("git@gitlab.com:g/sub/p.git"), "gitlab");
  assert.equal(detectForge("https://gitlab.acme.io/g/p"), "gitlab");
  assert.equal(detectForge("ssh://git@codeberg.org/o/r.git"), "forgejo");
  assert.equal(detectForge("https://gitea.acme.io/o/r"), "gitea");
  assert.equal(detectForge("https://git.acme.io/o/r"), null);
  assert.deepEqual(parseRemote("git@gitlab.com:g/sub/p.git", {}), { webUrl: "https://gitlab.com", host: "gitlab.com", path: "g/sub/p" });
  assert.deepEqual(parseRemote("ssh://git@git.acme.io:2222/o/r.git", {}), { webUrl: "https://git.acme.io", host: "git.acme.io", path: "o/r" });
  assert.deepEqual(parseRemote("https://git.acme.io/gl/o/r.git", { AGENTIC_SDLC_FORGE_URL: "https://git.acme.io/gl/" }), { webUrl: "https://git.acme.io/gl", host: "git.acme.io", path: "o/r" });
  const chosen = resolveForge("/x", { env: { AGENTIC_SDLC_FORGE: "gitea" }, url: "https://git.acme.io/o/r" });
  assert.equal(chosen.forge.id, "gitea");
  assert.match(resolveForge("/x", { env: {}, url: "/local/path" }).reason ?? "", /AGENTIC_SDLC_FORGE/u);
  assert.match(resolveForge("/x", { env: { AGENTIC_SDLC_FORGE: "gitlab" }, url: "/local/path" }).reason, /remote URL/u);
});

test("token comes from the environment, else the keychain, else a clear error that names both", () => {
  assert.deepEqual(forgeCredential({ webUrl: "https://gitlab.com", envNames: ["GITLAB_TOKEN"], env: { GITLAB_TOKEN: "t1" }, gitRunner: noKeychain }), { scheme: "token", token: "t1" });
  let input = "";
  const keychain = (args, text) => {
    input = text;
    return { status: 0, stdout: "protocol=https\nhost=gitlab.com\nusername=me\npassword=t2\n" };
  };
  assert.deepEqual(forgeCredential({ webUrl: "https://gitlab.com", envNames: [], env: {}, gitRunner: keychain }), { scheme: "basic", username: "me", token: "t2" });
  assert.match(input, /host=gitlab\.com/u);
  const forge = resolveForge("/x", { env: {}, url: "https://gitlab.com/g/p", http: fakeHttp({}), gitRunner: noKeychain }).forge;
  assert.throws(() => forge.listPullRequests("main"), (error) => error.code === "FORGE_TOKEN_MISSING" && /GITLAB_TOKEN/u.test(error.message) && /git credential approve/u.test(error.message));
});

test("gitlab merge requests normalize, merge with the head sha and rebase when behind", () => {
  const mr = normalizeMergeRequest({ iid: 3, title: "ST-1", web_url: "u3", source_branch: "story/ST-1", sha: "s3", detailed_merge_status: "mergeable", head_pipeline: { status: "success" }, created_at: "2026-10-01" });
  assert.deepEqual([mr.number, mr.mergeable, mr.checks, mr.review], [3, "clean", "green", "none"]);
  assert.equal(normalizeMergeRequest({ iid: 4, detailed_merge_status: "ci_still_running", head_pipeline: { status: "running" } }).checks, "pending");
  assert.equal(normalizeMergeRequest({ iid: 5, detailed_merge_status: "not_approved" }).review, "required");
  assert.equal(normalizeMergeRequest({ iid: 6, merge_status: "cannot_be_merged" }).mergeable, "conflicting");
  assert.equal(normalizeMergeRequest({ iid: 7, draft: true }).mergeable, "draft");

  const calls = [];
  const project = "/api/v4/projects/g%2Fp";
  const http = fakeHttp({
    [`GET ${project}/merge_requests`]: [{ iid: 1 }, { iid: 2 }],
    [`GET ${project}/merge_requests/1`]: { iid: 1, source_branch: "story/ST-2", sha: "a1", detailed_merge_status: "need_rebase", head_pipeline: { status: "success" }, created_at: "2026-10-01" },
    [`GET ${project}/merge_requests/2`]: { iid: 2, source_branch: "story/ST-3", sha: "a2", detailed_merge_status: "mergeable", head_pipeline: { status: "success" }, created_at: "2026-10-02" },
    [`PUT ${project}/merge_requests/2/merge`]: { state: "merged" },
    [`PUT ${project}/merge_requests/1/rebase`]: { rebase_in_progress: true },
    [`GET ${project}/repository/commits/main`]: { id: "m1", web_url: "wm" },
    [`GET ${project}/repository/commits/m1/statuses`]: [{ name: "test", status: "failed", target_url: "j1" }, { name: "lint", status: "failed", allow_failure: true }],
  }, calls);
  const forge = resolveForge("/x", { env: { GITLAB_TOKEN: "secret" }, url: "git@gitlab.com:g/p.git", http }).forge;
  const run = runMergeQueue({ forge, base: "main", max: 1 });
  assert.deepEqual(run.merged.map((item) => item.number), [2]);
  const merge = calls.find((call) => call.key.endsWith("/2/merge"));
  assert.deepEqual(merge.body, { sha: "a2", squash: true });
  assert.equal(merge.headers.Authorization, "Bearer secret");
  assert.match(calls[0].query, /target_branch=main/u);
  assert.throws(() => forge.mergePullRequest({ number: 2, headSha: "a2", method: "rebase" }), /merge method/u);
  forge.updateBranch({ number: 1 });
  assert.ok(calls.some((call) => call.key.endsWith("/1/rebase")));
  const status = forge.baseStatus("main");
  assert.deepEqual([status.sha, status.state, status.failing.map((item) => item.name)], ["m1", "red", ["test"]]);
});

test("gitea and forgejo pull requests normalize, filter by base and merge with head_commit_id", () => {
  assert.equal(reviewState([{ user: { login: "a" }, state: "REQUEST_CHANGES" }, { user: { login: "a" }, state: "APPROVED" }]), "approved");
  assert.equal(reviewState([{ user: { login: "a" }, state: "APPROVED" }, { user: { login: "b" }, state: "REQUEST_CHANGES" }]), "changes_requested");
  assert.equal(reviewState([{ user: { login: "b" }, state: "REQUEST_CHANGES", dismissed: true }]), "none");
  assert.equal(normalizeGiteaPullRequest({ number: 1, title: "WIP: x", mergeable: true }).mergeable, "draft");
  assert.equal(normalizeGiteaPullRequest({ number: 1, title: "x", mergeable: false }).mergeable, "conflicting");
  assert.equal(normalizeGiteaPullRequest({ number: 1, title: "x", mergeable: true }, { statuses: [{ status: "pending" }] }).checks, "pending");

  const calls = [];
  const repo = "/api/v1/repos/o/r";
  const http = fakeHttp({
    [`GET ${repo}/pulls`]: [
      { number: 9, title: "other", base: { ref: "dev" }, head: { ref: "x", sha: "h9" }, mergeable: true },
      { number: 5, title: "ST-1", base: { ref: "main" }, head: { ref: "story/ST-1", sha: "h5" }, mergeable: true, created_at: "2026-10-01" },
    ],
    [`GET ${repo}/commits/h5/status`]: { statuses: [{ context: "ci", status: "success" }] },
    [`GET ${repo}/pulls/5/reviews`]: [],
    [`POST ${repo}/pulls/5/merge`]: 200,
    [`GET ${repo}/commits/main/status`]: { sha: "m2", statuses: [{ context: "ci", status: "failure", target_url: "t" }] },
  }, calls);
  const forge = resolveForge("/x", { env: { FORGEJO_TOKEN: "tok" }, url: "https://codeberg.org/o/r.git", http }).forge;
  assert.equal(forge.id, "forgejo");
  const prs = forge.listPullRequests("main");
  assert.deepEqual(prs.map((item) => [item.number, item.mergeable, item.checks]), [[5, "clean", "green"]]);
  const run = runMergeQueue({ forge, base: "main" });
  assert.deepEqual(run.merged.map((item) => item.number), [5]);
  const merge = calls.find((call) => call.key.endsWith("/5/merge"));
  assert.deepEqual(merge.body, { Do: "squash", head_commit_id: "h5" });
  assert.equal(merge.headers.Authorization, "token tok");
  const status = forge.baseStatus("main");
  assert.deepEqual([status.state, status.url, status.failing[0].name], ["red", "https://codeberg.org/o/r/commit/m2", "ci"]);
});

test("a forge error names the status and the forge message, never the token", () => {
  const http = fakeHttp({ "PUT /api/v4/projects/g%2Fp/merge_requests/2/merge": 405 });
  const forge = resolveForge("/x", { env: { GITLAB_TOKEN: "s3cr3t" }, url: "https://gitlab.com/g/p", http }).forge;
  assert.throws(() => forge.mergePullRequest({ number: 2, headSha: "a" }), (error) => error.code === "FORGE_COMMAND_FAILED" && /405/u.test(error.message) && !error.message.includes("s3cr3t"));
});
