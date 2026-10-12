import path from "node:path";

import { fs } from "../runtime/host.mjs";
import { remoteBaseRef } from "../engine/merge-drift.mjs";
import { firstLine, runGit } from "../engine/shared-refs.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";

export const OBSERVATORY_REMOTE_STORIES_SCHEMA_VERSION = "change-observatory:remote-stories:v1";
const DEFAULT_TIMEOUT_SECONDS = 5;
const MAX_REMOTE_STORIES = 500;
const MAX_CACHED_REFS = 16;
const CACHE = new Map();
const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Stories recorded on the remote base branch that this checkout does not
 * have yet, read from the remote-tracking branch that `status` keeps up to
 * date. Read-only: no fetch, no checkout change, no write.
 */
export function readRemoteOnlyStories(projectRoot, {
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  git = (args) => runGit(projectRoot, args, { timeoutSeconds }),
  baseRef = null,
  hasLocalStory = (id) => fs.existsSync(path.join(projectRoot, ".sdlc", "stories", id)),
} = {}) {
  let base = baseRef;
  if (!base) {
    let policy;
    try {
      policy = orchestrationPolicy(readConfig(projectRoot));
    } catch {
      policy = null;
    }
    const remote = policy?.coordination?.remote || "origin";
    try {
      base = remoteBaseRef({ root: projectRoot }, remote, policy?.merge_drift?.base_branch ?? null, timeoutSeconds);
    } catch {
      base = null;
    }
  }
  if (!base) return result({ checked: false });
  // Live polling calls this every few seconds: while the remote base branch
  // has not moved (same commit), the listing and every story already read are
  // reused and the only process started is the one that resolves the ref.
  const sha = firstLine(git(["rev-parse", "--verify", "--quiet", `${base.ref}^{commit}`]).stdout);
  const cacheKey = sha ? `${projectRoot}\0${base.ref}` : null;
  let cached = cacheKey ? CACHE.get(cacheKey) : null;
  if (!cached || cached.sha !== sha) {
    cached = { sha, ids: null, stories: new Map() };
    if (cacheKey) {
      CACHE.delete(cacheKey);
      CACHE.set(cacheKey, cached);
      while (CACHE.size > MAX_CACHED_REFS) CACHE.delete(CACHE.keys().next().value);
    }
  }
  if (!cached.ids) {
    const listed = git(["ls-tree", "--name-only", `${base.ref}:.sdlc/stories`]);
    if (!listed.ok) return result({ checked: true, branch: base.branch });
    cached.ids = String(listed.stdout ?? "").split("\n").map((line) => line.trim())
      .filter((id) => STORY_ID.test(id));
  }
  const ids = cached.ids.filter((id) => !hasLocalStory(id)).slice(0, MAX_REMOTE_STORIES);
  const stories = [];
  for (const id of ids) {
    if (!cached.stories.has(id)) cached.stories.set(id, readStory(git, base.ref, id));
    const story = cached.stories.get(id);
    if (story) stories.push(story);
  }
  return result({ checked: true, branch: base.branch, stories });
}

function readStory(git, ref, id) {
  const shown = git(["show", `${ref}:.sdlc/stories/${id}/story.json`]);
  if (!shown.ok) return null;
  let record;
  try {
    record = JSON.parse(shown.stdout);
  } catch {
    return null;
  }
  if (record?.id && record.id !== id) return null;
  const when = firstLine(git(["log", "-1", "--format=%cI", ref, "--", `.sdlc/stories/${id}`]).stdout) || null;
  return {
    storyId: id,
    title: typeof record?.title === "string" ? record.title : null,
    status: typeof record?.status === "string" ? record.status : null,
    phase: typeof record?.phase === "string" ? record.phase : null,
    requirementIds: Array.isArray(record?.requirement_refs)
      ? record.requirement_refs.filter((value) => typeof value === "string")
      : [],
    createdAt: typeof record?.created_at === "string" ? record.created_at : null,
    recordedAt: when,
  };
}

function readConfig(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, ".sdlc", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

function result({ checked, branch = null, stories = [] }) {
  return { schemaVersion: OBSERVATORY_REMOTE_STORIES_SCHEMA_VERSION, checked, branch, stories };
}
