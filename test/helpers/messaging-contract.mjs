import assert from "node:assert/strict";
import test from "node:test";

import { assertMessagingProvider } from "../../lib/adapters/messaging/port.mjs";
import { cursorOf } from "../../lib/messaging/cursor.mjs";

/**
 * The behaviour every messaging provider must show. `setup()` returns
 * `{ provider, config }` on a fresh, empty channel. Run it from a test file
 * once per provider: runMessagingContract("local", () => ...).
 */
export function runMessagingContract(name, setup) {
  const message = (text, extra = {}) => ({ from: "Ada · pc-1", host: "pc-1", ghLogin: null, story: "ST-A-001", text, kind: "info", replyTo: null, to: null, version: "0.0.0", ...extra });

  test(`${name}: implements the messaging port`, async () => {
    const { provider } = await setup();
    assertMessagingProvider(provider);
    assert.ok(Array.isArray(provider.guarantees));
  });

  test(`${name}: the channel is found or created, and finding it again is idempotent`, async () => {
    const { provider, config } = await setup();
    const first = await provider.ensureChannel({ config, verify: true });
    const second = await provider.ensureChannel({ config });
    assert.equal(second.issue, first.issue);
    assert.equal(second.url, first.url);
    assert.equal(second.created, false);
  });

  test(`${name}: a published message reads back normalized, ids grow, order is kept`, async () => {
    const { provider, config } = await setup();
    const a = await provider.publish({ config, message: message("first") });
    const b = await provider.publish({ config, message: message("second", { kind: "question", to: "Bob" }) });
    const c = await provider.publish({ config, message: message("third", { kind: "answer", replyTo: b.id }) });
    for (const sent of [a, b, c]) {
      assert.match(String(sent.id), /^\d{1,20}$/u);
      assert.match(String(sent.time), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u);
    }
    assert.ok(Number(a.id) < Number(b.id) && Number(b.id) < Number(c.id));
    const all = (await provider.poll({ config, since: "all" })).filter((item) => item.plugin_message);
    assert.deepEqual(all.map((item) => item.text), ["first", "second", "third"]);
    const [, question, answer] = all;
    assert.equal(question.kind, "question");
    assert.equal(question.to, "Bob");
    assert.equal(question.from, "Ada · pc-1");
    assert.equal(question.host, "pc-1");
    assert.equal(question.story, "ST-A-001");
    assert.equal(answer.kind, "answer");
    assert.equal(answer.reply_to, b.id);
  });

  test(`${name}: reading from a cursor returns only later messages`, async () => {
    const { provider, config } = await setup();
    await provider.publish({ config, message: message("one") });
    await provider.publish({ config, message: message("two") });
    const all = (await provider.poll({ config, since: "all" })).filter((item) => item.plugin_message);
    const later = await provider.poll({ config, since: cursorOf(all[0]) });
    assert.deepEqual(later.filter((item) => item.plugin_message).map((item) => item.text), ["two"]);
  });

  test(`${name}: an unknown kind reads as info`, async () => {
    const { provider, config } = await setup();
    await provider.publish({ config, message: message("odd", { kind: "nonsense" }) });
    const [read] = (await provider.poll({ config, since: "all" })).filter((item) => item.plugin_message);
    assert.equal(read.kind, "info");
  });

  test(`${name}: subscribe delivers new messages and stops when asked`, async () => {
    const { provider, config } = await setup();
    const before = await provider.publish({ config, message: message("before") });
    const controller = new AbortController();
    const seen = [];
    const listening = provider.subscribe({
      config,
      since: cursorOf(before),
      signal: controller.signal,
      intervalSeconds: 0.02,
      onMessage: (item) => {
        seen.push(item.text);
        return false;
      },
    });
    await provider.publish({ config, message: message("after") });
    const timer = setTimeout(() => controller.abort(), 5000);
    await listening;
    clearTimeout(timer);
    assert.deepEqual(seen, ["after"]);
  });

  test(`${name}: whoami answers a login or null`, async () => {
    const { provider } = await setup();
    const login = await provider.whoami({});
    assert.ok(login === null || typeof login === "string");
  });
}
