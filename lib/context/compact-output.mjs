import { runsInsideAgentHost } from "../agent-host.mjs";
import { compactJsonPayload, createRecordLocator } from "./compact-json.mjs";
import { estimateTokens, resolveContextPolicy } from "./policy.mjs";

/**
 * Compact form of the human text output, meant for agents: outcome, next
 * step, decision (only when one is needed), summary and the most useful
 * technical details. Pure and deterministic.
 */
const MODES = ["compact", "full"];
const OUTCOME = /^(?:Outcome|Risultato): ?(.*)$/u;
const IMPACT = /^(?:What this changes in practice|Cosa cambia in pratica): ?/u;
const DECISION = /^(?:What you need to decide|Cosa devi decidere): ?(.*)$/u;
const PROTECTED = /^(?:What remains protected|Cosa resta protetto): ?/u;
const NEXT = /^(?:Next step|Prossimo passo): ?(.*)$/u;
const DETAILS_HEADER = /^(?:Technical details \(optional\)|Dettagli tecnici \(facoltativi\)):\s*$/u;
const CORRELATION = /^-?\s*(?:Correlation ID|ID correlazione):/iu;
const NOTHING_TO_DECIDE = /^(?:no |nothing|none|you do not|there is nothing|non (?:devi|serve|c'è)|nessun)/iu;
const PRIORITY_DETAIL = /error|errore|fail|blocked|bloccat|refus|rifiut|denied|agentic-sdlc |mpsf |--[a-z]/iu;
const ID_TOKEN = /\b[A-Z][A-Z0-9]{1,}-[A-Z0-9][A-Z0-9._-]*\b/u;

let projectConfig = null;
let projectRoot = null;
let locator = null;

export function setOutputProjectConfig(config, root = null) {
  projectConfig = config && typeof config === "object" ? config : null;
  projectRoot = root ? String(root) : null;
  locator = null;
}

export function resolveOutputMode({ options = {}, env = process.env, policy } = {}) {
  if (options?.verbose === true) return "full";
  if (options?.compact === true) return "compact";
  const fromEnv = String(env?.AGENTIC_SDLC_OUTPUT ?? "").trim().toLowerCase();
  if (MODES.includes(fromEnv)) return fromEnv;
  const mode = policy?.output?.mode;
  if (MODES.includes(mode)) return mode;
  return runsInsideAgentHost(env) ? "compact" : "full";
}

function selectDetails(details) {
  const priority = details.filter((line) => PRIORITY_DETAIL.test(line) || ID_TOKEN.test(line));
  const rest = details.filter((line) => !(PRIORITY_DETAIL.test(line) || ID_TOKEN.test(line)));
  return [...priority, ...rest];
}

export function compactGuidanceLines(lines, { maxDetailLines = 6, maxTokens = 300 } = {}) {
  const input = Array.isArray(lines) ? lines.map((line) => String(line)) : [];
  const outcomeIndex = input.findIndex((line) => OUTCOME.test(line));
  if (outcomeIndex < 0) return input;
  const headerIndex = input.findIndex((line) => DETAILS_HEADER.test(line));
  const head = headerIndex < 0 ? input : input.slice(0, headerIndex);
  const tail = headerIndex < 0 ? [] : input.slice(headerIndex + 1);

  let outcome = "";
  let next = "";
  let decision = "";
  const summary = [];
  for (const line of head) {
    let match;
    if ((match = OUTCOME.exec(line))) outcome = match[1].trim();
    else if ((match = NEXT.exec(line))) next = match[1].trim();
    else if ((match = DECISION.exec(line))) decision = match[1].trim();
    else if (IMPACT.test(line) || PROTECTED.test(line)) continue;
    else if (line.trim()) summary.push(line.trim());
  }
  const details = tail
    .map((line) => line.trim())
    .filter((line) => line && !CORRELATION.test(line))
    .map((line) => line.replace(/^- ?/u, ""))
    .filter(Boolean);

  const fixed = [outcome];
  if (next) fixed.push(`next: ${next}`);
  if (decision && !NOTHING_TO_DECIDE.test(decision)) fixed.push(`decide: ${decision}`);
  fixed.push(...summary);

  const selected = selectDetails(details);
  const build = (count) => {
    const kept = selected.slice(0, count).map((line) => `- ${line}`);
    const dropped = selected.length - count;
    return [...fixed, ...kept, ...(dropped > 0 ? [`… ${dropped} more: --verbose`] : [])];
  };
  let count = Math.min(selected.length, Math.max(0, maxDetailLines));
  let result = build(count);
  while (count > 0 && estimateTokens(result.join("\n")) > maxTokens) {
    count -= 1;
    result = build(count);
  }
  return result;
}

/** True when this run prints the agent form (flags, environment, project policy, agent host). */
export function compactOutputRequested(options = {}, env = process.env) {
  return resolveOutputMode({ options, env, policy: resolveContextPolicy(projectConfig) }) === "compact";
}

/** The agent form of rendered guidance lines, within the project's output budget. */
export function compactOutputLines(lines) {
  const policy = resolveContextPolicy(projectConfig);
  return compactGuidanceLines(lines, { maxDetailLines: policy.output.max_detail_lines, maxTokens: policy.output.max_tokens });
}

/**
 * JSON profile of this run: --json-profile, then --verbose/--compact,
 * AGENTIC_SDLC_JSON_PROFILE, AGENTIC_SDLC_OUTPUT (compact -> agent),
 * host_policy.context.output.json_profile; "auto" is the agent profile
 * inside an agent host. Internal callers that parse the payload pass
 * --json-profile full.
 */
export function resolveJsonProfile({ options = {}, env = process.env, policy } = {}) {
  const requested = String(options?.["json-profile"] ?? "").trim().toLowerCase();
  if (requested === "agent" || requested === "full") return requested;
  if (options?.verbose === true) return "full";
  if (options?.compact === true) return "agent";
  const fromEnv = String(env?.AGENTIC_SDLC_JSON_PROFILE ?? "").trim().toLowerCase();
  if (fromEnv === "agent" || fromEnv === "full") return fromEnv;
  const output = String(env?.AGENTIC_SDLC_OUTPUT ?? "").trim().toLowerCase();
  if (output === "compact") return "agent";
  if (output === "full") return "full";
  const mode = policy?.output?.json_profile;
  if (mode === "agent" || mode === "full") return mode;
  return runsInsideAgentHost(env) ? "agent" : "full";
}

/** The payload to print for --json: the agent profile or the payload unchanged. */
export function jsonPayloadForOutput(payload, options = {}, env = process.env) {
  if (resolveJsonProfile({ options, env, policy: resolveContextPolicy(projectConfig) }) !== "agent") return payload;
  if (!locator) locator = createRecordLocator(projectRoot);
  return compactJsonPayload(payload, { locate: locator });
}
