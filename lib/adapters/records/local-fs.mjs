import path from "node:path";
import { crypto, fs } from "../../runtime/host.mjs";
import { RECORD_GUARANTEES } from "../capabilities.mjs";
import { createFileRecordStore } from "./fs-store.mjs";
import { RecordStoreError, SEGMENT_PATTERN } from "./port.mjs";

/**
 * Records as plain files on this computer, without git: for a project that
 * is not a repository, for tests and for trying the plugin. Traces keep their
 * hash chain; nothing else is guaranteed, so a lifecycle certification is
 * refused (see GATE_REQUIREMENTS) and coordination state is only seen here.
 *
 * Options: { "dir": "<records folder>" } (default .sdlc), relative to the project.
 * Shared state lives in <records folder>/.shared-state/<namespace>/.
 */
export const LOCAL_FS_STORE_ID = "local-fs";
export const LOCAL_FS_GUARANTEES = Object.freeze([RECORD_GUARANTEES.hash_chain]);
const SHARED_DIR = ".shared-state";

function keyOf(payload) {
  const wanted = [payload?.wait_id, payload?.action].filter(Boolean).join("--");
  if (wanted && SEGMENT_PATTERN.test(wanted)) return wanted;
  return crypto.createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex").slice(0, 32);
}

export function createLocalFsStore({ root, sdlcRoot, options = {} }) {
  const recordsRoot = options.dir ? path.resolve(root, String(options.dir)) : sdlcRoot;
  const folder = (namespace) => {
    if (!SEGMENT_PATTERN.test(String(namespace))) throw new RecordStoreError("invalid_key", `'${namespace}' is not a valid namespace.`);
    return path.join(recordsRoot ?? path.join(root, ".sdlc"), SHARED_DIR, namespace);
  };
  const sharedState = Object.freeze({
    namespaces: Object.freeze(["*"]),
    read(namespace) {
      let names = [];
      try {
        names = fs.readdirSync(folder(namespace)).filter((name) => name.endsWith(".json")).sort();
      } catch {
        names = [];
      }
      const records = [];
      for (const name of names) {
        try {
          records.push({ ...JSON.parse(fs.readFileSync(path.join(folder(namespace), name), "utf8")), shared: false });
        } catch {
          // A damaged record counts for nothing.
        }
      }
      return { records, note: "local records only: this store does not share state between computers" };
    },
    write(namespace, payload) {
      const dir = folder(namespace);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${keyOf(payload)}.json`);
      try {
        fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, { flag: "wx" });
      } catch (error) {
        if (error?.code === "EEXIST") return { status: "exists", key: path.basename(file, ".json") };
        throw error;
      }
      return { status: "local", key: path.basename(file, ".json"), note: "kept on this computer only" };
    },
  });
  async function publish() {
    return { published: false, reason: "the local-fs store keeps records in place; there is nowhere to publish them" };
  }
  return createFileRecordStore({ id: LOCAL_FS_STORE_ID, root, sdlcRoot: recordsRoot, guarantees: LOCAL_FS_GUARANTEES, sharedState, publish });
}
