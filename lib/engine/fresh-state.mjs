import path from "node:path";

import { childProcess, crypto, Date, fs, process } from "../runtime/host.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";
import { remoteBaseRef } from "./merge-drift.mjs";
import { PRESENCE_REF_ROOT, PRESENCE_TRACKING_ROOT, ROLE_REF_ROOT, ROLE_TRACKING_ROOT } from "./role-leases.mjs";
import { remoteAlreadyFetched } from "./shared-fetch.mjs";
import { firstLine, gitFailure, resolveSharedScope, runGit } from "./shared-refs.mjs";

/**
 * Up-to-date state reader. Work that must see what the team sees (roles,
 * presence, the context pack header) reads the base branch as the remote has
 * it, never the working tree of whatever branch is checked out: a clone left
 * hundreds of commits behind would otherwise trust stale claims and records.
 *
 *   fetchFreshState(context)        one bounded fetch of the base branch and the
 *                                   presence/role refs, at most every FETCH_MIN_INTERVAL_MS
 *   baseFreshness(context)          { remote, branch, ref, sha, behind, ahead, fetched_at }
 *   createBaseReader(root, ref)     the context reader port over `git ls-tree`/`git show`
 *   ensureBaseWorktree(context)     a dedicated worktree on the base, inside
 *                                   <git-common-dir>/agentic-sdlc/, for role writes
 *
 * Every step is best effort: without a remote or a network the reader falls
 * back to the last fetched copy and says how old it is. AGENTIC_SDLC_FRESH_FETCH=off
 * skips the network entirely.
 */
export const FRESH_FETCH_ENV = "AGENTIC_SDLC_FRESH_FETCH";
export const FETCH_MIN_INTERVAL_MS = 60_000;
export const STATE_DIR = "agentic-sdlc";
export const FRESH_STATE_FILE = "fresh-state.json";
export const BASE_WORKTREE_DIR = "base-worktree";
const FETCH_TIMEOUT_SECONDS = 5;
const LOCAL_TIMEOUT_SECONDS = 5;
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const MAX_SHOW_BYTES = 16 * 1024 * 1024;

export function freshFetchEnabled(env = process.env) {
  return !OFF_VALUES.has(String(env[FRESH_FETCH_ENV] ?? "").trim().toLowerCase());
}

function stateDir(root) {
  const common = findGitCommonDir(root);
  return common ? path.join(common, STATE_DIR) : null;
}

function readState(root) {
  const dir = stateDir(root);
  if (!dir) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, FRESH_STATE_FILE), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(root, state) {
  const dir = stateDir(root);
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FRESH_STATE_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`);
    fs.renameSync(temporary, file);
  } catch {
    // Only the throttle is lost: the next call fetches again.
  }
}

function policyOf(context) {
  try {
    const policy = orchestrationPolicy(context.config);
    return { coordination: policy.coordination, remote: policy.coordination.remote || "origin", configured: policy.merge_drift?.base_branch ?? null };
  } catch {
    return { coordination: { mode: "auto", remote: "origin" }, remote: "origin", configured: null };
  }
}

/** The base branch: the configured one, else the remote's default as last fetched, else "main". */
export function resolveFreshBase(context) {
  const { remote, configured } = policyOf(context);
  const known = remoteBaseRef(context, remote, configured, LOCAL_TIMEOUT_SECONDS);
  if (known) return { remote, branch: known.branch, ref: known.ref };
  const branch = configured || "main";
  return { remote, branch, ref: `refs/remotes/${remote}/${branch}` };
}

/**
 * One bounded fetch of the base branch and of the presence/role refs.
 * Returns { fetched, skipped?, error?, base }. Skipped when fetched less than
 * FETCH_MIN_INTERVAL_MS ago, when the caller's command already fetched the
 * remote, or when AGENTIC_SDLC_FRESH_FETCH is off.
 */
export function fetchFreshState(context, { env = process.env, now = Date.now(), force = false, timeoutSeconds = FETCH_TIMEOUT_SECONDS } = {}) {
  const root = context.root;
  const base = resolveFreshBase(context);
  if (!freshFetchEnabled(env)) return { fetched: false, skipped: "disabled", base };
  if (!force && remoteAlreadyFetched(base.remote, env)) return { fetched: false, skipped: "already_fetched", base };
  const state = readState(root);
  const last = Date.parse(String(state.fetched_at ?? ""));
  if (!force && Number.isFinite(last) && now - last >= 0 && now - last < FETCH_MIN_INTERVAL_MS && state.remote === base.remote && state.branch === base.branch) {
    return { fetched: false, skipped: "recent", base };
  }
  const { coordination } = policyOf(context);
  const scope = resolveSharedScope(context, { ...coordination, remote: base.remote }, "orchestration_policy.coordination");
  if (scope.scope !== "shared" || scope.unavailable) return { fetched: false, skipped: "no_remote", base, error: scope.unavailable ?? scope.note ?? null };
  const fingerprint = String(scope.fingerprint || "unknown").slice(0, 16);
  const fetched = runGit(root, [
    "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", base.remote,
    `+refs/heads/${base.branch}:refs/remotes/${base.remote}/${base.branch}`,
    `+${PRESENCE_REF_ROOT}/*:${PRESENCE_TRACKING_ROOT}/${fingerprint}/*`,
    `+${ROLE_REF_ROOT}/*:${ROLE_TRACKING_ROOT}/${fingerprint}/*`,
  ], { timeoutSeconds });
  // The attempt counts for the throttle even when it fails: an offline computer does not retry on every call.
  writeState(root, { ...state, remote: base.remote, branch: base.branch, attempted_at: new Date(now).toISOString(), ...(fetched.ok ? { fetched_at: new Date(now).toISOString() } : {}) });
  return fetched.ok ? { fetched: true, base } : { fetched: false, base, error: gitFailure(fetched) };
}

/**
 * How the base branch compares with `head` (default HEAD), from the local
 * copy of the remote: { remote, branch, ref, sha, behind, ahead, fetched_at }.
 * behind/ahead are null when either side cannot be resolved.
 */
export function baseFreshness(context, { head = "HEAD", base = null } = {}) {
  const resolved = base ?? resolveFreshBase(context);
  const git = (args) => runGit(context.root, args, { timeoutSeconds: LOCAL_TIMEOUT_SECONDS });
  const sha = firstLine(git(["rev-parse", "--verify", "--quiet", `${resolved.ref}^{commit}`]).stdout) || null;
  let behind = null;
  let ahead = null;
  if (sha) {
    const counted = git(["rev-list", "--left-right", "--count", `${head}...${sha}`]);
    const match = /^(\d+)\s+(\d+)/u.exec(firstLine(counted.stdout));
    if (counted.ok && match) {
      ahead = Number(match[1]);
      behind = Number(match[2]);
    }
  }
  const state = readState(context.root);
  return { remote: resolved.remote, branch: resolved.branch, ref: resolved.ref, sha, behind, ahead, fetched_at: state.fetched_at ?? null };
}

/** Fetch (bounded, throttled) then compare: what a reader shows before trusting shared state. */
export function freshState(context, options = {}) {
  const fetch = fetchFreshState(context, options);
  return { ...baseFreshness(context, { base: fetch.base }), fetch: { fetched: fetch.fetched, skipped: fetch.skipped ?? null, error: fetch.error ?? null } };
}

/** One line for a header: "3 commits behind origin/main", or null when unknown. */
export function freshnessLine(freshness) {
  if (!freshness || freshness.behind === null || freshness.behind === undefined) return null;
  const name = `${freshness.remote}/${freshness.branch}`;
  if (freshness.behind === 0) return `up to date with ${name}`;
  return `${freshness.behind} commit${freshness.behind === 1 ? "" : "s"} behind ${name}: shared records read from the working tree may be stale`;
}

function normalizeRelative(relative) {
  const value = String(relative ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (value.split("/").includes("..") || value.startsWith("/")) throw new Error(`Path outside the project: ${relative}`);
  return value;
}

/**
 * Read port over a git revision (default the base branch): same interface as
 * createFsRecordReader (lib/context/reader.mjs), but every read goes through
 * `git ls-tree` and `git show <ref>:<path>`, never the working tree. `prefix`
 * is the project folder inside the repository (default: found by git).
 */
export function createBaseReader(root, ref, { prefix = null } = {}) {
  const projectPrefix = prefix ?? firstLine(runGit(root, ["rev-parse", "--show-prefix"], { timeoutSeconds: LOCAL_TIMEOUT_SECONDS }).stdout).replace(/\/+$/u, "");
  const files = new Map();
  const dirs = new Map();
  const bytesCache = new Map();
  const git = (args, options = {}) => runGit(root, args, { timeoutSeconds: LOCAL_TIMEOUT_SECONDS, ...options });
  const full = (relative) => [projectPrefix, normalizeRelative(relative)].filter(Boolean).join("/");
  const readBytes = (relative) => {
    const key = normalizeRelative(relative);
    if (bytesCache.has(key)) return bytesCache.get(key);
    const bytes = spawnShow(root, `${ref}:${full(key)}`);
    bytesCache.set(key, bytes);
    files.set(key, bytes === null ? null : crypto.createHash("sha256").update(bytes).digest("hex"));
    return bytes;
  };
  return {
    kind: "git",
    root,
    ref,
    list(relative) {
      const key = normalizeRelative(relative);
      const listed = git(["ls-tree", "-z", "--name-only", `${ref}:${full(key)}`]);
      const names = listed.ok ? listed.stdout.split("\0").filter(Boolean).filter((name) => !name.startsWith(".")).sort() : [];
      dirs.set(key, names);
      return names;
    },
    readJson(relative) {
      const bytes = readBytes(relative);
      if (bytes === null) return null;
      try {
        return JSON.parse(bytes.toString("utf8"));
      } catch {
        return null;
      }
    },
    readText(relative, max = 65_536) {
      const bytes = readBytes(relative);
      return bytes === null ? null : bytes.subarray(0, max).toString("utf8");
    },
    readLines(relative, visit) {
      const bytes = readBytes(relative);
      if (bytes === null) return false;
      for (const line of bytes.toString("utf8").split(/\r?\n/u)) if (line.trim()) visit(line);
      return true;
    },
    hash(relative) {
      const key = normalizeRelative(relative);
      if (!files.has(key)) readBytes(key);
      return files.get(key);
    },
    observed() {
      return { files: Object.fromEntries(files), dirs: Object.fromEntries(dirs) };
    },
  };
}

function spawnShow(root, spec) {
  // Raw bytes, not decoded text: the hash must match the blob as committed.
  const result = childProcess.spawnSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "show", spec], {
    timeout: LOCAL_TIMEOUT_SECONDS * 1000,
    maxBuffer: MAX_SHOW_BYTES,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  return result.status === 0 && !result.error ? Buffer.from(result.stdout) : null;
}

/**
 * The dedicated worktree on the base branch, at
 * <git-common-dir>/agentic-sdlc/base-worktree, detached at the fetched base
 * tip. Role writes happen there, never in a story branch. A clean worktree is
 * moved to the current base tip; one with uncommitted changes is left as it is
 * and reported (dirty: true), so no write in progress is lost.
 * Returns { path, ref, sha, created, updated, dirty } or { error }.
 */
export function ensureBaseWorktree(context, { base = null } = {}) {
  const root = context.root;
  const dir = stateDir(root);
  if (!dir) return { error: "this project is not a git repository" };
  const resolved = base ?? resolveFreshBase(context);
  const git = (args, cwd = root) => runGit(cwd, args, { timeoutSeconds: 30 });
  const sha = firstLine(git(["rev-parse", "--verify", "--quiet", `${resolved.ref}^{commit}`]).stdout) || null;
  if (!sha) return { error: `${resolved.remote}/${resolved.branch} has not been fetched in this clone` };
  const worktree = path.join(dir, BASE_WORKTREE_DIR);
  const registered = git(["worktree", "list", "--porcelain"]).stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => samePath(line.slice("worktree ".length), worktree));
  if (!registered) {
    git(["worktree", "prune"]);
    if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const added = git(["worktree", "add", "--detach", "--force", worktree, sha]);
    if (!added.ok) return { error: gitFailure(added) };
    return { path: worktree, ref: resolved.ref, branch: resolved.branch, remote: resolved.remote, sha, created: true, updated: false, dirty: false };
  }
  const status = git(["status", "--porcelain", "--untracked-files=normal"], worktree);
  if (!status.ok) return { error: gitFailure(status) };
  if (status.stdout.trim()) {
    return { path: worktree, ref: resolved.ref, branch: resolved.branch, remote: resolved.remote, sha: firstLine(git(["rev-parse", "HEAD"], worktree).stdout) || null, created: false, updated: false, dirty: true };
  }
  const current = firstLine(git(["rev-parse", "HEAD"], worktree).stdout);
  if (current === sha) return { path: worktree, ref: resolved.ref, branch: resolved.branch, remote: resolved.remote, sha, created: false, updated: false, dirty: false };
  const moved = git(["checkout", "--quiet", "--detach", sha], worktree);
  if (!moved.ok) return { error: gitFailure(moved) };
  return { path: worktree, ref: resolved.ref, branch: resolved.branch, remote: resolved.remote, sha, created: false, updated: true, dirty: false };
}

function samePath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}
