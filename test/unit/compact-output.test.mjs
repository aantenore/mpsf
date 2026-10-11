import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compactGuidanceLines, resolveOutputMode } from "../../lib/context/compact-output.mjs";
import { estimateTokens } from "../../lib/context/policy.mjs";
import { createFixtureDir } from "../helpers/test-isolation.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "agentic-sdlc.mjs");
const AGENT_ENV = { CLAUDECODE: "1" };

function block({ decision = "Nothing to decide.", details = ["Correlation ID: corr-1"], summary = [] } = {}) {
  return [
    "Outcome: The project is ready.",
    "What this changes in practice: Nothing yet.",
    `What you need to decide: ${decision}`,
    "What remains protected: Everything.",
    "Next step: Describe the outcome.",
    ...summary,
    "",
    "Technical details (optional):",
    ...details.map((line) => `- ${line}`),
  ];
}

test("mode precedence: verbose, compact, env, policy, host", () => {
  const policy = (mode) => ({ output: { mode } });
  assert.equal(resolveOutputMode({ options: { verbose: true, compact: true }, env: { AGENTIC_SDLC_OUTPUT: "compact" } }), "full");
  assert.equal(resolveOutputMode({ options: { compact: true }, env: { AGENTIC_SDLC_OUTPUT: "full" } }), "compact");
  assert.equal(resolveOutputMode({ options: {}, env: { AGENTIC_SDLC_OUTPUT: "full", ...AGENT_ENV }, policy: policy("compact") }), "full");
  assert.equal(resolveOutputMode({ options: {}, env: { AGENTIC_SDLC_OUTPUT: "compact" }, policy: policy("full") }), "compact");
  assert.equal(resolveOutputMode({ options: {}, env: AGENT_ENV, policy: policy("full") }), "full");
  assert.equal(resolveOutputMode({ options: {}, env: {}, policy: policy("compact") }), "compact");
  assert.equal(resolveOutputMode({ options: {}, env: AGENT_ENV, policy: policy("auto") }), "compact");
  assert.equal(resolveOutputMode({ options: {}, env: {}, policy: policy("auto") }), "full");
  assert.equal(resolveOutputMode({ options: { json: true }, env: {} }), "full");
  assert.equal(resolveOutputMode({ options: { json: true }, env: AGENT_ENV }), "compact");
});

test("english block: outcome, next, no protected/impact lines, no correlation id", () => {
  const out = compactGuidanceLines(block({ details: ["Project: demo", "Correlation ID: corr-1"] }));
  assert.deepEqual(out, ["The project is ready.", "next: Describe the outcome.", "- Project: demo"]);
});

test("italian block", () => {
  const lines = [
    "Risultato: Pronto.",
    "Cosa cambia in pratica: Niente.",
    "Cosa devi decidere: Descrivi l'esito.",
    "Cosa resta protetto: Tutto.",
    "Prossimo passo: Concorda il requisito.",
    "",
    "Dettagli tecnici (facoltativi):",
    "- Progetto: demo",
    "- ID correlazione: corr-9",
  ];
  assert.deepEqual(compactGuidanceLines(lines), ["Pronto.", "next: Concorda il requisito.", "decide: Descrivi l'esito.", "- Progetto: demo"]);
});

test("decide line kept only when a decision is needed", () => {
  assert.ok(compactGuidanceLines(block({ decision: "Choose the scope." })).includes("decide: Choose the scope."));
  for (const none of ["Nothing to decide.", "No decision needed.", "None.", "You do not need to decide.", "Nessuna decisione.", "Non serve decidere."]) {
    assert.ok(!compactGuidanceLines(block({ decision: none })).some((line) => line.startsWith("decide:")), none);
  }
});

test("summary lines are kept trimmed, empty ones dropped", () => {
  const out = compactGuidanceLines(block({ summary: ["  Stories: 3  ", "   "] }));
  assert.deepEqual(out.slice(0, 3), ["The project is ready.", "next: Describe the outcome.", "Stories: 3"]);
});

test("detail priority, cap and marker", () => {
  const details = ["plain a", "plain b", "Run agentic-sdlc status", "plain c", "Story ST-A-001 blocked", "plain d"];
  const out = compactGuidanceLines(block({ details }), { maxDetailLines: 3 });
  assert.deepEqual(out.slice(2), ["- Run agentic-sdlc status", "- Story ST-A-001 blocked", "- plain a", "… 3 more: --verbose"]);
  const all = compactGuidanceLines(block({ details }), { maxDetailLines: 10 });
  assert.ok(!all.some((line) => line.includes("more: --verbose")));
});

test("token cap drops details from the end and keeps the essentials", () => {
  const details = Array.from({ length: 6 }, (_, index) => `detail number ${index} ${"x".repeat(60)}`);
  const out = compactGuidanceLines(block({ decision: "Choose.", details }), { maxDetailLines: 6, maxTokens: 60 });
  assert.ok(estimateTokens(out.join("\n")) <= 60);
  assert.equal(out[0], "The project is ready.");
  assert.ok(out.includes("decide: Choose."));
  assert.match(out.at(-1), /^… \d+ more: --verbose$/u);
  const tiny = compactGuidanceLines(block({ details }), { maxTokens: 1 });
  assert.deepEqual(tiny.slice(0, 2), ["The project is ready.", "next: Describe the outcome."]);
});

test("deterministic and passthrough", () => {
  const input = block({ details: ["a error", "b", "Correlation ID: c"] });
  assert.deepEqual(compactGuidanceLines(input), compactGuidanceLines(input));
  const plain = ["just text", "- item"];
  assert.deepEqual(compactGuidanceLines(plain), plain);
});

test("cli: --compact shortens text output and leaves --json untouched", () => {
  const root = createFixtureDir("sdlc-compact-");
  const env = { ...process.env, AGENTIC_SDLC_OUTPUT: "full" };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8", env });
  assert.equal(run("init").status, 0);
  const full = run("status", "--sync", "off");
  const compact = run("status", "--sync", "off", "--compact");
  assert.equal(full.status, 0);
  assert.equal(compact.status, 0);
  assert.match(full.stdout, /What remains protected/u);
  assert.doesNotMatch(compact.stdout, /What remains protected/u);
  assert.ok(compact.stdout.length < full.stdout.length);
  const json = (result) => {
    const payload = JSON.parse(result.stdout);
    delete payload.correlation_id;
    return payload;
  };
  assert.deepEqual(json(run("status", "--sync", "off", "--json", "--compact")), json(run("status", "--sync", "off", "--json")));
});
