import path from "node:path";
import { fileURLToPath } from "node:url";

import { childProcess, fs, process } from "../runtime/host.mjs";
import { PLUGIN_ROOT } from "../runtime/paths.mjs";
import { ensureBaseWorktree, fetchFreshState } from "./fresh-state.mjs";
import { gitFailure, runGit } from "./shared-refs.mjs";

/**
 * Runs one role duty that writes records (config/role-duties.json, `publish:
 * "base"`) away from the person's checkout: in the dedicated worktree on the
 * base branch (lib/engine/fresh-state.mjs), then commits what changed under
 * .sdlc with [skip ci] and pushes it to the base branch, never forced. A
 * push refused because the base moved is retried once on top of it; any
 * other failure puts the worktree back on the base tip and waits for the
 * next tick. Started detached by lib/engine/role-duties.mjs:
 *
 *   node role-duty-worker.mjs <project root> <duty key> <command words...>
 */
const CLI = path.join(PLUGIN_ROOT, "bin", "agentic-sdlc.mjs");
const DUTY_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_SECONDS = 30;

function readConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".sdlc", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

function runCli(cwd, command, env) {
  return childProcess.spawnSync(process.execPath, [CLI, ...command, "--json", "--root", cwd], {
    cwd,
    encoding: "utf8",
    timeout: DUTY_TIMEOUT_MS,
    env,
    windowsHide: true,
  });
}

/** Runs the duty in the base worktree and publishes its records; returns what happened. */
export function runDutyOnBase(root, key, command, { env = process.env, log = () => {}, run = runCli } = {}) {
  const context = { root, config: readConfig(root) };
  fetchFreshState(context, { env, force: true });
  const base = ensureBaseWorktree(context);
  if (base.error) return { published: false, error: base.error };
  if (base.dirty) return { published: false, error: `${base.path} has changes nobody published: left as it is for a person` };
  const git = (args) => runGit(base.path, args, { timeoutSeconds: GIT_TIMEOUT_SECONDS });
  const ran = run(base.path, command, { ...env, AGENTIC_SDLC_ROLE_DUTY: key });
  log(`${ran.stdout ?? ""}${ran.stderr ?? ""}`);
  const changed = git(["status", "--porcelain", "--untracked-files=all", "--", ".sdlc"]);
  if (!changed.ok || !changed.stdout.trim()) return { published: false, exit: ran.status };
  const restore = () => {
    git(["reset", "--quiet", "--hard", base.ref]);
    git(["clean", "-fdq", "--", ".sdlc"]);
  };
  const added = git(["add", "-A", "--", ".sdlc"]);
  const committed = added.ok ? git(["commit", "--quiet", "--no-verify", "-m", `${command.join(" ")}: records [skip ci]`]) : added;
  if (!committed.ok) {
    restore();
    return { published: false, exit: ran.status, error: gitFailure(committed) };
  }
  const push = () => git(["push", "--porcelain", "--no-verify", base.remote, `HEAD:refs/heads/${base.branch}`]);
  let pushed = push();
  if (!pushed.ok) {
    // The base moved meanwhile: the records are deterministic, so they go on top of it.
    const fetched = git(["fetch", "--quiet", "--no-tags", base.remote, `+refs/heads/${base.branch}:${base.ref}`]);
    const rebased = fetched.ok ? git(["rebase", "--quiet", base.ref]) : fetched;
    if (!rebased.ok) git(["rebase", "--abort"]);
    pushed = rebased.ok ? push() : rebased;
  }
  if (!pushed.ok) {
    restore();
    return { published: false, exit: ran.status, error: gitFailure(pushed) };
  }
  return { published: true, exit: ran.status, commit: (git(["rev-parse", "HEAD"]).stdout || "").trim() };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [root, key, ...command] = process.argv.slice(2);
  try {
    const result = runDutyOnBase(root, key, command, { log: (text) => process.stdout.write(text) });
    process.stdout.write(`\n${JSON.stringify({ duty: key, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`\n${JSON.stringify({ duty: key, published: false, error: String(error?.message ?? error) })}\n`);
  }
}
