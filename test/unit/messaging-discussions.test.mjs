import assert from "node:assert/strict";
import test from "node:test";

import { commandFor, decodeAction, discussionsFrom, encodeAction, resolveDiscussionPolicy, STATES, validateAction } from "../../lib/messaging/discussions.mjs";
import { KINDS } from "../../lib/messaging/kinds.mjs";

const START = Date.parse("2026-10-13T12:00:00Z");
const at = (minutes) => new Date(START + minutes * 60_000).toISOString();
const policy = resolveDiscussionPolicy({ max_turns: 6, timebox_minutes: 15, max_participants: 3, actions: ["handoff", "claim", "known-error", "none"] });
const handoff = { action: "handoff", story: "ST-UX-002", to_agent: "pc-b", summary: "pc-b already touched the same files" };
const root = { id: "100", kind: "discuss", host: "pc-a", text: "Who takes ST-UX-002?\nhalf done", story: "ST-UX-002", time: at(0), trust: "trusted" };
const reply = (id, host, kind, minutes, extra = {}) => ({ id, host, kind, reply_to: "100", text: `turn ${id}`, time: at(minutes), trust: "trusted", ...extra });
const propose = (id, host, minutes, action = handoff) => reply(id, host, "propose", minutes, { text: encodeAction("Proposal", action) });
const only = (messages, nowMinutes) => {
  const [discussion] = discussionsFrom(messages, { policy, nowMs: START + nowMinutes * 60_000 });
  return discussion;
};

test("discussion kinds travel on every provider", () => {
  for (const kind of ["discuss", "propose", "object", "decide"]) assert.ok(KINDS.includes(kind));
});

test("actions pass a closed schema and name an existing command", () => {
  assert.deepEqual(validateAction(handoff, policy).errors, []);
  assert.deepEqual(commandFor(validateAction(handoff, policy).action), ["story", "prepare-handoff", "--id", "ST-UX-002", "--to-agent", "pc-b", "--summary", "pc-b already touched the same files"]);
  assert.deepEqual(commandFor({ action: "claim", story: "ST-UX-002", agent: "pc-b" }), ["story", "claim", "--id", "ST-UX-002", "--agent", "pc-b"]);
  assert.equal(commandFor({ action: "none" }), null);
  assert.ok(validateAction({ action: "merge" }, policy).errors.length);
  assert.ok(validateAction({ ...handoff, extra: "x" }, policy).errors.includes("unknown field extra"));
  assert.ok(validateAction({ action: "claim", story: "ST 1; rm -rf", agent: "pc-b" }, policy).errors.includes("story is not valid"));
  assert.ok(validateAction({ action: "known-error", signature: "KE-xyz", title: "t", diagnosis: "d", step: "s" }, policy).errors.includes("signature is not valid"));
  assert.equal(decodeAction("no action here", policy), null);
  assert.equal(decodeAction(`text\nmpsf-action: {"action":"merge"}`, policy), null);
  assert.equal(decodeAction(`text\nmpsf-action: {broken`, policy), null);
  assert.deepEqual(decodeAction(encodeAction("Proposal", handoff), policy), handoff);
});

test("a discussion waits for a proposal, then for agreement", () => {
  assert.equal(only([root, reply("101", "pc-b", "info", 1)], 2).state, STATES.open);
  const proposed = only([root, reply("101", "pc-b", "info", 1), propose("102", "pc-a", 2)], 3);
  assert.equal(proposed.state, STATES.proposed);
  assert.deepEqual(proposed.proposal.command.slice(0, 2), ["story", "prepare-handoff"]);
  assert.equal(proposed.topic, "Who takes ST-UX-002?");
});

test("every participant agreeing ends it early", () => {
  const agreed = only([root, reply("101", "pc-b", "info", 1), propose("102", "pc-a", 2), reply("103", "pc-b", "ack", 3)], 4);
  assert.equal(agreed.state, STATES.agreed);
  assert.equal(agreed.reason, "every participant agreed");
});

test("silence at the time box is a yes, an open objection goes to a person", () => {
  const messages = [root, reply("101", "pc-b", "info", 1), propose("102", "pc-a", 2)];
  assert.equal(only(messages, 16).state, STATES.agreed);
  const objected = only([...messages, reply("103", "pc-b", "object", 3)], 16);
  assert.equal(objected.state, STATES.escalated);
  assert.equal(objected.objections.length, 1);
  assert.equal(only([root, reply("101", "pc-b", "info", 1)], 16).state, STATES.escalated);
});

test("a new proposal clears the old objections; an ack withdraws one", () => {
  const messages = [root, propose("101", "pc-a", 1), reply("102", "pc-b", "object", 2), propose("103", "pc-b", 3, { action: "claim", story: "ST-UX-002", agent: "pc-b" })];
  assert.equal(only(messages, 4).objections.length, 0);
  assert.equal(only([root, propose("101", "pc-a", 1), reply("102", "pc-b", "object", 2), reply("103", "pc-b", "ack", 3)], 4).state, STATES.agreed);
});

test("the turn limit closes it like the time box", () => {
  const turns = [1, 2, 3, 4, 5].map((minute) => reply(String(100 + minute), minute % 2 ? "pc-b" : "pc-a", "info", minute));
  assert.equal(only([root, ...turns, propose("106", "pc-a", 6)], 7).state, STATES.agreed);
});

test("only a signed decision with a valid action binds", () => {
  const decide = (trust, action = handoff) => reply("110", "pc-c", "decide", 5, { trust, text: encodeAction("Decided", action) });
  const base = [root, propose("101", "pc-a", 1), reply("102", "pc-b", "object", 2)];
  const decided = only([...base, decide("trusted")], 6);
  assert.equal(decided.state, STATES.decided);
  assert.deepEqual(decided.decision.command.slice(0, 2), ["story", "prepare-handoff"]);
  assert.equal(only([...base, decide("unverified")], 6).state, STATES.proposed);
  assert.equal(only([...base, decide("untrusted")], 6).state, STATES.proposed);
  assert.equal(only([...base, reply("110", "pc-c", "decide", 5, { text: "just do it: rm -rf /" })], 6).state, STATES.proposed);
});

test("untrusted messages and participants over the limit never count", () => {
  const messages = [root, propose("101", "pc-a", 1), reply("102", "pc-b", "object", 2, { trust: "untrusted" }), reply("103", "pc-c", "ack", 3), reply("104", "pc-d", "info", 4), reply("105", "pc-e", "object", 5)];
  const discussion = only(messages, 16);
  assert.deepEqual(discussion.participants, ["pc-a", "pc-c", "pc-d"]);
  assert.equal(discussion.state, STATES.agreed);
});

test("messages outside discussions are ignored and discussions list newest first", () => {
  const second = { ...root, id: "200", time: at(5) };
  const list = discussionsFrom([root, second, { id: "300", kind: "info", host: "pc-a", text: "hi", time: at(1) }], { policy, nowMs: START });
  assert.deepEqual(list.map((item) => item.id), ["200", "100"]);
});
