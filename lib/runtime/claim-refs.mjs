import path from "node:path";
import { fs } from "./host.mjs";

/**
 * Claim refs as this clone last saw them, to tell whether a claim recorded in
 * a working tree has ended. A claim file is a snapshot of the branch that is
 * checked out, so a worktree behind the base branch can still say "active"
 * after the story was released elsewhere; the shared refs written when a
 * claim or release is published are clone-wide and do not go stale that way.
 *
 * Ref names look like
 *   refs/agentic-sdlc-shared/claims/<remote fingerprint, 16>/<story>/<epoch>/claim|release
 *   refs/agentic-sdlc/claims/<story>/<epoch>/claim|release
 */
export const CLAIM_REF_PREFIXES = Object.freeze(["refs/agentic-sdlc-shared/claims/", "refs/agentic-sdlc/claims/"]);
const CLAIM_REF = /\/claims\/(?:([0-9a-f]{16})\/)?([^/]+)\/([0-9]{6})\/(claim|release)$/u;
const OWN_REF = /\/claims\/([^/]+)\/([0-9]{6})\/claim$/u;
const MAX_DEPTH = 6;

function walk(dir, prefix, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), `${name}/`, depth + 1, out);
    else if (entry.isFile()) out.add(name);
  }
}

/**
 * Names of the claim refs of a repository, read from the ref files and
 * packed-refs (no git process). Null when they cannot be read this way
 * (no common dir, or a reftable repository): callers keep today's behaviour.
 */
export function readClaimRefNames(commonDir) {
  if (!commonDir) return null;
  if (fs.existsSync(path.join(commonDir, "reftable"))) return null;
  const names = new Set();
  for (const prefix of CLAIM_REF_PREFIXES) walk(path.join(commonDir, ...prefix.split("/").filter(Boolean)), prefix, 0, names);
  try {
    for (const line of fs.readFileSync(path.join(commonDir, "packed-refs"), "utf8").split("\n")) {
      const name = line.split(" ")[1];
      if (name && CLAIM_REF_PREFIXES.some((prefix) => name.startsWith(prefix))) names.add(name.trim());
    }
  } catch {
    // no packed-refs
  }
  return names;
}

/**
 * True when the refs show that `claim` (a claim.json record) has ended: its
 * own epoch was released, or a later epoch of the same story exists. A claim
 * that was never shared, or refs that cannot be read, never count as ended.
 */
export function claimEndedByRefs(claim, refNames) {
  if (!refNames || claim?.shared_claim?.scope !== "shared") return false;
  const own = OWN_REF.exec(String(claim.shared_claim.ref ?? ""));
  if (!own) return false;
  const [, storyId, epoch] = own;
  const fingerprint = String(claim.shared_claim.remote_fingerprint ?? "").slice(0, 16) || null;
  for (const name of refNames) {
    const match = CLAIM_REF.exec(name);
    if (!match || match[2] !== storyId) continue;
    if (match[1] && fingerprint && match[1] !== fingerprint) continue;
    if (match[3] > epoch || (match[3] === epoch && match[4] === "release")) return true;
  }
  return false;
}
