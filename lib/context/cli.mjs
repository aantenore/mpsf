import { UserError } from "../cli/user-error.mjs";
import { alreadyDelivered, budgetState, cappedBudget, chargeUsage, listUsage, readBudget, writeBudget } from "./budget.mjs";
import { estimateTokens, resolveContextPolicy } from "./policy.mjs";
import { buildContextPack, getContextRef } from "./service.mjs";

const DEFAULT_GET_BUDGET = 1500;

function requestedBudget(value, fallback) {
  if (value === undefined || value === null || value === true) return fallback;
  return value;
}

function exhaustedText(state) {
  return `Context budget of this session used up (${state.used}/${state.cap} tokens): nothing printed. `
    + "Work from what you already have, or raise the cap on this computer (agentic-sdlc context budget --set <tokens>, or AGENTIC_SDLC_CONTEXT_BUDGET).\n";
}

/**
 * Builds a pack within this session's remaining budget and charges it.
 * Returns { status: "ok"|"exhausted"|"unchanged", result?, text, tokens }.
 * With `dedupe`, a pack this session already received is not printed again.
 */
export function budgetedPack(context, { story, phase = null, budget = null, cache = true, pluginVersion = null, dedupe = false, trigger = null, env = process.env } = {}) {
  const state = budgetState(context.root, env);
  if (state.exhausted) return { status: "exhausted", text: exhaustedText(state), tokens: 0, state };
  const policy = resolveContextPolicy(context.config);
  const requested = requestedBudget(budget, policy.pack.budget_tokens);
  const full = buildContextPack(context, { story, phase, budget: requested, cache, pluginVersion });
  if (dedupe && alreadyDelivered(state, full.pack.pack_hash)) {
    const text = `Context pack ${full.pack.story_id} · ${full.pack.phase} unchanged (${String(full.pack.pack_hash).slice(0, 12)}), already given in this session: agentic-sdlc context pack --story ${full.pack.story_id} prints it again.\n`;
    chargeUsage(context.root, { kind: "pack", story: full.pack.story_id, tokens: estimateTokens(text), trigger }, env);
    return { status: "unchanged", result: full, text, tokens: estimateTokens(text), state };
  }
  // Rebuilt smaller only when it does not fit what the session has left.
  const result = state.remaining === null || full.pack.tokens <= state.remaining
    ? full
    : buildContextPack(context, { story, phase: full.pack.phase, budget: cappedBudget(requested, state), cache, pluginVersion });
  chargeUsage(context.root, { kind: "pack", story: result.pack.story_id, tokens: result.pack.tokens, packHash: full.pack.pack_hash, trigger }, env);
  return { status: "ok", result, text: result.text, tokens: result.pack.tokens, state };
}

/** `context pack --story <id> [--phase <p>] [--budget <tokens>] [--json]` */
export function contextPackCommand(context, options, { pluginVersion = null, env = process.env } = {}) {
  if (!options.story) throw new UserError("context pack needs --story <story-id>.");
  const outcome = budgetedPack(context, {
    story: options.story,
    phase: options.phase ? String(options.phase) : null,
    budget: options.budget,
    cache: options["no-cache"] !== true,
    pluginVersion,
    env,
  });
  if (outcome.status === "exhausted") {
    if (options.json === true) console.log(JSON.stringify({ status: "budget_exhausted", cap_tokens: outcome.state.cap, used_tokens: outcome.state.used }, null, 2));
    else process.stdout.write(outcome.text);
    return outcome;
  }
  const { result } = outcome;
  if (options.json === true) {
    console.log(JSON.stringify({
      status: "ok",
      cache: result.cache,
      source_files: result.source_files,
      source_tokens: result.source_tokens,
      pack_tokens: result.pack.tokens,
      ...(outcome.state.cap !== null ? { session_budget: { cap_tokens: outcome.state.cap, used_tokens: outcome.state.used + outcome.tokens } } : {}),
      pack: result.pack,
    }, null, 2));
  } else {
    process.stdout.write(result.text);
  }
  return result;
}

/** `context get <ref> [--budget <tokens>]` */
export function contextGetCommand(context, options, args = [], { env = process.env } = {}) {
  const ref = options.ref ?? args[0];
  if (!ref || args.length > 1) throw new UserError("context get needs exactly one ref, as printed by context pack (sec:..., rec:..., trace:...).");
  const state = budgetState(context.root, env);
  if (state.exhausted) {
    if (options.json === true) console.log(JSON.stringify({ status: "budget_exhausted", ref, cap_tokens: state.cap, used_tokens: state.used }, null, 2));
    else process.stdout.write(exhaustedText(state));
    return { ref, text: "" };
  }
  const requested = requestedBudget(options.budget, DEFAULT_GET_BUDGET);
  const budget = state.remaining === null ? options.budget : cappedBudget(Number(requested), state);
  const result = getContextRef(context, ref, { budget });
  chargeUsage(context.root, { kind: "get", ref: String(ref), tokens: estimateTokens(result.text) }, env);
  if (options.json === true) console.log(JSON.stringify({ status: "ok", ref: result.ref, text: result.text }, null, 2));
  else process.stdout.write(result.text);
  return result;
}

/** `context budget [--set <tokens> | --clear] [--json]`: this computer's per-session cap and what the sessions used. */
export function contextBudgetCommand(context, options, { env = process.env } = {}) {
  if (options.set !== undefined && options.clear === true) throw new UserError("Use either --set or --clear.");
  if (options.set !== undefined) {
    const cap = Number(options.set);
    if (!Number.isInteger(cap) || cap < 0 || cap > 10_000_000) throw new UserError(`--set must be a whole number of tokens (0 removes the cap), got '${options.set}'.`);
    if (!writeBudget(context.root, cap === 0 ? null : cap)) throw new UserError("Could not save the budget: not inside a git clone.");
  } else if (options.clear === true) {
    writeBudget(context.root, null);
  }
  const { cap, source } = readBudget(context.root, env);
  const state = budgetState(context.root, env);
  const usage = listUsage(context.root, { env });
  const payload = { status: "ok", cap_tokens: cap, source, session: { used_tokens: state.used, remaining_tokens: state.remaining, packs: state.ledger.packs ?? 0, gets: state.ledger.gets ?? 0 }, sessions: usage.sessions };
  if (options.json === true) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }
  const lines = [
    cap === null ? "Context budget per session: no cap on this computer." : `Context budget per session: ${cap} tokens (${source === "env" ? "AGENTIC_SDLC_CONTEXT_BUDGET" : "local setting"}).`,
    `This session: ${state.used} tokens used${state.remaining === null ? "" : `, ${state.remaining} left`} (${payload.session.packs} packs, ${payload.session.gets} gets).`,
  ];
  if (usage.sessions.length > 1) lines.push(`Sessions in the last 24h on this clone: ${usage.sessions.length}, ${usage.sessions.reduce((sum, item) => sum + item.used, 0)} tokens in all.`);
  console.log(lines.join("\n"));
  return payload;
}
