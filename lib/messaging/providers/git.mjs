import path from "node:path";
import { childProcess, crypto, Date, fs, process } from "../../runtime/host.mjs";
import { resolveSince } from "../cursor.mjs";
import { KINDS } from "../kinds.mjs";
import { signedTrust, signFields, trustContext } from "../signature.mjs";
import { machineId } from "../../runtime/machine.mjs";
import { GIT_PROVIDER_ID } from "../../adapters/messaging/ids.mjs";

/**
 * Git messaging adapter. The channel lives in the project's own remote, so it
 * works with any git host and needs no other service or account: access to
 * the repository is the authentication.
 *
 *   refs/agentic-sdlc/channel/<machine-id>   one ref per computer, written only by that computer
 *
 * A message is a small commit on the sender's ref (empty tree); its message
 * holds one signed JSON line (see ../signature.mjs). Every computer appends to
 * its own ref only, so a push is always a fast-forward and never conflicts
 * with another computer. Hosts that refuse custom refs get the same layout
 * under branches (refs/heads/agentic-sdlc/channel/<machine-id>), chosen on the
 * first refused push and remembered per clone; those commits carry [skip ci].
 *
 * Reading fetches every channel ref (at most once per FETCH_MIN_MS), walks the
 * commits each ref gained since the last read and keeps them in a per-clone
 * cache in arrival order (<git-common-dir>/agentic-sdlc/git-channel/). The
 * read position handed to callers is the arrival order, so a message pushed
 * late by a computer with a wrong clock or a slow network is still delivered.
 * Message ids are the same on every computer (sender time and a random part),
 * so replies point at the right message everywhere.
 *
 * Old messages are compacted: once a day, a computer rewrites its own ref
 * keeping only the last COMPACT_AFTER_DAYS days (force-with-lease, its ref
 * only). A reader that no longer finds its last commit walks the ref again
 * and drops what it already has.
 */
export { GIT_PROVIDER_ID };
// Messages reach every clone of the remote, and each one is signed by the computer that wrote it.
export const GIT_GUARANTEES = Object.freeze(["cross_host_delivery", "ordered_ids", "signed_sender"]);
export const CHANNEL_NAMESPACE = "refs/agentic-sdlc/channel";
export const BRANCH_NAMESPACE = "refs/heads/agentic-sdlc/channel";
const TRACK = Object.freeze({ refs: "refs/agentic-sdlc/channel-remote", branches: "refs/agentic-sdlc/channel-branch" });
const REMOTE = Object.freeze({ refs: CHANNEL_NAMESPACE, branches: BRANCH_NAMESPACE });
const STATE_DIR = path.join("agentic-sdlc", "git-channel");
const STATE_FILE = "state.json";
const CACHE_FILE = "messages.jsonl";
const LOCK_DIR = "lock";
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const FETCH_MIN_MS = 15_000;
const CALL_TIMEOUT_MS = 20_000;
const DEFAULT_LISTEN_SECONDS = 30;
const MAX_TEXT = 4000;
const MAX_WALK = 2000;
const CACHE_KEEP_MS = 30 * 86_400_000;
const CACHE_MAX = 10_000;
const COMPACT_AFTER_DAYS = 14;
const COMPACT_EVERY_MS = 86_400_000;
const PAYLOAD_VERSION = 1;
const MACHINE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const SUBJECT = "agentic-sdlc message [skip ci]";
const TEMPORARY = /could not read from remote|unable to access|could not resolve|timed out|timeout|connection|early eof|unexpected disconnect|returned error: 5\d\d|rpc failed|permission denied|authentication failed|could not read username|terminal prompts disabled/iu;
const CONFLICT = /non-fast-forward|fetch first|stale info|\[rejected\]/iu;
const REFUSED = /remote rejected|deny|denied|refus|not allowed|funny refname|invalid ref|hook declined|protected|forbidden/iu;

function setupError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.setup = true;
  return error;
}

function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function textOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: process.env.GIT_ASKPASS ?? "", LC_ALL: "C" });

/** Local git command; returns stdout, throws on failure. */
function gitSync(root, args, { input, env } = {}) {
  return String(childProcess.execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    env: env ?? gitEnv(),
  }));
}

function gitTry(root, args, options) {
  try {
    return gitSync(root, args, options);
  } catch {
    return null;
  }
}

/** Network git command (fetch, push, ls-remote): resolves { code, out } and never rejects except on abort. */
function gitNet(root, args, signal) {
  return new Promise((resolve, reject) => {
    childProcess.execFile("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: CALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      signal,
      env: gitEnv(),
    }, (error, stdout, stderr) => {
      if (error?.name === "AbortError") return reject(error);
      if (error?.code === "ENOENT") return reject(setupError("git is not installed or not on PATH."));
      const out = `${stdout ?? ""}\n${stderr ?? ""}`;
      if (error?.killed) return resolve({ code: 124, out: `${out}\ngit timed out` });
      return resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out });
    });
  });
}

function classifyPush(result) {
  if (result.code === 0) return "ok";
  if (TEMPORARY.test(result.out)) return "temporary";
  if (CONFLICT.test(result.out) && !/remote rejected/iu.test(result.out)) return "conflict";
  if (REFUSED.test(result.out)) return "refused";
  return "failed";
}

function firstLine(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? "";
}

// ---- per-clone state ------------------------------------------------------------------------------------------

function context(config) {
  const root = textOrNull(config?.root);
  if (!root) throw setupError("The git messaging channel needs the project folder.");
  const common = gitTry(root, ["rev-parse", "--git-common-dir"])?.trim();
  if (!common) throw setupError(`${root} is not a git clone, so the git channel cannot be used.`);
  const remote = textOrNull(config.remote) ?? "origin";
  return { root, remote, dir: path.join(path.resolve(root, common), STATE_DIR) };
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readState(ctx) {
  const state = readJsonFile(path.join(ctx.dir, STATE_FILE)) ?? {};
  return {
    mode: state.mode === "branches" ? "branches" : "refs",
    seen: state.seen && typeof state.seen === "object" ? state.seen : {},
    seq: Number.isSafeInteger(state.seq) ? state.seq : 0,
    last_id: Number.isSafeInteger(state.last_id) ? state.last_id : 0,
    last_fetch_ms: Number(state.last_fetch_ms) || 0,
    compacted_ms: Number(state.compacted_ms) || 0,
  };
}

function writeState(ctx, state) {
  writeAtomic(path.join(ctx.dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

function readCache(ctx) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(ctx.dir, CACHE_FILE), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (Number.isSafeInteger(entry?.seq) && entry.payload && typeof entry.payload === "object") entries.push(entry);
    } catch {
      // A torn line: skipped.
    }
  }
  return entries;
}

function appendCache(ctx, cache, added, nowMs) {
  if (added.length === 0) return;
  const all = [...cache, ...added];
  if (all.length > CACHE_MAX || (cache[0] && nowMs - Date.parse(cache[0].at) > CACHE_KEEP_MS)) {
    const kept = all.filter((entry) => nowMs - Date.parse(entry.at) <= CACHE_KEEP_MS).slice(-CACHE_MAX);
    writeAtomic(path.join(ctx.dir, CACHE_FILE), kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    return;
  }
  fs.mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(ctx.dir, CACHE_FILE), added.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
}

// One writer at a time: a promise chain inside this process, a lock folder across processes.
const chains = new Map();

function withLock(ctx, nowFn, action) {
  const previous = chains.get(ctx.dir) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    fs.mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
    const lock = path.join(ctx.dir, LOCK_DIR);
    const deadline = nowFn() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw setupError(`Cannot lock the git channel: ${error.message}`, error);
        try {
          if (nowFn() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
        } catch {
          // Released meanwhile.
        }
        if (nowFn() > deadline) throw setupError("The git channel is locked by another process; try again.");
        sleepSync(25);
      }
    }
    try {
      return await action();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  });
  chains.set(ctx.dir, run);
  return run;
}

// ---- commits --------------------------------------------------------------------------------------------------

function commitEnv(machine) {
  const email = `${machine}@agentic-sdlc.invalid`;
  return { ...gitEnv(), GIT_AUTHOR_NAME: "agentic-sdlc", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "agentic-sdlc", GIT_COMMITTER_EMAIL: email };
}

function emptyTree(root) {
  return gitSync(root, ["mktree"], { input: "" }).trim();
}

function commitMessage(root, machine, parent, body) {
  const args = ["-c", "commit.gpgSign=false", "commit-tree", emptyTree(root)];
  if (parent) args.push("-p", parent);
  args.push("-F", "-");
  return gitSync(root, args, { input: body, env: commitEnv(machine) }).trim();
}

function refSha(root, ref) {
  return gitTry(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim() || null;
}

/** The JSON payload of a channel commit message, or null. */
export function parseCommitBody(body) {
  const text = String(body ?? "");
  const start = text.indexOf("\n{");
  const json = (start >= 0 ? text.slice(start + 1) : text).trim();
  try {
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.v !== PAYLOAD_VERSION) return null;
    if (!/^\d{1,16}$/u.test(String(payload.id ?? "")) || typeof payload.text !== "string" || !textOrNull(payload.time)) return null;
    return payload;
  } catch {
    return null;
  }
}

function logCommits(root, range) {
  const out = gitTry(root, ["log", `-n${MAX_WALK}`, "--format=%H%x1f%B%x1e", range]);
  if (!out) return [];
  return out.split("\x1e").map((chunk) => chunk.replace(/^\s+/u, "")).filter(Boolean).map((chunk) => {
    const split = chunk.indexOf("\x1f");
    return { sha: chunk.slice(0, split), payload: parseCommitBody(chunk.slice(split + 1)) };
  }).reverse();
}

// ---- reading --------------------------------------------------------------------------------------------------

function trackedRefs(root) {
  const out = gitTry(root, ["for-each-ref", "--format=%(refname) %(objectname)", TRACK.refs, TRACK.branches]) ?? "";
  return out.split("\n").filter(Boolean).map((line) => {
    const [ref, sha] = line.split(" ");
    return { ref, sha, machine: ref.split("/").pop() };
  }).filter((item) => MACHINE_PATTERN.test(item.machine));
}

function fetchArgs(ctx) {
  return ["fetch", "--quiet", "--no-tags", "--prune", "--no-recurse-submodules", "--no-write-fetch-head", ctx.remote,
    `+${REMOTE.refs}/*:${TRACK.refs}/*`, `+${REMOTE.branches}/*:${TRACK.branches}/*`];
}

const entryKey = (machine, payload) => `${machine}:${payload.mid ?? payload.id}`;

/** Adds the commits the tracked refs gained since the last read to the cache, in arrival order. */
function ingest(ctx, state, cache, nowMs) {
  const known = new Set(cache.map((entry) => entry.key));
  const fresh = [];
  for (const { ref, sha, machine } of trackedRefs(ctx.root)) {
    const previous = state.seen[ref];
    if (previous === sha) continue;
    const linear = previous && gitTry(ctx.root, ["merge-base", "--is-ancestor", previous, sha]) !== null;
    for (const commit of logCommits(ctx.root, linear ? `${previous}..${sha}` : sha)) {
      if (!commit.payload) continue;
      const key = entryKey(machine, commit.payload);
      if (known.has(key)) continue;
      known.add(key);
      fresh.push({ key, machine, payload: commit.payload });
    }
    state.seen[ref] = sha;
  }
  fresh.sort((left, right) => String(left.payload.time).localeCompare(String(right.payload.time)) || Number(left.payload.id) - Number(right.payload.id));
  const at = new Date(nowMs).toISOString();
  const added = fresh.map((item) => ({ seq: (state.seq += 1), at, key: item.key, machine: item.machine, payload: item.payload }));
  appendCache(ctx, cache, added, nowMs);
  return [...cache, ...added];
}

/** A cached entry as a normalized message, with its trust and arrival cursor. */
function toMessage(entry, trust) {
  const payload = entry.payload;
  return {
    id: String(payload.id),
    time: payload.time,
    from: textOrNull(payload.from),
    host: textOrNull(payload.host),
    story: textOrNull(payload.story),
    kind: KINDS.includes(payload.kind) ? payload.kind : "info",
    reply_to: textOrNull(payload.reply_to),
    to: textOrNull(payload.to),
    version: textOrNull(payload.version),
    gh_login: textOrNull(payload.gh_login),
    stories: Array.isArray(payload.stories) ? payload.stories.map(String).slice(0, 20) : null,
    ...(textOrNull(payload.until) ? { until: payload.until } : {}),
    text: payload.text.trim(),
    title: null,
    plugin_message: true,
    machine: entry.machine,
    trust: signedTrust(payload, { ...trust, expectedMachine: entry.machine }),
    cursor: `${entry.at.replace(/\.\d{3}Z$/u, "Z")}|${entry.seq}`,
  };
}

// Cursors below this are arrival positions of this clone; above it, message ids (sender time based).
const ARRIVAL_LIMIT = 1e12;

function selectSince(entries, since, nowMs) {
  const { iso, afterId } = resolveSince(since, nowMs);
  if (afterId !== null) {
    return afterId < ARRIVAL_LIMIT ? entries.filter((entry) => entry.seq > afterId) : entries.filter((entry) => Number(entry.payload.id) > afterId);
  }
  if (iso) {
    const from = Date.parse(iso);
    return entries.filter((entry) => Date.parse(entry.payload.time) >= from);
  }
  return entries;
}

// ---- provider -------------------------------------------------------------------------------------------------

export function createGitProvider({ now = () => Date.now(), sleep, env = process.env } = {}) {
  const wait = sleep ?? ((ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  }));

  function remoteUrl(ctx) {
    const url = gitTry(ctx.root, ["remote", "get-url", ctx.remote])?.trim();
    if (!url) throw setupError(`The git channel needs the remote '${ctx.remote}', which this clone does not have.`);
    return url;
  }

  async function ensureChannel({ config, signal, verify = false }) {
    const ctx = context(config);
    const url = remoteUrl(ctx);
    if (verify) {
      const result = await gitNet(ctx.root, ["ls-remote", ctx.remote, `${REMOTE.refs}/*`], signal);
      if (result.code !== 0) throw setupError(`Cannot reach the remote '${ctx.remote}': ${firstLine(result.out)}`);
    }
    return { issue: null, created: false, url: `${url.replace(/\/\/[^/@]*@/u, "//")} ${REMOTE[readState(ctx).mode]}/*` };
  }

  async function fetchChannel(ctx, state, signal, force = false) {
    if (!force && now() - state.last_fetch_ms < FETCH_MIN_MS) return null;
    const result = await gitNet(ctx.root, fetchArgs(ctx), signal);
    if (result.code !== 0) return `Cannot read the git channel from '${ctx.remote}': ${firstLine(result.out)}`;
    state.last_fetch_ms = now();
    return null;
  }

  async function push(ctx, sha, remoteRef, signal, lease = null) {
    const args = ["push", "--quiet", "--porcelain", "--no-verify"];
    if (lease) args.push(`--force-with-lease=${remoteRef}:${lease}`);
    args.push(ctx.remote, `${sha}:${remoteRef}`);
    return classifyPush(await gitNet(ctx.root, args, signal));
  }

  function nextId(state, mid) {
    const base = now() * 1000 + (parseInt(mid.slice(0, 4), 16) % 1000);
    return Math.max(base, state.last_id + 1);
  }

  /** Rewrites this computer's ref keeping the recent messages; best effort, at most once a day. */
  async function compact(ctx, state, machine, signal) {
    if (now() - state.compacted_ms < COMPACT_EVERY_MS) return;
    state.compacted_ms = now();
    const track = `${TRACK[state.mode]}/${machine}`;
    const tip = refSha(ctx.root, track);
    if (!tip) return;
    const commits = logCommits(ctx.root, tip);
    const cutoff = now() - COMPACT_AFTER_DAYS * 86_400_000;
    const keepFrom = commits.findIndex((commit) => commit.payload && Date.parse(commit.payload.time) >= cutoff);
    const keep = commits.slice(keepFrom < 0 ? Math.max(0, commits.length - 1) : keepFrom);
    if (keep.length === commits.length) return;
    let parent = null;
    for (const commit of keep) {
      const body = gitSync(ctx.root, ["log", "-1", "--format=%B", commit.sha]);
      parent = commitMessage(ctx.root, machine, parent, body);
    }
    if ((await push(ctx, parent, `${REMOTE[state.mode]}/${machine}`, signal, tip)) !== "ok") return;
    gitTry(ctx.root, ["update-ref", track, parent, tip]);
    state.seen[track] = parent;
  }

  async function publish({ config, message, signal }) {
    signal?.throwIfAborted?.();
    const text = String(message?.text ?? "").trim();
    if (!text) throw new Error("A message needs text.");
    if (text.length > MAX_TEXT) throw new Error(`A message is limited to ${MAX_TEXT} characters.`);
    const ctx = context(config);
    remoteUrl(ctx);
    const machine = machineId(env);
    return withLock(ctx, now, async () => {
      const state = readState(ctx);
      const mid = crypto.randomBytes(8).toString("hex");
      const fields = {
        mid,
        time: isoSeconds(now()),
        from: textOrNull(message.from),
        host: textOrNull(message.host),
        story: textOrNull(message.story),
        kind: KINDS.includes(message.kind) ? message.kind : "info",
        reply_to: textOrNull(message.replyTo ?? message.reply_to),
        to: textOrNull(message.to),
        version: textOrNull(message.version),
        gh_login: textOrNull(message.ghLogin ?? message.gh_login),
        stories: Array.isArray(message.stories) ? message.stories.map(String).slice(0, 20) : null,
        ...(textOrNull(message.until) ? { until: message.until } : {}),
        text,
      };
      const payload = { v: PAYLOAD_VERSION, id: String(nextId(state, mid)), ...fields, ...signFields(fields, env) };
      const body = `${SUBJECT}\n\n${JSON.stringify(payload)}\n`;
      const attempt = async (mode) => {
        const track = `${TRACK[mode]}/${machine}`;
        const remoteRef = `${REMOTE[mode]}/${machine}`;
        let sha = commitMessage(ctx.root, machine, refSha(ctx.root, track), body);
        let outcome = await push(ctx, sha, remoteRef, signal);
        if (outcome === "conflict") {
          // Another clone on this computer wrote first: take its tip and append on top.
          await gitNet(ctx.root, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", ctx.remote, `+${remoteRef}:${track}`], signal);
          sha = commitMessage(ctx.root, machine, refSha(ctx.root, track), body);
          outcome = await push(ctx, sha, remoteRef, signal);
        }
        return { outcome, sha, track };
      };
      let result = await attempt(state.mode);
      if (result.outcome === "refused" && state.mode === "refs") {
        const fallback = await attempt("branches");
        if (fallback.outcome === "ok") state.mode = "branches";
        result = fallback.outcome === "ok" ? fallback : result;
      }
      if (result.outcome === "temporary" || result.outcome === "conflict") throw setupError(`The git channel could not be written now (${ctx.remote}); the message is kept and sent later.`);
      if (result.outcome !== "ok") throw new Error(`The remote '${ctx.remote}' refuses the git channel; choose another messaging provider.`);
      gitTry(ctx.root, ["update-ref", result.track, result.sha]);
      state.seen[result.track] = result.sha;
      state.last_id = Number(payload.id);
      const cache = readCache(ctx);
      const entry = { seq: (state.seq += 1), at: new Date(now()).toISOString(), key: entryKey(machine, payload), machine, payload };
      appendCache(ctx, cache, [entry], now());
      try {
        await compact(ctx, state, machine, signal);
      } catch {
        // Compaction is housekeeping; the message is sent.
      }
      writeState(ctx, state);
      return toMessage(entry, trustContext(ctx.root, env));
    });
  }

  async function poll({ config, since, signal, force = false }) {
    signal?.throwIfAborted?.();
    const ctx = context(config);
    remoteUrl(ctx);
    const { entries, failure } = await withLock(ctx, now, async () => {
      const state = readState(ctx);
      const failed = await fetchChannel(ctx, state, signal, force);
      const all = ingest(ctx, state, readCache(ctx), now());
      writeState(ctx, state);
      return { entries: all, failure: failed };
    });
    if (failure) throw setupError(failure);
    const trust = trustContext(ctx.root, env);
    return selectSince(entries, since, now()).map((entry) => toMessage(entry, trust));
  }

  async function subscribe({ config, since, signal, onMessage, onError, intervalSeconds = DEFAULT_LISTEN_SECONDS }) {
    let cursor = since ?? isoSeconds(now());
    while (!signal?.aborted) {
      try {
        for (const message of await poll({ config, since: cursor, signal, force: true })) {
          cursor = message.cursor;
          if ((await onMessage(message)) === false) return;
        }
      } catch (error) {
        if (signal?.aborted) return;
        onError?.(error);
      }
      if (signal?.aborted) return;
      await wait(intervalSeconds * 1000, signal);
    }
  }

  async function whoami() {
    return null;
  }

  return Object.freeze({ id: GIT_PROVIDER_ID, guarantees: GIT_GUARANTEES, ensureChannel, publish, poll, subscribe, whoami });
}
