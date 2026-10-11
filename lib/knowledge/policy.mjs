import path from "node:path";
import { fileURLToPath } from "node:url";
import { fs } from "../runtime/host.mjs";

/**
 * Effective knowledge policy: the plugin defaults (config/knowledge.json)
 * overridden by `host_policy.knowledge` in the project configuration.
 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const KNOWLEDGE_DEFAULTS_FILE = path.join(PLUGIN_ROOT, "config", "knowledge.json");
export const KNOWLEDGE_SOURCES = Object.freeze(["known_errors", "gates", "fix_stories", "channel_answers"]);

let cachedDefaults = null;

export function knowledgeDefaults() {
  if (!cachedDefaults) {
    try {
      cachedDefaults = JSON.parse(fs.readFileSync(KNOWLEDGE_DEFAULTS_FILE, "utf8"));
    } catch {
      cachedDefaults = {};
    }
  }
  return cachedDefaults;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function resolveKnowledgePolicy(config = null, defaults = knowledgeDefaults()) {
  const own = object(config?.host_policy?.knowledge);
  const base = object(defaults);
  const pick = (key, fallback) => positiveInt(own[key], positiveInt(base[key], fallback));
  const sources = {};
  for (const source of KNOWLEDGE_SOURCES) sources[source] = (object(own.sources)[source] ?? object(base.sources)[source]) !== false;
  return Object.freeze({
    enabled: (own.enabled ?? base.enabled) !== false,
    min_occurrences: pick("min_occurrences", 2),
    pack_entries: pick("pack_entries", 6),
    summary_max_chars: pick("summary_max_chars", 400),
    sources: Object.freeze(sources),
  });
}
