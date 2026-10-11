import { process } from "../../runtime/host.mjs";
import { createGiteaForge, FORGEJO_FORGE_ID, GITEA_FORGE_ID } from "./gitea.mjs";
import { createGitHubForge, GITHUB_FORGE_ID } from "./github.mjs";
import { createGitLabForge, GITLAB_FORGE_ID } from "./gitlab.mjs";

/**
 * Forge adapters the coordinator merges and reads CI through. A forge is
 * picked by AGENTIC_SDLC_FORGE, else from the remote URL. Each adapter has
 * the same four methods: baseStatus(branch), listPullRequests(base),
 * mergePullRequest({ number, headSha, method }), updateBranch({ number }).
 * Self-managed GitLab or Gitea on a host whose name does not say so is
 * chosen with AGENTIC_SDLC_FORGE (and AGENTIC_SDLC_FORGE_URL for another
 * port or a path prefix).
 */
export const FORGE_ENV = "AGENTIC_SDLC_FORGE";
const ADAPTERS = Object.freeze({
  [GITHUB_FORGE_ID]: createGitHubForge,
  [GITLAB_FORGE_ID]: createGitLabForge,
  [GITEA_FORGE_ID]: (options) => createGiteaForge({ ...options, id: GITEA_FORGE_ID }),
  [FORGEJO_FORGE_ID]: (options) => createGiteaForge({ ...options, id: FORGEJO_FORGE_ID }),
});

export function forgeIds() {
  return Object.keys(ADAPTERS);
}

function remoteHost(text) {
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/u.exec(text);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    try {
      return new URL(text).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  return scp ? scp[1].toLowerCase() : "";
}

/** The forge id a remote URL points to, or null when none is known. */
export function detectForge(url) {
  const host = remoteHost(String(url ?? "").trim());
  if (!host) return null;
  if (host === "github.com" || host.endsWith(".github.com")) return GITHUB_FORGE_ID;
  if (host === "codeberg.org" || /(^|[.-])forgejo([.-]|$)/u.test(host)) return FORGEJO_FORGE_ID;
  if (/(^|[.-])gitea([.-]|$)/u.test(host)) return GITEA_FORGE_ID;
  if (/(^|[.-])gitlab([.-]|$)/u.test(host)) return GITLAB_FORGE_ID;
  return null;
}

/** { forge, id } or { forge: null, id, reason } when no adapter fits. */
export function resolveForge(root, { env = process.env, url = null, runner, http, gitRunner } = {}) {
  const chosen = String(env[FORGE_ENV] ?? "").trim().toLowerCase() || detectForge(url);
  if (!chosen) return { forge: null, id: null, reason: `no forge adapter for this remote; set ${FORGE_ENV} to one of ${forgeIds().join(", ")}` };
  const create = ADAPTERS[chosen];
  if (!create) return { forge: null, id: chosen, reason: `unknown forge '${chosen}'; known: ${forgeIds().join(", ")}` };
  try {
    return { forge: create({ root, url, env, ...(runner ? { runner } : {}), ...(http ? { http } : {}), ...(gitRunner ? { gitRunner } : {}) }), id: chosen };
  } catch (error) {
    return { forge: null, id: chosen, reason: String(error?.message ?? error) };
  }
}
