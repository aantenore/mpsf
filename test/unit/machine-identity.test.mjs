import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hostId } from "../../lib/messaging/identity.mjs";
import { registerMachineKey } from "../../lib/messaging/signature.mjs";
import { keyFingerprint, legacyMachineId, machineDir, machineId, machineKey, resetMachineCache, signWithMachineKey, verifyMachineSignature } from "../../lib/runtime/machine.mjs";

const fresh = () => ({ AGENTIC_SDLC_MACHINE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "agentic-machine-")) });

test("the id is decided once, as the legacy hash plus a random part, and survives a change of host name", () => {
  const env = fresh();
  resetMachineCache();
  const first = machineId(env, { hostname: "MacBook-Pro.local" });
  assert.match(first, new RegExp(`^${legacyMachineId("MacBook-Pro.local")}-[0-9a-f]{8}$`, "u"));
  resetMachineCache();
  assert.equal(machineId(env, { hostname: "MacBook-Pro.fritz.box" }), first, "a new host name keeps the id");
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.AGENTIC_SDLC_MACHINE_DIR, "machine.json"), "utf8")).id, first);
  // The explicit label still wins; without it every caller on the computer sees the same id.
  assert.equal(hostId({ ...env, AGENTIC_SDLC_HOST_LABEL: "PC3" }), "PC3");
  assert.equal(hostId(env), first);
});

test("two computers with the same default host name get different ids; a kept legacy id is never changed", () => {
  const a = fresh();
  const b = fresh();
  resetMachineCache();
  const idA = machineId(a, { hostname: "MacBook-Pro.local" });
  resetMachineCache();
  const idB = machineId(b, { hostname: "MacBook-Pro.local" });
  assert.notEqual(idA, idB);
  const legacy = fresh();
  fs.writeFileSync(path.join(legacy.AGENTIC_SDLC_MACHINE_DIR, "machine.json"), JSON.stringify({ id: legacyMachineId("old-host"), created_at: "2025-01-01T00:00:00Z" }));
  resetMachineCache();
  assert.equal(machineId(legacy, { hostname: "MacBook-Pro.local" }), legacyMachineId("old-host"));
  resetMachineCache();
});

test("registering a key never replaces another computer's key under the same id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-machine-root-"));
  const other = fresh();
  const mine = fresh();
  for (const env of [other, mine]) fs.writeFileSync(path.join(env.AGENTIC_SDLC_MACHINE_DIR, "machine.json"), JSON.stringify({ id: "pc-shared" }));
  resetMachineCache();
  const first = registerMachineKey(root, other);
  assert.equal(first.written, true);
  const before = fs.readFileSync(path.join(root, first.path), "utf8");
  resetMachineCache();
  const second = registerMachineKey(root, mine);
  assert.equal(second.written, false);
  assert.equal(second.conflict, true);
  assert.equal(second.registered_fingerprint, first.fingerprint);
  assert.equal(fs.readFileSync(path.join(root, first.path), "utf8"), before);
  resetMachineCache();
});

test("an unwritable config folder still gives the same id every time", () => {
  const env = { AGENTIC_SDLC_MACHINE_DIR: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentic-machine-")), "file") };
  fs.writeFileSync(env.AGENTIC_SDLC_MACHINE_DIR, "not a folder");
  resetMachineCache();
  assert.equal(machineId(env, { hostname: "h1" }), legacyMachineId("h1"));
  resetMachineCache();
  assert.equal(machineId(env, { hostname: "h1" }), legacyMachineId("h1"));
});

test("the key is made once, kept private, and signs what others can verify", () => {
  const env = fresh();
  const key = machineKey(env);
  const again = machineKey(env);
  assert.equal(again.fingerprint, key.fingerprint);
  assert.equal(key.fingerprint, keyFingerprint(key.publicKey));
  assert.match(key.fingerprint, /^[0-9a-f]{16}$/u);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(env.AGENTIC_SDLC_MACHINE_DIR, "machine-key.pem")).mode & 0o077, 0);
  const signature = signWithMachineKey("hello", env);
  assert.equal(verifyMachineSignature("hello", signature, key.publicKey), true);
  assert.equal(verifyMachineSignature("hello!", signature, key.publicKey), false);
  assert.equal(verifyMachineSignature("hello", signature, machineKey(fresh()).publicKey), false);
  assert.equal(verifyMachineSignature("hello", "garbage", key.publicKey), false);
});

test("the default folder follows XDG_CONFIG_HOME, else ~/.config", () => {
  assert.equal(machineDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u"), path.join("/x/cfg", "agentic-sdlc"));
  if (process.platform !== "win32") assert.equal(machineDir({}, "/home/u"), path.join("/home/u", ".config", "agentic-sdlc"));
});

test("an unusable machine key file is moved aside and replaced", async () => {
  const { default: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { machineKey, MACHINE_KEY_FILE } = await import("../../lib/runtime/machine.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "machine-key-"));
  try {
    const first = machineKey({}, { home });
    const keyFile = fs.readdirSync(home, { recursive: true }).find((name) => String(name).endsWith(MACHINE_KEY_FILE));
    fs.writeFileSync(path.join(home, keyFile), "not a key");
    const second = machineKey({}, { home });
    assert.notEqual(second.fingerprint, first.fingerprint);
    assert.equal(machineKey({}, { home }).fingerprint, second.fingerprint);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
