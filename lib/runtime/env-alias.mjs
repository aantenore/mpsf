/**
 * Imported first by the hook entry and the CLI. Every MPSF_<NAME> variable is an alias of
 * AGENTIC_SDLC_<NAME>: when only the new name is set, the old name gets its value, so the code and
 * older plugin versions keep reading AGENTIC_SDLC_*. An explicit AGENTIC_SDLC_* value always wins.
 */
import { process } from "../runtime/host.mjs";

export const ENV_PREFIX = "AGENTIC_SDLC_";
export const ENV_ALIAS_PREFIX = "MPSF_";

export function applyEnvAliases(env = process.env) {
  for (const key of Object.keys(env)) {
    if (!key.startsWith(ENV_ALIAS_PREFIX) || key.length === ENV_ALIAS_PREFIX.length) continue;
    const target = ENV_PREFIX + key.slice(ENV_ALIAS_PREFIX.length);
    if (env[target] === undefined) env[target] = env[key];
  }
  return env;
}

applyEnvAliases();
