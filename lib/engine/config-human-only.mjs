/**
 * Which edits to `.sdlc/config.json` only a person may confirm with
 * `config migrate --apply`. The list of JSON pointers lives in
 * config/config-human-only.json.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fs } from "../runtime/host.mjs";

const POLICY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "config-human-only.json");

let cached = null;
export function humanOnlyConfigPaths() {
  cached ??= JSON.parse(fs.readFileSync(POLICY_FILE, "utf8")).paths;
  return cached;
}

function covers(prefix, pointer) {
  return pointer === prefix || pointer.startsWith(`${prefix}/`) || prefix.startsWith(`${pointer}/`) || pointer === "";
}

/**
 * The human-only pointers touched by `drift` (from configEditsSinceConfirmation).
 * Unknown edits (no confirmed copy to compare with) count as touching all of them.
 */
export function humanOnlyEdits(drift, paths = humanOnlyConfigPaths()) {
  if (!drift || drift.status !== "changed") return [];
  if (drift.change_count === null) return [...paths];
  const touched = new Set();
  for (const change of drift.changes) {
    for (const prefix of paths) if (covers(prefix, String(change.path ?? ""))) touched.add(prefix);
  }
  return [...touched];
}
