import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { agentHostEnvValue, detectAgentHost } from "../agent-host.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";

/**
 * Context budget of one worker. It belongs to the worker, never to a shared
 * role: the cap is a local setting of this computer (AGENTIC_SDLC_CONTEXT_BUDGET,
 * else `context budget --set`, kept under the git common directory and never
 * published), and it applies per agent session to what `context pack` and
 * `context get` put in front of the agent. Without a cap nothing is limited,
 * as before; the consumption is tracked either way, so the Change
 * Observatory can show it.
 *
 *   <git common dir>/agentic-sdlc/context-budget.json        { session_tokens }
 *   <git common dir>/agentic-sdlc/context-usage/<hash>.json   one ledger per session
 */
export const CONTEXT_BUDGET_ENV = "AGENTIC_SDLC_CONTEXT_BUDGET";
export const CONTEXT_SESSION_ENV = "AGENTIC_SDLC_SESSION_ID";
export const USAGE_SCHEMA = "agentic-sdlc.context-usage.v1";
export const MIN_USEFUL_TOKENS = 100;
const BUDGET_FILE = ["agentic-sdlc", "context-budget.json"];
const USAGE_DIR = ["agentic-sdlc", "context-usage"];
const KEEP_DELIVERED = 50;
const KEEP_CALLS = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sha(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

function tokensOf(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/** The agent session this process runs in: the host's session id, else AGENTIC_SDLC_SESSION_ID, else "terminal". */
export function contextSessionId(env = process.env) {
  try {
    const value = agentHostEnvValue(detectAgentHost(env), "session_id", env);
    if (value) return value;
  } catch {
    // An invalid host override only means no host session id.
  }
  return String(env[CONTEXT_SESSION_ENV] ?? "").trim() || "terminal";
}

function commonDir(root) {
  try {
    return findGitCommonDir(root);
  } catch {
    return null;
  }
}

export function budgetFilePath(root) {
  const common = commonDir(root);
  return common ? path.join(common, ...BUDGET_FILE) : null;
}

export function usageDirPath(root) {
  const common = commonDir(root);
  return common ? path.join(common, ...USAGE_DIR) : null;
}

/** { cap: tokens per session or null (no cap), source: "env"|"local"|null } */
export function readBudget(root, env = process.env) {
  const fromEnv = String(env[CONTEXT_BUDGET_ENV] ?? "").trim();
  if (fromEnv !== "") {
    const cap = tokensOf(fromEnv);
    return { cap: cap > 0 ? cap : null, source: "env" };
  }
  const file = budgetFilePath(root);
  const cap = tokensOf(file ? readJson(file)?.session_tokens : null);
  return { cap: cap > 0 ? cap : null, source: cap > 0 ? "local" : null };
}

/** Sets (or with null clears) this computer's per-session cap. */
export function writeBudget(root, cap) {
  const file = budgetFilePath(root);
  if (!file) return false;
  if (cap === null) {
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  return writeJson(file, { session_tokens: cap, updated_at: new Date().toISOString() });
}

function ledgerPath(root, session) {
  const dir = usageDirPath(root);
  return dir ? path.join(dir, `${sha(session).slice(0, 24)}.json`) : null;
}

export function readUsage(root, env = process.env) {
  const session = contextSessionId(env);
  const file = ledgerPath(root, session);
  const ledger = (file && readJson(file)) || null;
  return ledger?.schema === USAGE_SCHEMA
    ? ledger
    : { schema: USAGE_SCHEMA, session: sha(session).slice(0, 12), used_tokens: 0, packs: 0, gets: 0, delivered: {}, calls: [] };
}

/** { cap, used, remaining (null without a cap), exhausted } for this session. */
export function budgetState(root, env = process.env) {
  const { cap, source } = readBudget(root, env);
  const ledger = readUsage(root, env);
  const used = Number(ledger.used_tokens) || 0;
  const remaining = cap === null ? null : Math.max(0, cap - used);
  return { cap, source, used, remaining, exhausted: remaining !== null && remaining < MIN_USEFUL_TOKENS, ledger };
}

/** The budget a call may use: the requested one, lowered to what the session has left. */
export function cappedBudget(requested, state) {
  if (state.remaining === null || !Number.isInteger(Number(requested))) return requested;
  return Math.max(MIN_USEFUL_TOKENS, Math.min(Number(requested), state.remaining));
}

/** True when this session already received this exact pack. */
export function alreadyDelivered(state, packHash) {
  return Boolean(packHash && state.ledger.delivered?.[packHash]);
}

function prune(dir, keep) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (file === keep || !name.endsWith(".json")) continue;
      if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // Old ledgers are only clutter.
  }
}

/** Adds one call to this session's ledger. Never throws. */
export function chargeUsage(root, { kind, story = null, ref = null, tokens = 0, packHash = null, trigger = null }, env = process.env) {
  const session = contextSessionId(env);
  const file = ledgerPath(root, session);
  if (!file) return null;
  const ledger = readUsage(root, env);
  const at = new Date().toISOString();
  const { cap } = readBudget(root, env);
  ledger.host = detectAgentHostId(env);
  ledger.started_at ??= at;
  ledger.updated_at = at;
  ledger.cap_tokens = cap;
  ledger.used_tokens = (Number(ledger.used_tokens) || 0) + Math.max(0, Number(tokens) || 0);
  if (kind === "pack") ledger.packs = (Number(ledger.packs) || 0) + 1;
  if (kind === "get") ledger.gets = (Number(ledger.gets) || 0) + 1;
  if (packHash) {
    const delivered = { ...(ledger.delivered ?? {}), [packHash]: at };
    ledger.delivered = Object.fromEntries(Object.entries(delivered).sort(([, a], [, b]) => String(a).localeCompare(String(b))).slice(-KEEP_DELIVERED));
  }
  ledger.calls = [...(Array.isArray(ledger.calls) ? ledger.calls : []), { at, kind, story, ref, tokens, ...(trigger ? { trigger } : {}) }].slice(-KEEP_CALLS);
  writeJson(file, ledger);
  prune(path.dirname(file), file);
  return ledger;
}

function detectAgentHostId(env) {
  try {
    return detectAgentHost(env).id;
  } catch {
    return null;
  }
}

/** Every session ledger of this clone updated within `withinMs`, newest first (for the Observatory). */
export function listUsage(root, { now = Date.now(), withinMs = 24 * 60 * 60 * 1000, env = process.env } = {}) {
  const dir = usageDirPath(root);
  if (!dir) return { cap: readBudget(root, env).cap, sessions: [] };
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    names = [];
  }
  const sessions = names
    .map((name) => readJson(path.join(dir, name)))
    .filter((ledger) => ledger?.schema === USAGE_SCHEMA && now - (Date.parse(ledger.updated_at) || 0) <= withinMs)
    .map((ledger) => ({
      session: String(ledger.session ?? ""),
      host: ledger.host ?? null,
      cap: tokensOf(ledger.cap_tokens) || null,
      used: Number(ledger.used_tokens) || 0,
      packs: Number(ledger.packs) || 0,
      gets: Number(ledger.gets) || 0,
      started_at: ledger.started_at ?? null,
      updated_at: ledger.updated_at ?? null,
      last: Array.isArray(ledger.calls) ? ledger.calls.at(-1) ?? null : null,
    }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return { cap: readBudget(root, env).cap, sessions };
}
