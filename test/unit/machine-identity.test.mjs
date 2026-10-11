import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hostId } from "../../lib/messaging/identity.mjs";
import { keyFingerprint, legacyMachineId, machineDir, machineId, machineKey, resetMachineCache, signWithMachineKey, verifyMachineSignature } from "../../lib/runtime/machine.mjs";

const fresh = () => ({ AGENTIC_SDLC_MACHINE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "agentic-machine-")) });

test("the id is decided once, as the legacy hash, and survives a change of host name", () => {
  const env = fresh();
  resetMachineCache();
  const first = machineId(env, { hostname: "MacBook-Pro.local" });
  assert.equal(first, legacyMachineId("MacBook-Pro.local"));
  resetMachineCache();
  assert.equal(machineId(env, { hostname: "MacBook-Pro.fritz.box" }), first, "a new host name keeps the id");
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.AGENTIC_SDLC_MACHINE_DIR, "machine.json"), "utf8")).id, first);
  // The explicit label still wins; without it every caller on the computer sees the same id.
  assert.equal(hostId({ ...env, AGENTIC_SDLC_HOST_LABEL: "PC3" }), "PC3");
  assert.equal(hostId(env), first);
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
