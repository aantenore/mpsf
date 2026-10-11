import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, describe } from "node:test";
import { fileURLToPath } from "node:url";

import { computeRequirementExecutionProfileHash } from "../lib/autonomy-policy.mjs";
import { computeStableHash } from "../lib/canonical.mjs";
import { buildHelpModel } from "../lib/cli/help.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-${label}-`));
}

function run(args, { cwd = ROOT, input } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    input,
  });
}

function mustRun(args, options) {
  const result = run(args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function documentedExampleArguments(example) {
  const tokens = [...example.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
  assert.equal(tokens.shift(), "mpsf");
  return tokens;
}

function primaryText(stdout, locale = "en") {
  const marker = locale === "it"
    ? "Dettagli tecnici (facoltativi):"
    : "Technical details (optional):";
  assert.match(stdout, new RegExp(marker.replace(/[()]/gu, "\\$&"), "u"));
  return stdout.split(marker)[0];
}

function assertPrimaryHasNoTechnicalJargon(stdout, locale = "en") {
  const primary = primaryText(stdout, locale);
  assert.doesNotMatch(primary, /\b(?:bounded-autonomous|checkpointed|audit_only|host_verified)\b/iu);
  assert.doesNotMatch(primary, /\b(?:REQ|AUT|AUTH|CAP|ST)-[A-Z0-9._-]+\b/u);
  assert.doesNotMatch(primary, /\.sdlc\/|--[a-z][a-z-]*|\b(?:agentic-sdlc|mpsf)\s+[a-z]/iu);
}

test("hierarchical help works outside a project and keeps technical literals secondary", () => {
  const cwd = temporaryDirectory("help");
  const result = mustRun(["help", "autonomy", "delivery", "approve", "--locale", "it"], { cwd });
  assert.match(result.stdout, /^Risultato:/u);
  assert.match(result.stdout, /Risultato:/u);
  assert.match(result.stdout, /Cosa cambia in pratica:/u);
  assert.match(result.stdout, /Cosa devi decidere:/u);
  assert.match(result.stdout, /Cosa resta protetto:/u);
  assert.match(result.stdout, /Prossimo passo:/u);
  assertPrimaryHasNoTechnicalJargon(result.stdout, "it");
  assert.match(result.stdout.split("Dettagli tecnici (facoltativi):")[1], /autonomy delivery approve/u);
  assert.equal(fs.existsSync(path.join(cwd, ".sdlc")), false);
});

test("direct focused help exposes the exact inputs for the core work sequence", () => {
  const cwd = temporaryDirectory("core-work-help");
  const expectations = [
    { command: ["story", "create"], required: ["--id", "--title"], present: ["--acceptance"] },
    { command: ["story", "acceptance", "add"], required: ["--id", "--acceptance"], present: ["--summary"] },
    { command: ["story", "claim"], required: ["--id", "--agent"], present: ["--branch"] },
    { command: ["output", "resolve"], required: ["--story", "--type"], present: [] },
    { command: ["contract", "approve"], required: ["--id"], present: ["--actor-type", "--approval-source", "--approval-evidence", "--standing-approval"] },
    {
      command: ["requirement", "supersede"],
      required: ["--id", "--new-id", "--reason", "--actor-type"],
      present: [
        "--approval-source",
        "--actor-name",
        "--actor-email",
        "--summary",
        "--approval-evidence",
        "--authorization",
        "--host-receipt-file",
      ],
    },
    { command: ["task", "start"], required: [], present: ["--intent-json", "--intent-file", "--contract-id", "--confirm-start"] },
  ];

  for (const expectation of expectations) {
    const payload = JSON.parse(mustRun([...expectation.command, "--help", "--json"], { cwd }).stdout);
    const options = new Map(payload.options.map((entry) => [entry.flag, entry]));
    for (const flag of expectation.required) {
      assert.equal(options.get(flag)?.required, true, `${expectation.command.join(" ")} should require ${flag}`);
    }
    for (const flag of expectation.present) {
      assert.equal(options.has(flag), true, `${expectation.command.join(" ")} should expose ${flag}`);
    }
  }

  const italian = mustRun(["task", "start", "--help", "--locale", "it"], { cwd });
  assertPrimaryHasNoTechnicalJargon(italian.stdout, "it");
  assert.match(italian.stdout.split("Dettagli tecnici (facoltativi):")[1], /--intent-json/u);
  const acceptanceGroup = mustRun(["help", "story", "acceptance", "--locale", "it"], { cwd });
  assert.match(acceptanceGroup.stdout, /Completa i criteri di successo osservabili/u);
  const acceptanceLeaf = JSON.parse(
    mustRun(["help", "story", "acceptance", "add", "--json"], { cwd }).stdout,
  );
  assert.equal(acceptanceLeaf.command.path, "story acceptance add");
  assert.equal(
    acceptanceLeaf.options.find((entry) => entry.flag === "--acceptance")?.required,
    true,
  );
  assert.equal(fs.existsSync(path.join(cwd, ".sdlc")), false);
});

// Merged: the four requirement scenarios below each ran their own init in a fresh directory. They use
// disjoint requirement ids (REQ-BOOKING-001/002, REQ-SCOPE-CANONICAL/EMPTY/ROOT/OUTSIDE/GIT-METADATA,
// REQ-SCOPE-R1..R3, REQ-SCOPE-LEGACY) and only touch their own records, so they share one initialized
// project and run in order. The legacy scenario tampers with its own profile and stays last.
// Help field checks for these commands live in test/unit/cli-help.test.mjs.
describe("requirement and contract commands on one initialized project", () => {
  let cwd;

  before(() => {
    cwd = temporaryDirectory("requirement-agreement");
    mustRun(["init", "--project-name", "Requirement agreement", "--root", cwd]);
  });

  test("requirement and contract help describe commands that run with the documented inputs", () => {
    const proposed = JSON.parse(mustRun([
      "requirement", "propose",
      "--root", cwd,
      "--id", "REQ-BOOKING-001",
      "--title", "Reliable booking confirmation",
      "--summary", "Confirm a booking once and expose a recoverable failure",
      "--acceptance", "A successful request returns one confirmation reference",
      "--autonomy-ceiling", "checkpointed",
      "--write-path", "src",
      "--write-path", "test",
      "--write-path", "evidence",
      "--json",
    ], { cwd }).stdout);
    assert.equal(proposed.status, "proposed");
    assert.deepEqual(
      proposed.autonomy_profile.constraints.allowed_write_paths,
      ["evidence", "src", "test"],
    );
    assert.deepEqual(proposed.warnings, []);

    const approved = JSON.parse(mustRun([
      "requirement", "approve",
      "--root", cwd,
      "--id", "REQ-BOOKING-001",
      "--actor-type", "human",
      "--approval-source", "explicit-user",
      "--summary", "Approved the displayed outcome, checks, limits, and maximum delivery independence",
      "--json",
    ], { cwd }).stdout);
    assert.equal(approved.status, "approved");

    const revised = JSON.parse(mustRun([
      "requirement", "revise",
      "--root", cwd,
      "--id", "REQ-BOOKING-001",
      "--new-id", "REQ-BOOKING-002",
      "--summary", "Confirm a booking once and expose recoverable failures",
      "--json",
    ], { cwd }).stdout);
    assert.equal(revised.status, "proposed");

    const approvedRevision = JSON.parse(mustRun([
      "requirement", "approve",
      "--root", cwd,
      "--id", "REQ-BOOKING-002",
      "--actor-type", "human",
      "--approval-source", "explicit-user",
      "--summary", "Approved the direct revision before replacing the active requirement",
      "--json",
    ], { cwd }).stdout);
    assert.equal(approvedRevision.status, "approved");

    const superseded = JSON.parse(mustRun([
      ...documentedExampleArguments(buildHelpModel(["requirement", "supersede"]).examples[0]),
      "--root", cwd,
      "--json",
    ], { cwd }).stdout);
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.event.requirement_ref.id, "REQ-BOOKING-001");
    assert.equal(superseded.event.replacement_ref.id, "REQ-BOOKING-002");

    const contract = JSON.parse(mustRun([
      "contract", "create",
      "--root", cwd,
      "--id", "CONTRACT-BOOKING-DESIGN-001",
      "--phase", "design",
      "--context-summary", "Use the agreed booking outcome and current API boundaries",
      "--validation", "Review the result against the agreed acceptance criteria",
      "--json",
    ], { cwd }).stdout);
    assert.equal(contract.contract.id, "CONTRACT-BOOKING-DESIGN-001");
    assert.equal(contract.contract.status, "draft");
  });

  test("requirement write paths become Git-relative and invalid root or outside scopes leave no proposal", () => {
    const proposed = JSON.parse(mustRun([
      "requirement", "propose",
      "--root", cwd,
      "--id", "REQ-SCOPE-CANONICAL",
      "--title", "Canonical project scope",
      "--summary", "Change only the named project areas",
      "--acceptance", "The named project areas contain the verified result",
      "--autonomy-ceiling", "checkpointed",
      "--write-path", `${cwd}/src/../src`,
      "--write-path", "./test",
      "--write-path", "src",
      "--json",
    ], { cwd }).stdout);
    assert.deepEqual(proposed.autonomy_profile.material_scope.write_paths, ["src", "test"]);
    assert.deepEqual(proposed.autonomy_profile.constraints.allowed_write_paths, ["src", "test"]);
    assert.deepEqual(proposed.warnings, []);

    const empty = JSON.parse(mustRun([
      "requirement", "propose",
      "--root", cwd,
      "--id", "REQ-SCOPE-EMPTY",
      "--title", "Empty project scope",
      "--summary", "Describe an outcome before its file areas are known",
      "--acceptance", "A later revision names every area that may change",
      "--autonomy-ceiling", "supervised",
      "--locale", "it",
      "--json",
    ], { cwd }).stdout);
    assert.equal(empty.warnings.length, 1);
    assert.match(empty.warnings[0], /scope di scrittura.*vuoto/iu);

    for (const [id, rejectedPath, message] of [
      ["REQ-SCOPE-ROOT", cwd, /project root itself/u],
      ["REQ-SCOPE-OUTSIDE", path.join(os.tmpdir(), "agentic-sdlc-outside-scope"), /inside the target project root/u],
      ["REQ-SCOPE-GIT-METADATA", ".git/index", /cannot include Git repository metadata/u],
    ]) {
      const rejected = run([
        "requirement", "propose",
        "--root", cwd,
        "--id", id,
        "--title", "Rejected project scope",
        "--summary", "This proposal must remain atomic",
        "--acceptance", "No partial requirement or profile is written",
        "--autonomy-ceiling", "supervised",
        "--write-path", rejectedPath,
        "--json",
      ], { cwd });
      assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
      assert.match(rejected.stderr, message);
      assert.equal(fs.existsSync(path.join(cwd, ".sdlc", "requirements", `${id}.json`)), false);
      assert.equal(
        fs.existsSync(path.join(cwd, ".sdlc", "autonomy", "requirements", `AUT-${id}-R1.json`)),
        false,
      );
    }
  });

  test("requirement revise inherits write scope when omitted and replaces it when explicit", () => {
    const proposed = JSON.parse(mustRun([
      "requirement", "propose",
      "--root", cwd,
      "--id", "REQ-SCOPE-R1",
      "--title", "Initial project scope",
      "--summary", "Change source and tests",
      "--acceptance", "Source and tests prove the result",
      "--autonomy-ceiling", "checkpointed",
      "--write-path", path.join(cwd, "src"),
      "--write-path", "test",
      "--json",
    ], { cwd }).stdout);
    assert.deepEqual(proposed.autonomy_profile.constraints.allowed_write_paths, ["src", "test"]);

    const inherited = JSON.parse(mustRun([
      "requirement", "revise",
      "--root", cwd,
      "--id", "REQ-SCOPE-R1",
      "--new-id", "REQ-SCOPE-R2",
      "--summary", "Keep the same file boundary while refining the outcome",
      "--json",
    ], { cwd }).stdout);
    assert.deepEqual(inherited.autonomy_profile.material_scope.write_paths, ["src", "test"]);
    assert.deepEqual(inherited.autonomy_profile.constraints.allowed_write_paths, ["src", "test"]);

    const replaced = JSON.parse(mustRun([
      "requirement", "revise",
      "--root", cwd,
      "--id", "REQ-SCOPE-R2",
      "--new-id", "REQ-SCOPE-R3",
      "--summary", "Replace the file boundary explicitly",
      "--write-path", "docs",
      "--write-path", path.join(cwd, "evidence"),
      "--json",
    ], { cwd }).stdout);
    assert.deepEqual(replaced.autonomy_profile.material_scope.write_paths, ["docs", "evidence"]);
    assert.deepEqual(replaced.autonomy_profile.constraints.allowed_write_paths, ["docs", "evidence"]);
    assert.equal(replaced.autonomy_profile.constraints.allowed_write_paths.includes("src"), false);
  });

  test("approval rejects a legacy non-canonical requirement scope without rewriting it", () => {
    const proposed = JSON.parse(mustRun([
      "requirement", "propose",
      "--root", cwd,
      "--id", "REQ-SCOPE-LEGACY",
      "--title", "Legacy absolute scope",
      "--summary", "Preserve an old proposal until an explicit revision",
      "--acceptance", "Approval fails closed without rewriting the proposal",
      "--autonomy-ceiling", "checkpointed",
      "--write-path", "src",
      "--json",
    ], { cwd }).stdout);
    const requirementPath = path.join(cwd, proposed.requirement_path);
    const profilePath = path.join(cwd, proposed.autonomy_profile_path);
    const legacyProfile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    const absoluteSource = path.join(cwd, "src");
    legacyProfile.material_scope.write_paths = [absoluteSource];
    legacyProfile.material_scope_hash = computeStableHash(legacyProfile.material_scope);
    legacyProfile.constraints.allowed_write_paths = [absoluteSource];
    legacyProfile.profile_hash = computeRequirementExecutionProfileHash(legacyProfile);
    fs.writeFileSync(profilePath, `${JSON.stringify(legacyProfile, null, 2)}\n`, "utf8");

    const requirementBefore = fs.readFileSync(requirementPath, "utf8");
    const profileBefore = fs.readFileSync(profilePath, "utf8");
    const rejected = run([
      "requirement", "approve",
      "--root", cwd,
      "--id", "REQ-SCOPE-LEGACY",
      "--actor-type", "human",
      "--approval-source", "explicit-user",
      "--summary", "Approve the displayed legacy proposal",
      "--json",
    ], { cwd });
    assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
    assert.match(rejected.stderr, /non-canonical write scope/u);
    assert.match(rejected.stderr, /without rewriting either proposal/u);
    assert.equal(fs.readFileSync(requirementPath, "utf8"), requirementBefore);
    assert.equal(fs.readFileSync(profilePath, "utf8"), profileBefore);
  });
});

test("completion is deterministic, static, redirectable, and project-free", () => {
  const cwd = temporaryDirectory("completion");
  const first = mustRun(["completion", "bash"], { cwd }).stdout;
  const second = mustRun(["completion", "bash"], { cwd }).stdout;
  assert.equal(first, second);
  assert.match(first, /complete -F/u);
  assert.doesNotMatch(first, /\beval\b|\$\([^)]*\)|`[^`]*`/u);
  const syntax = spawnSync("bash", ["-n"], { encoding: "utf8", input: first });
  if (syntax.error?.code !== "ENOENT") assert.equal(syntax.status, 0, syntax.stderr);
  const probe = spawnSync("bash", ["-s"], { encoding: "utf8", input: [
    first,
    "COMP_WORDS=(mpsf autonomy delivery action '')",
    "COMP_CWORD=4",
    "_agentic_sdlc_completion",
    "printf '%s\\n' \"${COMPREPLY[@]}\"",
  ].join("\n") });
  if (probe.error?.code !== "ENOENT") {
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /^--action$/mu);
    assert.match(probe.stdout, /^--outcome$/mu);
    assert.match(probe.stdout, /^--evidence$/mu);
    assert.doesNotMatch(probe.stdout, /^approve$/mu);
  }
  const rootProbe = spawnSync("bash", ["-s"], { encoding: "utf8", input: [
    first,
    "COMP_WORDS=(mpsf '')",
    "COMP_CWORD=1",
    "_agentic_sdlc_completion",
    "printf '%s\\n' \"${COMPREPLY[@]}\"",
  ].join("\n") });
  if (rootProbe.error?.code !== "ENOENT") {
    assert.equal(rootProbe.status, 0, rootProbe.stderr);
    assert.match(rootProbe.stdout, /^autonomy$/mu);
    assert.match(rootProbe.stdout, /^status$/mu);
    assert.doesNotMatch(rootProbe.stdout, /^(?:action|approve|propose)$/mu);
  }
  const envelope = JSON.parse(mustRun(["completion", "powershell", "--json"], { cwd }).stdout);
  assert.equal(envelope.shell, "powershell");
  assert.match(envelope.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(fs.existsSync(path.join(cwd, ".sdlc")), false);
});

test("presentation presets compose deterministically and cannot authorize or widen work", () => {
  const cwd = temporaryDirectory("presets");
  for (const [name, options] of [
    ["authority", { authorization: "AUTH-NOT-ALLOWED" }],
    ["view", { view: "dev" }],
    ["limit", { limit: 1 }],
  ]) {
    const unsafe = path.join(cwd, `unsafe-${name}.json`);
    fs.writeFileSync(unsafe, `${JSON.stringify(options)}\n`, "utf8");
    const rejected = run(["status", "--cli-preset", `@${unsafe}`], { cwd });
    // An unusable preset is a usage error: exit 2, not a refused request.
    assert.equal(rejected.status, 2, name);
    assert.match(rejected.stderr, /Technical details \(optional\):/u);
    assert.match(rejected.stderr, new RegExp(`cannot set '${Object.keys(options)[0]}'`, "u"));
  }
  assert.equal(fs.existsSync(path.join(cwd, ".sdlc")), false);

  const firstExport = mustRun(["preset", "export", "human-it", "diagnostic"], { cwd }).stdout;
  const secondExport = mustRun(["preset", "export", "human-it", "diagnostic"], { cwd }).stdout;
  assert.equal(firstExport, secondExport);
  const exported = JSON.parse(firstExport);
  assert.equal(exported.schema_version, "agentic-sdlc-cli-preset-v1");
  assert.deepEqual(exported.options, { full: true, json: true, locale: "it" });

  const exportedPath = path.join(cwd, "exported.json");
  fs.writeFileSync(exportedPath, firstExport, "utf8");
  const roundTrip = mustRun(["preset", "export", `@${exportedPath}`], { cwd }).stdout;
  assert.equal(roundTrip, firstExport);
});

test("machine preset preserves status compatibility and explicit CLI options win", () => {
  const cwd = temporaryDirectory("status");
  mustRun(["init", "--project-name", "Preset status", "--root", cwd]);
  const machine = JSON.parse(mustRun(["status", "--root", cwd, "--cli-preset", "machine"]).stdout);
  assert.equal(machine.schema_version, "cli-status:v1");
  assert.ok(machine.project);
  assert.ok(machine.counts);
  assert.ok(machine.summary);
  assert.ok(machine.next_action);

  const explicitEnglish = mustRun([
    "status",
    "--root", cwd,
    "--cli-preset", "human-it",
    "--locale", "en",
  ]).stdout;
  assert.match(explicitEnglish, /^Outcome:/u);
  assert.doesNotMatch(explicitEnglish, /^Risultato:/u);
  assertPrimaryHasNoTechnicalJargon(explicitEnglish, "en");

  const activity = JSON.parse(mustRun([
    "report", "activity",
    "--root", cwd,
    "--view", "dev",
    "--json",
  ]).stdout);
  assert.equal(activity.view, "dev", "explicit --view remains a runtime option");

  const decisions = path.join(cwd, ".sdlc", "decisions");
  fs.writeFileSync(path.join(decisions, "DEC-FIRST.json"), `${JSON.stringify({ id: "DEC-FIRST", summary: "explicit-limit-probe" })}\n`, "utf8");
  fs.writeFileSync(path.join(decisions, "DEC-SECOND.json"), `${JSON.stringify({ id: "DEC-SECOND", summary: "explicit-limit-probe" })}\n`, "utf8");
  mustRun(["index", "rebuild", "--root", cwd]);
  const search = JSON.parse(mustRun([
    "kb", "search", "explicit-limit-probe",
    "--root", cwd,
    "--limit", "1",
    "--json",
  ]).stdout);
  assert.equal(search.results.length, 1, "explicit --limit still controls result count");
});

test("trace append help example uses a runtime-valid mandatory and operational flag set", () => {
  const cwd = temporaryDirectory("trace-help");
  mustRun(["init", "--project-name", "Trace help", "--root", cwd]);
  const result = JSON.parse(mustRun([
    "trace", "append",
    "--root", cwd,
    "--type", "decision",
    "--summary", "Approved the exact implementation boundary",
    "--outcome", "ready",
    "--action", "requirement.approve",
    "--related", "REQ-001",
    "--actor-type", "human",
    "--json",
  ]).stdout);
  assert.equal(result.status, "appended");
  assert.equal(result.event.type, "decision");
  assert.equal(result.event.outcome, "ready");
  assert.equal(result.event.action, "requirement.approve");
  assert.deepEqual(result.event.related, ["REQ-001"]);
  assert.equal(result.event.actor.type, "human");
});

test("machine mode returns one stable JSON error envelope", () => {
  const cwd = temporaryDirectory("json-errors");
  // The envelope's error code and the exit code report the same category:
  // an unresolvable command, preset, option, or locale exits 2.
  const cases = [
    { args: ["help", "not-a-command", "--json=true"], code: "UNKNOWN_COMMAND", status: 2 },
    { args: ["preset", "show", "not-a-preset", "--json", "true"], code: "CLI_PRESET_ERROR", status: 2 },
    { args: ["--version", "--locale", "fr", "--json=true"], code: "USAGE_ERROR", status: 2 },
    { args: ["--not-a-real-option", "--json=true"], code: "USAGE_ERROR", status: 2 },
    { args: ["--not-a-real-option", "--json", "true"], code: "USAGE_ERROR", status: 2 },
  ];
  for (const entry of cases) {
    const result = run(entry.args, { cwd });
    assert.equal(result.status, entry.status, `${entry.code}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.schema_version, "agentic-sdlc-cli-error:v1");
    assert.equal(payload.status, "error");
    assert.equal(payload.error.code, entry.code);
    assert.equal(typeof payload.error.message, "string");
    assert.deepEqual(Object.keys(payload.human_guidance), [
      "result",
      "impact",
      "required_decision",
      "protection_boundary",
      "next_action",
      "details",
    ]);
  }
  assert.equal(fs.existsSync(path.join(cwd, ".sdlc")), false);
});
