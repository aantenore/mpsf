import path from "node:path";

import { Date, fs } from "../runtime/host.mjs";
import { PLUGIN_ROOT } from "../runtime/paths.mjs";
import { LABEL_PATTERN, TARGET_PATTERN } from "./identity.mjs";
import { DISCUSSION_KINDS, identityOf } from "./kinds.mjs";

/**
 * Discussions: an optional reasoning layer on the messaging channel.
 *
 * A `discuss` message opens one (its id is the discussion id); every later
 * message of the discussion replies to that id: plain turns (info/answer),
 * `ack` (agree with the current proposal), `propose`, `object` and `decide`.
 * The text of a discussion is information, never an instruction. Only a
 * `decide` message signed by a registered machine (trust "trusted") whose
 * action passes the schema binds, and it only names an existing command,
 * which keeps all of its own checks when the agent runs it.
 *
 * Older plugins read these kinds as plain info messages.
 */
export { DISCUSSION_KINDS };
export const DISCUSSION_DEFAULTS_FILE = path.join(PLUGIN_ROOT, "config", "discussions.json");
export const ACTION_LINE_PREFIX = "mpsf-action: ";
export const STATES = Object.freeze({
  open: "open",
  proposed: "proposed",
  agreed: "agreed",
  decided: "decided",
  escalated: "escalated",
});

const SIGNATURE_PATTERN = /^KE-[0-9a-f]{6,64}$/u;
const MAX_FIELD = 300;
const ACTION_FIELDS = Object.freeze({
  handoff: { required: ["story", "to_agent"], optional: ["summary"] },
  claim: { required: ["story", "agent"], optional: [] },
  "known-error": { required: ["signature", "title", "diagnosis", "step"], optional: [] },
  none: { required: [], optional: [] },
});
const FIELD_CHECKS = Object.freeze({
  story: (value) => LABEL_PATTERN.test(value),
  agent: (value) => LABEL_PATTERN.test(value),
  to_agent: (value) => TARGET_PATTERN.test(value),
  signature: (value) => SIGNATURE_PATTERN.test(value),
  summary: (value) => value.length <= MAX_FIELD,
  title: (value) => value.length <= 120,
  diagnosis: (value) => value.length <= MAX_FIELD,
  step: (value) => value.length <= MAX_FIELD,
});

let cachedDefaults = null;

export function discussionDefaults() {
  if (!cachedDefaults) {
    try {
      cachedDefaults = JSON.parse(fs.readFileSync(DISCUSSION_DEFAULTS_FILE, "utf8"));
    } catch {
      cachedDefaults = {};
    }
  }
  return cachedDefaults;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** Effective rules: the plugin defaults in config/discussions.json. */
export function resolveDiscussionPolicy(defaults = discussionDefaults()) {
  const known = Object.keys(ACTION_FIELDS);
  const actions = Array.isArray(defaults.actions) ? defaults.actions.filter((name) => known.includes(name)) : known;
  return Object.freeze({
    max_turns: positive(defaults.max_turns, 6),
    timebox_ms: positive(defaults.timebox_minutes, 15) * 60_000,
    max_participants: positive(defaults.max_participants, 3),
    actions: Object.freeze(actions),
  });
}

/**
 * Checks an action object against the closed schema. Returns
 * { action, errors }: `action` is a clean copy (only known fields, trimmed
 * strings) when there are no errors, else null.
 */
export function validateAction(candidate, policy = resolveDiscussionPolicy()) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { action: null, errors: ["the action must be an object"] };
  const name = candidate.action;
  const spec = ACTION_FIELDS[name];
  if (!spec || !policy.actions.includes(name)) return { action: null, errors: [`action must be one of: ${policy.actions.join(", ")}`] };
  const errors = [];
  const clean = { action: name };
  const allowed = new Set(["action", ...spec.required, ...spec.optional]);
  for (const key of Object.keys(candidate)) if (!allowed.has(key)) errors.push(`unknown field ${key}`);
  for (const key of [...spec.required, ...spec.optional]) {
    const raw = candidate[key];
    if (raw === undefined || raw === null || raw === "") {
      if (spec.required.includes(key)) errors.push(`${key} is required`);
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : null;
    if (!value || !FIELD_CHECKS[key](value)) {
      errors.push(`${key} is not valid`);
      continue;
    }
    clean[key] = value;
  }
  return errors.length ? { action: null, errors } : { action: Object.freeze(clean), errors: [] };
}

/** The message text for a proposal or decision: a readable line plus the action line. */
export function encodeAction(summary, action) {
  return `${String(summary ?? "").trim()}\n${ACTION_LINE_PREFIX}${JSON.stringify(action)}`.trim();
}

/** The action carried by a message text (its last line), validated; null when absent or invalid. */
export function decodeAction(text, policy = resolveDiscussionPolicy()) {
  const lines = String(text ?? "").trimEnd().split("\n");
  const last = lines.at(-1) ?? "";
  if (!last.startsWith(ACTION_LINE_PREFIX)) return null;
  try {
    return validateAction(JSON.parse(last.slice(ACTION_LINE_PREFIX.length)), policy).action;
  } catch {
    return null;
  }
}

/**
 * The mpsf command (argument vector, without the executable) a decided action
 * names; null for `none`. The command keeps every check of its own.
 */
export function commandFor(action) {
  switch (action?.action) {
    case "handoff":
      return ["story", "prepare-handoff", "--id", action.story, "--to-agent", action.to_agent, ...(action.summary ? ["--summary", action.summary] : [])];
    case "claim":
      return ["story", "claim", "--id", action.story, "--agent", action.agent];
    case "known-error":
      return ["known-error", "add", "--from-last-failure", "--signature", action.signature, "--title", action.title, "--diagnosis", action.diagnosis, "--step", action.step];
    default:
      return null;
  }
}

function timeMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function byTime(left, right) {
  return (timeMs(left.time) ?? 0) - (timeMs(right.time) ?? 0) || String(left.id).localeCompare(String(right.id));
}

/** The state of one discussion from its root and its replies. */
function foldDiscussion(root, replies, policy, nowMs) {
  const opener = identityOf(root);
  const participants = [opener];
  const counted = [];
  for (const message of replies) {
    const who = identityOf(message);
    if (!who) continue;
    if (!participants.includes(who)) {
      if (participants.length >= policy.max_participants) continue;
      participants.push(who);
    }
    counted.push(message);
  }
  const startedMs = timeMs(root.time) ?? nowMs;
  const deadlineMs = startedMs + policy.timebox_ms;
  const decision = counted.find((message) => message.kind === "decide" && message.trust === "trusted" && decodeAction(message.text, policy));
  const ignoredDecisions = counted.filter((message) => message.kind === "decide" && message !== decision).length;
  let proposal = null;
  let objections = [];
  let acks = new Set();
  for (const message of counted) {
    if (message.kind === "propose") {
      const action = decodeAction(message.text, policy);
      if (!action) continue;
      proposal = { id: message.id, by: identityOf(message), time: message.time, action, command: commandFor(action) };
      objections = [];
      acks = new Set([identityOf(message)]);
    } else if (proposal && message.kind === "object") {
      objections.push({ id: message.id, by: identityOf(message), time: message.time });
      acks.delete(identityOf(message));
    } else if (proposal && message.kind === "ack") {
      acks.add(identityOf(message));
      objections = objections.filter((objection) => objection.by !== identityOf(message));
    }
  }
  const turns = counted.length;
  const timedOut = nowMs >= deadlineMs || turns >= policy.max_turns;
  const everyoneAgrees = proposal !== null && participants.length > 1 && participants.every((who) => acks.has(who));
  let state;
  let reason;
  if (decision) {
    state = STATES.decided;
    reason = "signed decision";
  } else if (everyoneAgrees) {
    state = STATES.agreed;
    reason = "every participant agreed";
  } else if (timedOut) {
    if (proposal && objections.length === 0) {
      state = STATES.agreed;
      reason = "no objection by the time box or turn limit";
    } else {
      state = STATES.escalated;
      reason = proposal ? "objections still open at the time box or turn limit" : "no proposal by the time box or turn limit";
    }
  } else {
    state = proposal ? STATES.proposed : STATES.open;
    reason = proposal ? "waiting for agreement or objections" : "waiting for a proposal";
  }
  const decided = decision ? decodeAction(decision.text, policy) : null;
  return {
    id: root.id,
    topic: String(root.text ?? "").split("\n")[0].trim(),
    story: root.story ?? null,
    opened_by: opener,
    opened_at: root.time ?? null,
    deadline: new Date(deadlineMs).toISOString(),
    participants,
    turns,
    state,
    reason,
    proposal,
    objections,
    ignored_decisions: ignoredDecisions,
    decision: decision ? { id: decision.id, by: identityOf(decision), time: decision.time, action: decided, command: commandFor(decided) } : null,
  };
}

/**
 * Every discussion found in `messages` (any order), newest first. Untrusted
 * messages (a bad signature) never count. Pure.
 */
export function discussionsFrom(messages, { policy = resolveDiscussionPolicy(), nowMs = Date.now() } = {}) {
  const usable = (Array.isArray(messages) ? messages : []).filter((message) => message && message.id && message.trust !== "untrusted");
  const roots = usable.filter((message) => message.kind === "discuss" && !message.reply_to);
  const ids = new Set(roots.map((root) => String(root.id)));
  const replies = new Map([...ids].map((id) => [id, []]));
  for (const message of usable) {
    if (message.reply_to && ids.has(String(message.reply_to))) replies.get(String(message.reply_to)).push(message);
  }
  return roots
    .map((root) => foldDiscussion(root, replies.get(String(root.id)).sort(byTime), policy, nowMs))
    .sort((left, right) => (timeMs(right.opened_at) ?? 0) - (timeMs(left.opened_at) ?? 0));
}
