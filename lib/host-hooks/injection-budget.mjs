import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { estimateTokens, resolveContextPolicy } from "../context/policy.mjs";

/**
 * Keeps host-hook text small: lines already injected earlier in the same
 * session are dropped, the rest is capped by line count and token budget, and
 * a pointer tells the agent where to read the detail. The filter is pure; the
 * ledger of what a session already saw is a small file under the git common
 * directory.
 */
const DEFAULT_POINTER = "mpsf wait list";
const DEFAULT_BUDGET_TOKENS = 200;
const LEDGER_DIRECTORY = ["agentic-sdlc", "hook-ledger"];

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Record ids such as ST-12, KE-001 or REQ-CTX-3: their digits name a different subject. */
const RECORD_ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\b/gu;

/**
 * Normalized dedupe key: numbers (and how many of them a list holds) and
 * spacing do not make a line new, but a different record id does, so a wait
 * on another story is not suppressed as a repeat.
 */
export function injectionKey(line) {
  const text = String(line ?? "").trim().replace(/\s+/gu, " ");
  let normalized = "";
  let last = 0;
  for (const match of text.matchAll(RECORD_ID)) {
    normalized += maskNumbers(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  normalized = (normalized + maskNumbers(text.slice(last))).replace(/#(?:, ?#)+/gu, "#").toLowerCase();
  return sha256(normalized).slice(0, 16);
}

function maskNumbers(text) {
  return text.replace(/\d+/gu, "#");
}

function splitLines(text) {
  return String(text ?? "").split("\n").map((line) => line.replace(/\s+$/u, "")).filter((line) => line.trim() !== "");
}

function tokens(lines) {
  return estimateTokens(lines.join("\n"));
}

/**
 * @returns {{ text: string, keys: string[], stats: object }}
 */
export function filterInjection(text, { seen = new Set(), event = "", policy = resolveContextPolicy(), pointer = DEFAULT_POINTER } = {}) {
  const lines = splitLines(text);
  const hooks = policy.hooks;
  const budget = hooks.budget_tokens?.[event] ?? DEFAULT_BUDGET_TOKENS;
  const multi = lines.length > 1;
  // scope 0 is the first-line header; every ":" header opens a new scope.
  const entries = [];
  let scope = 0;
  lines.forEach((line, index) => {
    if (multi && index === 0) {
      entries.push({ line, header: true, scope: 0, first: true });
    } else if (line.endsWith(":")) {
      scope += 1;
      entries.push({ line, header: true, scope, first: false });
    } else {
      entries.push({ line, header: false, scope: index === 0 || scope === 0 ? 0 : scope, first: false, key: injectionKey(line) });
    }
  });
  let suppressed = 0;
  let content = entries.filter((entry) => {
    if (entry.header) return false;
    if (hooks.dedupe && seen.has(entry.key)) {
      suppressed += 1;
      return false;
    }
    return true;
  });
  const compose = (kept, marker) => {
    const keptSet = new Set(kept);
    const scopes = new Set(kept.map((entry) => entry.scope));
    const out = entries.filter((entry) => (entry.header ? (entry.first ? kept.length > 0 : scopes.has(entry.scope)) : keptSet.has(entry))).map((entry) => entry.line);
    if (marker > 0) out.push(`… ${marker} more: ${pointer}`);
    return out;
  };
  const total = content.length;
  const fits = (kept) => {
    const marker = total - kept.length;
    const out = compose(kept, marker);
    // The session's standing instructions are sent once per session: only the token budget caps them.
    return (event === "session_start" || out.length <= hooks.max_lines) && tokens(out) <= budget;
  };
  while (content.length > 0 && !fits(content)) content = content.slice(0, -1);
  const capped = total - content.length;
  const output = compose(content, capped);
  const keptEntries = new Set(content);
  const keys = [];
  for (const entry of entries) {
    if (entry.header ? output.includes(entry.line) : keptEntries.has(entry)) keys.push(entry.key ?? injectionKey(entry.line));
  }
  const outText = output.join("\n");
  return {
    text: outText,
    keys,
    stats: {
      input_lines: lines.length,
      output_lines: output.length,
      input_tokens: estimateTokens(lines.join("\n")),
      output_tokens: estimateTokens(outText),
      suppressed_lines: suppressed + capped,
    },
  };
}

export function ledgerPath(commonDir, sessionId) {
  return path.join(commonDir, ...LEDGER_DIRECTORY, `${sha256(String(sessionId)).slice(0, 24)}.json`);
}

export function readLedger(commonDir, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(commonDir, sessionId), "utf8"));
    return {
      keys: Array.isArray(parsed.keys) ? parsed.keys.filter((key) => typeof key === "string") : [],
      stats: parsed.stats && typeof parsed.stats === "object" ? parsed.stats : {},
    };
  } catch {
    return { keys: [], stats: {} };
  }
}

export function writeLedger(commonDir, sessionId, ledger, maxKeys = 500) {
  const file = ledgerPath(commonDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { keys: ledger.keys.slice(-maxKeys), stats: ledger.stats };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Removes ledgers not touched for `maxAgeDays`. Best effort. */
export function pruneLedgers(directory, maxAgeDays, now = Date.now()) {
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(directory, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeDays * 86_400_000) fs.rmSync(file, { force: true });
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}

export function hookInjectionStats(commonDir, sessionId) {
  if (!commonDir || !sessionId) return {};
  return readLedger(commonDir, sessionId).stats;
}

/**
 * Filters one hook's text against what the session already saw. Never throws:
 * on any internal error the text is filtered without a ledger.
 * `extraTokens` counts text sent outside the filter (for example a safety notice).
 */
export function applyInjectionBudget({ text, event, sessionId, commonDir, config = null, pointer = DEFAULT_POINTER, now = Date.now(), extraTokens = 0 }) {
  let policy;
  try {
    policy = resolveContextPolicy(config);
  } catch {
    return String(text ?? "");
  }
  try {
    if (!sessionId || !commonDir) return filterInjection(text, { event, policy, pointer }).text;
    const ledger = readLedger(commonDir, sessionId);
    const result = filterInjection(text, { seen: new Set(ledger.keys), event, policy, pointer });
    const previous = ledger.stats[event] ?? {};
    ledger.stats[event] = {
      injected_tokens: (previous.injected_tokens ?? 0) + result.stats.output_tokens + extraTokens,
      suppressed_lines: (previous.suppressed_lines ?? 0) + result.stats.suppressed_lines,
      calls: (previous.calls ?? 0) + 1,
    };
    const merged = ledger.keys.filter((key) => !result.keys.includes(key)).concat(result.keys);
    try {
      writeLedger(commonDir, sessionId, { keys: merged, stats: ledger.stats }, policy.hooks.ledger_max_keys);
      if (Math.abs(now) % 20 === 0) pruneLedgers(path.dirname(ledgerPath(commonDir, sessionId)), policy.hooks.ledger_max_age_days, now);
    } catch {
      // the ledger is an optimisation
    }
    return result.text;
  } catch {
    try {
      return filterInjection(text, { event, policy, pointer }).text;
    } catch {
      return String(text ?? "");
    }
  }
}

/**
 * Applies a text filter to the free-text fields of a hook output
 * (`systemMessage`, `hookSpecificOutput.additionalContext`) and nothing else:
 * `decision` and `reason` pass through untouched. Returns null when the
 * output ends up with nothing to say.
 */
export function filterHookOutput(output, filterText) {
  if (!output || typeof output !== "object") return output ?? null;
  const result = { ...output };
  if (typeof result.systemMessage === "string") {
    const text = filterText(result.systemMessage);
    if (text) result.systemMessage = text;
    else delete result.systemMessage;
  }
  if (result.hookSpecificOutput && typeof result.hookSpecificOutput.additionalContext === "string") {
    const text = filterText(result.hookSpecificOutput.additionalContext);
    if (text) result.hookSpecificOutput = { ...result.hookSpecificOutput, additionalContext: text };
    else delete result.hookSpecificOutput;
  }
  return Object.keys(result).length > 0 ? result : null;
}
