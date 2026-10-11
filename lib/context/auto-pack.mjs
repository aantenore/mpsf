import { runsInsideAgentHost } from "../agent-host.mjs";
import { budgetedPack } from "./cli.mjs";

/**
 * The context pack handed to the agent when it claims a story or starts its
 * task: printed after the command's own output, inside an agent session
 * only (a person's terminal and --json output stay as they were), within the
 * session's budget, and only once per session while the pack is unchanged.
 * AGENTIC_SDLC_CONTEXT_PACK=off turns it off. Never fails the command.
 */
export const AUTO_PACK_ENV = "AGENTIC_SDLC_CONTEXT_PACK";
const OFF = new Set(["0", "false", "no", "off", "disabled"]);

export function autoPackEnabled(env = process.env) {
  return runsInsideAgentHost(env) && !OFF.has(String(env[AUTO_PACK_ENV] ?? "").trim().toLowerCase());
}

export function autoContextPack(context, storyId, { trigger, options = {}, pluginVersion = null, env = process.env, write = (text) => process.stdout.write(text) } = {}) {
  if (!storyId || options.json === true || !autoPackEnabled(env)) return null;
  try {
    const outcome = budgetedPack(context, { story: String(storyId), pluginVersion, dedupe: true, trigger, env });
    write(outcome.text);
    return outcome.status;
  } catch {
    return null;
  }
}
