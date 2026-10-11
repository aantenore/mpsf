import path from "node:path";
import { Date, fs, process } from "../runtime/host.mjs";
import { parseLimitSeconds } from "../runtime/bounded-child-process.mjs";
import { VERSION } from "../engine/definitions.mjs";
import { AUTO_ENV } from "./auto.mjs";
import { settingsFor } from "./attention.mjs";
import { authorFor, PROVIDERS, resolveProvider } from "./commands.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";
import { claimEndedByRefs, readClaimRefNames } from "../runtime/claim-refs.mjs";

/**
 * Presence from the host hook, so the other computers know what this one is
 * doing without asking. While this clone holds active story claims it sends
 * an `[auto]` status (kind info) when the set of stories or their phases
 * changes, once when a story stays in one phase longer than the stall
 * threshold, and again after 12 hours to stay visible; with no claim it
 * offers help (kind offer) when it becomes free, and again after 12 hours.
 * Read from local records and local refs only (claims, claim refs, workflow
 * checkpoints); best effort and silent.
 *
 *   AGENTIC_SDLC_MESSAGING_HEARTBEAT_MINUTES   minimum gap between two status messages (default 15, 0 = off);
 *                                              set explicitly, a status is also sent every gap (periodic, as before)
 *   AGENTIC_SDLC_MESSAGING_STALL_HOURS         one notice per story and phase after this long (default 4, 0 = off)
 *
 * The state lives under `presence` in <git-common-dir>/agentic-sdlc/messaging-auto.json.
 */
export const HEARTBEAT_ENV = "AGENTIC_SDLC_MESSAGING_HEARTBEAT_MINUTES";
export const DEFAULT_HEARTBEAT_MINUTES = 15;
export const STALL_ENV = "AGENTIC_SDLC_MESSAGING_STALL_HOURS";
export const DEFAULT_STALL_HOURS = 4;
export const OFFER_EVERY_MS = 12 * 3600_000;
export const REFRESH_MS = 12 * 3600_000;
const LEGACY_OFFER_EVERY_MS = 60 * 60_000;
const STALLED_KEEP = 50;
const MAX_TIMEOUT_MS = 3000;
const LISTED = 3;

export function heartbeatMinutes(env = process.env) {
  const raw = String(env?.[HEARTBEAT_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_HEARTBEAT_MINUTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_HEARTBEAT_MINUTES;
}

/** True when the heartbeat gap was set explicitly: then the status is also sent every gap. */
export function heartbeatPeriodic(env = process.env) {
  const raw = String(env?.[HEARTBEAT_ENV] ?? "").trim();
  return raw !== "" && Number(raw) > 0;
}

export function stallHours(env = process.env) {
  const raw = String(env?.[STALL_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_STALL_HOURS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STALL_HOURS;
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function localBranchExists(commonDir, branch) {
  if (!commonDir || !branch) return false;
  if (fs.existsSync(path.join(commonDir, "refs", "heads", ...String(branch).split("/")))) return true;
  try {
    return fs.readFileSync(path.join(commonDir, "packed-refs"), "utf8").includes(` refs/heads/${branch}\n`);
  } catch {
    return false;
  }
}

/** branch -> folder of every worktree of the repository with that branch checked out (file reads only). */
function worktreeDirs(commonDir) {
  const dirs = new Map();
  if (!commonDir) return dirs;
  const branchOf = (headFile) => {
    try {
      return /^ref: refs\/heads\/(.+)$/mu.exec(fs.readFileSync(headFile, "utf8"))?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  };
  if (path.basename(commonDir) === ".git") {
    const branch = branchOf(path.join(commonDir, "HEAD"));
    if (branch) dirs.set(branch, path.dirname(commonDir));
  }
  let names = [];
  try {
    names = fs.readdirSync(path.join(commonDir, "worktrees"));
  } catch {
    names = [];
  }
  for (const name of names) {
    const meta = path.join(commonDir, "worktrees", name);
    const branch = branchOf(path.join(meta, "HEAD"));
    if (!branch || dirs.has(branch)) continue;
    try {
      const dir = path.dirname(path.resolve(meta, fs.readFileSync(path.join(meta, "gitdir"), "utf8").trim()));
      if (fs.existsSync(dir)) dirs.set(branch, dir);
    } catch {
      // a worktree without a readable gitdir is skipped
    }
  }
  return dirs;
}

/**
 * Active, unexpired claims whose branch exists in this clone (claim records
 * are shared through git, the branch is what ties a claim to this computer),
 * each with its workflow phase and when it was entered. Every worktree of
 * the clone with a branch checked out is read, so each hook of the clone sees
 * the same set; a live record in the story's own worktree wins. A record the
 * claim refs show as released or superseded does not count: a worktree behind
 * the base branch keeps an old "active" snapshot of a claim that already ended.
 */
export function localActiveClaims(root, { now = Date.now(), branchExists, claimEnded } = {}) {
  const commonDir = findGitCommonDir(root);
  const hasBranch = branchExists ?? ((branch) => localBranchExists(commonDir, branch));
  let refNames;
  const ended = claimEnded ?? ((claim) => {
    if (refNames === undefined) refNames = readClaimRefNames(commonDir);
    return claimEndedByRefs(claim, refNames);
  });
  const live = (claim) => {
    if (!claim || claim.status !== "active") return false;
    const expires = Date.parse(claim.expires_at ?? "");
    if (Number.isFinite(expires) && expires <= now) return false;
    return hasBranch(claim.branch) && !ended(claim);
  };
  const dirs = worktreeDirs(commonDir);
  const roots = [path.resolve(root)];
  for (const dir of dirs.values()) if (!roots.includes(path.resolve(dir))) roots.push(path.resolve(dir));
  const found = new Map();
  for (const dir of roots) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(dir, ".sdlc", "stories"));
    } catch {
      continue;
    }
    for (const name of names) {
      const claim = readJson(path.join(dir, ".sdlc", "stories", name, "claim.json"));
      if (!live(claim)) continue;
      const story = String(claim.story_id || name);
      const own = claim.branch && dirs.has(claim.branch) && path.resolve(dirs.get(claim.branch)) === dir;
      const seen = found.get(story.toUpperCase());
      if (!seen || (own && !seen.own)) found.set(story.toUpperCase(), { story, claim, dir, own });
    }
  }
  const claims = [...found.values()].map(({ story, claim, dir }) => ({ story, since: Date.parse(claim.claimed_at ?? "") || null, phase: null, dir }));
  if (claims.length === 0) return claims;
  const byDir = new Map();
  for (const claim of claims) byDir.set(claim.dir, [...(byDir.get(claim.dir) ?? []), claim]);
  for (const [dir, group] of byDir) {
    const instancesDir = path.join(dir, ".sdlc", "workflows", "instances");
    let instances = [];
    try {
      instances = fs.readdirSync(instancesDir);
    } catch {
      instances = [];
    }
    const byStory = new Map(group.map((claim) => [claim.story.toUpperCase(), claim]));
    for (const id of instances) {
      const instance = readJson(path.join(instancesDir, id, "instance.json"));
      const claim = byStory.get(String(instance?.metadata?.governance_binding?.story_id ?? "").toUpperCase());
      if (!claim) continue;
      const checkpoint = readJson(path.join(instancesDir, id, "checkpoint.json"));
      if (!checkpoint?.current_state) continue;
      const updated = Date.parse(checkpoint.updated_at ?? "");
      if (claim.phaseSince && Number.isFinite(updated) && updated < claim.phaseSince) continue;
      claim.phase = String(checkpoint.current_state);
      claim.phaseSince = Number.isFinite(updated) ? updated : null;
    }
  }
  return claims.map(({ dir: _dir, ...claim }) => claim).sort((a, b) => a.story.localeCompare(b.story));
}

function describe(claim, now) {
  const since = claim.phaseSince ?? claim.since;
  const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 60_000)) : null;
  return `${claim.story}${claim.phase ? ` in fase ${claim.phase}` : ""}${minutes !== null ? ` da ${minutes} min` : ""}`;
}

/** What the status is about: the stories and their phases, in a stable order. */
export function presenceSet(claims) {
  return claims.map((claim) => `${claim.story}:${claim.phase ?? ""}`).sort().join(",");
}

function recent(at, gapMs, now) {
  return Number.isFinite(at) && now - at < gapMs;
}

/**
 * Pure choice of the presence message, or null. `presence` is the stored
 * state: `last_status` and `last_offer` times, `last_set` (what the last
 * status or offer said; "" for free) and `stalled` (story:phase keys already
 * reported as stalled).
 */
export function selectPresence({ claims, presence = {}, now = Date.now(), heartbeatMs = DEFAULT_HEARTBEAT_MINUTES * 60_000, offerMs = OFFER_EVERY_MS, periodic = false, stallMs = DEFAULT_STALL_HOURS * 3600_000, refreshMs = REFRESH_MS }) {
  if (claims.length > 0) {
    if (!(heartbeatMs > 0)) return null;
    if (recent(presence.last_status, heartbeatMs, now)) return null;
    const set = presenceSet(claims);
    if (periodic || set !== presence.last_set || !recent(presence.last_status, refreshMs, now)) {
      const listed = claims.slice(0, LISTED).map((claim) => describe(claim, now)).join("; ");
      const more = claims.length > LISTED ? ` e altre ${claims.length - LISTED}` : "";
      return { kind: "info", story: claims.length === 1 ? claims[0].story : null, stories: claims.map((claim) => claim.story).slice(0, 20), text: `[auto] stato: ${listed}${more}`, field: "last_status", set };
    }
    if (!(stallMs > 0)) return null;
    const stalled = new Set(Array.isArray(presence.stalled) ? presence.stalled.map(String) : []);
    const stuck = claims.find((claim) => {
      const since = claim.phaseSince ?? claim.since;
      return Number.isFinite(since) && now - since >= stallMs && !stalled.has(`${claim.story}:${claim.phase ?? ""}`);
    });
    if (!stuck) return null;
    const hours = Math.floor((now - (stuck.phaseSince ?? stuck.since)) / 3600_000);
    return { kind: "info", story: stuck.story, stories: claims.map((claim) => claim.story).slice(0, 20), text: `[auto] stato: ${stuck.story} ferma${stuck.phase ? ` in fase ${stuck.phase}` : ""} da ${hours} h`, field: "last_status", set, stalled: `${stuck.story}:${stuck.phase ?? ""}` };
  }
  if (recent(presence.last_offer, heartbeatMs > 0 ? heartbeatMs : DEFAULT_HEARTBEAT_MINUTES * 60_000, now)) return null;
  const wasBusy = typeof presence.last_set === "string" && presence.last_set !== "";
  // Periodic mode (heartbeat set explicitly) keeps the old hourly offer.
  if (!wasBusy && recent(presence.last_offer, periodic ? LEGACY_OFFER_EVERY_MS : offerMs, now)) return null;
  return { kind: "offer", story: null, stories: [], text: "[auto] libero: posso prendere lavoro o aiutare", field: "last_offer", set: "" };
}

/** One throttled presence step for the host hook; returns what was sent or null. */
export async function checkPresence(root, { env = process.env, providers = PROVIDERS, now = Date.now(), branchExists, claimEnded } = {}) {
  const settings = settingsFor(root, env);
  if (!settings?.statePath) return null;
  const state = readJson(settings.statePath) ?? {};
  const presence = state.presence && typeof state.presence === "object" ? state.presence : {};
  // Two presence messages are always at least one gap apart: skip the reads while inside it.
  const gapMs = (heartbeatMinutes(env) || DEFAULT_HEARTBEAT_MINUTES) * 60_000;
  const last = Math.max(Number.isFinite(presence.last_status) ? presence.last_status : 0, Number.isFinite(presence.last_offer) ? presence.last_offer : 0);
  if (recent(last, gapMs, now)) return null;
  const choice = selectPresence({
    claims: localActiveClaims(root, { now, branchExists, claimEnded }),
    presence,
    now,
    heartbeatMs: heartbeatMinutes(env) * 60_000,
    periodic: heartbeatPeriodic(env),
    stallMs: stallHours(env) * 3600_000,
  });
  if (!choice) return null;
  // Claim the slot first, so parallel hooks do not all send.
  const latest = readJson(settings.statePath) ?? {};
  const stalled = Array.isArray(presence.stalled) ? presence.stalled.map(String) : [];
  const claimed = {
    ...presence,
    [choice.field]: now,
    last_set: choice.set,
    stalled: choice.stalled ? [...stalled.filter((key) => key !== choice.stalled), choice.stalled].slice(-STALLED_KEEP) : stalled,
  };
  fs.mkdirSync(path.dirname(settings.statePath), { recursive: true });
  fs.writeFileSync(settings.statePath, `${JSON.stringify({ ...latest, presence: claimed }, null, 2)}\n`, { mode: 0o600 });
  // A send that throws keeps the slot (no retry storm) but not what it would have announced.
  const forget = () => {
    try {
      const after = readJson(settings.statePath) ?? {};
      const current = after.presence && typeof after.presence === "object" ? after.presence : {};
      const restored = { ...current, stalled };
      if (presence.last_set === undefined) delete restored.last_set;
      else restored.last_set = presence.last_set;
      fs.writeFileSync(settings.statePath, `${JSON.stringify({ ...after, presence: restored }, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // best effort
    }
  };
  const seconds = parseLimitSeconds(env[AUTO_ENV.timeout]);
  const timeout = Math.min((seconds && seconds > 0 ? seconds : 3) * 1000, MAX_TIMEOUT_MS);
  try {
    const sent = await resolveProvider(settings.config, providers).publish({
      config: settings.config,
      message: { ...authorFor(root, env), version: VERSION, kind: choice.kind, story: choice.story, stories: choice.stories, text: choice.text },
      signal: AbortSignal.timeout(timeout),
    });
    if (sent?.id) {
      const after = readJson(settings.statePath) ?? {};
      const own = Array.isArray(after.own) ? after.own.map(String) : [];
      fs.writeFileSync(settings.statePath, `${JSON.stringify({ ...after, own: [...own, String(sent.id)].slice(-200) }, null, 2)}\n`, { mode: 0o600 });
    }
  } catch {
    forget();
    return null;
  }
  return choice;
}
