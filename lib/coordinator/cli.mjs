import { Date, process } from "../runtime/host.mjs";
import { fail } from "../cli/user-error.mjs";
import { output } from "../engine/output.mjs";
import { humanGuidanceLocale } from "../lifecycle/guidance.mjs";
import { liveHosts, readCoordinationCopies } from "../engine/role-leases.mjs";
import { runGit } from "../engine/shared-refs.mjs";
import { recapStatus } from "../messaging/recap.mjs";
import { sendAutoAlert } from "../messaging/auto.mjs";
import { buildDigest, digestDue } from "./digest.mjs";
import { planMainGreen } from "./main-green.mjs";
import { runMergeQueue } from "./merge-queue.mjs";
import { MERGE_METHODS } from "./forges/github.mjs";
import { resolveForge } from "./forges/index.mjs";
import { checkStoryRecords, defaultRecordsRef, readRefStoryRecords } from "./records-check.mjs";
import {
  coordinatorGate,
  projectCoordinates,
  readCoordinatorState,
  readLocalStories,
  remoteUrl,
  skippedLines,
  skippedResult,
  updateCoordinatorState,
} from "./project.mjs";

/**
 * `coordinator digest|check-records|main-green|merge`: the project duties
 * the coordinator runs once for everyone. Each one is idempotent, accepts
 * --dry-run and --json, and does nothing on a computer that does not hold
 * the coordinator role (lib/coordinator/project.mjs).
 */

function text(options, name) {
  const value = options[name];
  return value === undefined || value === null || value === true ? "" : String(Array.isArray(value) ? value.at(-1) : value).trim();
}

function list(value) {
  if (value === undefined || value === null || value === false || value === true) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}

function gated(context, options, task, deps) {
  const gate = coordinatorGate(context.root, { env: deps.env ?? process.env, now: deps.now ?? Date.now(), ...(deps.holds ? { holds: deps.holds } : {}) });
  if (gate.holds) return null;
  const result = skippedResult(task, gate);
  output(options, result, skippedLines(task, gate, humanGuidanceLocale(options) === "it"));
  return result;
}

function forgeFor(context, deps) {
  if (deps.forge) return deps.forge;
  const { remote } = projectCoordinates(context.root);
  const resolved = resolveForge(context.root, { env: deps.env ?? process.env, url: remoteUrl(context.root, remote) });
  if (!resolved.forge) fail(resolved.reason);
  return resolved.forge;
}

/** `coordinator digest [--force] [--dry-run] [--json]` */
export async function coordinatorDigestCommand(context, options, deps = {}) {
  const task = "coordinator digest";
  const skipped = gated(context, options, task, deps);
  if (skipped) return skipped;
  const now = deps.now ?? Date.now();
  const italian = humanGuidanceLocale(options) === "it";
  const { presence } = readCoordinationCopies(context.root);
  const digest = buildDigest({ live: liveHosts(presence, now), recap: recapStatus(context.root, { now }), stories: readLocalStories(context.sdlcRoot) });
  const due = digestDue(digest, readCoordinatorState(context.root), { now, force: options.force === true });
  let sent = null;
  if (due.due && options["dry-run"] !== true) {
    const send = deps.send ?? ((alert) => sendAutoAlert(context.root, alert, { env: deps.env ?? process.env }));
    sent = await send({ key: digest.key, story: null, kind: "info", text: digest.text });
    if (sent?.sent) updateCoordinatorState(context.root, { digest_hash: digest.hash, digest_at: now });
  }
  const status = options["dry-run"] === true ? "dry_run" : !due.due ? "skipped" : sent?.sent ? "sent" : "not_sent";
  const result = { status, task, digest: { text: digest.text, hash: digest.hash, live: digest.live, open_p1: digest.open_p1 }, ...(due.due ? {} : { reason: due.reason }), ...(sent && !sent.sent ? { reason: sent.skipped ?? "not_sent" } : {}) };
  const reasonText = result.reason ? ` (${result.reason})` : "";
  output(options, result, [
    italian ? `Digest: ${status}${reasonText}` : `Digest: ${status}${reasonText}`,
    `  ${digest.text}`,
  ]);
  return result;
}

/** `coordinator check-records [--ref <ref>] [--json]`: fails when a record is inconsistent. */
export function coordinatorCheckRecordsCommand(context, options, deps = {}) {
  const task = "coordinator check-records";
  const skipped = gated(context, options, task, deps);
  if (skipped) return skipped;
  const italian = humanGuidanceLocale(options) === "it";
  const ref = text(options, "ref") || defaultRecordsRef(context.root, projectCoordinates(context.root));
  let records;
  try {
    records = readRefStoryRecords(context.root, ref);
  } catch (error) {
    fail(String(error?.message ?? error));
  }
  const check = checkStoryRecords(records);
  const result = { status: check.errors > 0 ? "inconsistent" : "ok", task, ref, ...check };
  output(options, result, [
    italian
      ? `Record delle story su ${ref}: ${check.stories} story, ${check.errors} errori, ${check.warnings} avvisi.`
      : `Story records on ${ref}: ${check.stories} stories, ${check.errors} errors, ${check.warnings} warnings.`,
    ...check.issues.map((item) => `${item.level} ${item.code} ${item.story}: ${item.detail} (${item.path})`),
  ]);
  if (check.errors > 0) process.exitCode = 1;
  return result;
}

function manualStatus(context, options, baseBranch, remote) {
  const ref = text(options, "ref") || `${remote}/${baseBranch}`;
  const resolved = runGit(context.root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { timeoutSeconds: 10 });
  const sha = resolved.status === 0 ? String(resolved.stdout).trim() : null;
  if (!sha) fail(`Cannot resolve ${ref}; pass --ref <commit> with --failing.`);
  return { branch: baseBranch, sha, state: "red", failing: list(options.failing).map((name) => ({ name })) };
}

/**
 * `coordinator main-green [--failing <check>] [--ref <ref>] [--dry-run] [--json]`:
 * opens one P1 fix story when the base branch is red; never reverts.
 */
export async function coordinatorMainGreenCommand(context, options, deps = {}) {
  const task = "coordinator main-green";
  const skipped = gated(context, options, task, deps);
  if (skipped) return skipped;
  const italian = humanGuidanceLocale(options) === "it";
  const { remote, baseBranch } = projectCoordinates(context.root);
  const status = list(options.failing).length > 0 ? manualStatus(context, options, baseBranch, remote) : forgeFor(context, deps).baseStatus(baseBranch);
  const plan = planMainGreen({ status, stories: readLocalStories(context.sdlcRoot) });
  if (plan.action === "create" && options["dry-run"] !== true) {
    const create = deps.createStory ?? (await import("../engine/story.mjs")).createStory;
    // The story create output (human or --json) is this command's output.
    create(context, {
      id: plan.story.id,
      title: plan.story.title,
      acceptance: plan.story.acceptance,
      priority: plan.story.priority,
      status: "ready",
      ...(options.json === true ? { json: true } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
    });
    return { status: "created", task, ...plan };
  }
  const result = { status: options["dry-run"] === true ? "dry_run" : "ok", task, ...plan };
  const lines = {
    none: italian ? `${baseBranch} non è rosso (${plan.state}): nessuna story.` : `${baseBranch} is not red (${plan.state}): no story.`,
    exists: italian ? `${baseBranch} è rosso; la story di fix ${plan.story_id} è già aperta.` : `${baseBranch} is red; fix story ${plan.story_id} is already open.`,
    create: italian ? `${baseBranch} è rosso: aprirei la story P1 ${plan.story?.id} (${plan.story?.title}). Nessun revert.` : `${baseBranch} is red: would open P1 story ${plan.story?.id} (${plan.story?.title}). No revert.`,
  };
  output(options, result, [lines[plan.action]]);
  return result;
}

/** `coordinator merge [--max <n>] [--method merge|squash|rebase] [--dry-run] [--json]` */
export async function coordinatorMergeCommand(context, options, deps = {}) {
  const task = "coordinator merge";
  const skipped = gated(context, options, task, deps);
  if (skipped) return skipped;
  const italian = humanGuidanceLocale(options) === "it";
  const method = text(options, "method") || "squash";
  if (!MERGE_METHODS.includes(method)) fail(`--method must be one of ${MERGE_METHODS.join(", ")}.`);
  const maxText = text(options, "max");
  const max = maxText ? Number(maxText) : 1;
  if (!Number.isInteger(max) || max < 1 || max > 20) fail("--max must be a whole number from 1 to 20.");
  const { baseBranch } = projectCoordinates(context.root);
  const run = runMergeQueue({ forge: forgeFor(context, deps), base: baseBranch, stories: readLocalStories(context.sdlcRoot), max, method, dryRun: options["dry-run"] === true });
  const queue = run.plan.queue.map((item) => ({ number: item.pr.number, url: item.pr.url, story: item.story, state: item.state }));
  const result = { status: options["dry-run"] === true ? "dry_run" : run.failed.length > 0 ? "partial" : "ok", task, base: baseBranch, queue, merged: run.merged, updated: run.updated, failed: run.failed };
  output(options, result, [
    italian ? `Coda di merge verso ${baseBranch}: ${queue.length} PR, ${run.plan.ready.length} pronte.` : `Merge queue into ${baseBranch}: ${queue.length} pull requests, ${run.plan.ready.length} ready.`,
    ...queue.map((item) => `#${item.number}${item.story ? ` ${item.story}` : ""}: ${item.state}`),
    ...run.merged.map((item) => (italian ? `Unita #${item.number}` : `Merged #${item.number}`)),
    ...(run.updated ? [italian ? `Aggiornato il branch di #${run.updated.number}` : `Updated the branch of #${run.updated.number}`] : []),
    ...run.failed.map((item) => `${italian ? "Non riuscito" : "Failed"} #${item.number}: ${item.error}`),
  ]);
  if (run.failed.length > 0) process.exitCode = 1;
  return result;
}
