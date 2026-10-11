import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertMessagingProvider } from "../../lib/adapters/messaging/port.mjs";
import { MESSAGING_PROVIDERS } from "../../lib/adapters/messaging/registry.mjs";
import { createGithubProvider } from "../../lib/messaging/providers/github.mjs";
import { createLocalProvider } from "../../lib/messaging/providers/local.mjs";
import { createNoneProvider } from "../../lib/messaging/providers/none.mjs";
import { createFakeGh } from "../helpers/fake-gh.mjs";
import { runMessagingContract } from "../helpers/messaging-contract.mjs";

runMessagingContract("github", async () => {
  const fake = createFakeGh({ issues: [{ number: 1, title: "channel", state: "open", labels: [{ name: "agentic-sdlc-channel" }] }], nextIssue: 2 });
  return { provider: createGithubProvider({ exec: fake.exec, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))) }), config: { repo: "acme/shop", issue: 1, local_path: null } };
});

runMessagingContract("local", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentic-local-channel-")), "channel");
  return { provider: createLocalProvider(), config: { provider: "local", local_dir: dir } };
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
