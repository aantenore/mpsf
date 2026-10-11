import path from "node:path";
import { crypto, fs, os, process } from "./host.mjs";

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
 * with the network, the id does not. It is the id the plugin always used
 * (`pc-` and a short hash of the host name at that moment), so claims,
 * stories and messages written before keep pointing at this computer.
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
 * The stable id of this computer. Decided on first use and kept; never
 * throws: when the config folder cannot be written the id is still the same
 * one, derived again next time.
 */
export function machineId(env = process.env, { home = os.homedir(), hostname = os.hostname(), now = () => new Date().toISOString() } = {}) {
  const dir = machineDir(env, home);
  if (cached?.dir === dir) return cached.id;
  const stored = readMachine(dir);
  const id = ID_PATTERN.test(String(stored?.id ?? ""))
    ? stored.id
    : writeMachineOnce(dir, { id: legacyMachineId(hostname), created_at: now() }).id;
  cached = { dir, id };
  return id;
}

/** The Ed25519 key of this computer, made on first use: { publicKey (PEM), fingerprint, privateKey }. */
export function machineKey(env = process.env, { home = os.homedir() } = {}) {
  const dir = machineDir(env, home);
  const keyFile = path.join(dir, MACHINE_KEY_FILE);
  let privateKey = null;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, "utf8"));
  } catch {
    privateKey = null;
  }
  if (!privateKey || privateKey.asymmetricKeyType !== "ed25519") {
    const pair = crypto.generateKeyPairSync("ed25519");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(keyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
      privateKey = pair.privateKey;
    } catch {
      // Another session made it first: use that one.
      privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, "utf8"));
    }
  }
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
