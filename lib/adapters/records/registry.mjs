import path from "node:path";
import { fs, process } from "../../runtime/host.mjs";
import { normalizeAdapterSection, readProjectConfig } from "../config.mjs";
import { createGitSdlcStore, GIT_SDLC_STORE_ID } from "./git-sdlc.mjs";
import { createLocalFsStore, LOCAL_FS_STORE_ID } from "./local-fs.mjs";

/**
 * Record stores shipped with the plugin, by id. A team that keeps records
 * elsewhere (a document wiki, an issue tracker, a database) adds a factory
 * here implementing lib/adapters/records/port.mjs that passes the contract
 * suite in test/unit/adapters-records-contract.test.mjs, and declares only
 * the guarantees it really gives: gates refuse what it cannot back.
 */
export const RECORD_STORES = Object.freeze({
  [GIT_SDLC_STORE_ID]: createGitSdlcStore,
  [LOCAL_FS_STORE_ID]: createLocalFsStore,
});
export const RECORD_STORE_ALIASES = Object.freeze({ git: GIT_SDLC_STORE_ID, "sdlc-git": GIT_SDLC_STORE_ID, local: LOCAL_FS_STORE_ID });
export { GIT_SDLC_STORE_ID, LOCAL_FS_STORE_ID };

const cache = new Map();

function configStamp(root) {
  try {
    const stat = fs.statSync(path.join(root, ".sdlc", "config.json"));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "none";
  }
}

/** The validated records adapter section of a parsed project config. */
export function recordsAdapter(projectConfig) {
  return normalizeAdapterSection("records", projectConfig?.host_policy?.adapters?.records, {
    known: Object.keys(RECORD_STORES),
    aliases: RECORD_STORE_ALIASES,
  });
}

/**
 * The record store of a project: `{ root, sdlcRoot }` (an engine context
 * works), with the parsed config when the caller has it. Stores are kept per
 * root while its config file is unchanged. An invalid or unknown records
 * adapter throws: records never silently go somewhere else.
 */
export function openRecordStore(context, { config = undefined, stores = RECORD_STORES } = {}) {
  const root = path.resolve(String(context?.root ?? process.cwd()));
  const sdlcRoot = context?.sdlcRoot ? path.resolve(String(context.sdlcRoot)) : path.join(root, ".sdlc");
  const custom = stores !== RECORD_STORES || config !== undefined;
  const key = `${root}\u0000${sdlcRoot}`;
  const stamp = configStamp(root);
  const cached = custom ? null : cache.get(key);
  if (cached && cached.stamp === stamp) return cached.store;
  const adapter = recordsAdapter(config === undefined ? readProjectConfig(root) : config);
  const factory = stores[adapter.provider];
  if (!factory) throw new Error(`Record store '${adapter.provider}' is not available.`);
  const store = factory({ root, sdlcRoot, options: adapter.options });
  if (!custom) cache.set(key, { stamp, store });
  return store;
}
