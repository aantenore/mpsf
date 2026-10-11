import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertMessagingProvider } from "../../lib/adapters/messaging/port.mjs";
import { MESSAGING_PROVIDERS } from "../../lib/adapters/messaging/registry.mjs";
import { createGitProvider } from "../../lib/messaging/providers/git.mjs";
import { createGithubProvider } from "../../lib/messaging/providers/github.mjs";
import { createLocalProvider } from "../../lib/messaging/providers/local.mjs";
import { createNoneProvider } from "../../lib/messaging/providers/none.mjs";
import { createFakeGh } from "../helpers/fake-gh.mjs";
import { createBareOrigin, createFixtureDir } from "../helpers/test-isolation.mjs";
import { spawnSync } from "node:child_process";
import { runMessagingContract } from "../helpers/messaging-contract.mjs";
import { cursorOf } from "../../lib/messaging/cursor.mjs";

runMessagingContract("github", async () => {
  const fake = createFakeGh({ issues: [{ number: 1, title: "channel", state: "open", labels: [{ name: "agentic-sdlc-channel" }] }], nextIssue: 2 });
  return { provider: createGithubProvider({ exec: fake.exec, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))) }), config: { repo: "acme/shop", issue: 1, local_path: null } };
});

runMessagingContract("local", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentic-local-channel-")), "channel");
  return { provider: createLocalProvider(), config: { provider: "local", local_dir: dir } };
});

function gitClone(origin) {
  const dir = createFixtureDir("agentic-git-channel-");
  spawnSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  if (origin) spawnSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return dir;
}

runMessagingContract("git", async () => {
  const root = gitClone(null);
  createBareOrigin(root);
  return { provider: createGitProvider(), config: { provider: "git", root, remote: "origin" } };
});

test("git: messages cross clones, are signed, and a late push is still delivered", async () => {
  const first = gitClone(null);
  const bare = createBareOrigin(first);
  const second = gitClone(bare);
  let clock = Date.parse("2026-10-11T10:00:00Z");
  const now = () => clock;
  const writer = createGitProvider({ now });
  const reader = createGitProvider({ now });
  const a = await writer.publish({ config: { root: first }, message: { from: "A", text: "hello", kind: "question" } });
  const got = await reader.poll({ config: { root: second }, since: "all", force: true });
  assert.deepEqual(got.map((m) => m.text), ["hello"]);
  assert.equal(got[0].id, a.id);
  assert.equal(got[0].trust, "trusted"); // same computer key in tests
  const cursor = cursorOf(got[0]);
  // The second clone answers; the first clone, with an older clock, writes later.
  await reader.publish({ config: { root: second }, message: { from: "B", text: "answer", kind: "answer", replyTo: a.id } });
  clock -= 60_000;
  await writer.publish({ config: { root: first }, message: { from: "A", text: "late" } });
  clock += 120_000;
  const later = await reader.poll({ config: { root: second }, since: cursor, force: true });
  assert.deepEqual(later.map((m) => m.text).sort(), ["answer", "late"]);
  assert.equal(later.find((m) => m.text === "answer").reply_to, a.id);
});

test("git: a tampered message reads as untrusted", async () => {
  const root = gitClone(null);
  createBareOrigin(root);
  const provider = createGitProvider();
  await provider.publish({ config: { root }, message: { from: "A", text: "real" } });
  const { signedTrust } = await import("../../lib/messaging/signature.mjs");
  const [read] = await provider.poll({ config: { root }, since: "all", force: true });
  assert.equal(read.trust, "trusted");
  const log = spawnSync("git", ["log", "-1", "--format=%B", "refs/agentic-sdlc/channel-remote/" + read.machine], { cwd: root, encoding: "utf8" }).stdout;
  const payload = JSON.parse(log.slice(log.indexOf("{")));
  assert.equal(signedTrust({ ...payload, text: "forged" }), "untrusted");
  assert.equal(signedTrust(payload, { own: null }), "unverified");
});

test("git: a host that refuses custom refs gets branches, and old messages are compacted", async () => {
  const root = gitClone(null);
  const bare = createBareOrigin(root);
  fs.writeFileSync(path.join(bare, "hooks", "pre-receive"), "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/agentic-sdlc/*) echo denied >&2; exit 1;; esac; done\nexit 0\n", { mode: 0o755 });
  spawnSync("git", ["config", "core.hooksPath", path.join(bare, "hooks")], { cwd: bare });
  let clock = Date.parse("2026-09-01T10:00:00Z");
  const provider = createGitProvider({ now: () => clock });
  await provider.publish({ config: { root }, message: { from: "A", text: "old" } });
  const branches = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads/agentic-sdlc/channel"], { cwd: bare, encoding: "utf8" }).stdout.trim();
  assert.match(branches, /^refs\/heads\/agentic-sdlc\/channel\//u);
  const subject = spawnSync("git", ["log", "-1", "--format=%s", branches], { cwd: bare, encoding: "utf8" }).stdout;
  assert.match(subject, /\[skip ci\]/u);
  clock += 20 * 86_400_000;
  await provider.publish({ config: { root }, message: { from: "A", text: "new" } });
  const count = spawnSync("git", ["rev-list", "--count", branches], { cwd: bare, encoding: "utf8" }).stdout.trim();
  assert.equal(count, "1");
  const other = gitClone(bare);
  const read = await createGitProvider({ now: () => clock }).poll({ config: { root: other }, since: "all", force: true });
  assert.deepEqual(read.map((m) => m.text), ["new"]);
});

test("git: message setup picks git for a new channel, proposes the key, and status shows it", async () => {
  const { messageSetup, messageStatus, formatMessage } = await import("../../lib/messaging/commands.mjs");
  const root = gitClone(null);
  createBareOrigin(root);
  const env = { ...process.env, AGENTIC_SDLC_MESSAGING_AUTO: "off", AGENTIC_SDLC_MESSAGING_JOIN: "off" };
  const log = console.log;
  console.log = () => {};
  try {
    const setup = await messageSetup({ root, json: true }, env);
    assert.equal(setup.provider, "git");
    assert.equal(setup.machine_key.written, true);
    assert.ok(fs.existsSync(path.join(root, setup.machine_key.path)));
    const status = messageStatus({ root, json: true }, env);
    assert.equal(status.provider, "git");
    assert.equal(status.machine_key.registered, true);
  } finally {
    console.log = log;
  }
  assert.match(formatMessage({ from: "X", text: "hi", trust: "untrusted" }, "me"), /\[untrusted\]/u);
  assert.doesNotMatch(formatMessage({ from: "X", text: "hi", trust: "trusted" }, "me"), /trusted/u);
});

test("github: agent comments are signed; hand-written ones are trusted only from repository members", async () => {
  const { toGithubBody, fromGithubComment } = await import("../../lib/messaging/providers/github.mjs");
  const { signFields, trustContext } = await import("../../lib/messaging/signature.mjs");
  const message = { from: "A", host: "pc-1", text: "ciao", kind: "question", replyTo: null, to: null, version: "1.0.0", stories: null };
  const signature = signFields({ mid: "abc", ...message, reply_to: null });
  const body = toGithubBody(message, "abc", signature);
  const trust = trustContext(null);
  const comment = (extra) => ({ id: 7, created_at: "2026-01-01T00:00:00Z", user: { login: "x" }, ...extra });
  assert.equal(fromGithubComment(comment({ body, author_association: "NONE" }), trust).trust, "trusted");
  assert.equal(fromGithubComment(comment({ body: body.replace("ciao", "forged"), author_association: "OWNER" }), trust).trust, "untrusted");
  assert.equal(fromGithubComment(comment({ body: "hand written", author_association: "COLLABORATOR" }), trust).trust, "trusted");
  assert.equal(fromGithubComment(comment({ body: "hand written", author_association: "NONE" }), trust).trust, "untrusted");
  assert.equal(fromGithubComment(comment({ body, author_association: "NONE" })).trust, undefined);
});

test("every registered provider implements the port", () => {
  for (const [id, factory] of Object.entries(MESSAGING_PROVIDERS)) {
    const provider = assertMessagingProvider(factory());
    assert.equal(provider.id, id);
  }
});

test("none: publishing is dropped and reading finds nothing", async () => {
  const provider = createNoneProvider();
  const sent = await provider.publish({ config: {}, message: { text: "x" } });
  assert.equal(sent.id, null);
  assert.deepEqual(await provider.poll({ config: {}, since: "all" }), []);
  const controller = new AbortController();
  controller.abort();
  await provider.subscribe({ config: {}, signal: controller.signal, onMessage: () => assert.fail("no message expected") });
});

test("local: a damaged line is skipped and parallel writers get distinct ids", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-local-channel-"));
  const config = { local_dir: dir };
  const provider = createLocalProvider();
  await provider.publish({ config, message: { text: "a", from: "x" } });
  fs.appendFileSync(path.join(dir, "channel.jsonl"), "{not json\n");
  const sent = await Promise.all(Array.from({ length: 8 }, (_, index) => provider.publish({ config, message: { text: `p${index}`, from: "x" } })));
  assert.equal(new Set(sent.map((item) => item.id)).size, 8);
  const all = await provider.poll({ config, since: "all" });
  assert.equal(all.length, 9);
});

test("local: a missing folder setting is a temporary (setup) failure, so the outbox keeps the message", async () => {
  const provider = createLocalProvider();
  await assert.rejects(provider.publish({ config: {}, message: { text: "x" } }), (error) => error.setup === true);
});
