import { RECORD_GUARANTEES } from "../capabilities.mjs";
import { createFileRecordStore } from "./fs-store.mjs";
import { RecordStoreError } from "./port.mjs";
import { registeredSharedNamespaces, sharedNamespaceHandler } from "./shared-namespaces.mjs";

/**
 * The default record store: the `.sdlc/` folder of the repository. History
 * and immutability come from git, publication is one commit on the base
 * branch (story publish-records), and coordination state is shared as
 * create-only refs on the remote (refs/agentic-sdlc/*). Records travel with
 * the code, so a merged change and its evidence share one history.
 */
export const GIT_SDLC_STORE_ID = "git-sdlc";
export const GIT_SDLC_GUARANTEES = Object.freeze(Object.values(RECORD_GUARANTEES));

export function createGitSdlcStore({ root, sdlcRoot }) {
  const sharedState = Object.freeze({
    get namespaces() {
      return registeredSharedNamespaces();
    },
    read(namespace, options = {}) {
      const handler = sharedNamespaceHandler(namespace);
      if (!handler) throw new RecordStoreError("unknown_namespace", `No shared state '${namespace}' is known.`);
      return handler.read(root, options);
    },
    write(namespace, payload) {
      const handler = sharedNamespaceHandler(namespace);
      if (!handler) throw new RecordStoreError("unknown_namespace", `No shared state '${namespace}' is known.`);
      return handler.write(root, payload);
    },
  });
  /** Brings a story's records to the base branch: one commit, pushed as its own branch (see story publish-records). */
  async function publish({ context, options }) {
    if (!context || !options) throw new RecordStoreError("invalid_request", "publish needs the command context and options.");
    const { publishStoryRecords } = await import("../../engine/story-records-publish.mjs");
    return publishStoryRecords(context, options);
  }
  return createFileRecordStore({ id: GIT_SDLC_STORE_ID, root, sdlcRoot, guarantees: GIT_SDLC_GUARANTEES, sharedState, publish });
}
