import fs from "node:fs";
import path from "node:path";

/**
 * Agent profile of a command's JSON payload: outcome, involved ids,
 * essential hashes, next step, warnings/errors, and `context get rec:` refs
 * in place of long blocks (assistant messages, repeated technical details,
 * whole nested records). Pure given the record locator; deterministic
 * (keys sorted, lists in payload order). The full payload stays available
 * with `--json-profile full`.
 */
export const AGENT_JSON_PROFILE = "agent";
export const JSON_PROFILES = Object.freeze(["agent", "full"]);
const FULL_HINT = "--json-profile full";
const MAX_LIST = 5;
const MAX_TEXT = 240;
const ID_KEY = /(?:^|_)ids?$/u;
const HASH_KEY = /(?:^|_)hash$/u;
const PATH_KEY = /(?:^|_)path$/u;
// Scalar fields of a nested record that identify it or state its outcome.
const RECORD_FIELDS = new Set([
  "id", "kind", "status", "revision", "phase", "story_id", "requirement_id", "delivery_id", "contract_id",
  "effective_level", "requested_level", "execution_status", "autonomy_ceiling", "outcome", "result", "decision",
]);
// Long, presentation-only blocks: never part of the agent profile.
const DROPPED = new Set(["assistant_message", "assistant_message_presentation", "assistant_message_source_language", "context_optimization"]);
const NOTHING_TO_DECIDE = /^(?:no |nothing|none|you do not|there is nothing|non (?:devi|serve|c'è)|nessun)/iu;
const SKIPPED_DIRECTORIES = new Set(["cache", "indexes"]);
const MAX_INDEXED_FILES = 50_000;

function clip(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function sorted(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b, "en")));
}

function sdlcRef(value) {
  const text = String(value ?? "").replace(/\\/gu, "/");
  const index = text.indexOf(".sdlc/");
  return index >= 0 ? `rec:${text.slice(index)}` : null;
}

/**
 * Finds the record file named `<id>.json` under .sdlc (outside derived
 * folders) once per process; null when absent or ambiguous.
 */
export function createRecordLocator(root) {
  let index = null;
  const build = () => {
    index = new Map();
    const sdlc = path.join(root, ".sdlc");
    const stack = [""];
    let seen = 0;
    while (stack.length > 0 && seen < MAX_INDEXED_FILES) {
      const relative = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(sdlc, relative), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!(relative === "" && SKIPPED_DIRECTORIES.has(entry.name)) && !entry.name.startsWith(".")) stack.push(child);
        } else if (entry.name.endsWith(".json")) {
          seen += 1;
          const id = entry.name.slice(0, -".json".length);
          index.set(id, index.has(id) ? null : `.sdlc/${child}`);
        }
      }
    }
  };
  return (id) => {
    if (!root || typeof id !== "string" || !id) return null;
    if (!index) build();
    return index.get(id) ?? null;
  };
}

function recordSummary(value, locate) {
  const summary = {};
  for (const [key, field] of Object.entries(value)) {
    if (!scalar(field) || field === null) continue;
    if (RECORD_FIELDS.has(key) || HASH_KEY.test(key)) summary[key] = typeof field === "string" ? clip(field) : field;
    else if (PATH_KEY.test(key) && sdlcRef(field)) summary.ref = sdlcRef(field);
  }
  if (!summary.ref && typeof value.id === "string") {
    const located = locate(value.id);
    if (located) summary.ref = `rec:${located}`;
  }
  return sorted(summary);
}

function textList(value) {
  return value.slice(0, MAX_LIST).map((item) => (isRecord(item) ? clip(item.message ?? item.code ?? item.reason ?? JSON.stringify(item)) : clip(item)));
}

export function compactJsonPayload(payload, { locate = () => null } = {}) {
  if (!isRecord(payload)) return payload;
  const result = { profile: AGENT_JSON_PROFILE };
  const ids = {};
  const hashes = {};
  const records = {};
  const refs = new Set();
  const omitted = [];
  const decision = isRecord(payload.human_guidance) ? String(payload.human_guidance.required_decision ?? "").trim() : "";
  // A person must decide: the message written for them stays, so the agent can show it.
  const personDecides = (Array.isArray(payload.approval_requests) && payload.approval_requests.length > 0)
    || (decision !== "" && !NOTHING_TO_DECIDE.test(decision));
  for (const [key, value] of Object.entries(payload)) {
    if (key === "correlation_id" || key === "status") {
      result[key] = value;
    } else if (key === "assistant_message" && personDecides && typeof value === "string") {
      result.assistant_message = value;
    } else if (DROPPED.has(key)) {
      omitted.push(key);
    } else if (key === "human_guidance" && isRecord(value)) {
      if (value.result) result.outcome = clip(value.result);
      if (value.next_action) result.next = clip(value.next_action);
      if (personDecides && decision) result.decide = clip(decision);
      omitted.push(key);
    } else if (["errors", "warnings", "human_blockers", "blockers"].includes(key) && Array.isArray(value)) {
      if (value.length > 0) result[key] = textList(value);
      if (value.length > MAX_LIST) omitted.push(`${key}[${MAX_LIST}:]`);
    } else if (key === "error") {
      result.error = isRecord(value) ? sorted(Object.fromEntries(Object.entries(value).filter(([, field]) => scalar(field)).map(([name, field]) => [name, typeof field === "string" ? clip(field) : field]))) : clip(value);
    } else if (["next", "next_action", "next_command", "suggested_command"].includes(key) && scalar(value)) {
      result.next = typeof value === "string" ? clip(value) : value;
    } else if (scalar(value)) {
      if (value === null) continue;
      if (ID_KEY.test(key)) ids[key] = value;
      else if (HASH_KEY.test(key)) hashes[key] = value;
      else if (PATH_KEY.test(key) && sdlcRef(value)) refs.add(sdlcRef(value));
      else if (typeof value === "boolean" || typeof value === "number") result[key] = value;
      else if (String(value).length <= 80) result[key] = value;
      else omitted.push(key);
    } else if (Array.isArray(value)) {
      if (value.every((item) => typeof item === "string" && item.length <= 120) && ID_KEY.test(key)) ids[key] = value.slice(0, MAX_LIST * 4);
      else {
        const itemIds = value.filter(isRecord).map((item) => item.id).filter((id) => typeof id === "string");
        if (itemIds.length > 0) ids[key] = itemIds.slice(0, MAX_LIST * 4);
        else if (value.length > 0) omitted.push(key);
      }
    } else if (isRecord(value)) {
      const summary = recordSummary(value, locate);
      if (Object.keys(summary).length > 0) records[key] = summary;
      else omitted.push(key);
    }
  }
  if (Object.keys(ids).length > 0) result.ids = sorted(ids);
  if (Object.keys(hashes).length > 0) result.hashes = sorted(hashes);
  if (Object.keys(records).length > 0) result.records = sorted(records);
  if (refs.size > 0) result.refs = [...refs].sort().map((ref) => `context get ${ref}`);
  if (omitted.length > 0) {
    result.omitted = omitted.sort();
    result.full = FULL_HINT;
  }
  return sorted(result);
}
