import path from "node:path";
import { fileURLToPath } from "node:url";

import { childProcess, Date, fs, process } from "../runtime/host.mjs";
import { PLUGIN_ROOT } from "../runtime/paths.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";
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
// One duty at a time uses the base worktree; a lock older than this was left by a dead run.
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_WAIT_MS = 150_000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Takes the base worktree lock, waiting for another duty; returns a release function or null. */
function lockBaseWorktree(root, { now = () => Date.now() } = {}) {
  const common = findGitCommonDir(root);
  if (!common) return null;
  const file = path.join(common, "agentic-sdlc", "base-worktree.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
      return () => fs.rmSync(file, { force: true });
    } catch {
      try {
        if (now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) fs.rmSync(file, { force: true });
      } catch {
        // gone meanwhile
      }
    }
    if (now() > deadline) return null;
    sleep(1_000);
  }
}

/** Where the project sits inside its repository ("" at the top). */
function projectPrefix(root) {
  const top = runGit(root, ["rev-parse", "--show-toplevel"], { timeoutSeconds: GIT_TIMEOUT_SECONDS });
  if (!top.ok) return "";
  try {
    return path.relative(fs.realpathSync(top.stdout.trim()), fs.realpathSync(root));
  } catch {
    return "";
  }
}

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
export function runDutyOnBase(root, key, command, options = {}) {
  const release = lockBaseWorktree(root);
  if (!release) return { published: false, error: "another duty is using the base worktree" };
  try {
    return runLocked(root, key, command, options);
  } finally {
    release();
  }
}

function runLocked(root, key, command, { env = process.env, log = () => {}, run = runCli } = {}) {
  const context = { root, config: readConfig(root) };
  fetchFreshState(context, { env, force: true });
  const base = ensureBaseWorktree(context);
  if (base.error) return { published: false, error: base.error };
  if (base.dirty) return { published: false, error: `${base.path} has changes nobody published: left as it is for a person` };
  const git = (args) => runGit(base.path, args, { timeoutSeconds: GIT_TIMEOUT_SECONDS });
  // A project in a subfolder of its repository runs in the same subfolder of the base worktree.
  const prefix = projectPrefix(root);
  const projectDir = path.join(base.path, prefix);
  const records = prefix ? path.join(prefix, ".sdlc") : ".sdlc";
  if (!fs.existsSync(path.join(projectDir, ".sdlc"))) return { published: false, error: `the base branch has no project at ${prefix || "."}` };
  const ran = run(projectDir, command, { ...env, AGENTIC_SDLC_ROLE_DUTY: key });
  log(`${ran.stdout ?? ""}${ran.stderr ?? ""}`);
  const changed = git(["status", "--porcelain", "--untracked-files=all", "--", records]);
  if (!changed.ok || !changed.stdout.trim()) return { published: false, exit: ran.status };
  const restore = () => {
    git(["reset", "--quiet", "--hard", base.ref]);
    git(["clean", "-fdq", "--", records]);
  };
  const added = git(["add", "-A", "--", records]);
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
