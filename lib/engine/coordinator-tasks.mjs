import path from "node:path";

import { console, Date, fs, process } from "../runtime/host.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";
import { UserError } from "../cli/user-error.mjs";
import { VERSION } from "./definitions.mjs";
import { runGit } from "./shared-refs.mjs";
import { holdsRole, liveHosts, readCoordinationCopies, rolesStatus } from "./role-leases.mjs";
import { hostId } from "../messaging/identity.mjs";

/**
 * Duties of the coordinator role about claims and waits, each a standalone,
 * idempotent command (`coordinator free-claims|settle-waits|handoff`)
 * with --dry-run and --json. Each one runs only on the computer that holds the
 * coordinator role (holdsRole: with no shared remote, roles off or no valid
 * lease every computer does, as before roles) and does nothing elsewhere.
 *
 *   free-claims      frees a claim (and saves its handoff pack) only when its lease ended (no push within the
 *                    claim time to live), no declared wait protects it and its
 *                    holder has no live presence, nor one that ended within
 *                    FREE_CLAIMS_PRESENCE_GRACE_MS; otherwise a person decides
 *   settle-waits     closes expired explicit waits and stale channel questions
 *   handoff          builds the handoff pack of a story again, on demand
 */
export const COORDINATOR_ROLE = "coordinator";
export const COORDINATOR_AGENT = "coordinator";
/**
 * How long after a presence ended its computer still counts as possibly
 * there for free-claims: renewals back off for minutes on a slow link and
 * clocks drift, so a claim is not freed under a computer that is merely late.
 */
export const FREE_CLAIMS_PRESENCE_GRACE_MS = 15 * 60_000;
const HANDOFF_DIR = "handoffs";

function projectRoot(options) {
  return path.resolve(String(options.root || process.cwd()));
}

function emit(options, payload, lines) {
  if (options.json === true) console.log(JSON.stringify(payload, null, 2));
  else console.log(lines.filter(Boolean).join("\n"));
  return payload;
}

/** Null when this computer runs the coordinator's duties now, else the skipped result (printed). */
function notCoordinator(root, command, options, env, now) {
  const role = holdsRole(root, COORDINATOR_ROLE, { env, now });
  if (role.holds) return null;
  return emit(options, { command, status: "skipped", reason: "not_coordinator", holder: role.holder, mode: role.mode }, [
    `${command}: nothing done, the coordinator role is held by ${role.holder} (${role.mode}).`,
  ]);
}

/** Presence copies after one bounded fetch of the coordination refs (local copies with --offline). */
function presenceNow(root, options, env, now) {
  try {
    const status = rolesStatus(root, { env, now, fetch: options.offline !== true });
    // A shared remote that could not be read: old copies would make live computers look gone.
    if (options.offline !== true && status.shared && status.note) return [];
  } catch {
    // The local copies are used as they are.
  }
  return readCoordinationCopies(root).presence;
}

// ---- free-claims ------------------------------------------------------------------------------------------

/**
 * What to do with each abandoned claim (status says its lease ended with no
 * push and no valid wait). Pure. A holder counts as present when a live
 * presence names the story or its claim identity names a live computer;
 * with no presence known at all, presence cannot be ruled out and a person
 * decides. Returns [{ story_id, action: "free"|"ask", reason, holder }].
 */
export function planFreeClaims({ stories = [], presence = [], now = Date.now(), graceMs = FREE_CLAIMS_PRESENCE_GRACE_MS } = {}) {
  const live = new Set(liveHosts(presence, now));
  const late = new Set(liveHosts(presence, now - Math.max(0, Number(graceMs) || 0)).filter((host) => !live.has(host)));
  // No live presence at all, this computer's included, means stale copies (a failed fetch), not every holder gone.
  const stale = presence.length > 0 && live.size === 0;
  const plans = [];
  for (const story of stories) {
    if (story.claim_health?.state !== "abandoned") continue;
    const holder = story.shared_claim?.holder ?? null;
    const base = { story_id: story.id, holder: holder ? { agent: holder.agent, branch: holder.branch, host: holder.identity?.host ?? null, epoch: holder.epoch } : null, lease_expires_at: story.claim_health.lease_expires_at ?? null, last_activity_at: story.claim_health.last_activity_at ?? null };
    if (!holder || holder.reservation || holder.parked || !Number.isSafeInteger(holder.epoch) || !holder.claimant_id) {
      plans.push({ ...base, action: "ask", reason: "not_shared" });
      continue;
    }
    const host = holder.identity?.host ?? null;
    const named = presence.filter((item) => live.has(item.host) && Array.isArray(item.stories) && item.stories.includes(story.id)).map((item) => item.host);
    if (named.length > 0 || (host && live.has(host))) {
      plans.push({ ...base, action: "ask", reason: "holder_present", present: [...new Set([...named, ...(host && live.has(host) ? [host] : [])])] });
    } else if ((host && late.has(host)) || presence.some((item) => late.has(item.host) && Array.isArray(item.stories) && item.stories.includes(story.id))) {
      // A presence just past its end is a slow link or a skewed clock more often than a computer gone.
      plans.push({ ...base, action: "ask", reason: "holder_presence_late" });
    } else if (presence.length === 0 || stale) {
      plans.push({ ...base, action: "ask", reason: "presence_unknown" });
    } else {
      plans.push({ ...base, action: "free", reason: "lease_expired_no_wait_no_presence" });
    }
  }
  return plans.sort((left, right) => left.story_id.localeCompare(right.story_id, "en"));
}

/** Brings the remote's claim branches in (bounded), so pushes made elsewhere renew their leases first. */
function fetchClaimBranches(context, remote, branches, timeoutSeconds) {
  const names = [...new Set(branches.filter((branch) => /^[A-Za-z0-9._/-]{1,200}$/u.test(String(branch || ""))))];
  if (names.length === 0) return;
  runGit(context.root, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", remote, ...names.map((name) => `+refs/heads/${name}:refs/remotes/${remote}/${name}`)], { timeoutSeconds });
}

async function abandonedSnapshot(context) {
  const { buildOrchestrationSnapshot } = await import("./common.mjs");
  return buildOrchestrationSnapshot(context, { sharedClaims: true });
}

/** `coordinator free-claims [--dry-run] [--offline] [--json]` */
export async function freeClaimsCommand(context, options = {}, env = process.env) {
  const root = context.root;
  const now = Date.now();
  const skipped = notCoordinator(root, "free-claims", options, env, now);
  if (skipped) return skipped;
  const { storyClaimPolicy, resolveClaimScope, shareStoryClaimRelease } = await import("./story-claim-shared.mjs");
  const policy = storyClaimPolicy(context);
  const target = resolveClaimScope(context, policy.coordination);
  let snapshot = await abandonedSnapshot(context);
  let plans = planFreeClaims({ stories: snapshot.stories, presence: presenceNow(root, options, env, now), now });
  if (options.offline !== true && target.scope === "shared" && !target.unavailable && plans.some((item) => item.action === "free")) {
    fetchClaimBranches(context, target.remote, plans.filter((item) => item.action === "free").map((item) => item.holder?.branch), policy.coordination.timeout_seconds);
    snapshot = await abandonedSnapshot(context);
    plans = planFreeClaims({ stories: snapshot.stories, presence: readCoordinationCopies(root).presence, now });
  }
  const self = hostId(env);
  const results = [];
  for (const plan of plans) {
    if (plan.action !== "free" || options["dry-run"] === true) {
      results.push({ ...plan, outcome: plan.action === "free" ? "would_free" : "person_decides" });
      continue;
    }
    const story = snapshot.stories.find((item) => item.id === plan.story_id);
    const holder = story.shared_claim.holder;
    const released = shareStoryClaimRelease(context, {
      claim: { story_id: plan.story_id, shared_claim: { scope: "shared", remote: target.remote, remote_fingerprint: target.fingerprint, claimant_id: holder.claimant_id, epoch: holder.epoch } },
      status: "released",
      reason: `freed by the coordinator (${self}): the lease ended at ${plan.lease_expires_at} with no push, no declared wait and no live presence of the holder`,
      releasedAt: new Date(now).toISOString(),
      agent: COORDINATOR_AGENT,
      actor: { id: self, type: "agent" },
      personDecision: true,
    });
    const outcome = released?.status === "shared" ? "freed" : released?.status === "already_shared" || released?.status === "taken_over" ? "already_free" : "not_freed";
    let handoff = null;
    if (outcome === "freed") {
      try {
        handoff = (await buildHandoff(context, plan.story_id, snapshot)).file;
      } catch {
        // The claim is freed either way; `coordinator handoff --story` builds the pack later.
      }
    }
    results.push({ ...plan, outcome, ...(handoff ? { handoff } : {}), ...(outcome === "not_freed" ? { error: released?.error ?? "claims are not shared" } : {}) });
  }
  const payload = { command: "free-claims", status: "ok", dry_run: options["dry-run"] === true, claims: results };
  const lines = results.length === 0 ? ["free-claims: no abandoned claim."] : results.map((item) => {
    if (item.outcome === "freed") return `${item.story_id}: freed (lease ended ${item.lease_expires_at})${item.handoff ? `; handoff pack in ${item.handoff}` : `; handoff: mpsf coordinator handoff --story ${item.story_id}`}`;
    if (item.outcome === "would_free") return `${item.story_id}: would be freed (lease ended ${item.lease_expires_at}).`;
    if (item.outcome === "already_free") return `${item.story_id}: already freed elsewhere.`;
    if (item.outcome === "not_freed") return `${item.story_id}: NOT freed (${item.error}); run again later.`;
    if (item.reason === "holder_presence_late") return `${item.story_id}: not freed yet, its holder's presence ended only minutes ago (a slow link or clock); run again later.`;
    const why = item.reason === "holder_present" ? `its holder is still present (${item.present.join(", ")})` : item.reason === "presence_unknown" ? "no computer presence is known here" : "the claim is not shared";
    return `${item.story_id}: a person decides, ${why}: mpsf story claim --id ${item.story_id} --agent "<agent>" --force --reason "<why>" --actor-type human, or story park.`;
  });
  return emit(options, payload, lines);
}

// ---- handoff ----------------------------------------------------------------------------------------------

function handoffPath(root, storyId) {
  const common = findGitCommonDir(root);
  return common ? path.join(common, "agentic-sdlc", HANDOFF_DIR, `${storyId}.md`) : null;
}

/** The handoff text of one story (previous holder, branch, last push, then the pack); saved unless `write` is false. */
async function buildHandoff(context, storyId, snapshot, { budget = null, write = true } = {}) {
  const { buildContextPack } = await import("../context/service.mjs");
  const { HANDOFF_PHASE } = await import("../context/pack.mjs");
  const story = snapshot.stories.find((item) => item.id === storyId) ?? null;
  const holder = story?.shared_claim?.holder ?? null;
  const state = story?.orchestration_state ?? "unknown";
  const built = buildContextPack(context, { story: storyId, phase: HANDOFF_PHASE, budget, cache: write, pluginVersion: VERSION });
  const header = [
    `# Handoff ${storyId}`,
    `State: ${state}${holder ? `; claimed by ${holder.agent} on ${holder.branch} since ${holder.claimed_at}` : ""}.`,
    story?.claim_health?.last_activity_at ? `Last push on the claim branch: ${story.claim_health.last_activity_at}.` : null,
    holder?.branch ? `Earlier work, if pushed: branch ${holder.branch} on the remote.` : null,
    `Take it: mpsf story claim --id ${storyId} --agent "<agent>"`,
    "",
  ].filter((line) => line !== null).join("\n");
  const text = `${header}\n${built.text}`;
  const file = write ? handoffPath(context.root, storyId) : null;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return { story: storyId, state, file, text, pack: built.pack };
}

/** `coordinator handoff --story <id> [--budget <tokens>] [--dry-run] [--json]` */
export async function handoffCommand(context, options = {}, env = process.env) {
  const storyId = String(options.story ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/u.test(storyId)) throw new UserError("coordinator handoff needs --story <story-id>.");
  const skipped = notCoordinator(context.root, "handoff", options, env, Date.now());
  if (skipped) return skipped;
  const handoff = await buildHandoff(context, storyId, await abandonedSnapshot(context), { budget: options.budget, write: options["dry-run"] !== true });
  const payload = { command: "handoff", status: "ok", dry_run: options["dry-run"] === true, story: storyId, state: handoff.state, file: handoff.file, pack_tokens: handoff.pack.tokens, pack: handoff.pack };
  if (options.json === true) return emit(options, payload, []);
  process.stdout.write(`${handoff.text}${handoff.file ? `\n(saved in ${handoff.file})\n` : ""}`);
  return payload;
}

// ---- settle-waits -----------------------------------------------------------------------------------------

/**
 * The waits the coordinator closes: explicit waits past their end (expired,
 * or escalated and past their end) and channel questions older than their
 * maximum age (stale). Pure. Returns [{ id, kind, resolution }].
 */
export function planSettleWaits(waits = [], { now = Date.now() } = {}) {
  const ended = (item) => {
    const until = Date.parse(String(item.until ?? ""));
    return Number.isFinite(until) && until <= now;
  };
  return waits.flatMap((item) => {
    if (item.source === "explicit" && (item.state === "expired" || (item.state === "escalated" && ended(item)))) {
      return [{ id: item.id, kind: "expired_wait", resolution: `expired at ${item.until}: closed by the coordinator` }];
    }
    if (item.blocker?.type === "question" && item.state === "stale") {
      return [{ id: item.id, kind: "stale_question", resolution: `no answer since ${item.since}: stale question closed by the coordinator` }];
    }
    return [];
  });
}

/** `coordinator settle-waits [--dry-run] [--offline] [--json]` */
export async function settleWaitsCommand(options = {}, env = process.env) {
  const root = projectRoot(options);
  const now = Date.now();
  const skipped = notCoordinator(root, "settle-waits", options, env, now);
  if (skipped) return skipped;
  const { buildWaitPayload, collectWaits, writeSharedWaitRecord } = await import("./wait-registry.mjs");
  const collected = collectWaits(root, { env, now, fetch: options.offline !== true });
  const plans = planSettleWaits(collected.waits, { now });
  const self = hostId(env);
  const results = plans.map((plan) => {
    if (options["dry-run"] === true) return { ...plan, outcome: "would_close" };
    const written = writeSharedWaitRecord(root, buildWaitPayload({ waitId: plan.id, action: "resolve", resolution: plan.resolution, actor: { host: self, name: COORDINATOR_AGENT }, createdAt: new Date(now).toISOString() }));
    const outcome = written.status === "exists" ? "already_closed" : written.status === "not_shared" ? "not_shared" : "closed";
    return { ...plan, outcome, ...(written.error ? { error: written.error } : {}) };
  });
  const payload = { command: "settle-waits", status: "ok", dry_run: options["dry-run"] === true, waits: results, ...(collected.note ? { note: collected.note } : {}) };
  const lines = results.length === 0 ? ["settle-waits: no expired wait and no stale question."] : results.map((item) => `${item.id}: ${item.outcome.replace("_", " ")} (${item.kind.replace("_", " ")})${item.error ? `: ${item.error}` : ""}`);
  return emit(options, payload, lines);
}

function projectConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".sdlc", "config.json"), "utf8"));
  } catch {
    return null;
  }
}
