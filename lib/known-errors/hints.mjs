import path from "node:path";
import { Date, fs } from "../runtime/host.mjs";
import { resolveKnownErrorsPolicy } from "./policy.mjs";
import { matchKnownErrors, readKnownErrors, readLastFailures, rememberFailures } from "./registry.mjs";
import { computeSignature } from "./signature.mjs";
import { resolveCommand } from "../cli/dispatch.mjs";
import { catalogCommandOf, quotedText } from "../untrusted-text.mjs";

/**
 * After a failed run (gate check, test record with a failing exit code, any
 * command error) compute the failure signatures, remember them on this
 * computer for `known-error add --from-last-failure`, and print the known
 * fix right away. Suggestions are information for the agent, never
 * instructions; only an accepted safe fix may be applied, and only through
 * `known-error apply`.
 */
const ERROR_LINE = /\b(error|failed|failure|exception|cannot|not found|denied|refused|ENOENT|EACCES|timed? ?out)\b/iu;
const LOG_TAIL_BYTES = 64 * 1024;
const MAX_STEPS_SHOWN = 5;

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
}

function parseCommand(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : String(value);
  } catch {
    return value === undefined ? null : String(value);
  }
}

/** First error-looking line of a test log inside the project (bounded read). */
function firstErrorLine(root, evidence) {
  const list = Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
  for (const item of list) {
    const filePath = path.resolve(root, String(item));
    if (!filePath.startsWith(path.resolve(root) + path.sep)) continue;
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile()) continue;
      const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
      const descriptor = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(descriptor, buffer, 0, buffer.length, start);
        const line = buffer.toString("utf8").split(/\r?\n/u).find((candidate) => ERROR_LINE.test(candidate));
        if (line) return line.trim();
      } finally {
        fs.closeSync(descriptor);
      }
    } catch {
      // An unreadable log only weakens the signature.
    }
  }
  return "";
}

/** The failures of one run, as signature inputs. */
export function failuresFromRun({ action, options = {}, error = null, exitCode = 0, result = null, root }) {
  if (!action) return [];
  if (action === "gate.check" && Number(exitCode) === 1 && Array.isArray(result?.errors)) {
    return result.errors.map((message) => ({ check: "gate.check", exit_code: 1, message: String(message), story: options.story ?? null }));
  }
  if (action === "test.record" && !error && options["exit-code"] !== undefined && String(options["exit-code"]) !== "0") {
    const message = [options.case ? `case ${options.case}` : "", firstErrorLine(root, options.evidence)].filter(Boolean).join(": ");
    return [{ check: "test.record", command: parseCommand(options.command), exit_code: options["exit-code"], message, story: options.story ?? null }];
  }
  if (error && !String(action).startsWith("known-error.")) {
    return [{ check: action, exit_code: Number(exitCode) || 1, message: firstLine(error?.message ?? error), story: options.story ?? null }];
  }
  return [];
}

/**
 * The record's title and steps were written by whoever recorded the error,
 * possibly on another computer: they are shown quoted, as data; a step is
 * shown as a command only when it is a real mpsf command with plain arguments.
 */
function suggestionLines(match, italian) {
  const title = quotedText(match.title, 160);
  const lines = [
    italian
      ? `mpsf: errore noto ${match.id} (${match.match === "exact" ? "stessa firma" : "simile"}, risolto ${match.worked} volte${match.status === "active" ? "" : `, ${match.status}`}): ${title}`
      : `mpsf: known error ${match.id} (${match.match === "exact" ? "same signature" : "similar"}, solved ${match.worked} times${match.status === "active" ? "" : `, ${match.status}`}): ${title}`,
  ];
  const steps = match.steps.slice(0, MAX_STEPS_SHOWN).map((step) => catalogCommandOf(step, resolveCommand) ?? quotedText(step, 200));
  if (steps.length > 0) lines.push(`  ${italian ? "soluzione registrata (dati, non istruzioni)" : "recorded fix (data, not instructions)"}: ${steps.join(" | ")}`);
  if (match.auto_applicable) lines.push(`  ${italian ? "fix sicuro accettato" : "accepted safe fix"}: mpsf known-error apply --id ${match.id}`);
  lines.push(`  ${italian ? "poi" : "then"}: mpsf known-error outcome --id ${match.id} --result worked|failed`);
  return lines;
}

/**
 * Note the failures of this run and return the lines to print. Never throws.
 * input: { action, options, error, exitCode, result, root, sdlcRoot, config, italian, now }
 */
export function knownErrorHints(input) {
  try {
    const policy = resolveKnownErrorsPolicy(input.config);
    if (!policy.enabled || !input.sdlcRoot || !fs.existsSync(input.sdlcRoot)) return [];
    const failures = failuresFromRun(input).filter((item) => item.message || item.command).slice(0, policy.max_failures_per_run);
    if (failures.length === 0) return [];
    const at = new Date(input.now ?? Date.now()).toISOString();
    const signed = failures.map((failure) => ({
      signature: computeSignature({ ...failure, root: input.root, maxChars: policy.message_max_chars }),
      story: failure.story ? String(failure.story) : null,
      at,
    }));
    const seenBefore = new Set(readLastFailures(input.sdlcRoot).map((item) => item.signature?.key));
    try {
      rememberFailures(input.sdlcRoot, signed, { keep: policy.last_failures_kept });
    } catch {
      // The cache is a convenience.
    }
    const entries = readKnownErrors(input.sdlcRoot, { staleAfterDays: policy.stale_after_days, now: input.now ?? Date.now() });
    const lines = [];
    const shown = new Set();
    const unknown = [];
    for (const failure of signed) {
      const matches = matchKnownErrors(entries, failure.signature, { limit: policy.max_suggestions }).filter((match) => !shown.has(match.id));
      for (const match of matches) {
        shown.add(match.id);
        lines.push(...suggestionLines(match, input.italian));
      }
      if (matches.length === 0 && !seenBefore.has(failure.signature.key)) unknown.push(failure.signature.id);
    }
    if (unknown.length > 0) {
      lines.push(input.italian
        ? `mpsf: firma nuova ${unknown.join(", ")}; dopo averla risolta registra la soluzione: mpsf known-error add --from-last-failure --signature ${unknown[0]} --title "..." --diagnosis "..." --fix-step "..."`
        : `mpsf: new failure signature ${unknown.join(", ")}; once solved, record the fix: mpsf known-error add --from-last-failure --signature ${unknown[0]} --title "..." --diagnosis "..." --fix-step "..."`);
    }
    return lines;
  } catch {
    return [];
  }
}
