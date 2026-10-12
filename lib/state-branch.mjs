// Operational records kept off the base branch, on an orphan branch of the
// same remote (default `sdlc-state`). Only the heavy, high-churn records move:
// delivery action receipts, autonomy executions and non-final gate reports.
// Everything the base branch certifies from its own tree stays there:
// requirements, contracts, decisions, baseline, config, stories, dependencies,
// the final gate receipts (`gates/<story>-final.json`) and, for now, the
// traces with their workflow checkpoints (one atomic unit rebuilt by story
// sync). Paths on the state branch are the same as in the working tree, so
// the format never changes when sharding (one branch or ref per story) is
// switched on: the shard of a path is a pure function of it.
// This module holds the pure rules; git lives in lib/engine/state-branch.mjs.

import { Date } from "./runtime/host.mjs";

export const STATE_RECORDS_PROVIDER = "sdlc-state";
export const STATE_FEATURE_ID = "sdlc-state-records";
export const DEFAULT_STATE_OPTIONS = Object.freeze({
  branch: "sdlc-state",
  remote: null,
  push_interval_seconds: 120,
  pull_interval_seconds: 60,
});
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/u;
const RESERVED_BRANCHES = new Set(["main", "master", "HEAD"]);

// What lives on the state branch, by level. Level 1 (0.150): action
// receipts, executions and non-final gate reports. Level 2 (0.151): also the
// traces with their checkpoints, the workflow instances and the final gate
// receipts; readers that certified them from the base branch tree read the
// state branch too, and the hash-chained histories are rebased, never
// overwritten. The level a project uses is the requirement files it holds.
export const STATE_LEVEL_FOLDERS = Object.freeze({
  1: Object.freeze(["autonomy/actions", "autonomy/executions", "gates"]),
  2: Object.freeze(["autonomy/actions", "autonomy/executions", "gates", "traces", "workflows/instances"]),
});
export const STATE_FEATURE_IDS = Object.freeze({ 1: STATE_FEATURE_ID, 2: "sdlc-state-traces" });
export const STATE_MAX_LEVEL = 2;
const FINAL_GATE = /^gates\/[^/]+-final\.json$/u;
// Transient files: locks, temporary copies and a transition in progress.
const TRANSIENT = /(^|\/)\.locks?\/|\.(tmp|lock|bak|previous)$|\/pending-transition\.json$|(^|\/)\.[^/]*\.tmp[^/]*$/u;

// Lines of `.sdlc/.gitignore` that keep the state records out of the base branch, per level.
export const STATE_GITIGNORE_BEGIN = "# sdlc-state records (mpsf state migrate)";
export const STATE_GITIGNORE_BLOCKS = Object.freeze({
  1: Object.freeze([STATE_GITIGNORE_BEGIN, "autonomy/actions/", "autonomy/executions/", "gates/*", "!gates/*-final.json"]),
  2: Object.freeze(["# sdlc-state records, level 2 (mpsf state migrate)", "traces/", "workflows/instances/", "gates/*-final.json"]),
});

// The project switches to the state branch with this requirement file (committed on
// the base branch by `state migrate`), so no configuration change is needed and
// older plugins ask for an update. host_policy.adapters.records with provider
// sdlc-state also switches it and is where its options go.
export const STATE_REQUIREMENT_PATH = "compatibility/sdlc-state-records.json";

/** The requirement file of a level, relative to the records folder. */
export function stateRequirementPath(level) {
  return `compatibility/${STATE_FEATURE_IDS[level]}.json`;
}

/**
 * The records adapter section to use for the state branch, or null when the
 * project does not use it: the configured sdlc-state section, or the default
 * one when the requirement file is there and no other provider is configured.
 */
export function stateAdapterSection(config, requirementPresent) {
  const records = config?.host_policy?.adapters?.records;
  if (records?.provider === STATE_RECORDS_PROVIDER || records?.provider === "state-branch") return { provider: STATE_RECORDS_PROVIDER, options: records.options ?? {} };
  const provider = records?.provider;
  if (requirementPresent && (provider === undefined || ["git-sdlc", "git", "sdlc-git"].includes(provider))) return { provider: STATE_RECORDS_PROVIDER, options: {} };
  return null;
}

/** The validated options of the sdlc-state records adapter. invalid(message) reports a wrong value. */
export function stateBranchOptions(options = {}, invalid = (message) => { throw new Error(message); }) {
  const value = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const branch = value.branch ?? DEFAULT_STATE_OPTIONS.branch;
  if (typeof branch !== "string" || !BRANCH_PATTERN.test(branch) || branch.includes("..") || RESERVED_BRANCHES.has(branch)) {
    invalid("host_policy.adapters.records.options.branch must be a branch name other than the base branch.");
  }
  const remote = value.remote ?? null;
  if (remote !== null && (typeof remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(remote))) {
    invalid("host_policy.adapters.records.options.remote must be a git remote name.");
  }
  const seconds = (key) => {
    const item = value[key] ?? DEFAULT_STATE_OPTIONS[key];
    if (!Number.isInteger(item) || item < 0 || item > 86_400) invalid(`host_policy.adapters.records.options.${key} must be a number of seconds (0-86400).`);
    return item;
  };
  return Object.freeze({ branch, remote, push_interval_seconds: seconds("push_interval_seconds"), pull_interval_seconds: seconds("pull_interval_seconds") });
}

function inside(filePath, sdlcFolder) {
  const normalized = String(filePath || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
  const folder = String(sdlcFolder || ".sdlc").replace(/\/$/u, "");
  return normalized.startsWith(`${folder}/`) ? normalized.slice(folder.length + 1) : null;
}

/** True when a project path (`.sdlc/...`) is a record kept on the state branch at `level`. */
export function isStateRecordPath(filePath, sdlcFolder = ".sdlc", level = 1) {
  const relative = inside(filePath, sdlcFolder);
  if (!relative || relative.split("/").some((part) => part === ".." || part === "")) return false;
  if (TRANSIENT.test(relative)) return false;
  if (level < 2 && FINAL_GATE.test(relative)) return false;
  return (STATE_LEVEL_FOLDERS[level] ?? STATE_LEVEL_FOLDERS[1]).some((folder) => relative.startsWith(`${folder}/`));
}

/**
 * The hash-chained history a state path belongs to: { trace, checkpoint }
 * (project paths) for `traces/<name>.jsonl` and its checkpoint, else null.
 */
export function stateTracePair(filePath, sdlcFolder = ".sdlc") {
  const relative = inside(filePath, sdlcFolder) ?? "";
  const folder = String(sdlcFolder || ".sdlc").replace(/\/$/u, "");
  const trace = /^traces\/([^/]+\.jsonl)$/u.exec(relative) ?? /^traces\/\.integrity\/([^/]+\.jsonl)\.checkpoint\.json$/u.exec(relative);
  if (!trace) return null;
  return { name: trace[1], trace: `${folder}/traces/${trace[1]}`, checkpoint: `${folder}/traces/.integrity/${trace[1]}.checkpoint.json` };
}

/**
 * The shard a state record belongs to: a story id (ST-...) when the path or
 * the record names one, "project" otherwise. Not used to place files yet;
 * a per-story branch or ref reads the same paths.
 */
export function stateShardKey(filePath, record = null, sdlcFolder = ".sdlc") {
  const relative = inside(filePath, sdlcFolder) ?? "";
  const execution = /^autonomy\/executions\/AUT-PR-([^/]+)\//u.exec(relative);
  if (execution) return `ST-${execution[1]}`;
  const trace = /^traces\/(?:\.integrity\/)?(ST-[A-Za-z0-9._-]+?)\.jsonl/u.exec(relative);
  if (trace) return trace[1];
  const workflow = /^workflows\/instances\/(?:WF|DELIVERY)-(ST-[^/]+)\//u.exec(relative);
  if (workflow) return workflow[1];
  const gate = /^gates\/(ST-[A-Za-z0-9._-]+?)(?:-(?:strict|lifecycle|final|report))?\.json$/u.exec(relative);
  if (gate) return gate[1];
  const delivery = record?.delivery?.id;
  if (typeof delivery === "string" && /^PR-[A-Za-z0-9._-]+$/u.test(delivery)) return `ST-${delivery.slice(3)}`;
  return "project";
}

/** The message of a state commit: never starts a CI pipeline on the hosts that honour [skip ci]. */
export function stateCommitMessage(count, machine = "") {
  const from = machine ? ` from ${machine}` : "";
  return `mpsf state: ${count} record${count === 1 ? "" : "s"}${from} [skip ci]\n\nOperational records kept off the base branch.`;
}

/** `.sdlc/.gitignore` text with the state lines up to `level` added once (null when they are already there). */
export function withStateGitignore(text, level = 1) {
  let current = String(text ?? "");
  let changed = false;
  for (let index = 1; index <= level; index += 1) {
    const block = STATE_GITIGNORE_BLOCKS[index];
    // Blocks written before the rename say "agentic-sdlc state migrate".
    const lines = current.split(/\r?\n/u);
    if (lines.includes(block[0]) || lines.includes(block[0].replace("(mpsf ", "(agentic-sdlc "))) continue;
    current = `${current === "" || current.endsWith("\n") ? current : `${current}\n`}${block.join("\n")}\n`;
    changed = true;
  }
  return changed ? current : null;
}

/** True when the throttle allows a new run: `last` is the epoch ms of the previous one. */
export function isDue(last, intervalSeconds, now = Date.now()) {
  return !Number.isFinite(last) || now - last >= intervalSeconds * 1000;
}
