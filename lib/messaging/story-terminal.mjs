// Whether a story is already over (merged, released, closed, abandoned or superseded),
// read from the project's own records with the shared lifecycle derivation.

import fs from "node:fs";
import path from "node:path";

import { deriveStoryLifecycle } from "../change-observatory/story-progress.mjs";
import { mergeReceiptEvidence } from "../engine/merge-receipts.mjs";

const TERMINAL_KEYS = new Set(["superseded", "abandoned", "closed", "merged"]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The lifecycle key of the story ("merged", "closed", "inProgress"...), from files on disk. */
export function storyLifecycleKey(root, storyId) {
  const sdlcRoot = path.join(root, ".sdlc");
  const final = readJson(path.join(sdlcRoot, "gates", `${storyId}-final.json`));
  const checkpoint = readJson(path.join(sdlcRoot, "workflows", "instances", `DELIVERY-${storyId}`, "checkpoint.json"));
  let merged = false;
  try {
    merged = mergeReceiptEvidence({ root, sdlcRoot }, storyId)?.passed === true;
  } catch {
    // Unreadable receipts prove nothing.
  }
  return deriveStoryLifecycle({
    closureEvent: readJson(path.join(sdlcRoot, "stories", storyId, "closure.json"))?.event ?? null,
    finalGatePassed: final?.lifecycle_complete === true && final?.status === "passed",
    workflowState: checkpoint?.current_state ?? null,
    deliveryState: merged ? "merged" : null,
  }).key;
}

/** True when the story needs no more help from the other computers. */
export function storyIsTerminal(root, storyId) {
  if (!storyId) return false;
  try {
    return TERMINAL_KEYS.has(storyLifecycleKey(root, storyId));
  } catch {
    return false;
  }
}
