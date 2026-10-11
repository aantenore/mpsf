import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Effective context policy: the plugin defaults (config/context.json)
 * overridden by `host_policy.context` in the project configuration. Every
 * budget is in estimated tokens (see estimateTokens).
 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONTEXT_DEFAULTS_FILE = path.join(PLUGIN_ROOT, "config", "context.json");
export const OUTPUT_MODES = Object.freeze(["auto", "compact", "full"]);

let cachedDefaults = null;

export function contextDefaults() {
  if (!cachedDefaults) {
    try {
      cachedDefaults = JSON.parse(fs.readFileSync(CONTEXT_DEFAULTS_FILE, "utf8"));
    } catch {
      cachedDefaults = {};
    }
  }
  return cachedDefaults;
}

/** Rough, deterministic token estimate: four characters per token, rounded up. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function weights(own, fallback) {
  const source = Object.keys(object(own)).length > 0 ? object(own) : object(fallback);
  const result = {};
  for (const [section, weight] of Object.entries(source)) {
    const number = Number(weight);
    if (Number.isFinite(number) && number > 0) result[section] = number;
  }
  return result;
}

export function resolveContextPolicy(config = null, defaults = contextDefaults()) {
  const own = object(config?.host_policy?.context);
  const ownOutput = object(own.output);
  const ownHooks = object(own.hooks);
  const ownPack = object(own.pack);
  const base = object(defaults);
  const baseOutput = object(base.output);
  const baseHooks = object(base.hooks);
  const basePack = object(base.pack);
  const mode = [ownOutput.mode, baseOutput.mode].find((value) => OUTPUT_MODES.includes(value)) ?? "auto";
  const hookBudgets = {};
  for (const event of new Set([...Object.keys(object(baseHooks.budget_tokens)), ...Object.keys(object(ownHooks.budget_tokens))])) {
    hookBudgets[event] = positiveInt(object(ownHooks.budget_tokens)[event], positiveInt(object(baseHooks.budget_tokens)[event], 200));
  }
  const phaseSections = {};
  const phases = new Set([...Object.keys(object(basePack.phase_sections)), ...Object.keys(object(ownPack.phase_sections))]);
  for (const phase of [...phases].sort()) {
    phaseSections[phase] = weights(object(ownPack.phase_sections)[phase], object(basePack.phase_sections)[phase]);
  }
  return Object.freeze({
    output: Object.freeze({
      mode,
      max_tokens: positiveInt(ownOutput.max_tokens, positiveInt(baseOutput.max_tokens, 300)),
      max_detail_lines: positiveInt(ownOutput.max_detail_lines, positiveInt(baseOutput.max_detail_lines, 6)),
    }),
    hooks: Object.freeze({
      dedupe: (ownHooks.dedupe ?? baseHooks.dedupe) !== false,
      max_lines: positiveInt(ownHooks.max_lines, positiveInt(baseHooks.max_lines, 12)),
      ledger_max_keys: positiveInt(ownHooks.ledger_max_keys, positiveInt(baseHooks.ledger_max_keys, 500)),
      ledger_max_age_days: positiveInt(ownHooks.ledger_max_age_days, positiveInt(baseHooks.ledger_max_age_days, 7)),
      budget_tokens: Object.freeze(hookBudgets),
    }),
    pack: Object.freeze({
      budget_tokens: positiveInt(ownPack.budget_tokens, positiveInt(basePack.budget_tokens, 2000)),
      file_index_max_entries: positiveInt(ownPack.file_index_max_entries, positiveInt(basePack.file_index_max_entries, 40)),
      symbols_per_file: positiveInt(ownPack.symbols_per_file, positiveInt(basePack.symbols_per_file, 8)),
      test_runs: positiveInt(ownPack.test_runs, positiveInt(basePack.test_runs, 3)),
      decisions: positiveInt(ownPack.decisions, positiveInt(basePack.decisions, 8)),
      phase_sections: Object.freeze(phaseSections),
    }),
  });
}
