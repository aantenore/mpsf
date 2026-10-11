import path from "node:path";
import { fs, process } from "../runtime/host.mjs";
import { scanFiles } from "../secret-scan.mjs";

/**
 * Which adapter serves messaging and which serves the records, read from
 * `.sdlc/config.json` -> `host_policy.adapters`:
 *
 *   "adapters": {
 *     "messaging": { "provider": "github", "options": { ... } },
 *     "records":   { "provider": "git-sdlc", "options": { ... } }
 *   }
 *
 * Both sections are optional; without them the plugin behaves as before
 * (GitHub channel, `.sdlc/` folder in git). Options never hold a secret: a
 * credential is named by reference only, as an environment variable name in
 * a key ending with `_env` (for example "token_env": "TEAM_CHAT_TOKEN") or a
 * credential-store reference in a key ending with `_ref`. Anything that looks
 * like a credential in the options is refused.
 */
export const ADAPTER_PORTS = Object.freeze(["messaging", "records"]);
export const DEFAULT_ADAPTERS = Object.freeze({
  messaging: Object.freeze({ provider: "github", options: Object.freeze({}) }),
  records: Object.freeze({ provider: "git-sdlc", options: Object.freeze({}) }),
});
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|webhook|bearer|cookie)/iu;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9+.-]{0,31}:[A-Za-z0-9._/@:-]{1,200}$/u;
const MAX_OPTION_DEPTH = 4;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

export class AdapterConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdapterConfigError";
    this.code = "ADAPTER_CONFIG_INVALID";
  }
}

function invalid(message) {
  throw new AdapterConfigError(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkOptions(value, where, depth = 0) {
  if (depth > MAX_OPTION_DEPTH) invalid(`${where} is nested too deeply.`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkOptions(item, `${where}[${index}]`, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const at = `${where}.${key}`;
      if (SECRET_KEY_PATTERN.test(key)) {
        if (key.endsWith("_env")) {
          if (typeof item !== "string" || !ENV_NAME_PATTERN.test(item)) invalid(`${at} must name an environment variable (for example TEAM_CHAT_TOKEN), never hold the value.`);
          continue;
        }
        if (key.endsWith("_ref")) {
          if (typeof item !== "string" || !CREDENTIAL_REF_PATTERN.test(item)) invalid(`${at} must be a credential reference such as keychain:team-chat, never the value.`);
          continue;
        }
        invalid(`${at} looks like a credential. Name it by reference instead: ${key}_env (an environment variable name) or ${key}_ref (a credential-store reference).`);
      }
      checkOptions(item, at, depth + 1);
    }
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value !== "string") invalid(`${where} must be JSON data.`);
  const scan = scanFiles([{ path: where, content: value }]);
  if (scan.outcome !== "clean") invalid(`${where} looks like it contains a credential; adapter options are stored in the repository and must not.`);
}

/**
 * Validates one `host_policy.adapters.<port>` section and returns
 * `{ provider, options }`. `known` is the list of provider ids this plugin
 * version ships; an unknown id is refused (fail closed) rather than silently
 * replaced by the default.
 */
export function normalizeAdapterSection(port, section, { known = null, aliases = {} } = {}) {
  const where = `host_policy.adapters.${port}`;
  if (section === undefined || section === null) return { ...DEFAULT_ADAPTERS[port], options: {}, source: "default" };
  if (!isPlainObject(section)) invalid(`${where} must be an object with a provider id.`);
  for (const key of Object.keys(section)) {
    if (!["provider", "options", "principle"].includes(key)) invalid(`${where}.${key} is not a known setting.`);
  }
  const raw = String(section.provider ?? "").trim();
  if (!PROVIDER_ID_PATTERN.test(raw)) invalid(`${where}.provider must be a provider id such as ${DEFAULT_ADAPTERS[port].provider}.`);
  const provider = aliases[raw] ?? raw;
  if (Array.isArray(known) && !known.includes(provider)) {
    invalid(`${where}.provider '${raw}' is not supported by this plugin version (supported: ${known.join(", ")}).`);
  }
  const options = section.options === undefined ? {} : section.options;
  if (!isPlainObject(options)) invalid(`${where}.options must be an object.`);
  checkOptions(options, `${where}.options`);
  return { provider, options, source: "config" };
}

/** The `host_policy.adapters` section of a parsed project config, validated; defaults for what is absent. */
export function resolveAdapters(projectConfig, { known = {}, aliases = {} } = {}) {
  const adapters = projectConfig?.host_policy?.adapters;
  if (adapters !== undefined && !isPlainObject(adapters)) invalid("host_policy.adapters must be an object.");
  const result = {};
  for (const port of ADAPTER_PORTS) {
    result[port] = normalizeAdapterSection(port, adapters?.[port], { known: known[port] ?? null, aliases: aliases[port] ?? {} });
  }
  for (const key of Object.keys(adapters ?? {})) {
    if (!ADAPTER_PORTS.includes(key) && key !== "principle") invalid(`host_policy.adapters.${key} is not a known port (known: ${ADAPTER_PORTS.join(", ")}).`);
  }
  return result;
}

/** The parsed `.sdlc/config.json` of a project root, or null when missing or unreadable. */
export function readProjectConfig(root) {
  const file = path.join(String(root), ".sdlc", "config.json");
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The value of a credential an adapter option names by reference
 * (`<name>_env`), read from the environment at the moment of use. Returns
 * null when it is not set; the value is never stored or logged.
 */
export function resolveCredential(options, name, env = process.env) {
  const variable = options?.[`${name}_env`];
  if (typeof variable !== "string" || !ENV_NAME_PATTERN.test(variable)) return null;
  const value = env[variable];
  return typeof value === "string" && value.length > 0 ? value : null;
}
