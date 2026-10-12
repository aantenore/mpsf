import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildObservatoryViewModel } from "../../lib/change-observatory/normalizer.mjs";
import { contextUsageRows } from "../../lib/change-observatory/now-panel.mjs";
import { budgetedPack } from "../../lib/context/cli.mjs";
import { createFsRecordReader } from "../../lib/context/reader.mjs";
import { knowledgeDistillCommand, knowledgeSourceReader, knownErrorsFrom } from "../../lib/knowledge/cli.mjs";
import { collectCandidates, planDistillation } from "../../lib/knowledge/distill.mjs";
import { resolveKnowledgePolicy } from "../../lib/knowledge/policy.mjs";
import { knowledgeForStory, readKnowledge } from "../../lib/knowledge/records.mjs";
import { readKnownErrors } from "../../lib/known-errors/registry.mjs";
import { computeSignature } from "../../lib/known-errors/signature.mjs";
import { createFixtureDir } from "../helpers/test-isolation.mjs";
import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";

const FAILURE = (story) => `Story ${story} changed packages/engine/.vitest/json/output.json outside the approved requirement write paths`;

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = createFixtureDir("sdlc-knowledge-");
  spawnSync("git", ["-C", root, "init", "-q"]);
  write(root, ".sdlc/config.json", { phase_order: ["discovery", "analysis", "design", "implementation", "validation", "release", "operations"] });
  const signature = computeSignature({ check: "gate.check", exit_code: 1, message: FAILURE("ST-A-001"), root });
  write(root, `.sdlc/known-errors/${signature.id}.json`, {
    kind: "known_error", schema_version: "known-error:v1", id: signature.id, title: "vitest cache in the diff",
    signature: { ...signature, aliases: [] }, diagnosis: "vitest writes .vitest/ inside the package", steps: ["add .vitest/ to .gitignore"],
    fix: { safe: false, actions: [] }, scope: { repo: null, plugin_versions: { min: "0.1.0", max: null } },
    seen_in: { story_id: "ST-A-001" }, created_by: { type: "agent", id: "codex" }, created_at: "2026-10-11T10:00:00.000Z", record_hash: "x", hash_algorithm: "sha256:stable-json:v1",
  });
  for (const story of ["ST-A-001", "ST-A-002"]) write(root, `.sdlc/gates/${story}-strict.json`, { status: "failed", story_id: story, checked_at: "2026-10-11T11:00:00Z", errors: [FAILURE(story)] });
  write(root, ".sdlc/gates/ST-A-003-strict.json", { status: "failed", errors: ["a one-off failure"] });
  for (const id of ["ST-A-001", "ST-A-002", "ST-A-003"]) {
    write(root, `.sdlc/stories/${id}/story.json`, { id, title: `Story ${id}`, status: "ready", phase: "implementation", contract_id: `contract-${id}`, acceptance_criteria: ["works"] });
    write(root, `.sdlc/contracts/contract-${id}.json`, { id: `contract-${id}`, status: "approved", phase: "implementation", delivery_execution_profile_id: `AUT-${id}` });
    write(root, `.sdlc/autonomy/deliveries/AUT-${id}.json`, { constraints: { allowed_write_paths: [id === "ST-A-003" ? "packages/engine" : "src"] } });
  }
  write(root, ".sdlc/stories/ST-FIX-001/story.json", { id: "ST-FIX-001", title: "Ignore the vitest cache", status: "done", fixes: { story_id: "ST-A-001", incident_id: "INC-1" }, acceptance_criteria: [".vitest is ignored"] });
  return { root, signature };
}

const MESSAGES = [
  { id: "m1", kind: "question", from: "pc-a", story: "ST-A-002", text: "Where does the export write its temp files?" },
  { id: "m2", kind: "answer", from: "pc-b", reply_to: "m1", text: "Under tmp/export, cleaned at the end." },
  { id: "m3", kind: "question", from: "pc-a", text: "[auto] status" },
];

function distil(root, messages = MESSAGES) {
  const reader = createFsRecordReader(root);
  const policy = resolveKnowledgePolicy(null);
  const candidates = collectCandidates({ reader, policy, knownErrors: readKnownErrors(path.join(root, ".sdlc")), messages, root });
  return planDistillation({ reader, candidates });
}

function apply(root, plan) {
  for (const item of plan.writes) write(root, item.path, item.value);
}

test("distillation merges a known error and the same gate failure into one trap, keeps fixes and answers", () => {
  const { root, signature } = fixture();
  const plan = distil(root);
  assert.equal(plan.writes.filter((item) => item.action === "create").length, 3);
  apply(root, plan);
  const created = readKnowledge(createFsRecordReader(root));
  const trap = created.find((item) => item.type === "trap");
  assert.equal(trap.title, "vitest cache in the diff");
  assert.deepEqual(trap.stories, ["ST-A-001", "ST-A-002"]);
  assert.deepEqual(trap.sources.map((source) => source.type).sort(), ["gate", "gate", "known_error"]);
  assert.equal(trap.sources.some((source) => source.ref.includes(signature.id)), true);
  assert.equal(created.some((item) => item.title.includes("one-off")), false, "a failure in one story only is not a trap");
  assert.equal(created.find((item) => item.type === "fix").stories.join(), "ST-A-001,ST-FIX-001");
  assert.match(created.find((item) => item.type === "answer").summary, /tmp\/export/u);
});

test("two computers with different copies of the project write the same record bytes; what each saw goes in its own event", () => {
  const { root: full, signature } = fixture();
  const { root: partial } = fixture();
  // The second computer has not pulled the known error, one gate, nor the latest answer yet.
  fs.rmSync(path.join(partial, `.sdlc/known-errors/${signature.id}.json`));
  write(partial, ".sdlc/gates/ST-A-003-final.json", { status: "failed", story_id: "ST-A-003", errors: [FAILURE("ST-A-003")] });
  const second = [...MESSAGES, { id: "m4", kind: "answer", from: "pc-c", reply_to: "m1", text: "Also under tmp/cache." }];
  const writesOf = (plan) => new Map(plan.writes.map((item) => [item.path, `${JSON.stringify(item.value, null, 2)}\n`]));
  const a = writesOf(distil(full));
  const b = writesOf(distil(partial, second));
  const records = [...a.keys()].filter((file) => !file.includes("/events/"));
  assert.equal(records.length, 3);
  for (const file of records) assert.equal(b.get(file), a.get(file), `${file} has the same bytes on both computers`);
  for (const [file, bytes] of a) if (b.has(file)) assert.equal(b.get(file), bytes, `${file}: one name, one content`);
  for (const [, value] of [...distil(full).writes, ...distil(partial, second).writes].map((item) => [item.path, item.value])) {
    const schema = value.kind === "knowledge" ? "knowledge.schema.json" : "knowledge-event.schema.json";
    assert.equal(validateAgainstSchema(value, schema, { schemaDir: path.resolve("schemas") }).valid, true);
  }
});

test("records are deterministic: a second run writes nothing, a new sighting is one event", () => {
  const { root } = fixture();
  const first = distil(root);
  const again = distil(root);
  assert.deepEqual(again.writes.map((item) => item.value), first.writes.map((item) => item.value), "same input, same bytes on any computer");
  apply(root, first);
  assert.equal(distil(root).writes.length, 0);
  write(root, ".sdlc/gates/ST-A-003-final.json", { status: "failed", story_id: "ST-A-003", errors: [FAILURE("ST-A-003")] });
  const next = distil(root);
  assert.equal(next.writes.length, 1);
  assert.equal(next.writes[0].action, "seen");
  apply(root, next);
  const trap = readKnowledge(createFsRecordReader(root)).find((entry) => entry.type === "trap");
  assert.equal(trap.stories.includes("ST-A-003"), true);
  assert.equal(trap.occurrences, 4);
});

test("the context pack shows the entries touching the story, and nothing when none does", () => {
  const { root } = fixture();
  apply(root, distil(root));
  const entries = readKnowledge(createFsRecordReader(root));
  assert.equal(knowledgeForStory(entries, { storyId: "ST-A-002" }).length, 2);
  assert.equal(knowledgeForStory(entries, { storyId: "ST-A-003", scopePaths: ["packages/engine"] }).length, 1, "the trap names a path inside the story's scope");
  const context = { root, sdlcRoot: path.join(root, ".sdlc"), config: JSON.parse(fs.readFileSync(path.join(root, ".sdlc/config.json"), "utf8")) };
  const env = { AGENTIC_SDLC_SESSION_ID: "s1" };
  const pack = budgetedPack(context, { story: "ST-A-002", phase: "implementation", cache: false, env });
  assert.match(pack.text, /## knowledge\ntrap KN-[0-9a-f]{12}: "vitest cache in the diff"/u);
  assert.match(pack.text, /answer KN-[0-9a-f]{12}: "Where does the export/u);
  write(root, ".sdlc/stories/ST-B-001/story.json", { id: "ST-B-001", title: "Unrelated", status: "ready", phase: "implementation", acceptance_criteria: ["x"] });
  assert.equal(budgetedPack(context, { story: "ST-B-001", phase: "implementation", cache: false, env }).text.includes("## knowledge"), false);
});

test("the budget is per worker session: capped, deduplicated, exhausted, visible", () => {
  const { root } = fixture();
  const context = { root, sdlcRoot: path.join(root, ".sdlc"), config: {} };
  const env = { AGENTIC_SDLC_SESSION_ID: "s2", AGENTIC_SDLC_CONTEXT_BUDGET: "450" };
  const first = budgetedPack(context, { story: "ST-A-001", phase: "implementation", cache: false, dedupe: true, env });
  assert.equal(first.status, "ok");
  assert.ok(first.tokens <= 450);
  const second = budgetedPack(context, { story: "ST-A-001", phase: "implementation", cache: false, dedupe: true, env });
  assert.equal(second.status, "unchanged");
  let last = second;
  for (let i = 0; i < 40 && last.status !== "exhausted"; i += 1) last = budgetedPack(context, { story: "ST-A-001", phase: "implementation", budget: 100, cache: false, env });
  assert.equal(last.status, "exhausted");
  assert.match(last.text, /used up/u);
  const other = budgetedPack(context, { story: "ST-A-001", phase: "implementation", cache: false, env: { ...env, AGENTIC_SDLC_SESSION_ID: "s3" } });
  assert.equal(other.status, "ok", "another session has its own budget");
  const rows = contextUsageRows(root);
  assert.equal(rows.sessions.length, 2);
  assert.ok(rows.sessions.every((row) => row.used > 0 && row.packs > 0));
});

test("distill without a role lease runs here, then the Observatory panel", async () => {
  const { root } = fixture();
  const context = { root, sdlcRoot: path.join(root, ".sdlc"), config: {} };
  const log = console.log;
  console.log = () => {};
  let result;
  try {
    result = await knowledgeDistillCommand(context, { json: true }, {
      env: { AGENTIC_SDLC_SESSION_ID: "s4" },
      fresh: () => ({ sha: null }),
      // The governed writer needs a CLI project boundary; the records are the same.
      writeRecord: (file, value) => write(root, path.relative(root, file), value),
    });
  } finally {
    console.log = log;
  }
  assert.equal(result.role.mode, "everyone");
  assert.equal(result.source, "working-tree");
  assert.equal(result.created.length >= 2, true);
  assert.equal(fs.existsSync(path.join(root, result.created[0])), true);
  const view = await buildObservatoryViewModel(root, { clock: () => new Date("2026-10-12T00:00:00Z") });
  assert.equal(view.knowledge.length, result.created.length);
  assert.equal(view.knowledge[0].type, "trap");
});

test("distillation reads the base branch, not the checkout", () => {
  const { root } = fixture();
  spawnSync("git", ["-C", root, "add", ".sdlc"]);
  spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
  const sha = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  fs.rmSync(path.join(root, ".sdlc/gates"), { recursive: true });
  const { reader, source } = knowledgeSourceReader({ root }, { fresh: () => ({ sha, remote: "origin", branch: "main" }) });
  assert.equal(source, "origin/main");
  assert.equal(knownErrorsFrom(reader).length, 1);
  const candidates = collectCandidates({ reader, policy: resolveKnowledgePolicy(null), knownErrors: knownErrorsFrom(reader), root });
  assert.equal(candidates.find((item) => item.type === "trap").stories.length, 2, "gates deleted in the checkout still count from the base");
});
