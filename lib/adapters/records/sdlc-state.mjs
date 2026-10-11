import { stateBranchOptions, STATE_RECORDS_PROVIDER } from "../../state-branch.mjs";
import { createGitSdlcStore, GIT_SDLC_GUARANTEES } from "./git-sdlc.mjs";
import { RecordStoreError } from "./port.mjs";

/**
 * The git store with its operational records (action receipts, executions,
 * non-final gate reports) on an orphan branch of the same remote instead of
 * the base branch (lib/state-branch.mjs). Records are read and written in
 * the working tree exactly as with git-sdlc; `mpsf state` and the
 * host hooks bring them to and from the state branch. History, immutability
 * and sharing still come from git, so every guarantee is kept.
 *
 * Options: { "branch": "sdlc-state", "remote": null, "push_interval_seconds": 120,
 *            "pull_interval_seconds": 60 }
 */
export const SDLC_STATE_STORE_ID = STATE_RECORDS_PROVIDER;

export function createSdlcStateStore({ root, sdlcRoot, options = {} }) {
  const settings = stateBranchOptions(options, (message) => {
    throw new RecordStoreError("invalid_options", message);
  });
  const base = createGitSdlcStore({ root, sdlcRoot });
  /** Story records still go to the base branch (publish-records); with `state: true` the state branch is pushed. */
  async function publish(request = {}) {
    if (request?.state !== true) return base.publish(request);
    const { pushStateRecords } = await import("../../engine/state-branch.mjs");
    return pushStateRecords({ root, sdlcRoot }, { force: true });
  }
  return Object.freeze({ ...base, id: SDLC_STATE_STORE_ID, guarantees: GIT_SDLC_GUARANTEES, stateBranch: settings, publish });
}
