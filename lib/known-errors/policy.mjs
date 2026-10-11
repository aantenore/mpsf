import path from "node:path";
import { fileURLToPath } from "node:url";
import { fs } from "../runtime/host.mjs";

/**
 * Effective known error policy: the plugin defaults (config/known-errors.json)
 * overridden by `host_policy.known_errors` in the project configuration.
 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const KNOWN_ERRORS_DEFAULTS_FILE = path.join(PLUGIN_ROOT, "config", "known-errors.json");

let cachedDefaults = null;

export function knownErrorsDefaults() {
  if (!cachedDefaults) {
    try {
      cachedDefaults = JSON.parse(fs.readFileSync(KNOWN_ERRORS_DEFAULTS_FILE, "utf8"));
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

export function resolveKnownErrorsPolicy(config = null, defaults = knownErrorsDefaults()) {
  const own = object(config?.host_policy?.known_errors);
  const base = object(defaults);
  const pick = (key, fallback) => positiveInt(own[key], positiveInt(base[key], fallback));
  return Object.freeze({
    enabled: (own.enabled ?? base.enabled) !== false,
    stale_after_days: pick("stale_after_days", 90),
    max_suggestions: pick("max_suggestions", 3),
    max_failures_per_run: pick("max_failures_per_run", 5),
    last_failures_kept: pick("last_failures_kept", 10),
    message_max_chars: pick("message_max_chars", 400),
  });
}
