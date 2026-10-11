import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { RECORD_GUARANTEES } from "../../lib/adapters/capabilities.mjs";
import { assertRecordStore, RecordStoreError } from "../../lib/adapters/records/port.mjs";

/**
 * The behaviour every record store must show. `setup()` returns
 * `{ store, sharedNamespace, sharedPayload(n) }` on an empty project.
 */
export function runRecordStoreContract(name, setup) {
  test(`${name}: implements the record store port`, async () => {
    const { store } = await setup();
    assertRecordStore(store);
    for (const guarantee of store.guarantees) assert.ok(Object.values(RECORD_GUARANTEES).includes(guarantee), `unknown guarantee ${guarantee}`);
  });

  test(`${name}: a record is created once and reads back unchanged`, async () => {
    const { store } = await setup();
    const record = { id: "DLGR-1", scope: { stories: ["ST-1"] }, n: 1 };
    const written = store.write("delegation", { id: "DLG-1" }, record);
    assert.equal(written.created, true);
    assert.deepEqual(store.read("delegation", { id: "DLG-1" }), record);
    assert.throws(() => store.write("delegation", { id: "DLG-1" }, { other: true }), (error) => error instanceof RecordStoreError && error.code === "exists");
    assert.deepEqual(store.read("delegation", { id: "DLG-1" }), record);
  });

  test(`${name}: immutable kinds refuse replacement, mutable kinds accept it`, async () => {
    const { store } = await setup();
    store.write("delegation", { id: "DLG-2" }, { v: 1 });
    assert.throws(() => store.write("delegation", { id: "DLG-2" }, { v: 2 }, { mode: "replace" }), (error) => error.code === "immutable");
    store.write("story", { id: "ST-1" }, { status: "ready" });
    store.write("story", { id: "ST-1" }, { status: "done" }, { mode: "replace" });
    assert.equal(store.read("story", { id: "ST-1" }).status, "done");
  });

  test(`${name}: missing records read as null and listing is sorted`, async () => {
    const { store } = await setup();
    assert.equal(store.read("story", { id: "ST-NONE" }), null);
    assert.deepEqual(store.list("delegation"), []);
    store.write("delegation", { id: "DLG-B" }, { v: 1 });
    store.write("delegation", { id: "DLG-A" }, { v: 1 });
    store.write("delegation-use", { parent: "DLG-A", id: "DLGUSE-2" }, { v: 2 });
    store.write("delegation-use", { parent: "DLG-A", id: "DLGUSE-1" }, { v: 1 });
    assert.deepEqual(store.list("delegation"), ["DLG-A", "DLG-B"]);
    assert.deepEqual(store.list("delegation-use", { parent: "DLG-A" }), ["DLGUSE-1", "DLGUSE-2"]);
    assert.deepEqual(store.list("delegation-use", { parent: "DLG-B" }), []);
  });

  test(`${name}: keys that leave the store and unknown kinds are refused`, async () => {
    const { store } = await setup();
    assert.throws(() => store.read("story", { id: "../../etc" }), (error) => error.code === "invalid_key");
    assert.throws(() => store.write("story", { id: "a/b" }, {}), (error) => error.code === "invalid_key");
    assert.throws(() => store.read("nonsense", { id: "x" }), (error) => error.code === "unknown_kind");
    assert.match(store.location("story", { id: "ST-1" }), /ST-1/u);
  });

  test(`${name}: traces append in order and verify; with a hash chain a rewrite is detected`, async () => {
    const { store } = await setup();
    store.appendTrace("ST-1", { type: "step", summary: "one" });
    store.appendTrace("ST-1", { type: "step", summary: "two" });
    assert.deepEqual(store.readTrace("ST-1").map((event) => event.summary), ["one", "two"]);
    assert.equal(store.verifyTrace("ST-1").valid, true);
    if (store.guarantees.includes(RECORD_GUARANTEES.hash_chain)) {
      const file = path.join(store.recordsRoot, "traces", "ST-1.jsonl");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("two", "TWO"));
      assert.equal(store.verifyTrace("ST-1").valid, false);
    }
  });

  test(`${name}: shared state is create-only and reads back`, async () => {
    const { store, sharedNamespace, sharedPayload } = await setup();
    const payload = sharedPayload(1);
    const first = store.sharedState.write(sharedNamespace, payload);
    assert.notEqual(first.status, "exists");
    const again = store.sharedState.write(sharedNamespace, payload);
    assert.equal(again.status, "exists");
    const { records } = store.sharedState.read(sharedNamespace, {});
    assert.equal(records.filter((record) => record.wait_id === payload.wait_id && record.action === payload.action).length, 1);
  });

  test(`${name}: publish answers with an outcome`, async () => {
    const { store, publishRequest } = await setup();
    if (!publishRequest) return;
    const outcome = await store.publish(publishRequest);
    assert.equal(typeof outcome, "object");
  });
}
