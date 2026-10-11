import { process } from "../../runtime/host.mjs";
import { createGitHubForge, GITHUB_FORGE_ID } from "./github.mjs";

/**
 * Forge adapters the coordinator merges and reads CI through. A forge is
 * picked by AGENTIC_SDLC_FORGE, else from the remote URL. Another forge
 * (GitLab, Gitea, Azure DevOps, Bitbucket) is one more entry here with the
 * same four methods: baseStatus(branch), listPullRequests(base),
 * mergePullRequest({ number, headSha, method }), updateBranch({ number }).
 */
export const FORGE_ENV = "AGENTIC_SDLC_FORGE";
const ADAPTERS = Object.freeze({ [GITHUB_FORGE_ID]: createGitHubForge });

export function forgeIds() {
  return Object.keys(ADAPTERS);
}

/** The forge id a remote URL points to, or null when none is known. */
export function detectForge(url) {
  const text = String(url ?? "");
  if (/(^|[@/.])github\.com[:/]/iu.test(text)) return GITHUB_FORGE_ID;
  return null;
}

/** { forge, id } or { forge: null, id, reason } when no adapter fits. */
export function resolveForge(root, { env = process.env, url = null, runner } = {}) {
  const chosen = String(env[FORGE_ENV] ?? "").trim().toLowerCase() || detectForge(url);
  if (!chosen) return { forge: null, id: null, reason: `no forge adapter for this remote; set ${FORGE_ENV} to one of ${forgeIds().join(", ")}` };
  const create = ADAPTERS[chosen];
  if (!create) return { forge: null, id: chosen, reason: `unknown forge '${chosen}'; known: ${forgeIds().join(", ")}` };
  return { forge: create({ root, ...(runner ? { runner } : {}) }), id: chosen };
}
