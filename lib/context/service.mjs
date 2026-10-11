import fs from "node:fs";
import path from "node:path";

import { computeStableHash } from "../canonical.mjs";
import { UserError } from "../cli/user-error.mjs";
import { assemblePack, collectStoryFacts, defaultPackPhase, fullSectionText, PACK_BUILDER_REVISION, packPhases, renderPackText, SECTION_ORDER, trackedFiles } from "./pack.mjs";
import { estimateTokens, resolveContextPolicy } from "./policy.mjs";
import { openRecordStore } from "../adapters/records/registry.mjs";
import { createFsRecordReader, createRecordStoreReader, observationStillValid } from "./reader.mjs";
import { redactPackText, setContextSecretRules } from "./redact.mjs";
import { freshnessLine, freshState } from "../engine/fresh-state.mjs";

/**
 * Application service of the context module: builds (or reuses) a story's
 * context pack and resolves the refs a pack hands out. The cache under
 * .sdlc/cache/context/ is derived data: it is written only when the
 * project's cache folder is a derived (ignored) folder, and an entry is
 * reused only while every record it was built from is byte-identical and no
 * record appeared in the folders it listed.
 */
export const CONTEXT_CACHE_SCHEMA = "agentic-sdlc.context-cache.v1";
const CACHE_DIR = ["cache", "context"];
const DEFAULT_GET_BUDGET = 1500;
const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Reader factory of a project: the RecordStore port of the project (with the
 * filesystem reader as fallback for kinds the port does not address yet), or
 * the filesystem reader alone when no store can be opened.
 */
export function readerFactory(context) {
  let store = null;
  try {
    store = openRecordStore(context, { config: context.config ?? undefined });
  } catch {
    store = null;
  }
  return (root) => (store ? createRecordStoreReader(store, { fallback: createFsRecordReader(root) }) : createFsRecordReader(root));
}

function requireStoryId(value) {
  const storyId = String(value ?? "").trim();
  if (!STORY_ID.test(storyId)) throw new UserError(`Invalid story id '${value}'.`);
  return storyId;
}

function positiveBudget(value, fallback) {
  if (value === undefined || value === null || value === true) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 100 || number > 200_000) throw new UserError(`--budget must be a whole number of tokens between 100 and 200000 (got '${value}').`);
  return number;
}

function cacheEnabled(context) {
  const derived = new Set(context.config?.cache_policy?.derived_directories || ["cache", "indexes"]);
  return derived.has(CACHE_DIR[0]);
}

function cachePath(context, storyId, phaseKey, budget) {
  return path.join(context.sdlcRoot, ...CACHE_DIR, storyId, `${phaseKey}-${budget}.json`);
}

function readCache(file) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    return entry?.schema === CONTEXT_CACHE_SCHEMA ? entry : null;
  } catch {
    return null;
  }
}

function writeCache(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(entry)}\n`);
    fs.renameSync(temporary, file);
  } catch {
    // The cache is an optimisation; a failed write only means a rebuild next time.
  }
}

function sourceTokens(root, observed) {
  let bytes = 0;
  for (const file of Object.keys(observed.files)) {
    if (!file.startsWith(".sdlc/")) continue;
    try {
      bytes += fs.statSync(path.join(root, file)).size;
    } catch {
      // missing records count for nothing
    }
  }
  return Math.ceil(bytes / 4);
}

/** How far this checkout is behind the base branch (bounded, throttled fetch first); null when unknown. */
function readFreshness(context) {
  try {
    return freshState(context);
  } catch {
    return null;
  }
}

/**
 * Builds the context pack of one story. Returns
 * { pack, text, cache: "hit"|"miss"|"off", source_tokens, source_files, freshness }.
 * `freshness` (false to skip) adds the "N commits behind <base>" line to the
 * text; it never changes the pack or its hash.
 */
export function buildContextPack(context, { story, phase = null, budget = null, cache = true, pluginVersion = null, gitFiles = trackedFiles, freshness = true } = {}) {
  const storyId = requireStoryId(story);
  const policy = resolveContextPolicy(context.config);
  setContextSecretRules(context.config);
  const tokens = positiveBudget(budget, policy.pack.budget_tokens);
  const phases = packPhases(context.config, policy);
  if (phase && !phases.includes(phase)) throw new UserError(`Unknown phase '${phase}' for a context pack. Use one of: ${phases.join(", ")}.`);
  const base = freshness === false ? null : (freshness && typeof freshness === "object" ? freshness : readFreshness(context));
  const baseLine = freshnessLine(base);
  const createReader = readerFactory(context);
  const keyMaterial = { revision: PACK_BUILDER_REVISION, policy, pluginVersion, phases, reader: createReader(context.root).kind };
  const cacheKey = computeStableHash(keyMaterial);
  const useCache = cache && cacheEnabled(context);
  const file = cachePath(context, storyId, phase ?? "auto", tokens);
  if (useCache) {
    const entry = readCache(file);
    if (entry && entry.cache_key === cacheKey && observationStillValid(context.root, entry.observed, createReader)
      && (entry.scope_paths.length === 0 || gitFiles(context.root, entry.scope_paths).listing_hash === entry.listing_hash)) {
      return { pack: entry.pack, text: renderPackText(entry.pack, { baseLine }), cache: "hit", source_tokens: entry.source_tokens, source_files: Object.keys(entry.observed.files).length, freshness: base };
    }
  }
  const reader = createReader(context.root);
  const facts = collectStoryFacts(reader, { storyId, policy, root: context.root, gitFiles });
  if (!facts) throw new UserError(`Story ${storyId} has no record at .sdlc/stories/${storyId}/story.json.`);
  const resolvedPhase = phase ?? defaultPackPhase({ story: facts.story, next: facts.next, phases });
  const pack = assemblePack(facts, { storyId, phase: resolvedPhase, budget: tokens, policy, pluginVersion });
  const observed = reader.observed();
  const result = { pack, text: renderPackText(pack, { baseLine }), cache: useCache ? "miss" : "off", source_tokens: sourceTokens(context.root, observed), source_files: Object.keys(observed.files).length, freshness: base };
  if (useCache) {
    writeCache(file, {
      schema: CONTEXT_CACHE_SCHEMA,
      cache_key: cacheKey,
      observed,
      scope_paths: facts.scope.paths,
      listing_hash: facts.listing_hash,
      source_tokens: result.source_tokens,
      pack,
    });
  }
  return result;
}

function capText(text, budget, hint) {
  if (estimateTokens(text) <= budget) return text;
  const lines = text.split("\n");
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget - 20) break;
    kept.push(line);
    used += cost;
  }
  return `${kept.join("\n")}\n… truncated at ${budget} tokens (${lines.length - kept.length} more lines)${hint ? `: ${hint}` : ""}\n`;
}

function redactLines(text) {
  return text.split("\n").map((line) => redactPackText(line)).join("\n");
}

function resolvePointer(value, pointer) {
  if (!pointer) return value;
  let current = value;
  for (const raw of pointer.replace(/^\//u, "").split("/")) {
    const key = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) throw new UserError(`No value at #${pointer}.`);
    current = current[key];
  }
  return current;
}

function recordPath(context, relative) {
  const normalized = String(relative ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!normalized.startsWith(".sdlc/") || normalized.split("/").includes("..")) {
    throw new UserError(`context get reads only records under .sdlc/ (got '${relative}').`);
  }
  const absolute = path.resolve(context.root, normalized);
  if (!absolute.startsWith(`${path.resolve(context.sdlcRoot)}${path.sep}`)) throw new UserError(`context get reads only records under .sdlc/ (got '${relative}').`);
  return { normalized, absolute };
}

function keysHint(value, ref) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return `narrow with ${ref}#/<key>; keys: ${Object.keys(value).sort().slice(0, 20).join(", ")}`;
}

/**
 * Resolves one ref handed out by a pack:
 *   sec:<story>/<phase>/<section>      the full, untruncated section
 *   rec:<.sdlc path>[#/json/pointer]    one record (or part of it), redacted
 *   trace:<story id|project>#<event id> one trace event, redacted
 */
export function getContextRef(context, ref, { budget = null, gitFiles = trackedFiles } = {}) {
  const value = String(ref ?? "").trim();
  const limit = positiveBudget(budget, DEFAULT_GET_BUDGET);
  setContextSecretRules(context.config);
  const [scheme, ...rest] = value.split(":");
  const target = rest.join(":");
  if (scheme === "sec") {
    const [storyRaw, phase, section] = target.split("/");
    const storyId = requireStoryId(storyRaw);
    if (!SECTION_ORDER.includes(section)) throw new UserError(`Unknown section '${section}'. Use one of: ${SECTION_ORDER.join(", ")}.`);
    const policy = resolveContextPolicy(context.config);
    const facts = collectStoryFacts(readerFactory(context)(context.root), { storyId, policy: { ...policy, pack: { ...policy.pack, file_index_max_entries: 10_000, decisions: 10_000, test_runs: 50 } }, root: context.root, gitFiles });
    if (!facts) throw new UserError(`Story ${storyId} has no record.`);
    return { ref: value, text: capText(fullSectionText(facts, { storyId, phase, section }), limit, null) };
  }
  if (scheme === "rec") {
    const [file, pointer = ""] = target.split("#");
    const { normalized, absolute } = recordPath(context, file);
    let raw;
    try {
      raw = fs.readFileSync(absolute, "utf8");
    } catch {
      throw new UserError(`No record at ${normalized}.`);
    }
    if (!normalized.endsWith(".json")) {
      if (pointer) throw new UserError("A #pointer applies only to JSON records.");
      return { ref: value, text: capText(redactLines(raw), limit, null) };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new UserError(`${normalized} is not valid JSON.`);
    }
    const selected = resolvePointer(parsed, pointer);
    const text = typeof selected === "string" ? `${selected}\n` : `${JSON.stringify(selected, null, 2)}\n`;
    return { ref: value, text: capText(redactLines(text), limit, keysHint(selected, `rec:${normalized}`)) };
  }
  if (scheme === "trace") {
    const [scopeId, eventId] = target.split("#");
    if (!eventId) throw new UserError("A trace ref needs #<event id>.");
    // trace:<story id or "project">#<event id> names the trace file of that story (or the project trace).
    const file = scopeId.includes("/") ? scopeId : `.sdlc/traces/${requireStoryId(scopeId)}.jsonl`;
    const { normalized, absolute } = recordPath(context, file);
    let found = null;
    let raw = "";
    try {
      raw = fs.readFileSync(absolute, "utf8");
    } catch {
      throw new UserError(`No trace at ${normalized}.`);
    }
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.includes(eventId)) continue;
      try {
        const event = JSON.parse(line);
        if (event?.id === eventId) {
          const { _trace_integrity: _integrity, ...rest } = event;
          found = rest;
          break;
        }
      } catch {
        // skip malformed lines
      }
    }
    if (!found) throw new UserError(`No event ${eventId} in ${normalized}.`);
    return { ref: value, text: capText(redactLines(`${JSON.stringify(found, null, 2)}\n`), limit, null) };
  }
  throw new UserError(`Unknown ref '${value}'. Refs start with sec:, rec: or trace: (as printed by context pack).`);
}
