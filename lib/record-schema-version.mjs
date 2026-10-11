import { fs } from "./runtime/host.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Format version of the JSON records under .sdlc (and the sdlc-state branch).
 *
 * Records name their format in `schema_version`, written in one of these ways:
 * - "<kind>:v<N>" (most records) or "<prefix>.<kind>.v<N>";
 * - the project config's version (story, contract, gate records): format 1;
 * - a positive integer;
 * - nothing (records written before the field existed): format 1.
 *
 * The highest format this plugin understands for each kind comes from the
 * bundled schemas, so a new format only needs its schema: no list to keep.
 * Older plugins ignore the field on records whose schema allows extra keys;
 * records with strict schemas already carried it.
 */
const SCHEMA_DIR = fileURLToPath(new URL("../schemas", import.meta.url));
const TAGGED = /^(?<kind>[A-Za-z0-9][A-Za-z0-9_.-]*?)[:.]v(?<version>[1-9][0-9]*)$/u;
const PROJECT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+].*)?$/u;

export const LEGACY_RECORD_SCHEMA_VERSION = 1;
export const CLAIM_SCHEMA_VERSION = "claim:v1";

/** Kind and format version of a record; `version` is null when unreadable. */
export function parseRecordSchemaVersion(record) {
  const raw = record && typeof record === "object" ? record.schema_version : undefined;
  if (raw === undefined || raw === null || raw === "") {
    return { kind: null, version: LEGACY_RECORD_SCHEMA_VERSION, legacy: true };
  }
  if (Number.isInteger(raw)) return { kind: null, version: raw >= 1 ? raw : null, legacy: false };
  if (typeof raw !== "string") return { kind: null, version: null, legacy: false };
  const tagged = TAGGED.exec(raw);
  if (tagged) return { kind: tagged.groups.kind, version: Number(tagged.groups.version), legacy: false };
  if (PROJECT_VERSION.test(raw)) return { kind: null, version: LEGACY_RECORD_SCHEMA_VERSION, legacy: false };
  return { kind: null, version: null, legacy: false };
}

/** Format version of a record: records without the field are version 1. */
export function recordSchemaVersion(record) {
  return parseRecordSchemaVersion(record).version;
}

let supportedCache = null;

function collectVersions(node, into) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectVersions(item, into);
    return;
  }
  const declared = node.properties?.schema_version;
  if (declared) {
    for (const value of [declared.const, ...(Array.isArray(declared.enum) ? declared.enum : [])]) {
      const tagged = typeof value === "string" ? TAGGED.exec(value) : null;
      if (!tagged) continue;
      const version = Number(tagged.groups.version);
      if (version > (into.get(tagged.groups.kind) ?? 0)) into.set(tagged.groups.kind, version);
    }
  }
  for (const value of Object.values(node)) collectVersions(value, into);
}

/** Highest format per kind found in the bundled schemas. */
export function supportedRecordSchemaVersions(schemaDir = SCHEMA_DIR) {
  if (schemaDir === SCHEMA_DIR && supportedCache) return supportedCache;
  const versions = new Map();
  let names = [];
  try {
    names = fs.readdirSync(schemaDir).filter((name) => name.endsWith(".schema.json"));
  } catch {
    names = [];
  }
  for (const name of names) {
    try {
      collectVersions(JSON.parse(fs.readFileSync(path.join(schemaDir, name), "utf8")), versions);
    } catch {
      // An unreadable schema only narrows what is known.
    }
  }
  if (schemaDir === SCHEMA_DIR) supportedCache = versions;
  return versions;
}

/**
 * How this plugin relates to a record's format. `newer` means a later plugin
 * wrote it: read it tolerantly and suggest updating. `kind` names the record
 * type for untagged records (story, claim, ...); it defaults to the tag.
 */
export function checkRecordSchemaVersion(record, { kind = null, supported = supportedRecordSchemaVersions() } = {}) {
  const parsed = parseRecordSchemaVersion(record);
  const recordKind = parsed.kind ?? kind;
  // A tag no bundled schema declares is written and read by code alone:
  // nothing here can tell whether it is newer.
  const max = parsed.kind
    ? supported.get(parsed.kind) ?? null
    : supported.get(recordKind) ?? LEGACY_RECORD_SCHEMA_VERSION;
  return {
    kind: recordKind,
    version: parsed.version,
    supported: max,
    legacy: parsed.legacy,
    unreadable: parsed.version === null,
    newer: parsed.version !== null && max !== null && parsed.version > max,
  };
}

/** Adds "<kind>:v<N>" to a record that has no schema_version yet. */
export function stampRecordSchemaVersion(record, kind, version = LEGACY_RECORD_SCHEMA_VERSION) {
  if (!record || typeof record !== "object" || record.schema_version !== undefined) return record;
  return { schema_version: `${kind}:v${version}`, ...record };
}
