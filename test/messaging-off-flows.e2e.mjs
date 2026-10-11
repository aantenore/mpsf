import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_HOSTS, AGENT_HOST_OVERRIDE_ENV } from "../lib/agent-host.mjs";
import { installFakeGh } from "./helpers/fake-gh.mjs";

/**
 * Messaging only notifies. With the `none` messaging provider the main
 * coordination flows (claim, release, explicit waits, records publication)
 * work exactly the same and never reach the messaging transport: their
 * state lives in the record store (claims and waits as shared refs, records
 * as commits). The channel settings below would turn the GitHub channel on;
 * a fake `gh` on PATH records every call, so a single message would show.
 */
const CLI = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "bin", "agentic-sdlc.mjs");
const TEMPORARY = new Set();
const ISOLATED = ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", AGENT_HOST_OVERRIDE_ENV, ...AGENT_HOSTS.flatMap((host) => [...host.markers, ...Object.values(host.env).filter(Boolean)])];

after(() => {
  for (const directory of TEMPORARY) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-nomsg-${label}-`));
  TEMPORARY.add(directory);
  return directory;
}

const fakeGh = installFakeGh(temporaryDirectory("gh"), { issues: [{ number: 1, title: "channel", state: "open", labels: [{ name: "agentic-sdlc-channel" }] }], nextIssue: 2 });
const MESSAGING_OFF = {
  ...fakeGh.env,
  AGENTIC_SDLC_MESSAGING_REPO: "acme/shop",
  AGENTIC_SDLC_MESSAGING_ISSUE: "1",
  AGENTIC_SDLC_MESSAGING_PROVIDER: "none",
};

function run(args, project, env = {}) {
  const base = { ...process.env };
  for (const key of ISOLATED) delete base[key];
  const host = /-second-/u.test(path.basename(project)) ? "pc-second" : "pc-first";
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf8",
    env: { ...base, AGENTIC_SDLC_PROGRESS: "off", AGENTIC_SDLC_HOST_LABEL: host, ...MESSAGING_OFF, ...env },
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, project) {
  const result = run(args, project);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

const mustRunJson = (args, project) => JSON.parse(mustRun([...args, "--json"], project).stdout);

function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

const human = (summary) => ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];

function prepareStory(project, storyId) {
  mustRun(["output", "template", "propose", "--root", project, "--type", "functional-analysis", "--summary", "Standard template"], project);
  mustRun(["output", "template", "approve", "--root", project, "--id", "functional-analysis-v1", ...human("Approve the template")], project);
  mustRun(["story", "create", "--no-derived-verification", "--root", project, "--id", storyId, "--title", `Story ${storyId}`, "--acceptance", "The result is observable", "--phase", "design", "--status", "ready"], project);
  mustRun(["contract", "create", "--root", project, "--phase", "design", "--story", storyId, "--id", `contract-${storyId}-design`, "--context-summary", "Design the story", "--qa", "Who approves?|Owner", "--output-ref", "functional-analysis:functional-analysis-v1:new", "--force"], project);
  mustRun(["contract", "approve", "--root", project, "--id", `contract-${storyId}-design`, ...human("Approve the contract")], project);
  const intent = JSON.stringify({ requested_action: "implement_story", confidence: 0.95, referenced_entities: [{ type: "story", id: storyId }], provided_artifacts: [], missing_context: [], proposed_phase: "design", artifact_type: null, skip_phases: [] });
  mustRun(["task", "start", "--root", project, "--story", storyId, "--intent-json", intent, "--confirm-start", "--actor-type", "human"], project);
}

function configureClone(project) {
  git(project, ["config", "user.name", "No Messaging E2E"]);
  git(project, ["config", "user.email", "nomsg-e2e@example.invalid"]);
  git(project, ["config", "commit.gpgSign", "false"]);
}

function sharedProject(label, storyId) {
  const first = temporaryDirectory(`${label}-first`);
  mustRun(["init", "--root", first, "--project-name", "No messaging"], first);
  git(first, ["init", "--quiet"]);
  git(first, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  configureClone(first);
  prepareStory(first, storyId);
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "test: approved story"]);
  const remote = temporaryDirectory(`${label}-remote`);
  git(remote, ["init", "--quiet", "--bare"]);
  git(first, ["remote", "add", "origin", remote]);
  git(first, ["push", "--quiet", "origin", "main"]);
  const second = temporaryDirectory(`${label}-second`);
  fs.rmSync(second, { recursive: true, force: true });
  assert.equal(spawnSync("git", ["clone", "--quiet", "--branch", "main", remote, second], { encoding: "utf8" }).status, 0);
  configureClone(second);
  for (const clone of [first, second]) git(clone, ["remote", "set-head", "origin", "main"]);
  return { first, second, remote };
}

function messagingCalls() {
  return fakeGh.read().calls.filter((args) => args.some((arg) => /issues|comments|user/u.test(String(arg))));
}

test("claim, release, waits and records publication work with messaging off and send nothing", () => {
  const { first, second, remote } = sharedProject("flows", "ST-1");
  const claim = (project, agent) => ["story", "claim", "--root", project, "--id", "ST-1", "--agent", agent, "--branch", "feature/ST-1"];

  // Claim: the shared ref decides, not a message.
  assert.equal(mustRunJson(claim(first, "alice"), first).claim.shared_claim.epoch, 1);
  const held = run([...claim(second, "bob"), "--json"], second);
  assert.notEqual(held.status, 0);
  assert.equal(JSON.parse(held.stdout || held.stderr).error.code, "STORY_CLAIM_HELD_ELSEWHERE");
  assert.match(spawnSync("git", ["ls-remote", remote, "refs/agentic-sdlc/claims/*"], { encoding: "utf8" }).stdout, /claims\/ST-1\/000001\/claim/u);

  // Explicit waits: written as shared records, seen by the other computer, resolved once.
  const added = mustRunJson(["wait", "add", "--root", second, "--on", "story:ST-1", "--until", "1h", "--reason", "needs ST-1"], second);
  assert.equal(added.shared.status, "shared");
  const seen = mustRunJson(["wait", "list", "--root", first], first);
  assert.ok(JSON.stringify(seen).includes(added.id), JSON.stringify(seen));
  assert.equal(mustRunJson(["wait", "resolve", "--root", first, "--id", added.id, "--resolution", "ST-1 is moving"], first).status, "resolved");
  assert.equal(mustRunJson(["wait", "resolve", "--root", second, "--id", added.id, "--resolution", "again"], second).status, "already_resolved");

  // Work, merge, release, then publish the records: one commit on its own branch.
  git(first, ["checkout", "--quiet", "-b", "feature/ST-1"]);
  fs.mkdirSync(path.join(first, "src"), { recursive: true });
  fs.writeFileSync(path.join(first, "src", "feature.mjs"), "export const feature = true;\n", "utf8");
  git(first, ["add", "src/feature.mjs"]);
  git(first, ["commit", "--quiet", "-m", "feat: feature"]);
  git(first, ["push", "--quiet", "origin", "feature/ST-1"]);
  git(second, ["fetch", "--quiet", "origin"]);
  git(second, ["merge", "--quiet", "--no-ff", "-m", "Merge pull request #1 from acme/feature/ST-1", "origin/feature/ST-1"]);
  git(second, ["push", "--quiet", "origin", "main"]);
  assert.equal(mustRunJson(["story", "release", "--root", first, "--id", "ST-1", "--reason", "Merged"], first).shared_release.status, "shared");
  const published = mustRunJson(["story", "publish-records", "--root", first, "--id", "ST-1"], first);
  assert.equal(published.status, "published");
  assert.ok(published.published.includes(".sdlc/stories/ST-1/claim.json"), JSON.stringify(published.published));

  // Messaging status says it is off, and nothing reached the transport.
  const status = mustRunJson(["message", "status", "--root", first], first);
  assert.equal(status.enabled, false);
  assert.match(status.reason, /none/u);
  assert.deepEqual(messagingCalls(), []);

  // Control: the same settings with the GitHub provider do reach the (fake) transport.
  const sent = run(["message", "send", "--root", first, "--text", "control", "--json"], first, { AGENTIC_SDLC_MESSAGING_PROVIDER: "github", AGENTIC_SDLC_MESSAGING_JOIN: "off" });
  assert.equal(sent.status, 0, sent.stderr);
  assert.ok(messagingCalls().length > 0);
});
