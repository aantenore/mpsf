import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractSymbols } from "../../lib/context/pack.mjs";
import { estimateTokens } from "../../lib/context/policy.mjs";
import { buildContextPack, getContextRef } from "../../lib/context/service.mjs";
import { createFixtureDir } from "../helpers/test-isolation.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "agentic-sdlc.mjs");
const STORY = "ST-CTX-001";
const GITHUB_TOKEN = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";
const PASSWORD_LINE = "password = \"correct-horse-battery\"";

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** A small governed project: one story with every kind of record the pack reads. */
function fixture() {
  const root = createFixtureDir("sdlc-context-pack-");
  write(root, ".sdlc/config.json", { phase_order: ["discovery", "analysis", "design", "implementation", "validation", "release", "operations"] });
  write(root, `.sdlc/stories/${STORY}/story.json`, {
    id: STORY,
    title: "Itinerary export",
    status: "ready",
    phase: "implementation",
    priority: "P1",
    contract_id: `contract-${STORY}-implementation`,
    acceptance_criteria: ["Export produces a PDF with every day", `Never log ${GITHUB_TOKEN}`],
    requirement_refs: [
      { id: "REQ-CTX-001", path: ".sdlc/requirements/REQ-CTX-001.json", revision: 1 },
      { id: "REQ-CTX-002", path: ".sdlc/requirements/REQ-CTX-002.json", revision: 1 },
    ],
  });
  write(root, ".sdlc/requirements/REQ-CTX-001.json", {
    id: "REQ-CTX-001", revision: 1, status: "approved", title: "Export",
    acceptance_criteria: ["CA-1 one page per day", `CA-2 the API key ${AWS_KEY} is never shown`, ...Array.from({ length: 30 }, (_, i) => `CA-${i + 3} criterion number ${i + 3} with enough words to take some room in the pack`)],
    non_goals: ["No printing service"],
  });
  write(root, ".sdlc/requirements/REQ-CTX-002.json", { id: "REQ-CTX-002", revision: 1, status: "proposed", title: "Draft idea", acceptance_criteria: ["SECRET-DRAFT criterion"] });
  write(root, `.sdlc/contracts/contract-${STORY}-implementation.json`, {
    id: `contract-${STORY}-implementation`, status: "approved", phase: "implementation", autonomy_level: "checkpointed",
    purpose: "Implement the export", outputs: ["code changes"], validation: ["tests pass"], human_gate: true,
    delivery_execution_profile_id: `AUT-PR-${STORY}`,
  });
  write(root, `.sdlc/autonomy/deliveries/AUT-PR-${STORY}.json`, {
    id: `AUT-PR-${STORY}`, constraints: { allowed_write_paths: ["src/export", "src/main.mjs"] },
    requirement_profile_refs: [{ id: "AUT-REQ-CTX-001-R1", path: ".sdlc/autonomy/requirements/AUT-REQ-CTX-001-R1.json" }],
  });
  write(root, ".sdlc/autonomy/requirements/AUT-REQ-CTX-001-R1.json", { constraints: { allowed_write_paths: ["docs"] } });
  write(root, `.sdlc/stories/${STORY}/steps/discovery.json`, { step: "discovery", status: "completed", summary: "found the export gap" });
  write(root, `.sdlc/stories/${STORY}/steps/analysis.json`, { step: "analysis", status: "completed", summary: "criteria agreed" });
  write(root, `.sdlc/stories/${STORY}/steps/design.json`, { step: "design", status: "completed", summary: "one module" });
  write(root, `.sdlc/tests/${STORY}-test-run-20261010100000000-aaaaaa.json`, { id: "run-1", outcome: "failed", phase: "implementation", totals: { passed: 3, failed: 1 }, summary: "first run", command: { argv: ["npm", "test"] } });
  write(root, `.sdlc/tests/${STORY}-test-run-20261010110000000-bbbbbb.json`, { id: "run-2", outcome: "passed", phase: "implementation", totals: { passed: 4, failed: 0 }, summary: "second run", command: { argv: ["npm", "test"] } });
  write(root, ".sdlc/dependencies/DEP-CTX.json", { edges: [{ from: "ST-CTX-000", to: STORY, type: "blocks", required_state: "merged" }] });
  write(root, ".sdlc/stories/ST-CTX-000/story.json", { id: "ST-CTX-000", title: "Data model", status: "merged" });
  write(root, `.sdlc/traces/${STORY}.jsonl`, [
    { id: "TR-1", story_id: STORY, type: "decision", summary: "Use one module for the export", created_at: "2026-10-10T10:00:00Z" },
    { id: "TR-2", story_id: STORY, type: "decision", summary: `Store the token ${GITHUB_TOKEN} nowhere`, created_at: "2026-10-10T11:00:00Z" },
    { id: "TR-3", story_id: STORY, type: "test", summary: "not a decision", created_at: "2026-10-10T12:00:00Z" },
  ].map((event) => JSON.stringify(event)).join("\n"));
  write(root, "src/export/pdf.mjs", "export function renderPdf() {}\nexport const PAGE_SIZE = 4;\nfunction hidden() {}\n");
  write(root, "src/main.mjs", "export async function main() {}\n");
  write(root, "src/other.mjs", "export function outOfScope() {}\n");
  write(root, "docs/export.md", `# Export\n${PASSWORD_LINE}\n`);
  git(root, "init", "-q");
  git(root, "add", "src", "docs");
  return root;
}

function contextOf(root) {
  return { root, sdlcRoot: path.join(root, ".sdlc"), config: JSON.parse(fs.readFileSync(path.join(root, ".sdlc", "config.json"), "utf8")) };
}

function assertNoSecrets(text) {
  for (const secret of [GITHUB_TOKEN, AWS_KEY, "correct-horse-battery"]) assert.equal(text.includes(secret), false, `secret leaked: ${secret}`);
}

test("the pack is deterministic: same records, same text and hash", () => {
  const root = fixture();
  const first = buildContextPack(contextOf(root), { story: STORY, phase: "implementation", cache: false });
  const second = buildContextPack(contextOf(root), { story: STORY, phase: "implementation", cache: false });
  assert.equal(first.text, second.text);
  assert.equal(first.pack.pack_hash, second.pack.pack_hash);
  assert.match(first.pack.pack_hash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(first.pack.sections.map((section) => section.id), ["story", "requirement", "contract", "decisions", "dependencies", "scope", "evidence", "waits", "next"]);
});

test("every section stays within its budget and points to the rest", () => {
  const root = fixture();
  for (const budget of [2000, 600]) {
    const { pack, text } = buildContextPack(contextOf(root), { story: STORY, phase: "implementation", budget, cache: false });
    for (const section of pack.sections) assert.ok(section.tokens <= section.budget_tokens, `${section.id} ${section.tokens} > ${section.budget_tokens}`);
    const sectionTotal = pack.sections.reduce((sum, section) => sum + section.budget_tokens, 0);
    assert.ok(sectionTotal <= budget + 24 * pack.sections.length, `${sectionTotal} vs ${budget}`);
    const requirement = pack.sections.find((section) => section.id === "requirement");
    assert.equal(requirement.truncated, true);
    assert.match(text, new RegExp(`… \\d+ more: context get sec:${STORY}/implementation/requirement`, "u"));
    assert.ok(estimateTokens(text) < budget * 1.3);
  }
  assert.throws(() => buildContextPack(contextOf(root), { story: STORY, budget: 5, cache: false }), /--budget/u);
});

test("only accepted criteria, the write scope, its files and symbols, latest tests first", () => {
  const root = fixture();
  const { text } = buildContextPack(contextOf(root), { story: STORY, phase: "implementation", budget: 4000, cache: false });
  assert.match(text, /REQ-CTX-001 r1 \[approved\]/u);
  assert.match(text, /REQ-CTX-002 r1 \[proposed\]: Draft idea\n {2}criteria not accepted yet/u);
  assert.equal(text.includes("SECRET-DRAFT"), false);
  assert.match(text, /file src\/main\.mjs: main/u);
  assert.match(text, /file src\/export\/pdf\.mjs: renderPdf, PAGE_SIZE/u);
  assert.equal(text.includes("src/other.mjs"), false);
  assert.equal(text.includes("hidden"), false);
  assert.ok(text.indexOf("second run") < text.indexOf("first run"));
  assert.match(text, /blocked_by ST-CTX-000 \[merged\] needs merged/u);
  assert.match(text, /implementation: /u);
  assert.match(text, /run: mpsf story complete-step --id ST-CTX-001 --step implementation/u);
});

test("phase slicing: analysis has no file index or evidence, handoff carries the step summaries", () => {
  const root = fixture();
  const analysis = buildContextPack(contextOf(root), { story: STORY, phase: "analysis", budget: 4000, cache: false });
  assert.deepEqual(analysis.pack.sections.map((section) => section.id), ["story", "requirement", "decisions", "dependencies", "waits", "next"]);
  assert.match(analysis.text, /non-goal: No printing service/u);
  const implementation = buildContextPack(contextOf(root), { story: STORY, phase: "implementation", budget: 4000, cache: false });
  assert.equal(implementation.text.includes("non-goal"), false);
  const handoff = buildContextPack(contextOf(root), { story: STORY, phase: "handoff", budget: 4000, cache: false });
  assert.match(handoff.text, /step design: completed — one module/u);
  assert.notEqual(analysis.pack.pack_hash, implementation.pack.pack_hash);
  assert.throws(() => buildContextPack(contextOf(root), { story: STORY, phase: "marketing", cache: false }), /Unknown phase/u);
  // Without --phase the pack follows the first open lifecycle step.
  assert.equal(buildContextPack(contextOf(root), { story: STORY, cache: false }).pack.phase, "implementation");
});

test("no secret reaches the pack or context get", () => {
  const root = fixture();
  const { text, pack } = buildContextPack(contextOf(root), { story: STORY, phase: "handoff", budget: 8000, cache: false });
  assertNoSecrets(text);
  assertNoSecrets(JSON.stringify(pack));
  assert.match(text, /\[REDACTED\]/u);
  const context = contextOf(root);
  assertNoSecrets(getContextRef(context, "rec:.sdlc/requirements/REQ-CTX-001.json").text);
  assertNoSecrets(getContextRef(context, `trace:${STORY}#TR-2`).text);
  assertNoSecrets(getContextRef(context, `sec:${STORY}/implementation/requirement`).text);
  assertNoSecrets(getContextRef(context, `sec:${STORY}/implementation/story`).text);
});

test("the cache is reused until a record changes or appears", () => {
  const root = fixture();
  const context = contextOf(root);
  const first = buildContextPack(context, { story: STORY, phase: "implementation" });
  assert.equal(first.cache, "miss");
  assert.ok(fs.existsSync(path.join(root, ".sdlc", "cache", "context", STORY, "implementation-2000.json")));
  const second = buildContextPack(context, { story: STORY, phase: "implementation" });
  assert.equal(second.cache, "hit");
  assert.equal(second.text, first.text);
  write(root, `.sdlc/tests/${STORY}-test-run-20261010110000000-bbbbbb.json`, { id: "run-2", outcome: "failed", phase: "implementation", totals: { passed: 2, failed: 2 }, summary: "second run", command: { argv: ["npm", "test"] } });
  const changed = buildContextPack(context, { story: STORY, phase: "implementation" });
  assert.equal(changed.cache, "miss");
  assert.notEqual(changed.pack.pack_hash, first.pack.pack_hash);
  assert.equal(buildContextPack(context, { story: STORY, phase: "implementation" }).cache, "hit");
  write(root, `.sdlc/tests/${STORY}-test-run-20261010120000000-cccccc.json`, { id: "run-3", outcome: "passed", phase: "implementation", totals: { passed: 4, failed: 0 }, summary: "third run", command: { argv: ["npm", "test"] } });
  const added = buildContextPack(context, { story: STORY, phase: "implementation" });
  assert.equal(added.cache, "miss");
  assert.match(added.text, /third run/u);
  write(root, "src/export/csv.mjs", "export function renderCsv() {}\n");
  git(root, "add", "src/export/csv.mjs");
  const newFile = buildContextPack(context, { story: STORY, phase: "implementation" });
  assert.equal(newFile.cache, "miss");
  assert.match(newFile.text, /renderCsv/u);
  // A project whose cache folder is canonical (not derived) is never written to.
  const canonical = { ...context, config: { ...context.config, cache_policy: { derived_directories: ["indexes"] } } };
  assert.equal(buildContextPack(canonical, { story: STORY, phase: "analysis" }).cache, "off");
  assert.equal(fs.existsSync(path.join(root, ".sdlc", "cache", "context", STORY, "analysis-2000.json")), false);
});

test("context get resolves refs and refuses paths outside the records", () => {
  const root = fixture();
  const context = contextOf(root);
  assert.equal(getContextRef(context, "rec:.sdlc/requirements/REQ-CTX-001.json#/acceptance_criteria/0").text, "CA-1 one page per day\n");
  assert.match(getContextRef(context, `trace:${STORY}#TR-1`).text, /Use one module/u);
  assert.match(getContextRef(context, `sec:${STORY}/implementation/requirement`).text, /CA-32 criterion number 32/u);
  assert.match(getContextRef(context, "rec:.sdlc/requirements/REQ-CTX-001.json", { budget: 100 }).text, /truncated at 100 tokens/u);
  for (const ref of ["rec:../outside.json", "rec:src/main.mjs", "rec:.sdlc/../src/main.mjs", "nope:x", `trace:${STORY}#TR-404`]) {
    assert.throws(() => getContextRef(context, ref), Error, ref);
  }
});

test("symbols are names only, never bodies", () => {
  assert.deepEqual(extractSymbols("export default class Big {}\nexport async function go() { return 1; }\ndef run():\n  pass\n", 5), ["Big", "go", "run"]);
  assert.deepEqual(extractSymbols("export const a = 1;\nexport const b = 2;\nexport const c = 3;", 2), ["a", "b"]);
});

test("CLI: context pack --json and context get, compact and deterministic", () => {
  const root = fixture();
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8" });
  const first = run("context", "pack", "--story", STORY, "--phase", "implementation", "--budget", "1200", "--json");
  assert.equal(first.status, 0, first.stderr);
  const parsed = JSON.parse(first.stdout);
  assert.equal(parsed.pack.story_id, STORY);
  assert.ok(parsed.source_tokens > 0);
  assert.ok(parsed.pack_tokens <= 1200 * 1.3);
  const text = run("context", "pack", "--story", STORY, "--phase", "implementation", "--budget", "1200");
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.includes(parsed.pack.pack_hash.slice(0, 12)), true);
  const again = run("context", "pack", "--story", STORY, "--phase", "implementation", "--budget", "1200", "--json");
  assert.equal(JSON.parse(again.stdout).pack.pack_hash, parsed.pack.pack_hash);
  const get = run("context", "get", `sec:${STORY}/implementation/scope`);
  assert.equal(get.status, 0, get.stderr);
  assert.match(get.stdout, /file src\/export\/pdf\.mjs/u);
  const refused = run("context", "get", "rec:../etc/passwd");
  assert.notEqual(refused.status, 0);
});

test("the pack reads through the RecordStore port, with the filesystem as fallback", async () => {
  const { createFsRecordReader, createRecordStoreReader } = await import("../../lib/context/reader.mjs");
  const { readerFactory } = await import("../../lib/context/service.mjs");
  const { assemblePack, collectStoryFacts } = await import("../../lib/context/pack.mjs");
  const { resolveContextPolicy } = await import("../../lib/context/policy.mjs");
  const root = fixture();
  assert.equal(readerFactory(contextOf(root))(root).kind, "record-store:git-sdlc");
  const calls = [];
  const store = {
    id: "memory",
    read(kind, key) {
      calls.push(`read:${kind}`);
      if (kind === "story") return { id: key.id, title: "From the store", status: "ready", phase: "analysis", acceptance_criteria: ["store criterion"], requirement_refs: [] };
      if (kind === "story-step") return { step: key.id, status: "completed", summary: `store ${key.id}` };
      return null;
    },
    list(kind, parent) {
      calls.push(`list:${kind}:${parent.parent}`);
      return ["discovery"];
    },
    readTrace(stream) {
      calls.push(`trace:${stream}`);
      return stream === STORY ? [{ id: "TR-S", story_id: STORY, type: "decision", summary: "Decided in the store", created_at: "2026-10-11T00:00:00Z" }] : [];
    },
  };
  const reader = createRecordStoreReader(store, { fallback: createFsRecordReader(root) });
  const policy = resolveContextPolicy(contextOf(root).config);
  const facts = collectStoryFacts(reader, { storyId: STORY, policy, root });
  const pack = assemblePack(facts, { storyId: STORY, phase: "handoff", budget: 4000, policy });
  const text = pack.sections.flatMap((section) => section.lines).join("\n");
  assert.match(text, /From the store/u);
  assert.match(text, /step discovery: completed — store discovery/u);
  assert.match(text, /Decided in the store/u);
  assert.match(text, /blocked_by ST-CTX-000/u);
  assert.ok(calls.includes("read:story") && calls.includes(`list:story-step:${STORY}`) && calls.includes(`trace:${STORY}`));
  assert.match(reader.observed().files[`.sdlc/stories/${STORY}/story.json`], /^[0-9a-f]{64}$/u);
});
