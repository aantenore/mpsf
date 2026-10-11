import path from "node:path";
import { failWithCode } from "../cli/user-error.mjs";
import { readProjectConfig } from "../adapters/config.mjs";
import { recordsAdapter } from "../adapters/records/registry.mjs";
import { buildRequirementRecord, COMPATIBILITY_DIRECTORY, requirementFileName } from "../plugin-compatibility.mjs";
import { childProcess, Date, fs, os, process } from "../runtime/host.mjs";
import { notePush, pushWindow } from "./push-budget.mjs";
import {
  isDue,
  isStateRecordPath,
  STATE_FEATURE_ID,
  STATE_RECORD_FOLDERS,
  STATE_RECORDS_PROVIDER,
  STATE_REQUIREMENT_PATH,
  stateAdapterSection,
  stateBranchOptions,
  stateCommitMessage,
  stateShardKey,
  withStateGitignore,
} from "../state-branch.mjs";
import { safeGitRemoteName } from "./git-remote-name.mjs";
import { output } from "./output.mjs";
import { firstLine, runGit } from "./shared-refs.mjs";

/**
 * mpsf state push|pull|sync|status|migrate: moves the operational
 * records (lib/state-branch.mjs) between the working tree and the state
 * branch of the remote. Records stay plain files under `.sdlc/`, so every
 * reader works unchanged; the base branch stops carrying them.
 *
 * - push: one commit on the remote tip with the records changed here since
 *   the last sync, pushed fast-forward only (the remote refuses a stale tip:
 *   compare-and-swap); refused pushes fetch, rebuild and retry with backoff.
 *   Throttled (push_interval_seconds) so all computers together stay well
 *   under the forge's push rate; each commit says [skip ci].
 * - pull: brings records written elsewhere, never overwriting one changed
 *   here and not pushed yet.
 * The last synced blob of each path is kept in the git dir, never in `.sdlc/`.
 */
const NETWORK_TIMEOUT_SECONDS = 60;
const LOCAL_TIMEOUT_SECONDS = 60;
const PUSH_RETRIES = 4;

function sdlcFolderOf(context) {
  const sdlcRoot = context.sdlcRoot ? path.resolve(String(context.sdlcRoot)) : path.join(context.root, ".sdlc");
  return path.relative(context.root, sdlcRoot).split(path.sep).join("/") || ".sdlc";
}

function gitRaw(root, args, { input = null, env = {} } = {}) {
  const result = childProcess.spawnSync("git", ["-C", root, ...args], {
    input: input ?? "",
    maxBuffer: 256 * 1024 * 1024,
    timeout: LOCAL_TIMEOUT_SECONDS * 1000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
    windowsHide: true,
  });
  return { ok: result.status === 0 && !result.error, stdout: result.stdout ?? Buffer.alloc(0), stderr: String(result.stderr ?? "") };
}

/** The state branch settings of a project, or null when it does not use the state branch (unless `assume`). */
export function stateSettings(context, { assume = false } = {}) {
  const root = path.resolve(String(context.root));
  const sdlcFolder = sdlcFolderOf({ ...context, root });
  const config = context.config && typeof context.config === "object" ? context.config : readProjectConfig(root);
  const section = stateAdapterSection(config, fs.existsSync(path.join(root, ...sdlcFolder.split("/"), ...STATE_REQUIREMENT_PATH.split("/"))));
  if (!section && !assume) return null;
  const options = stateBranchOptions(section?.options ?? {}, (message) => failWithCode("STATE_BRANCH_CONFIG_INVALID", message));
  const requested = options.remote ?? config?.orchestration_policy?.coordination?.remote;
  const remote = safeGitRemoteName(requested, root).remote;
  return { root, sdlcFolder, ...options, remote, trackingRef: remote ? `refs/remotes/${remote}/${options.branch}` : null };
}

function gitDir(root) {
  const result = runGit(root, ["rev-parse", "--absolute-git-dir"], { timeoutSeconds: LOCAL_TIMEOUT_SECONDS });
  return result.ok ? firstLine(result.stdout) : null;
}

function memoryPath(settings) {
  const dir = gitDir(settings.root);
  return dir ? path.join(dir, "agentic-sdlc", "state-branch", `${settings.branch.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`) : null;
}

function readMemory(settings) {
  const file = memoryPath(settings);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return { pushed_at: value.pushed_at ?? null, pulled_at: value.pulled_at ?? null, files: value.files && typeof value.files === "object" ? value.files : {} };
  } catch {
    return { pushed_at: null, pulled_at: null, files: {} };
  }
}

function writeMemory(settings, memory) {
  const file = memoryPath(settings);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(memory)}\n`);
  fs.renameSync(temp, file);
}

/** Project paths of the state records present in the working tree, sorted. */
export function localStateRecords(settings) {
  const found = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(settings.root, ...relative.split("/")), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && !entry.name.endsWith(".tmp") && !entry.name.endsWith(".lock") && isStateRecordPath(child, settings.sdlcFolder)) found.push(child);
    }
  };
  for (const folder of STATE_RECORD_FOLDERS) walk(`${settings.sdlcFolder}/${folder}`);
  return found.sort();
}

/** Blob ids of working-tree files, in order (`write` also stores them). */
function hashFiles(settings, files, { write = false } = {}) {
  if (files.length === 0) return [];
  const result = gitRaw(settings.root, ["hash-object", ...(write ? ["-w"] : []), "--stdin-paths"], { input: `${files.join("\n")}\n` });
  if (!result.ok) throw new Error(`hashing the records failed (${firstLine(result.stderr)})`);
  return String(result.stdout).split(/\r?\n/u).filter(Boolean);
}

/** { path: blob } of the state records on a commit (empty for null). */
function treeRecords(settings, commit) {
  if (!commit) return new Map();
  const result = gitRaw(settings.root, ["ls-tree", "-r", "-z", commit, "--", settings.sdlcFolder]);
  if (!result.ok) throw new Error(`reading ${settings.branch} failed (${firstLine(result.stderr)})`);
  const records = new Map();
  for (const entry of String(result.stdout).split("\0").filter(Boolean)) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/u.exec(entry);
    if (match && isStateRecordPath(match[2], settings.sdlcFolder)) records.set(match[2], match[1]);
  }
  return records;
}

function fetchState(settings) {
  if (!settings.remote) return { ok: false, tip: null, error: "no git remote is configured" };
  const fetched = runGit(settings.root, ["fetch", "--quiet", "--no-tags", settings.remote, `+refs/heads/${settings.branch}:${settings.trackingRef}`], { timeoutSeconds: NETWORK_TIMEOUT_SECONDS });
  if (!fetched.ok) {
    // A branch that does not exist yet is an empty state, not an error.
    const listed = runGit(settings.root, ["ls-remote", "--heads", settings.remote, `refs/heads/${settings.branch}`], { timeoutSeconds: NETWORK_TIMEOUT_SECONDS });
    if (listed.ok && !listed.stdout.trim()) {
      runGit(settings.root, ["update-ref", "-d", settings.trackingRef], { timeoutSeconds: LOCAL_TIMEOUT_SECONDS });
      return { ok: true, tip: null };
    }
    return { ok: false, tip: null, error: firstLine(fetched.stderr) || fetched.error || "git fetch failed" };
  }
  return { ok: true, tip: localTip(settings) };
}

function localTip(settings) {
  if (!settings.trackingRef) return null;
  return firstLine(runGit(settings.root, ["rev-parse", "--verify", "--quiet", `${settings.trackingRef}^{commit}`], { timeoutSeconds: LOCAL_TIMEOUT_SECONDS }).stdout) || null;
}

/** The configured git identity, or a neutral one so a clone without user.name can still record state. */
function commitIdentity(root, machine) {
  if (runGit(root, ["var", "GIT_COMMITTER_IDENT"], { timeoutSeconds: LOCAL_TIMEOUT_SECONDS }).ok) return {};
  const name = `agentic-sdlc${machine ? ` (${machine})` : ""}`;
  const email = "agentic-sdlc@localhost";
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Pushes the state records changed here since the last sync. `force` skips
 * the throttle; `all` pushes every local record the tip lacks or holds
 * differently (first migration). Returns a result, never throws for a
 * network failure.
 */
export function pushStateRecords(context, { force = false, all = false, settings = stateSettings(context), now = Date.now() } = {}) {
  if (!settings) return { status: "not_configured" };
  if (!settings.remote) return { status: "no_remote" };
  const memory = readMemory(settings);
  if (!force && !isDue(Date.parse(memory.pushed_at ?? ""), settings.push_interval_seconds, now)) return { status: "not_due", last_push: memory.pushed_at };
  // The computer's push budget (./push-budget.mjs): after failed pushes, wait for the backoff.
  if (!force && pushWindow(settings.root, { now, urgent: true }).backoff) return { status: "not_due", last_push: memory.pushed_at, backoff: true };
  const result = pushChangedStateRecords(settings, memory, { all, now });
  if (["pushed", "remote_unreachable", "push_refused"].includes(result.status)) notePush(settings.root, result.status === "pushed" ? "ok" : "temporary", { now });
  return result;
}

function pushChangedStateRecords(settings, memory, { all, now }) {
  const files = localStateRecords(settings);
  const blobs = hashFiles(settings, files);
  const changed = files.filter((file, index) => all || memory.files[file] !== blobs[index]);
  if (changed.length === 0) return { status: "up_to_date", pushed: 0 };
  hashFiles(settings, changed, { write: true });
  const blobOf = new Map(files.map((file, index) => [file, blobs[index]]));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-state-"));
  try {
    for (let attempt = 0; attempt <= PUSH_RETRIES; attempt += 1) {
      const fetched = fetchState(settings);
      if (!fetched.ok) return { status: "remote_unreachable", error: fetched.error, pending: changed.length };
      const onTip = treeRecords(settings, fetched.tip);
      const updates = changed.filter((file) => onTip.get(file) !== blobOf.get(file));
      if (updates.length === 0) {
        writeMemory(settings, { ...memory, pushed_at: new Date(now).toISOString(), files: { ...memory.files, ...Object.fromEntries(changed.map((file) => [file, blobOf.get(file)])) } });
        return { status: "up_to_date", pushed: 0, tip: fetched.tip };
      }
      const env = { GIT_INDEX_FILE: path.join(scratch, `index-${attempt}`) };
      const read = gitRaw(settings.root, fetched.tip ? ["read-tree", fetched.tip] : ["read-tree", "--empty"], { env });
      if (!read.ok) throw new Error(`reading ${settings.branch} failed (${firstLine(read.stderr)})`);
      const info = updates.map((file) => `100644 ${blobOf.get(file)}\t${file}`).join("\n");
      const indexed = gitRaw(settings.root, ["update-index", "--index-info"], { input: `${info}\n`, env });
      if (!indexed.ok) throw new Error(`staging the records failed (${firstLine(indexed.stderr)})`);
      const tree = firstLine(String(gitRaw(settings.root, ["write-tree"], { env }).stdout));
      const machine = os.hostname().replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 40);
      const commitArgs = ["commit-tree", tree, ...(fetched.tip ? ["-p", fetched.tip] : []), "-m", stateCommitMessage(updates.length, machine)];
      const commit = firstLine(runGit(settings.root, commitArgs, { timeoutSeconds: LOCAL_TIMEOUT_SECONDS, env: commitIdentity(settings.root, machine) }).stdout);
      if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("creating the state commit failed");
      // Fast-forward only: a tip moved by another computer is refused and retried on the new tip.
      const pushed = runGit(settings.root, ["push", "--quiet", settings.remote, `${commit}:refs/heads/${settings.branch}`], { timeoutSeconds: NETWORK_TIMEOUT_SECONDS });
      if (pushed.ok) {
        runGit(settings.root, ["update-ref", settings.trackingRef, commit], { timeoutSeconds: LOCAL_TIMEOUT_SECONDS });
        writeMemory(settings, { ...memory, pushed_at: new Date(now).toISOString(), files: { ...memory.files, ...Object.fromEntries(changed.map((file) => [file, blobOf.get(file)])) } });
        return { status: "pushed", pushed: updates.length, commit, branch: settings.branch, remote: settings.remote, attempts: attempt + 1 };
      }
      if (attempt < PUSH_RETRIES) sleep((2 ** attempt) * 1000 + Math.floor(Math.random() * 500));
      else return { status: "push_refused", error: firstLine(pushed.stderr) || pushed.error || "git push failed", pending: updates.length };
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { status: "push_refused", pending: changed.length };
}

/**
 * Brings the state records written elsewhere into the working tree. A record
 * changed here since the last sync is never overwritten; `force` skips the
 * throttle.
 */
export function pullStateRecords(context, { force = false, settings = stateSettings(context), now = Date.now() } = {}) {
  if (!settings) return { status: "not_configured" };
  if (!settings.remote) return { status: "no_remote" };
  const memory = readMemory(settings);
  if (!force && !isDue(Date.parse(memory.pulled_at ?? ""), settings.pull_interval_seconds, now)) return { status: "not_due", last_pull: memory.pulled_at };
  const fetched = fetchState(settings);
  if (!fetched.ok) return { status: "remote_unreachable", error: fetched.error };
  const onTip = treeRecords(settings, fetched.tip);
  const candidates = [...onTip.keys()];
  const present = candidates.filter((file) => fs.existsSync(path.join(settings.root, ...file.split("/"))));
  const hashed = hashFiles(settings, present);
  const localBlobs = new Map(present.map((file, index) => [file, hashed[index]]));
  const keptLocal = [];
  const wanted = [];
  for (const file of candidates) {
    const local = localBlobs.get(file);
    if (local === undefined) wanted.push(file);
    else if (local === onTip.get(file)) continue;
    // Unchanged here since the last sync: the other computer's version is newer.
    else if (memory.files[file] === local) wanted.push(file);
    else keptLocal.push(file);
  }
  if (wanted.length > 0) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-state-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
      const read = gitRaw(settings.root, ["read-tree", fetched.tip], { env });
      if (!read.ok) throw new Error(`reading ${settings.branch} failed (${firstLine(read.stderr)})`);
      const written = gitRaw(settings.root, ["checkout-index", "-f", "-z", "--stdin"], { input: `${wanted.join("\0")}\0`, env });
      if (!written.ok) throw new Error(`writing the records failed (${firstLine(written.stderr)})`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  writeMemory(settings, { ...memory, pulled_at: new Date(now).toISOString(), files: { ...memory.files, ...Object.fromEntries(wanted.map((file) => [file, onTip.get(file)])) } });
  return { status: "pulled", pulled: wanted.length, kept_local: keptLocal.length, tip: fetched.tip, branch: settings.branch, remote: settings.remote };
}

/** Pull then push, each on its own throttle. Never throws: hooks call it. */
export function syncStateRecords(context, { force = false } = {}) {
  try {
    const settings = stateSettings(context);
    if (!settings) return { status: "not_configured" };
    return { status: "synced", pull: pullStateRecords(context, { force, settings }), push: pushStateRecords(context, { force, settings }) };
  } catch (error) {
    return { status: "failed", error: error.message };
  }
}

function statePayload(settings) {
  const memory = readMemory(settings);
  const files = localStateRecords(settings);
  const blobs = hashFiles(settings, files);
  const unpushed = files.filter((file, index) => memory.files[file] !== blobs[index]);
  const shards = {};
  for (const file of files) {
    const key = stateShardKey(file, null, settings.sdlcFolder);
    shards[key] = (shards[key] ?? 0) + 1;
  }
  return { branch: settings.branch, remote: settings.remote, tip: localTip(settings), local_records: files.length, unpushed: unpushed.length, last_push: memory.pushed_at, last_pull: memory.pulled_at, shards };
}

function requireSettings(context, italian = false) {
  const settings = stateSettings(context);
  if (!settings) {
    failWithCode("STATE_BRANCH_NOT_CONFIGURED", italian
      ? `I record operativi sono ancora sul branch base. Per spostarli: mpsf state migrate.`
      : `Operational records still live on the base branch. To move them: mpsf state migrate.`);
  }
  if (!settings.remote) failWithCode("STATE_BRANCH_NO_REMOTE", "No usable git remote: the state branch needs one.");
  return settings;
}

function describe(result) {
  switch (result.status) {
    case "pushed": return `Pushed ${result.pushed} state record(s) to ${result.remote}/${result.branch} (${String(result.commit).slice(0, 12)}).`;
    case "pulled": return `Pulled ${result.pulled} state record(s) from ${result.remote}/${result.branch}${result.kept_local ? `; ${result.kept_local} changed here kept` : ""}.`;
    case "up_to_date": return "State records already up to date on the remote.";
    case "not_due": return `Skipped: last sync ${result.last_push ?? result.last_pull} is within the interval.`;
    case "remote_unreachable": return `Remote not reachable (${result.error}); records stay here and go with the next sync.`;
    case "push_refused": return `Push refused (${result.error ?? "remote moved"}); ${result.pending} record(s) go with the next sync.`;
    default: return `State sync: ${result.status}${result.error ? ` (${result.error})` : ""}.`;
  }
}

export function statePushCommand(context, options) {
  const settings = requireSettings(context);
  const result = pushStateRecords(context, { force: options["if-due"] !== true, settings });
  output(options, result, [describe(result)]);
  if (["remote_unreachable", "push_refused"].includes(result.status)) process.exitCode = 1;
}

export function statePullCommand(context, options) {
  const settings = requireSettings(context);
  const result = pullStateRecords(context, { force: options["if-due"] !== true, settings });
  output(options, result, [describe(result)]);
  if (result.status === "remote_unreachable") process.exitCode = 1;
}

export function stateSyncCommand(context, options) {
  requireSettings(context);
  const result = syncStateRecords(context, { force: options["if-due"] !== true });
  output(options, result, result.status === "synced" ? [describe(result.pull), describe(result.push)] : [describe(result)]);
}

export function stateStatusCommand(context, options) {
  const settings = stateSettings(context);
  if (!settings) {
    output(options, { provider: recordsAdapter(readProjectConfig(context.root)).provider, state_branch: false }, ["Operational records are on the base branch (no state branch). Move them with: mpsf state migrate --dry-run"]);
    return;
  }
  const payload = statePayload(settings);
  output(options, { provider: STATE_RECORDS_PROVIDER, state_branch: true, ...payload }, [
    `State branch ${payload.remote ?? "?"}/${payload.branch}: ${payload.local_records} record(s) here, ${payload.unpushed} not pushed yet.`,
    `Last push ${payload.last_push ?? "never"}, last pull ${payload.last_pull ?? "never"}.`,
  ]);
}

function trackedStateRecords(settings) {
  const result = gitRaw(settings.root, ["ls-files", "-z", "--", ...STATE_RECORD_FOLDERS.map((folder) => `${settings.sdlcFolder}/${folder}`)]);
  if (!result.ok) return [];
  return String(result.stdout).split("\0").filter((file) => file && isStateRecordPath(file, settings.sdlcFolder));
}

/**
 * state migrate: pushes every operational record to the state branch, then
 * sets the records adapter to sdlc-state, records the minimum plugin version
 * (older plugins ask for an update instead of missing records), adds the
 * ignore lines and removes the records from the index (the files stay here,
 * the history on the base branch stays). The person commits the result to
 * the base branch with the usual flow.
 */
export function stateMigrateCommand(context, options) {
  const config = readProjectConfig(context.root);
  if (!config) failWithCode("STATE_BRANCH_CONFIG_MISSING", "No readable .sdlc/config.json: run init first.");
  const current = recordsAdapter(config);
  if (!stateAdapterSection(config, true)) {
    failWithCode("STATE_BRANCH_PROVIDER_CONFLICT", `Records adapter '${current.provider}' is configured; the state branch only extends git-sdlc.`);
  }
  const settings = stateSettings(context, { assume: true });
  if (!settings.remote) failWithCode("STATE_BRANCH_NO_REMOTE", "No usable git remote: the state branch needs one.");
  const tracked = trackedStateRecords(settings);
  const local = localStateRecords(settings);
  const plan = { branch: settings.branch, remote: settings.remote, records_to_push: local.length, records_to_untrack: tracked.length, gitignore: `${settings.sdlcFolder}/.gitignore`, requirement: `.sdlc/compatibility/${STATE_FEATURE_ID}.json` };
  if (options["dry-run"] === true) {
    output(options, { status: "planned", ...plan }, [
      `Would push ${local.length} record(s) to ${settings.remote}/${settings.branch}, stop tracking ${tracked.length} on the base branch (history stays) and add .sdlc/${STATE_REQUIREMENT_PATH}, which switches every computer to the state branch and asks older plugins for an update.`,
    ]);
    return;
  }
  const pushed = pushStateRecords(context, { force: true, all: true, settings });
  if (!["pushed", "up_to_date"].includes(pushed.status)) {
    failWithCode("STATE_BRANCH_PUSH_FAILED", `Nothing changed: the records could not be pushed to ${settings.remote}/${settings.branch} (${pushed.error ?? pushed.status}).`);
  }
  // Same bytes on every computer (see buildRequirementRecord): plugins older than the feature ask for an update.
  const requirement = path.join(context.root, ...settings.sdlcFolder.split("/"), COMPATIBILITY_DIRECTORY, requirementFileName(STATE_FEATURE_ID));
  if (!fs.existsSync(requirement)) {
    fs.mkdirSync(path.dirname(requirement), { recursive: true });
    fs.writeFileSync(requirement, `${JSON.stringify(buildRequirementRecord(STATE_FEATURE_ID), null, 2)}\n`);
  }
  const ignorePath = path.join(context.root, ...settings.sdlcFolder.split("/"), ".gitignore");
  let ignoreText = "";
  try {
    ignoreText = fs.readFileSync(ignorePath, "utf8");
  } catch {
    ignoreText = "";
  }
  const nextIgnore = withStateGitignore(ignoreText);
  if (nextIgnore !== null) fs.writeFileSync(ignorePath, nextIgnore);
  if (tracked.length > 0) {
    const removed = gitRaw(context.root, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: `${tracked.join("\0")}\0` });
    if (!removed.ok) failWithCode("STATE_BRANCH_UNTRACK_FAILED", `Records pushed, but removing them from the index failed (${firstLine(removed.stderr)}). Run state migrate again.`);
  }
  output(options, { status: "migrated", ...plan, push: pushed }, [
    `${local.length} record(s) are on ${settings.remote}/${settings.branch}; ${tracked.length} are no longer tracked on this branch (files kept, history unchanged).`,
    "Commit .sdlc/.gitignore, .sdlc/compatibility and the removals to the base branch. Other computers need the plugin version that knows sdlc-state; their records come back with the next state pull.",
  ]);
}
