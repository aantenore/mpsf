import path from "node:path";
import { computeStableHash } from "../canonical.mjs";
import { comparePluginVersions, PLUGIN_VERSION } from "../plugin-compatibility.mjs";
import { Date, fs, process } from "../runtime/host.mjs";

/**
 * Known error database. One immutable record per problem,
 * `.sdlc/known-errors/KE-<signature>.json`, plus append-only events under
 * `.sdlc/known-errors/events/<KE-id>/` (worked, failed, accepted, retired):
 * every computer adds its own files, so nothing conflicts on merge and a
 * record is never rewritten. The last failures of this computer stay in the
 * derived cache `.sdlc/cache/known-errors/last-failures.json`.
 */
export const KNOWN_ERROR_KIND = "known_error";
export const KNOWN_ERROR_SCHEMA = "known-error:v1";
export const KNOWN_ERROR_EVENT_KIND = "known_error_event";
export const KNOWN_ERROR_EVENT_SCHEMA = "known-error-event:v1";
export const EVENT_TYPES = Object.freeze(["worked", "failed", "accepted", "retired"]);
export const SAFE_ACTION_TYPES = Object.freeze(["remove_path", "gitignore_add"]);
const ID_PATTERN = /^KE-[0-9a-f]{12}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isKnownErrorId(value) {
  return ID_PATTERN.test(String(value || ""));
}

export function knownErrorsRoot(sdlcRoot) {
  return path.join(sdlcRoot, "known-errors");
}

export function knownErrorPath(sdlcRoot, id) {
  return path.join(knownErrorsRoot(sdlcRoot), `${id}.json`);
}

export function knownErrorEventsRoot(sdlcRoot, id) {
  return path.join(knownErrorsRoot(sdlcRoot), "events", id);
}

export function lastFailuresPath(sdlcRoot) {
  return path.join(sdlcRoot, "cache", "known-errors", "last-failures.json");
}

function readJson(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listDir(dirPath) {
  try {
    return fs.readdirSync(dirPath).sort();
  } catch {
    return [];
  }
}

function readEvents(sdlcRoot, id) {
  const root = knownErrorEventsRoot(sdlcRoot, id);
  return listDir(root)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(root, name)))
    .filter((event) => event?.kind === KNOWN_ERROR_EVENT_KIND && event.known_error_id === id && EVENT_TYPES.includes(event.type))
    .sort((left, right) => String(left.at).localeCompare(String(right.at), "en"));
}

function inVersionRange(record, running) {
  const range = record?.scope?.plugin_versions ?? {};
  try {
    if (range.min && comparePluginVersions(running, range.min) < 0) return false;
    if (range.max && comparePluginVersions(running, range.max) > 0) return false;
  } catch {
    return true;
  }
  return true;
}

const ACCEPTING_ACTORS = Object.freeze(["human", "ci"]);

/** True when the record's own hash holds: a record edited after it was written never auto-applies. */
export function knownErrorHashHolds(record) {
  if (typeof record?.record_hash !== "string" || !record.record_hash) return false;
  const { record_hash: recorded, ...rest } = record;
  try {
    return computeStableHash(rest) === recorded;
  } catch {
    return false;
  }
}

/**
 * An `accepted` event counts only when a person (or CI) wrote it and it names
 * exactly the actions of the record (and its hash, when the event carries
 * one). Events arrive from other computers with a pull, so the actor written
 * at accept time is checked again here.
 */
export function acceptanceHolds(record, event) {
  if (event?.type !== "accepted" || !ACCEPTING_ACTORS.includes(event.actor?.type)) return false;
  if (event.record_hash !== undefined && event.record_hash !== record?.record_hash) return false;
  try {
    return computeStableHash(event.actions ?? null) === computeStableHash(record?.fix?.actions ?? null);
  } catch {
    return false;
  }
}

/**
 * Effective state of one record: active, suspect (its fix failed after it
 * last worked), stale (unused for stale_after_days), out_of_range (plugin
 * version outside its scope) or retired.
 */
export function summarizeKnownError(record, events, { now = Date.now(), staleAfterDays = 90, running = PLUGIN_VERSION } = {}) {
  const outcomes = events.filter((event) => event.type === "worked" || event.type === "failed");
  const worked = outcomes.filter((event) => event.type === "worked").length;
  const failed = outcomes.length - worked;
  const accepted = [...events].reverse().find((event) => acceptanceHolds(record, event)) ?? null;
  const retired = [...events].reverse().find((event) => event.type === "retired") ?? null;
  const last = outcomes.at(-1) ?? null;
  const lastWorked = [...outcomes].reverse().find((event) => event.type === "worked") ?? null;
  const lastActivity = Math.max(Date.parse(record.created_at) || 0, Date.parse(last?.at) || 0);
  let status = "active";
  if (retired) status = "retired";
  else if (!inVersionRange(record, running)) status = "out_of_range";
  else if (last?.type === "failed") status = "suspect";
  else if (lastActivity > 0 && now - lastActivity > staleAfterDays * DAY_MS) status = "stale";
  const safe = record?.fix?.safe === true && Array.isArray(record?.fix?.actions) && record.fix.actions.length > 0;
  return {
    id: record.id,
    title: record.title,
    status,
    signature: record.signature,
    diagnosis: record.diagnosis,
    steps: Array.isArray(record.steps) ? record.steps : [],
    fix: record.fix ?? { safe: false, actions: [] },
    safe,
    auto_applicable: safe && Boolean(accepted) && status === "active" && knownErrorHashHolds(record),
    accepted_by: accepted ? { actor: accepted.actor, at: accepted.at } : null,
    retired: retired ? { reason: retired.note ?? null, superseded_by: retired.superseded_by ?? null, at: retired.at } : null,
    scope: record.scope ?? null,
    seen_in: record.seen_in ?? null,
    used: outcomes.length,
    worked,
    failed,
    last_used_at: last?.at ?? null,
    last_verified_at: lastWorked?.at ?? null,
    created_at: record.created_at,
  };
}

/** Every record of the project with its effective state, sorted by id. */
export function readKnownErrors(sdlcRoot, options = {}) {
  const root = knownErrorsRoot(sdlcRoot);
  const entries = [];
  for (const name of listDir(root)) {
    if (!/^KE-[0-9a-f]{12}\.json$/u.test(name)) continue;
    const record = readJson(path.join(root, name));
    if (record?.kind !== KNOWN_ERROR_KIND || `${record.id}.json` !== name) continue;
    entries.push(summarizeKnownError(record, readEvents(sdlcRoot, record.id), options));
  }
  return entries;
}

function signatureKeys(entry) {
  const keys = new Set([entry.signature?.key].filter(Boolean));
  for (const alias of Array.isArray(entry.signature?.aliases) ? entry.signature.aliases : []) keys.add(alias);
  return keys;
}

/**
 * Known errors matching `signature`, best first: exact signature, then the
 * same check, path and normalized message regardless of the exit code.
 * Retired and out-of-range records are never proposed.
 */
export function matchKnownErrors(entries, signature, { limit = 3 } = {}) {
  const proposable = entries.filter((entry) => !["retired", "out_of_range"].includes(entry.status));
  const exact = proposable.filter((entry) => signatureKeys(entry).has(signature.key));
  const loose = proposable.filter((entry) => !exact.includes(entry)
    && entry.signature?.check === signature.check
    && entry.signature?.message === signature.message
    && (entry.signature?.path ?? null) === (signature.path ?? null));
  const rank = { active: 0, stale: 1, suspect: 2 };
  const order = (list) => [...list].sort((left, right) => (rank[left.status] ?? 3) - (rank[right.status] ?? 3) || right.worked - left.worked);
  return [...order(exact).map((entry) => ({ ...entry, match: "exact" })), ...order(loose).map((entry) => ({ ...entry, match: "similar" }))].slice(0, limit);
}

export function readLastFailures(sdlcRoot) {
  const value = readJson(lastFailuresPath(sdlcRoot));
  return Array.isArray(value?.failures) ? value.failures : [];
}

/** Remember this computer's latest failures (derived cache, never published). */
export function rememberFailures(sdlcRoot, failures, { keep = 10 } = {}) {
  if (!failures.length) return;
  const byKey = new Map(readLastFailures(sdlcRoot).map((item) => [item.signature?.key, item]));
  for (const failure of failures) {
    byKey.delete(failure.signature.key);
    byKey.set(failure.signature.key, failure);
  }
  const list = [...byKey.values()].slice(-keep);
  const filePath = lastFailuresPath(sdlcRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ schema_version: "known-error-last-failures:v1", failures: list }, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}
