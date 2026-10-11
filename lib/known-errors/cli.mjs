import path from "node:path";
import { computeStableHash } from "../canonical.mjs";
import { fail } from "../cli/user-error.mjs";
import { assertRecordSchema, buildAttribution, inferActorType, uniqueRecordSuffix } from "../engine/common.mjs";
import { output } from "../engine/output.mjs";
import { removePathGoverned, writeJsonFile, writeTextFile } from "../engine/storage.mjs";
import { humanGuidanceLocale } from "../lifecycle/guidance.mjs";
import { PLUGIN_VERSION } from "../plugin-compatibility.mjs";
import { childProcess, Date, fs } from "../runtime/host.mjs";
import { resolveKnownErrorsPolicy } from "./policy.mjs";
import {
  isKnownErrorId,
  KNOWN_ERROR_EVENT_KIND,
  KNOWN_ERROR_EVENT_SCHEMA,
  KNOWN_ERROR_KIND,
  KNOWN_ERROR_SCHEMA,
  knownErrorEventsRoot,
  knownErrorPath,
  matchKnownErrors,
  readKnownErrors,
  readLastFailures,
  SAFE_ACTION_TYPES,
} from "./registry.mjs";
import { computeSignature } from "./signature.mjs";

/**
 * `known-error list|show|match|add|outcome|accept|retire|apply`: the CLI of
 * the known error database (lib/known-errors/registry.mjs). Agents record
 * entries only through these commands, never by writing files.
 */

function list(value) {
  if (value === undefined || value === null || value === false) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item).trim()).filter(Boolean);
}

function text(options, name) {
  const value = options[name];
  return value === undefined || value === null || value === true ? "" : String(Array.isArray(value) ? value.at(-1) : value).trim();
}

function italianOf(options) {
  return humanGuidanceLocale(options) === "it";
}

function entriesOf(context) {
  const policy = resolveKnownErrorsPolicy(context.config);
  return readKnownErrors(context.sdlcRoot, { staleAfterDays: policy.stale_after_days });
}

function requireEntry(context, options) {
  const id = text(options, "id");
  if (!isKnownErrorId(id)) fail("--id must be a known error id (KE- followed by 12 hex characters), as known-error list shows it.");
  const entry = entriesOf(context).find((item) => item.id === id);
  if (!entry) fail(`Known error ${id} does not exist in .sdlc/known-errors.`);
  return entry;
}

function entryLines(entry, italian) {
  return [
    `${entry.id} [${entry.status}${entry.auto_applicable ? (italian ? ", fix sicuro accettato" : ", accepted safe fix") : ""}] ${entry.title}`,
    `  ${italian ? "firma" : "signature"}: ${[entry.signature?.check, entry.signature?.command, entry.signature?.exit_code ?? null, entry.signature?.path].filter((item) => item !== null && item !== undefined && item !== "").join(" · ")} · ${entry.signature?.message || "-"}`,
    `  ${italian ? "diagnosi" : "diagnosis"}: ${entry.diagnosis}`,
    ...entry.steps.map((step, index) => `  ${index + 1}. ${step}`),
    `  ${italian ? "usata" : "used"} ${entry.used} (${entry.worked} ok, ${entry.failed} ko)${entry.last_verified_at ? ` · ${italian ? "ultima verifica" : "last verified"} ${entry.last_verified_at}` : ""}`,
  ];
}

export function knownErrorListCommand(context, options) {
  const italian = italianOf(options);
  const entries = entriesOf(context).filter((entry) => options.all === true || !["retired", "out_of_range"].includes(entry.status));
  output(options, { status: "ok", known_errors: entries }, entries.length === 0
    ? [italian ? "Nessun errore noto registrato." : "No known error recorded."]
    : [
      italian ? `Errori noti: ${entries.length}` : `Known errors: ${entries.length}`,
      ...entries.map((entry) => `- ${entry.id} [${entry.status}] ${entry.title} (${entry.worked}/${entry.used})`),
    ]);
  return entries;
}

export function knownErrorShowCommand(context, options) {
  const entry = requireEntry(context, options);
  output(options, { status: "ok", known_error: entry }, entryLines(entry, italianOf(options)));
  return entry;
}

/** Match a failure given on the command line, or this computer's last failures. */
export function knownErrorMatchCommand(context, options) {
  const italian = italianOf(options);
  const policy = resolveKnownErrorsPolicy(context.config);
  const entries = entriesOf(context);
  const message = text(options, "message");
  const signatures = message
    ? [computeSignature({
      check: text(options, "check") || null,
      exit_code: text(options, "exit-code") || null,
      message,
      path: text(options, "path") || null,
      root: context.root,
      maxChars: policy.message_max_chars,
    })]
    : readLastFailures(context.sdlcRoot).map((item) => item.signature).reverse();
  const results = signatures.map((signature) => ({ signature, matches: matchKnownErrors(entries, signature, { limit: policy.max_suggestions }) }));
  const lines = results.length === 0
    ? [italian ? "Nessun fallimento recente su questo computer." : "No recent failure on this computer."]
    : results.flatMap(({ signature, matches }) => [
      `${signature.id}: ${signature.message || signature.command || "-"}`,
      ...(matches.length === 0
        ? [italian ? "  nessun errore noto" : "  no known error"]
        : matches.map((match) => `  -> ${match.id} [${match.status}, ${match.match}] ${match.title}`)),
    ]);
  output(options, { status: "ok", results }, lines);
  return results;
}

function safeActions(context, options) {
  const actions = [];
  for (const raw of list(options["remove-path"])) {
    actions.push({ type: "remove_path", path: projectRelative(context, raw) });
  }
  for (const pattern of list(options.gitignore)) {
    if (/[\r\n]/u.test(pattern) || pattern.startsWith("!")) fail(`--gitignore takes one plain ignore pattern: ${pattern}`);
    actions.push({ type: "gitignore_add", pattern });
  }
  return actions;
}

function projectRelative(context, raw) {
  const value = String(raw).replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  const segments = value.split("/");
  if (!value || path.isAbsolute(value) || /^[a-z]:/iu.test(value) || segments.includes("..")) {
    fail(`--remove-path must be a path inside the project, relative to its root: ${raw}`);
  }
  if ([".git", path.basename(context.sdlcRoot)].includes(segments[0])) fail(`--remove-path cannot point into ${segments[0]}: ${raw}`);
  return value;
}

export function knownErrorAddCommand(context, options) {
  const italian = italianOf(options);
  if (options["from-last-failure"] !== true) fail("known-error add needs --from-last-failure: entries are built from a failure this computer saw, never typed by hand.");
  const failures = readLastFailures(context.sdlcRoot);
  if (failures.length === 0) fail("No recent failure on this computer: run the failing gate, test or command first.");
  const wanted = text(options, "signature");
  const failure = wanted ? failures.find((item) => item.signature?.id === wanted) : failures.at(-1);
  if (!failure) fail(`Signature ${wanted} is not among this computer's recent failures (see known-error match).`);
  const title = text(options, "title");
  const diagnosis = text(options, "diagnosis");
  const steps = list(options["fix-step"]);
  if (!title || !diagnosis || steps.length === 0) fail("known-error add needs --title, --diagnosis and at least one --fix-step.");
  const actions = safeActions(context, options);
  if (options.safe === true && actions.length === 0) fail("--safe needs at least one --remove-path or --gitignore: only those actions can be applied automatically.");
  const id = failure.signature.id;
  const recordPath = knownErrorPath(context.sdlcRoot, id);
  if (fs.existsSync(recordPath)) fail(`Known error ${id} already exists; report how its fix went with known-error outcome --id ${id} --result worked|failed.`);
  const attribution = buildAttribution(context, options, "known-error.add");
  const { key, version, check, command, exit_code: exitCode, message, path: failurePath } = failure.signature;
  const record = {
    kind: KNOWN_ERROR_KIND,
    schema_version: KNOWN_ERROR_SCHEMA,
    id,
    title,
    signature: { version, key, check, command, exit_code: exitCode, message, path: failurePath, aliases: [] },
    diagnosis,
    steps,
    fix: { safe: options.safe === true, actions },
    scope: {
      repo: context.config?.project?.name ?? context.config?.project_name ?? null,
      plugin_versions: { min: text(options, "min-plugin") || PLUGIN_VERSION, max: text(options, "max-plugin") || null },
    },
    seen_in: { story_id: text(options, "story") || failure.story || null, check, at: failure.at },
    created_by: attribution.actor,
    created_at: new Date().toISOString(),
    git: attribution.git,
    hash_algorithm: "sha256:stable-json:v1",
  };
  record.record_hash = computeStableHash(record);
  assertRecordSchema(record, "known-error.schema.json", `Known error ${id}`);
  writeJsonFile(recordPath, record);
  const projectPath = path.relative(context.root, recordPath).split(path.sep).join("/");
  output(options, { status: "recorded", known_error: record, path: projectPath }, [
    italian ? `Errore noto registrato: ${id} (${title})` : `Known error recorded: ${id} (${title})`,
    `Path: ${projectPath}`,
    italian
      ? "Pubblicalo con i record della story (o in un commit su main) perché gli altri computer lo vedano."
      : "Publish it with the story's records (or in a commit on main) so the other computers see it.",
    ...(options.safe === true ? [italian ? `Il fix sicuro si applica solo dopo che una persona lo accetta: known-error accept --id ${id} --actor-type human` : `The safe fix applies only after a person accepts it: known-error accept --id ${id} --actor-type human`] : []),
  ]);
  return record;
}

function writeEvent(context, options, entry, type, extra = {}) {
  const attribution = buildAttribution(context, options, `known-error.${type}`);
  const at = new Date().toISOString();
  const event = {
    kind: KNOWN_ERROR_EVENT_KIND,
    schema_version: KNOWN_ERROR_EVENT_SCHEMA,
    known_error_id: entry.id,
    type,
    story_id: text(options, "story") || null,
    note: text(options, "note") || text(options, "reason") || null,
    ...extra,
    actor: attribution.actor,
    plugin_version: PLUGIN_VERSION,
    at,
  };
  assertRecordSchema(event, "known-error-event.schema.json", `Known error event of ${entry.id}`);
  const eventPath = path.join(knownErrorEventsRoot(context.sdlcRoot, entry.id), `${uniqueRecordSuffix()}-${type}.json`);
  writeJsonFile(eventPath, event);
  return { event, path: path.relative(context.root, eventPath).split(path.sep).join("/") };
}

export function knownErrorOutcomeCommand(context, options) {
  const entry = requireEntry(context, options);
  const result = text(options, "result");
  if (!["worked", "failed"].includes(result)) fail("--result must be worked or failed.");
  const written = writeEvent(context, options, entry, result);
  const italian = italianOf(options);
  output(options, { status: "recorded", ...written }, [
    result === "worked"
      ? (italian ? `${entry.id}: soluzione confermata.` : `${entry.id}: fix confirmed.`)
      : (italian ? `${entry.id}: la soluzione non ha funzionato, la voce ora è sospetta.` : `${entry.id}: the fix did not work; the entry is now suspect.`),
    `Path: ${written.path}`,
  ]);
  return written;
}

export function knownErrorAcceptCommand(context, options) {
  const entry = requireEntry(context, options);
  if (!entry.safe) fail(`${entry.id} has no safe fix to accept; its steps stay suggestions.`);
  const attribution = buildAttribution(context, options, "known-error.accept");
  // Inside an agent session the declared actor type is not trusted: the session itself decides.
  if (inferActorType({ agent: options.agent }) === "agent" || !["human", "ci"].includes(attribution.actor?.type)) {
    fail("Only a person (or CI on a person's behalf) accepts a safe fix for automatic use; an agent cannot accept its own suggestions.");
  }
  const written = writeEvent(context, options, entry, "accepted", { actions: entry.fix.actions });
  output(options, { status: "recorded", ...written }, [
    italianOf(options) ? `${entry.id}: fix sicuro accettato.` : `${entry.id}: safe fix accepted.`,
    `Path: ${written.path}`,
  ]);
  return written;
}

export function knownErrorRetireCommand(context, options) {
  const entry = requireEntry(context, options);
  if (!text(options, "reason")) fail("known-error retire needs --reason.");
  const supersededBy = text(options, "superseded-by") || null;
  if (supersededBy && !isKnownErrorId(supersededBy)) fail("--superseded-by must be a known error id.");
  const written = writeEvent(context, options, entry, "retired", { superseded_by: supersededBy });
  output(options, { status: "recorded", ...written }, [
    italianOf(options) ? `${entry.id}: ritirato.` : `${entry.id}: retired.`,
    `Path: ${written.path}`,
  ]);
  return written;
}

function tracked(context, projectPath) {
  const result = childProcess.spawnSync("git", ["ls-files", "--", projectPath], { cwd: context.root, encoding: "utf8", windowsHide: true });
  return result.status === 0 && String(result.stdout || "").trim().length > 0;
}

/** Apply an accepted safe fix: only removal of untracked paths and .gitignore additions. */
export function knownErrorApplyCommand(context, options) {
  const entry = requireEntry(context, options);
  const italian = italianOf(options);
  if (!entry.auto_applicable) {
    fail(italian
      ? `${entry.id} non ha un fix sicuro accettato e attivo (stato ${entry.status}); segui i passi a mano: ${entry.steps.join(" | ")}`
      : `${entry.id} has no accepted, active safe fix (status ${entry.status}); follow its steps by hand: ${entry.steps.join(" | ")}`);
  }
  const done = [];
  for (const action of entry.fix.actions) {
    if (!SAFE_ACTION_TYPES.includes(action.type)) fail(`Unsupported fix action ${action.type}.`);
    if (action.type === "remove_path") {
      const relative = projectRelative(context, action.path);
      const target = path.join(context.root, relative);
      if (!fs.existsSync(target)) { done.push(`${relative}: ${italian ? "già assente" : "already absent"}`); continue; }
      if (tracked(context, relative)) fail(`${relative} is tracked by Git; the safe fix only removes untracked files.`);
      removePathGoverned(target, { recursive: true, force: true });
      done.push(`${italian ? "rimosso" : "removed"} ${relative}`);
    } else {
      const gitignore = path.join(context.root, ".gitignore");
      const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
      if (current.split(/\r?\n/u).includes(action.pattern)) { done.push(`.gitignore: ${action.pattern} ${italian ? "già presente" : "already present"}`); continue; }
      writeTextFile(gitignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${action.pattern}\n`, { force: true });
      done.push(`.gitignore += ${action.pattern}`);
    }
  }
  output(options, { status: "applied", known_error_id: entry.id, actions: done }, [
    italian ? `${entry.id}: fix applicato.` : `${entry.id}: fix applied.`,
    ...done,
    italian ? `Riesegui il controllo, poi: known-error outcome --id ${entry.id} --result worked|failed` : `Run the check again, then: known-error outcome --id ${entry.id} --result worked|failed`,
  ]);
  return done;
}

