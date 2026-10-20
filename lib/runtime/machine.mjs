import path from "node:path";
import { crypto, Date, fs, os, process } from "../runtime/host.mjs";

/**
 * The identity of this computer, shared by every clone, worktree, session and
 * subagent on it. It lives outside every repository, in the user's config
 * folder:
 *
 *   <config>/agentic-sdlc/machine.json      { id, created_at, public_key, key_fingerprint }
 *   <config>/agentic-sdlc/machine-key.pem   Ed25519 private key (mode 0600), made on first use
 *
 * <config> is AGENTIC_SDLC_MACHINE_DIR's parent when that is set (tests, a
 * shared profile), else XDG_CONFIG_HOME, %APPDATA% on Windows, or ~/.config.
 *
 * The id is decided once and then kept: the host name of a laptop changes
 * with the network, the id does not. A computer that already kept an id
 * (`pc-` and a short hash of the host name) keeps it, so claims, stories and
 * messages written before keep pointing at it. A computer keeping its first
 * id adds a random part (`pc-<hash>-<random>`), so two computers with the
 * same default host name do not share one.
 * AGENTIC_SDLC_HOST_LABEL still wins over everything.
 */
export const MACHINE_DIR_ENV = "AGENTIC_SDLC_MACHINE_DIR";
export const MACHINE_FILE = "machine.json";
export const MACHINE_KEY_FILE = "machine-key.pem";
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

let cached = null;

/** Folder of the machine files. */
export function machineDir(env = process.env, home = os.homedir()) {
  const explicit = String(env[MACHINE_DIR_ENV] ?? "").trim();
  if (explicit) return path.resolve(explicit);
  const base = String(env.XDG_CONFIG_HOME ?? "").trim()
    || (process.platform === "win32" && String(env.APPDATA ?? "").trim())
    || path.join(home, ".config");
  return path.join(base, "agentic-sdlc");
}

/** The id the plugin derived from the host name before it was kept. */
export function legacyMachineId(hostname = os.hostname()) {
  return `pc-${crypto.createHash("sha256").update(hostname).digest("hex").slice(0, 6)}`;
}

/**
 * The id a computer gets the first time it keeps one: the legacy hash of the
 * host name plus a random part, so two computers with the same default host
 * name ("MacBook-Pro.local") no longer share an id. Ids already kept are never
 * changed; older plugins read the new form like any other id.
 */
export function newMachineId(hostname = os.hostname(), randomHex = () => crypto.randomBytes(4).toString("hex")) {
  const suffix = String(randomHex()).toLowerCase().replace(/[^0-9a-f]/gu, "").slice(0, 8);
  return suffix ? `${legacyMachineId(hostname)}-${suffix}` : legacyMachineId(hostname);
}

function readMachine(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MACHINE_FILE), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Writes the file only if nobody wrote it meanwhile (another session starting at the same moment). */
function writeMachineOnce(dir, record) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, MACHINE_FILE), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return record;
  } catch {
    return readMachine(dir) ?? record;
  }
}

function updateMachine(dir, record) {
  try {
    const file = path.join(dir, MACHINE_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // The key is still usable; the public key is recomputed next time.
  }
}

/**
 * The id that was really kept: the written record, or when the folder cannot
 * be written the legacy id, which is the same every time (a random id that
 * is not kept would change at every start).
 */
function keptOrLegacy(dir, hostname) {
  const kept = readMachine(dir);
  return ID_PATTERN.test(String(kept?.id ?? "")) ? kept.id : legacyMachineId(hostname);
}

/**
 * The stable id of this computer. Decided on first use and kept; never
 * throws: when the config folder cannot be written the id is still the same
 * one (the legacy hash of the host name), derived again next time.
 */
export function machineId(env = process.env, { home = os.homedir(), hostname = os.hostname(), now = () => new Date().toISOString(), randomHex } = {}) {
  const dir = machineDir(env, home);
  if (cached?.dir === dir) return cached.id;
  const stored = readMachine(dir);
  const id = ID_PATTERN.test(String(stored?.id ?? ""))
    ? stored.id
    : (writeMachineOnce(dir, { id: newMachineId(hostname, randomHex), created_at: now() }), keptOrLegacy(dir, hostname));
  cached = { dir, id };
  return id;
}

/** The Ed25519 key of this computer, made on first use: { publicKey (PEM), fingerprint, privateKey }. */
function readEd25519Key(keyFile) {
  try {
    const key = crypto.createPrivateKey(fs.readFileSync(keyFile, "utf8"));
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

/**
 * Creates this computer's key, published whole (a linked temp file), so a
 * session starting at the same moment never reads it half written. A key file
 * that is not a usable Ed25519 key is moved aside and replaced: messages
 * would otherwise go out unsigned until someone deletes it by hand.
 */
function createMachineKey(dir, keyFile) {
  const pair = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${keyFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.linkSync(temp, keyFile);
        return pair.privateKey;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      // Another session made it first: use that one, unless it is unusable.
      const existing = readEd25519Key(keyFile);
      if (existing) return existing;
      try {
        fs.renameSync(keyFile, `${keyFile}.unusable-${Date.now()}`);
      } catch {
        // Moved aside by another session meanwhile.
      }
    }
    return readEd25519Key(keyFile) ?? pair.privateKey;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function machineKey(env = process.env, { home = os.homedir() } = {}) {
  const dir = machineDir(env, home);
  const keyFile = path.join(dir, MACHINE_KEY_FILE);
  let privateKey = null;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, "utf8"));
  } catch {
    privateKey = null;
  }
  if (!privateKey || privateKey.asymmetricKeyType !== "ed25519") privateKey = createMachineKey(dir, keyFile);
  const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  const fingerprint = keyFingerprint(publicKey);
  const stored = readMachine(dir);
  if (stored && stored.key_fingerprint !== fingerprint) updateMachine(dir, { ...stored, public_key: publicKey, key_fingerprint: fingerprint });
  return { publicKey, fingerprint, privateKey };
}

/** Short hex fingerprint of an Ed25519 public key (PEM): sha256 of its DER form, 16 hex characters. */
export function keyFingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** Base64 Ed25519 signature of `data` with this computer's key. */
export function signWithMachineKey(data, env = process.env, options = {}) {
  const { privateKey } = machineKey(env, options);
  return crypto.sign(null, Buffer.from(String(data)), privateKey).toString("base64");
}

/** True when `signature` (base64) is a valid Ed25519 signature of `data` by `publicKeyPem`. */
export function verifyMachineSignature(data, signature, publicKeyPem) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    const raw = Buffer.from(String(signature ?? ""), "base64");
    return raw.length === 64 && crypto.verify(null, Buffer.from(String(data)), key, raw);
  } catch {
    return false;
  }
}

/** Forgets the cached id (tests). */
export function resetMachineCache() {
  cached = null;
}
