import path from "node:path";
import { fail } from "../cli/user-error.mjs";
import { assertRecordSchema, buildAttribution, uniqueRecordSuffix } from "../engine/common.mjs";
import { output } from "../engine/output.mjs";
import { writeJsonFile } from "../engine/storage.mjs";
import { humanGuidanceLocale } from "../lifecycle/guidance.mjs";
import { holdsRole } from "../engine/role-leases.mjs";
import { readKnownErrors } from "../known-errors/registry.mjs";
import { createFsRecordReader } from "../context/reader.mjs";
import { fs, process } from "../runtime/host.mjs";
import { collectCandidates, planDistillation } from "./distill.mjs";
import { resolveKnowledgePolicy } from "./policy.mjs";
import { isKnowledgeId, KNOWLEDGE_EVENT_KIND, KNOWLEDGE_EVENT_SCHEMA, knowledgeEventsDir, knowledgeForStory, readKnowledge } from "./records.mjs";

export const KNOWLEDGE_ROLE = "knowledge";

function text(options, name) {
  const value = options[name];
  return value === undefined || value === null || value === true ? "" : String(value).trim();
}

function italianOf(options) {
  return humanGuidanceLocale(options) === "it";
}

async function channelMessages(root) {
  try {
    const { cachedChannel } = await import("../engine/wait-registry.mjs");
    return cachedChannel(root).messages;
  } catch {
    return [];
  }
}

/**
 * `knowledge distill [--dry-run] [--force] [--json]`: collects the project's
 * recurring traps, fixes and answers into .sdlc/knowledge. Only the computer
 * holding the knowledge role does it (every computer when nobody holds a
 * valid lease); --force runs it anyway. Records are deterministic, so a
 * second run, or the same run on another computer, writes nothing new.
 */
export async function knowledgeDistillCommand(context, options, { env = process.env, writeRecord = writeJsonFile } = {}) {
  const italian = italianOf(options);
  const policy = resolveKnowledgePolicy(context.config);
  if (!policy.enabled) {
    output(options, { status: "disabled" }, [italian ? "Knowledge spenta (host_policy.knowledge.enabled=false)." : "Knowledge is off (host_policy.knowledge.enabled=false)."]);
    return { status: "disabled" };
  }
  const role = holdsRole(context.root, KNOWLEDGE_ROLE, { env });
  if (!role.holds && options.force !== true) {
    const result = { status: "skipped", role };
    output(options, result, [italian
      ? `Ruolo knowledge su ${role.holder}: la distillazione la fa quel computer (--force per farla qui).`
      : `The knowledge role is held by ${role.holder}: that computer distils (--force to do it here).`]);
    return result;
  }
  const reader = createFsRecordReader(context.root);
  const candidates = collectCandidates({
    reader,
    policy,
    knownErrors: readKnownErrors(context.sdlcRoot),
    messages: policy.sources.channel_answers ? await channelMessages(context.root) : [],
    root: context.root,
  });
  const plan = planDistillation({ reader, candidates });
  if (options["dry-run"] !== true) {
    for (const write of plan.writes) {
      const absolute = path.join(context.root, ...write.path.split("/"));
      if (fs.existsSync(absolute)) continue;
      assertRecordSchema(write.value, write.action === "create" ? "knowledge.schema.json" : "knowledge-event.schema.json", `Knowledge ${write.id}`);
      writeRecord(absolute, write.value);
    }
  }
  const created = plan.writes.filter((write) => write.action === "create");
  const seen = plan.writes.filter((write) => write.action === "seen");
  const result = { status: options["dry-run"] === true ? "planned" : "distilled", role, candidates: plan.total, created: created.map((write) => write.path), seen: seen.map((write) => write.path), unchanged: plan.unchanged };
  output(options, result, [
    italian
      ? `Knowledge: ${created.length} nuove, ${seen.length} aggiornate, ${plan.unchanged} invariate${options["dry-run"] === true ? " (prova, nulla scritto)" : ""}.`
      : `Knowledge: ${created.length} new, ${seen.length} updated, ${plan.unchanged} unchanged${options["dry-run"] === true ? " (dry run, nothing written)" : ""}.`,
    ...created.map((write) => `+ ${write.id} [${write.value.type}] ${write.value.title}`),
    ...(plan.writes.length > 0 && options["dry-run"] !== true
      ? [italian ? "Pubblica .sdlc/knowledge con un commit su main perché gli altri computer la vedano." : "Publish .sdlc/knowledge with a commit on main so the other computers see it."]
      : []),
  ]);
  return result;
}

/** `knowledge list [--story <id>] [--all] [--json]` */
export function knowledgeListCommand(context, options) {
  const italian = italianOf(options);
  let entries = readKnowledge(createFsRecordReader(context.root));
  const storyId = text(options, "story");
  if (storyId) entries = knowledgeForStory(entries, { storyId, scopePaths: [] });
  else if (options.all !== true) entries = entries.filter((entry) => !entry.retired);
  output(options, { status: "ok", knowledge: entries }, entries.length === 0
    ? [italian ? "Nessuna knowledge registrata." : "No knowledge recorded."]
    : [
      `Knowledge: ${entries.length}`,
      ...entries.map((entry) => `- ${entry.id} [${entry.type}${entry.retired ? (italian ? ", ritirata" : ", retired") : ""}] ${entry.title} (${entry.occurrences}×)${entry.paths.length ? ` · ${entry.paths.slice(0, 3).join(", ")}` : ""}`),
    ]);
  return entries;
}

/** `knowledge retire --id <KN-id> --reason <text>`: append-only, the record stays. */
export function knowledgeRetireCommand(context, options) {
  const id = text(options, "id");
  if (!isKnowledgeId(id)) fail("--id must be a knowledge id (KN-...), as knowledge list shows it.");
  const reason = text(options, "reason");
  if (!reason) fail("knowledge retire needs --reason.");
  const entry = readKnowledge(createFsRecordReader(context.root)).find((item) => item.id === id);
  if (!entry) fail(`No knowledge ${id}.`);
  const attribution = buildAttribution(context, options, "knowledge.retire");
  const event = { kind: KNOWLEDGE_EVENT_KIND, schema_version: KNOWLEDGE_EVENT_SCHEMA, knowledge_id: id, type: "retired", note: reason, actor: attribution.actor, at: new Date().toISOString() };
  assertRecordSchema(event, "knowledge-event.schema.json", `Knowledge ${id}`);
  const relative = `${knowledgeEventsDir(id)}/retired-${uniqueRecordSuffix()}.json`;
  writeJsonFile(path.join(context.root, ...relative.split("/")), event);
  output(options, { status: "recorded", path: relative, event }, [italianOf(options) ? `${id}: ritirata.` : `${id}: retired.`, `Path: ${relative}`]);
  return event;
}
