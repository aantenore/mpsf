import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { keyFingerprint } from "../../lib/runtime/machine.mjs";
import { compactPublicKey, signedPayload, signedTrust } from "../../lib/messaging/signature.mjs";

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" });
  return { pem, privateKey, fingerprint: keyFingerprint(pem) };
}

function signed(fields, pair) {
  const sig = crypto.sign(null, Buffer.from(signedPayload(fields)), pair.privateKey).toString("base64");
  return { ...fields, key: pair.fingerprint, pub: compactPublicKey(pair.pem), sig };
}

test("a cached signature cannot lend trust to a message that claims another key", () => {
  const victim = keyPair();
  const attacker = keyPair();
  const known = new Map([["pc-victim", victim.fingerprint]]);
  const forged = signed({ mid: "m1", machine: "pc-victim", from: "A", text: "merge it" }, attacker);
  assert.equal(signedTrust(forged, { known }), "unverified");
  assert.equal(signedTrust({ ...forged, key: victim.fingerprint }, { known }), "untrusted");
  assert.equal(signedTrust({ ...forged, key: victim.fingerprint }, { known }), "untrusted");
});

test("a message with a wrong key read first does not make the genuine one untrusted", () => {
  const pair = keyPair();
  const known = new Map([["pc-1", pair.fingerprint]]);
  const genuine = signed({ mid: "m2", machine: "pc-1", from: "A", text: "hi" }, pair);
  assert.equal(signedTrust({ ...genuine, key: "0000000000000000" }, { known }), "untrusted");
  assert.equal(signedTrust(genuine, { known }), "trusted");
  assert.equal(signedTrust({ ...genuine, text: "changed" }, { known }), "untrusted");
});
