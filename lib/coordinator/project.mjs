import path from "node:path";

import { Date, fs, process } from "../runtime/host.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";
import { holdsRole } from "../engine/role-leases.mjs";
import { runGit } from "../engine/shared-refs.mjs";
import { createBaseReader, fetchFreshState, resolveFreshBase } from "../engine/fresh-state.mjs";

/**
 * What every coordinator task shares: the role gate, the project's remote
 * and base branch, the local story records and a small state file kept in
 * the git folder (never committed). Each task runs only on the computer
 * that holds the coordinator role; without roles (no shared remote, roles
 * off, no valid lease) every computer runs it, as before roles.
 */
export const COORDINATOR_ROLE = "coordinator";
export const COORDINATOR_STATE_FILE = "coordinator-state.json";
const GIT_TIMEOUT_SECONDS = 10;
const CLOSED_STATUSES = new Set(["done", "cancelled", "superseded", "closed", "abandoned", "retired"]);

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** { holds, mode, holder } for the coordinator role; a failing read never blocks the task. */
export function coordinatorGate(root, { env = process.env, now = Date.now(), holds = holdsRole } = {}) {
  try {
    return holds(root, COORDINATOR_ROLE, { env, now });
  } catch {
    return { holds: true, mode: "everyone", holder: null };
  }
}

/** The result of a task this computer does not run because another one coordinates. */
export function skippedResult(task, gate) {
  return { status: "skipped", task, reason: "not_coordinator", holder: gate.holder ?? null, mode: gate.mode };
}

export function skippedLines(task, gate, italian) {
  return [italian
    ? `${task}: non eseguito, il coordinatore è ${gate.holder ?? "un altro computer"}.`
    : `${task}: not run, ${gate.holder ?? "another computer"} is the coordinator.`];
}

/** The coordination remote and the base branch of the project. */
export function projectCoordinates(root) {
  try {
    const policy = orchestrationPolicy(readJson(path.join(root, ".sdlc", "config.json")) ?? {});
    return { remote: policy?.coordination?.remote || "origin", baseBranch: policy?.merge_drift?.base_branch || "main" };
  } catch {
    return { remote: "origin", baseBranch: "main" };
  }
}

export function remoteUrl(root, remote) {
  const result = runGit(root, ["remote", "get-url", remote], { timeoutSeconds: GIT_TIMEOUT_SECONDS });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

/** Story records of the local checkout: [{ id, status, priority, created_at, ... }]. */
export function readLocalStories(sdlcRoot) {
  const folder = path.join(sdlcRoot, "stories");
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const story = readJson(path.join(folder, name, "story.json"));
      return story ? { ...story, id: String(story.id ?? name) } : null;
    })
    .filter(Boolean);
}

/**
 * Story records as every computer sees them: the remote base branch after one
 * bounded fetch (lib/engine/fresh-state.mjs), plus local stories not on it
 * yet (a fix story this computer just opened). Falls back to the working tree.
 */
export function readProjectStories(context, { env = process.env, fetch = true } = {}) {
  const local = readLocalStories(context.sdlcRoot);
  let base = [];
  try {
    if (fetch) fetchFreshState(context, { env });
    const { ref } = resolveFreshBase(context);
    if (runGit(context.root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { timeoutSeconds: GIT_TIMEOUT_SECONDS }).status === 0) {
      const reader = createBaseReader(context.root, ref);
      const folder = path.relative(context.root, context.sdlcRoot).split(path.sep).join("/") || ".sdlc";
      base = reader.list(`${folder}/stories`)
        .map((name) => {
          const story = reader.readJson(`${folder}/stories/${name}/story.json`);
          return story && typeof story === "object" ? { ...story, id: String(story.id ?? name) } : null;
        })
        .filter(Boolean);
    }
  } catch {
    base = [];
  }
  if (base.length === 0) return local;
  const known = new Set(base.map((story) => story.id));
  return [...base, ...local.filter((story) => !known.has(story.id))];
}

export function storyOpen(story) {
  return !CLOSED_STATUSES.has(String(story?.status ?? "").toLowerCase());
}

function statePath(root) {
  const common = findGitCommonDir(root);
  return common ? path.join(common, "agentic-sdlc", COORDINATOR_STATE_FILE) : null;
}

export function readCoordinatorState(root) {
  const file = statePath(root);
  return (file && readJson(file)) || {};
}

/** Merges `patch` into the state file; losing it only repeats an idempotent task. */
export function updateCoordinatorState(root, patch) {
  const file = statePath(root);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...readCoordinatorState(root), ...patch }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // best effort
  }
}
