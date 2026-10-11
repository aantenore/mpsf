import { createBareOrigin, createFixtureDir } from "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { forgetSharedRefState } from "../../lib/engine/shared-refs.mjs";
import { rolesTick } from "../../lib/engine/role-leases.mjs";
import { renderNowPanel } from "../../ui/change-observatory/now-panel.js";
import { setLocale } from "../../ui/change-observatory/i18n.js";
import { createChangeObservatoryBrowser } from "../helpers/change-observatory-browser-dom.mjs";
import { buildNowModel, coordinationRows, createMessagingSnapshot, readNowView } from "../../lib/change-observatory/now-panel.mjs";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

const CLAIMS = [
  { storyId: "ST-2", state: "claimed", agent: "codex", holder: "Antonio, mac", branch: "feature/ST-2", claimedAt: at(90), health: "active" },
  { storyId: "ST-1", state: "parked", agent: "claude", branch: "feature/ST-1", claimedAt: at(300) },
  { storyId: "ST-0", state: "completed", completion: "delivered" },
];

const MESSAGES = [
  { id: "m1", from: "mac", kind: "info", text: "[auto] stato: ST-2 in fase build da 5 min", time: at(20) },
  { id: "m2", from: "pc-b", kind: "question", text: "Chi prende ST-3?", time: at(15) },
  { id: "m3", from: "pc-c", kind: "info", text: "[auto] stato: ST-9 in fase test", time: at(60) },
  { id: "m4", from: "pc-c", kind: "offer", text: "[auto] libero: posso prendere lavoro o aiutare", time: at(10) },
  { id: "m5", from: "mac", kind: "answer", reply_to: "m2", text: "io", time: at(5) },
  { id: "m6", from: "mac", kind: "request", to: "pc-b", text: "Rivedi la PR", time: at(4) },
];

test("active claims become work rows with their workflow phase; completed ones are left out", () => {
  const model = buildNowModel({
    claims: CLAIMS,
    phases: new Map([["ST-2", { phase: "build", since: at(5) }]]),
    nowMs: NOW,
  });
  assert.equal(model.messaging, "off");
  assert.deepEqual(model.work.map((row) => row.storyId), ["ST-1", "ST-2"]);
  const st2 = model.work[1];
  assert.equal(st2.who, "Antonio, mac");
  assert.equal(st2.branch, "feature/ST-2");
  assert.equal(st2.phase, "build");
  assert.equal(st2.since, at(90));
  assert.equal(model.work[0].state, "parked");
  assert.equal(model.work[0].phase, null);
  assert.deepEqual([model.senders, model.open, model.free], [[], [], []]);
});

test("messages give the latest status per sender, open questions and free computers", () => {
  const model = buildNowModel({ claims: CLAIMS, messages: MESSAGES.slice().reverse(), messaging: "on", nowMs: NOW });
  const mac = model.senders.find((sender) => sender.from === "mac");
  assert.match(mac.status.text, /ST-2 in fase build/u);
  assert.equal(mac.last.text, "Rivedi la PR");
  assert.equal(model.senders[0].from, "mac", "most recent sender first");
  assert.deepEqual(model.free, [{ from: "pc-c", time: at(10) }]);
  // m2 waits on pc-c (mac answered); m6 waits on pc-b.
  assert.deepEqual(model.open.map((item) => [item.id, item.waitingOn]), [["m6", ["pc-b"]], ["m2", ["pc-c"]]]);
});

test("a status after an offer means the computer is busy again", () => {
  const model = buildNowModel({
    messages: [
      { id: "a", from: "pc-c", kind: "offer", text: "[auto] libero", time: at(30) },
      { id: "b", from: "pc-c", kind: "info", text: "[auto] stato: ST-4", time: at(1) },
    ],
    messaging: "on",
    nowMs: NOW,
  });
  assert.deepEqual(model.free, []);
});

test("the messaging snapshot is skipped when messaging is off and cached otherwise", async () => {
  const off = createMessagingSnapshot("/nonexistent", { env: { AGENTIC_SDLC_MESSAGING: "off" } });
  assert.deepEqual(await off.read(), { messaging: "off", messages: null });

  let polls = 0;
  let clock = 0;
  const providers = { github: () => ({ poll: async () => { polls += 1; return [MESSAGES[0]]; } }) };
  const env = { AGENTIC_SDLC_MESSAGING_REPO: "acme/shop" };
  const on = createMessagingSnapshot(process.cwd(), { env, providers, clock: () => clock });
  assert.equal((await on.read()).messaging, "on");
  await on.read();
  assert.equal(polls, 1, "served from cache");
  clock = 60_000;
  await on.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 2, "refreshed in background once stale");

  const failing = createMessagingSnapshot(process.cwd(), {
    env,
    providers: { github: () => ({ poll: async () => { throw new Error("down"); } }) },
  });
  assert.deepEqual(await failing.read(), { messaging: "unavailable", messages: null });
});

const ahead = (minutes) => new Date(NOW + minutes * 60_000).toISOString();
const PRESENCE = [
  { kind: "presence", host: "pc-a", at: at(25), expires_at: ahead(5), stories: ["ST-2", "ST-1"], roles: ["coordinator"], plugin_version: "0.148.5" },
  { kind: "presence", host: "pc-b", at: at(3), expires_at: ahead(27), stories: [], roles: [], plugin_version: "0.148.4" },
  { kind: "presence", host: "pc-c", at: at(300), expires_at: at(270), stories: ["ST-9"], roles: "bad" },
];

test("computers are listed latest first with whether they are alive; roles name their valid holder", () => {
  const { computers, roles } = coordinationRows({
    presence: PRESENCE,
    leases: {
      coordinator: { role: "coordinator", host: "pc-a", epoch: 4, expires_at: ahead(20), released: false },
      knowledge: { role: "knowledge", host: "pc-c", epoch: 2, expires_at: at(10), released: false },
    },
    nowMs: NOW,
  });
  assert.deepEqual(computers.map((item) => [item.host, item.alive]), [["pc-b", true], ["pc-a", true], ["pc-c", false]]);
  assert.deepEqual(computers[1], { host: "pc-a", alive: true, at: at(25), expires_at: ahead(5), stories: ["ST-2", "ST-1"], roles: ["coordinator"], plugin_version: "0.148.5" });
  assert.deepEqual([computers[2].roles, computers[2].plugin_version], [[], null], "malformed fields become empty");
  assert.deepEqual(roles, [
    { role: "coordinator", holder: "pc-a", expires_at: ahead(20) },
    { role: "knowledge", holder: null, expires_at: null },
  ]);

  const released = coordinationRows({ presence: [], leases: { coordinator: { host: "pc-a", expires_at: ahead(20), released: true } }, nowMs: NOW });
  assert.deepEqual(released, { computers: [], roles: [{ role: "coordinator", holder: null, expires_at: null }, { role: "knowledge", holder: null, expires_at: null }] });
});

test("the model carries the computers and roles it is given, and empty lists otherwise", () => {
  const rows = coordinationRows({ presence: PRESENCE.slice(0, 2), leases: {}, nowMs: NOW });
  const withRows = buildNowModel({ claims: CLAIMS, computers: rows.computers, roles: rows.roles, nowMs: NOW });
  assert.deepEqual(withRows.computers.map((item) => item.host), ["pc-b", "pc-a"]);
  assert.deepEqual(withRows.roles.map((item) => item.holder), [null, null]);
  const alsoWithMessages = buildNowModel({ messages: MESSAGES, messaging: "on", computers: rows.computers, roles: rows.roles, nowMs: NOW });
  assert.equal(alsoWithMessages.computers.length, 2);

  for (const model of [buildNowModel({ nowMs: NOW }), buildNowModel({ messages: MESSAGES, messaging: "on", nowMs: NOW }), buildNowModel({ computers: null, roles: "x", nowMs: NOW })]) {
    assert.deepEqual([model.computers, model.roles], [[], []]);
  }
  assert.equal(buildNowModel({ nowMs: NOW }).schemaVersion, "change-observatory:now:v1", "the added fields are additive");
});

test("the view reads computers and roles from the local copies of the presence refs, and is empty without them", async () => {
  const lone = createFixtureDir("now-lone-");
  const empty = await readNowView(lone, { nowMs: NOW });
  assert.deepEqual(empty.computers, []);
  assert.ok(empty.roles.every((item) => item.holder === null));

  const seed = createFixtureDir("now-seed-");
  execFileSync("git", ["init", "-q"], { cwd: seed });
  const bare = createBareOrigin(seed);
  const dir = createFixtureDir("now-pc-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".sdlc"));
  fs.writeFileSync(path.join(dir, ".sdlc", "config.json"), JSON.stringify({ orchestration_policy: { coordination: { mode: "auto", remote: "origin", timeout_seconds: 5 } } }));
  forgetSharedRefState();
  const env = { ...process.env, AGENTIC_SDLC_HOST_LABEL: "pc-a" };
  assert.equal((await rolesTick(dir, { env, now: NOW })).pushed, true);

  const view = await readNowView(dir, { nowMs: NOW + 60_000 });
  assert.deepEqual(view.computers.map((item) => [item.host, item.alive]), [["pc-a", true]]);
  assert.deepEqual(view.roles.map((item) => [item.role, item.holder]), [["coordinator", "pc-a"], ["knowledge", "pc-a"]]);
  const lapsed = await readNowView(dir, { nowMs: NOW + 24 * 60 * 60_000 });
  assert.deepEqual(lapsed.computers.map((item) => item.alive), [false]);
  assert.deepEqual(lapsed.roles.map((item) => item.holder), [null, null]);
});

function withBrowser(t_) {
  const previous = { document: globalThis.document, window: globalThis.window };
  const browser = createChangeObservatoryBrowser("http://127.0.0.1:43127/#overview");
  globalThis.document = browser.document;
  globalThis.window = browser.window;
  t_.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    setLocale("en");
  });
  return browser;
}

test("the panel shows one row per computer and who holds each role, in Italian when asked", (t_) => {
  withBrowser(t_);
  setLocale("it");
  const rows = coordinationRows({
    presence: PRESENCE,
    leases: { coordinator: { host: "pc-a", expires_at: ahead(20), released: false } },
    nowMs: NOW,
  });
  const container = document.createElement("section");
  renderNowPanel(container, { ...buildNowModel({ nowMs: NOW }), computers: rows.computers, roles: rows.roles });
  const text = container.textContent;
  assert.match(text, /Computer e ruoli/u);
  assert.match(text, /pc-a/u);
  assert.match(text, /storie ST-2, ST-1/u);
  assert.match(text, /ruoli coordinatore/u);
  assert.match(text, /plugin 0\.148\.5/u);
  assert.match(text, /pc-aattivo/u);
  assert.match(text, /pc-cnon attivo/u);
  assert.match(text, /coordinatore:pc-a fino alle \d/u);
  assert.match(text, /conoscenza:nessuno: ognuno fa da sé/u);

  setLocale("en");
  const english = document.createElement("section");
  renderNowPanel(english, { ...buildNowModel({ nowMs: NOW }), computers: [], roles: rows.roles.map((item) => ({ ...item, holder: null })) });
  assert.doesNotMatch(english.textContent, /Computers and roles/u, "hidden while nobody announced itself and no role has a holder");
  renderNowPanel(english, { ...buildNowModel({ nowMs: NOW }), computers: rows.computers.slice(0, 1), roles: rows.roles });
  assert.match(english.textContent, /Computers and roles/u);
  assert.match(english.textContent, /alive/u);
  assert.match(english.textContent, /coordinator:pc-a until \d/u);
});
