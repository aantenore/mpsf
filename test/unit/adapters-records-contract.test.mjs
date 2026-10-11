import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GATE_REQUIREMENTS, missingGuarantees, recordAssuranceLevel } from "../../lib/adapters/capabilities.mjs";
import { recordStoreGuaranteeErrors } from "../../lib/adapters/records/gate.mjs";
import { createGitSdlcStore } from "../../lib/adapters/records/git-sdlc.mjs";
import { createLocalFsStore } from "../../lib/adapters/records/local-fs.mjs";
import { createSdlcStateStore } from "../../lib/adapters/records/sdlc-state.mjs";
import { openRecordStore, RECORD_STORES } from "../../lib/adapters/records/registry.mjs";
import { assertRecordStore } from "../../lib/adapters/records/port.mjs";
import { delegationRecordPath, readDelegationRecord, readDelegationUses } from "../../lib/engine/delegation-records.mjs";
import { buildWaitPayload, sharedWaitRecords, WAITS_NAMESPACE, writeSharedWaitRecord } from "../../lib/engine/wait-registry.mjs";
import { runRecordStoreContract } from "../helpers/records-contract.mjs";

function project({ git = false, config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-store-"));
  fs.mkdirSync(path.join(root, ".sdlc"));
  fs.writeFileSync(path.join(root, ".sdlc", "config.json"), JSON.stringify(config));
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Store Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "store@example.invalid"], { cwd: root });
  }
  return root;
}

const waitPayload = (n) => buildWaitPayload({ waitId: `WAIT-20260101000000-00000${n}`, action: "open", waiter: { host: "pc-1" }, on: { type: "story", ref: "ST-1" }, until: "2026-01-01T02:00:00Z", createdAt: "2026-01-01T00:00:00Z" });

runRecordStoreContract("git-sdlc", async () => {
  const root = project({ git: true });
  return { store: createGitSdlcStore({ root, sdlcRoot: path.join(root, ".sdlc") }), sharedNamespace: WAITS_NAMESPACE, sharedPayload: waitPayload };
});

runRecordStoreContract("local-fs", async () => {
  const root = project();
  return { store: createLocalFsStore({ root, sdlcRoot: path.join(root, ".sdlc") }), sharedNamespace: WAITS_NAMESPACE, sharedPayload: waitPayload, publishRequest: {} };
});

runRecordStoreContract("sdlc-state", async () => {
  const root = project({ git: true });
  return { store: createSdlcStateStore({ root, sdlcRoot: path.join(root, ".sdlc") }), sharedNamespace: WAITS_NAMESPACE, sharedPayload: waitPayload };
});

test("every registered store implements the port", () => {
  const root = project({ git: true });
  for (const [id, factory] of Object.entries(RECORD_STORES)) {
    const store = assertRecordStore(factory({ root, sdlcRoot: path.join(root, ".sdlc"), options: {} }));
    assert.equal(store.id, id);
  }
});

test("the default store is git-sdlc with full assurance; a configured one is used, an unknown one refused", () => {
  const root = project({ git: true });
  const store = openRecordStore({ root });
  assert.equal(store.id, "git-sdlc");
  assert.equal(recordAssuranceLevel(store.guarantees), "full");
  const local = openRecordStore({ root }, { config: { host_policy: { adapters: { records: { provider: "local" } } } } });
  assert.equal(local.id, "local-fs");
  assert.equal(recordAssuranceLevel(local.guarantees), "local");
  assert.throws(() => openRecordStore({ root }, { config: { host_policy: { adapters: { records: { provider: "nowhere" } } } } }), /not supported/u);
});

test("gates fail closed when the store cannot give the guarantees their level needs", () => {
  const root = project();
  const context = { root, sdlcRoot: path.join(root, ".sdlc") };
  assert.deepEqual(recordStoreGuaranteeErrors(context, "lifecycle_complete"), []);
  const local = { ...context, config: { host_policy: { adapters: { records: { provider: "local-fs" } } } } };
  assert.deepEqual(recordStoreGuaranteeErrors(local, "standard"), []);
  assert.deepEqual(recordStoreGuaranteeErrors(local, "strict_intermediate"), []);
  const [error] = recordStoreGuaranteeErrors(local, "lifecycle_complete");
  assert.match(error, /local-fs.*immutable_history.*atomic_publish.*base_branch_coupling/u);
  const broken = { ...context, config: { host_policy: { adapters: { records: { provider: "nowhere" } } } } };
  assert.match(recordStoreGuaranteeErrors(broken, "standard")[0], /record store/u);
  assert.deepEqual(missingGuarantees([], GATE_REQUIREMENTS.standard), []);
});

test("delegation reads go through the store and agree with the writers' paths", () => {
  const root = project();
  const context = { root, sdlcRoot: path.join(root, ".sdlc") };
  const store = openRecordStore(context);
  store.write("delegation", { id: "DLG-X" }, { id: "DLGR-1" });
  store.write("delegation-use", { parent: "DLG-X", id: "DLGUSE-1" }, { id: "DLGUSE-1" });
  assert.equal(path.join(root, store.location("delegation", { id: "DLG-X" })), delegationRecordPath(context, "DLG-X"));
  assert.deepEqual(readDelegationRecord(context, "DLG-X"), { id: "DLGR-1" });
  assert.deepEqual(readDelegationUses(context, "DLG-X"), [{ id: "DLGUSE-1" }]);
  assert.equal(readDelegationRecord(context, "../escape"), null);
});

test("explicit waits work on the local-fs store, without git", () => {
  const root = project({ config: { host_policy: { adapters: { records: { provider: "local-fs" } } } } });
  const written = writeSharedWaitRecord(root, waitPayload(7));
  assert.equal(written.status, "local");
  const { records } = sharedWaitRecords(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].wait_id, "WAIT-20260101000000-000007");
  const tampered = path.join(root, ".sdlc", ".shared-state", WAITS_NAMESPACE, `${records[0].wait_id}--open.json`);
  fs.writeFileSync(tampered, fs.readFileSync(tampered, "utf8").replace("pc-1", "pc-2"));
  assert.equal(sharedWaitRecords(root).records.length, 0, "an altered record counts for nothing");
});
