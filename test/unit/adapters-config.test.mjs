import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdapterConfigError, resolveAdapters, resolveCredential } from "../../lib/adapters/config.mjs";
import { resolveMessagingConfig } from "../../lib/messaging/config.mjs";
import { messageRead, messageSend, messageStatus } from "../../lib/messaging/commands.mjs";

function clone({ adapters } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-adapters-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".sdlc"));
  if (adapters) fs.writeFileSync(path.join(root, ".sdlc/config.json"), JSON.stringify({ host_policy: { adapters } }));
  return root;
}

function quietly(action) {
  const log = console.log;
  console.log = () => {};
  return Promise.resolve().then(action).finally(() => {
    console.log = log;
  });
}

test("without adapter settings the defaults are the GitHub channel and the git .sdlc folder", () => {
  const adapters = resolveAdapters({});
  assert.equal(adapters.messaging.provider, "github");
  assert.equal(adapters.records.provider, "git-sdlc");
});

test("an unknown provider is refused, never replaced by the default", () => {
  assert.throws(() => resolveAdapters({ host_policy: { adapters: { records: { provider: "nowhere" } } } }, { known: { records: ["git-sdlc"] } }), AdapterConfigError);
  assert.throws(() => resolveAdapters({ host_policy: { adapters: { mail: { provider: "x" } } } }), /not a known port/u);
});

test("options never hold a credential: only references are accepted", () => {
  const ok = resolveAdapters({ host_policy: { adapters: { messaging: { provider: "github", options: { token_env: "TEAM_CHAT_TOKEN", webhook_ref: "keychain:team-chat", channel: "#delivery" } } } } });
  assert.equal(ok.messaging.options.channel, "#delivery");
  assert.throws(() => resolveAdapters({ host_policy: { adapters: { messaging: { provider: "github", options: { token: "xoxb-123" } } } } }), /token_env/u);
  assert.throws(() => resolveAdapters({ host_policy: { adapters: { messaging: { provider: "github", options: { token_env: "xoxb-123-lower" } } } } }), /environment variable/u);
  assert.throws(() => resolveAdapters({ host_policy: { adapters: { records: { provider: "git-sdlc", options: { note: "ghp_0123456789abcdefghijklmnopqrstuvwxyz" } } } } }), /credential/u);
  assert.equal(resolveCredential({ token_env: "TEAM_CHAT_TOKEN" }, "token", { TEAM_CHAT_TOKEN: "v" }), "v");
  assert.equal(resolveCredential({ token_env: "TEAM_CHAT_TOKEN" }, "token", {}), null);
});

test("messaging provider none turns messaging off from any source", () => {
  const root = clone();
  assert.equal(resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING_PROVIDER: "none", AGENTIC_SDLC_MESSAGING_REPO: "acme/shop" }).enabled, false);
  const fromConfig = clone({ adapters: { messaging: { provider: "none" } } });
  const config = resolveMessagingConfig(fromConfig, {});
  assert.equal(config.enabled, false);
  assert.match(config.reason, /none/u);
});

test("the local provider needs no repository; its folder comes from the adapter options", () => {
  const root = clone({ adapters: { messaging: { provider: "file", options: { dir: "shared-channel" } } } });
  const config = resolveMessagingConfig(root, {});
  assert.equal(config.enabled, true);
  assert.equal(config.provider, "local");
  assert.equal(config.local_dir, path.join(root, "shared-channel"));
  const env = resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING_LOCAL_DIR: "/tmp/elsewhere" });
  // Resolved against the project root, which on Windows can sit on another drive than the working directory.
  assert.equal(env.local_dir, path.resolve(root, "/tmp/elsewhere"));
});

test("send and read work end to end through the local provider", async () => {
  const root = clone({ adapters: { messaging: { provider: "local" } } });
  const env = { AGENTIC_SDLC_HOST_LABEL: "PC1", AGENTIC_SDLC_MESSAGING_JOIN: "off" };
  const sent = await quietly(() => messageSend({ root, text: "build is green", kind: "info", json: true }, env));
  assert.equal(sent.sent, true);
  const read = await quietly(() => messageRead({ root, since: "all", json: true }, env));
  assert.ok(read.messages.some((item) => item.text === "build is green" && item.host === "PC1"));
  const status = await quietly(() => messageStatus({ root, json: true }, env));
  assert.equal(status.provider, "local");
});
