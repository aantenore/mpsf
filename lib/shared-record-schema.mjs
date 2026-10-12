import path from "node:path";
import { fileURLToPath } from "node:url";
import { fs } from "./runtime/host.mjs";
import { validateAgainstSchema } from "./json-schema-validator.mjs";

/**
 * Schema check of a record read back from the project (written on any
 * computer, merged with a pull). Top-level fields the schema does not know
 * are ignored, so a record from a newer plugin that added one still counts;
 * everything the schema describes must hold.
 */
const SCHEMA_DIR = fileURLToPath(new URL("../schemas", import.meta.url));
const cache = new Map();
const topLevel = new Map();

function knownTopLevel(schemaName) {
  if (!topLevel.has(schemaName)) {
    let keys = null;
    try {
      const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, schemaName), "utf8"));
      keys = schema.additionalProperties === false && schema.properties ? new Set(Object.keys(schema.properties)) : null;
    } catch {
      keys = null;
    }
    topLevel.set(schemaName, keys);
  }
  return topLevel.get(schemaName);
}

export function sharedRecordValid(record, schemaName) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const keys = knownTopLevel(schemaName);
  const value = keys ? Object.fromEntries(Object.entries(record).filter(([key]) => keys.has(key))) : record;
  try {
    return validateAgainstSchema(value, schemaName, { schemaDir: SCHEMA_DIR, cache }).valid;
  } catch {
    return false;
  }
}
