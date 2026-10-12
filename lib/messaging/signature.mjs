import path from "node:path";
import { crypto, Date, fs, process } from "../runtime/host.mjs";
import { keyFingerprint, machineId, machineKey, signWithMachineKey, verifyMachineSignature } from "../runtime/machine.mjs";

/**
 * Signed messages. Every message the plugin writes carries an Ed25519
 * signature made with this computer's key (lib/runtime/machine.mjs), the
 * signer's machine id, the key fingerprint and the public key itself. A
 * reader checks the signature, then trusts the key only when the project
 * knows it:
 *
 *   .sdlc/machines/<machine-id>.json   { schema_version, id, public_key, fingerprint, registered_at }
 *
 * The file is committed like any other record, so registering a computer is
 * a change a person merges: that is the handshake. No secret is ever stored
 * there; the private key stays in the computer's config folder.
 *
 * Trust of a read message:
 *   trusted     valid signature by a registered key (or by this computer),
 *               or a hand-written comment by a member of the repository
 *   unverified  valid signature, key not registered in the project yet
 *   untrusted   no signature, a wrong one, or a hand-written comment by an outsider
 * Trust only changes how a message is shown: messages never approve or block anything.
 */
export const MACHINES_DIR = path.join(".sdlc", "machines");
export const MACHINE_RECORD_KIND = "agentic-sdlc-machine:v1";
export const TRUST = Object.freeze({ trusted: "trusted", unverified: "unverified", untrusted: "untrusted" });
const SIGNED_KIND = "agentic-sdlc-message:v1";
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const MAX_RECORD_BYTES = 8 * 1024;
const VERIFIED_CACHE_LIMIT = 5000;
const verifiedCache = new Map();

function field(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The bytes a signature covers: the fields every transport carries unchanged. */
export function signedPayload(fields) {
  return JSON.stringify([
    SIGNED_KIND,
    field(fields.mid),
    field(fields.machine),
    field(fields.from),
    field(fields.host),
    field(fields.story),
    field(fields.kind) ?? "info",
    field(fields.reply_to ?? fields.replyTo),
    field(fields.to),
    field(fields.version),
    Array.isArray(fields.stories) ? fields.stories.map(String) : null,
    field(fields.until),
    String(fields.text ?? "").trim(),
  ]);
}

/** Raw public key (base64 of the SPKI DER form) of a PEM key, the short form carried by a message. */
export function compactPublicKey(publicKeyPem) {
  return crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }).toString("base64");
}

function pemOf(compact) {
  try {
    return crypto.createPublicKey({ key: Buffer.from(String(compact ?? ""), "base64"), format: "der", type: "spki" }).export({ type: "spki", format: "pem" });
  } catch {
    return null;
  }
}

/**
 * The signature fields for a message: { machine, key, pub, sig }. `fields` are
 * the message fields plus `mid`. Never throws: without a usable key the
 * message goes out unsigned and reads as untrusted.
 */
export function signFields(fields, env = process.env) {
  try {
    const machine = machineId(env);
    const { publicKey, fingerprint } = machineKey(env);
    const sig = signWithMachineKey(signedPayload({ ...fields, machine }), env);
    return { machine, key: fingerprint, pub: compactPublicKey(publicKey), sig };
  } catch {
    return {};
  }
}

/**
 * Whether the signature fields of `fields` are a valid signature of its content
 * by the key they name. The cache holds only what the signature bytes decide
 * (payload valid for sig+pub, fingerprint of pub); the claimed `key` is compared
 * on every call, since it is not part of the signed payload.
 */
export function signatureValid(fields) {
  const sig = field(fields?.sig);
  const pub = field(fields?.pub);
  if (!sig || !pub || !field(fields?.machine)) return false;
  const payload = signedPayload(fields);
  const cacheKey = `${sig}|${pub}`;
  let known = verifiedCache.get(cacheKey);
  if (!known || known.payload !== payload) {
    const pem = pemOf(pub);
    const fingerprint = pem ? keyFingerprint(pem) : null;
    known = { payload, fingerprint, valid: Boolean(pem) && verifyMachineSignature(payload, sig, pem) };
    if (verifiedCache.size >= VERIFIED_CACHE_LIMIT) verifiedCache.delete(verifiedCache.keys().next().value);
    verifiedCache.set(cacheKey, known);
  }
  return known.valid && known.fingerprint !== null && known.fingerprint === fields.key;
}

function readRecord(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Registered keys of the project: Map machine id -> fingerprint. Only well-formed records count. */
export function readKnownKeys(root) {
  const known = new Map();
  if (!root) return known;
  const dir = path.join(root, MACHINES_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return known;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(path.join(dir, name));
    const id = String(record?.id ?? "");
    if (record?.schema_version !== MACHINE_RECORD_KIND || !ID_PATTERN.test(id) || `${id}.json` !== name) continue;
    try {
      const fingerprint = keyFingerprint(String(record.public_key));
      if (record.fingerprint && record.fingerprint !== fingerprint) continue;
      known.set(id, fingerprint);
    } catch {
      // A damaged key registers nothing.
    }
  }
  return known;
}

/** Fingerprint of the key a well-formed machine record for `id` holds, else null. */
function registeredFingerprint(record, id) {
  if (record?.schema_version !== MACHINE_RECORD_KIND || record.id !== id) return null;
  try {
    return keyFingerprint(String(record.public_key));
  } catch {
    return null;
  }
}

/** Fingerprint of this computer's key, or null when it cannot be made. */
export function ownFingerprint(env = process.env) {
  try {
    return machineKey(env).fingerprint;
  } catch {
    return null;
  }
}

/**
 * Trust of a signed (plugin) message. `expectedMachine`, when given, is the
 * machine the transport says wrote it (the owner of a git channel ref): a
 * signature by another machine does not count.
 */
export function signedTrust(fields, { known = new Map(), own = null, expectedMachine = null } = {}) {
  if (!signatureValid(fields)) return TRUST.untrusted;
  if (expectedMachine && fields.machine !== expectedMachine) return TRUST.untrusted;
  if (own && fields.key === own) return TRUST.trusted;
  return known.get(fields.machine) === fields.key ? TRUST.trusted : TRUST.unverified;
}

/** Trust of a comment a person wrote on a forge: members of the repository are trusted. */
export function associationTrust(association) {
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(String(association ?? "").toUpperCase()) ? TRUST.trusted : TRUST.untrusted;
}

/** Context for trust checks of one read: the project's registered keys and this computer's fingerprint. */
export function trustContext(root, env = process.env) {
  return { known: readKnownKeys(root), own: ownFingerprint(env) };
}

/**
 * Proposes this computer's key to the project: writes .sdlc/machines/<id>.json
 * when it is missing or unreadable. Returns { path, written, id, fingerprint }.
 * The file is committed and merged like any record; until then the other
 * computers show this computer's messages as unverified.
 *
 * A well-formed record holding a different key is never replaced: it may be
 * another computer with the same id (two computers with the same default host
 * name used to get one). The result then carries `conflict: true` and the
 * fingerprint already registered; a person deletes the file when it really is
 * this computer's old key.
 */
export function registerMachineKey(root, env = process.env, now = () => new Date().toISOString()) {
  const id = machineId(env);
  const { publicKey, fingerprint } = machineKey(env);
  const file = path.join(root, MACHINES_DIR, `${id}.json`);
  const relative = path.join(MACHINES_DIR, `${id}.json`);
  const current = readRecord(file);
  if (current?.schema_version === MACHINE_RECORD_KIND && current.fingerprint === fingerprint) {
    return { path: relative, written: false, id, fingerprint };
  }
  if (!ID_PATTERN.test(id)) return { path: null, written: false, id, fingerprint };
  const registered = registeredFingerprint(current, id);
  if (registered && registered !== fingerprint) {
    return { path: relative, written: false, id, fingerprint, conflict: true, registered_fingerprint: registered };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { schema_version: MACHINE_RECORD_KIND, id, public_key: publicKey, fingerprint, registered_at: now() };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return { path: relative, written: true, id, fingerprint };
}
