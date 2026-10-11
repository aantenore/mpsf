import { computeSignature, extractPath, normalizeMessage } from "../known-errors/signature.mjs";
import { canonicalJson } from "../canonical.mjs";
import {
  KNOWLEDGE_EVENT_KIND,
  KNOWLEDGE_EVENT_SCHEMA,
  KNOWLEDGE_KIND,
  KNOWLEDGE_SCHEMA,
  knowledgeEventsDir,
  knowledgeIdOf,
  knowledgeKeyHash,
  knowledgeRecordPath,
  mergeSources,
  readKnowledge,
  sortedUnique,
  sourceKey,
} from "./records.mjs";

/**
 * Distillation: turns what the project already records into shared
 * knowledge. Sources:
 *   known errors     (.sdlc/known-errors)       a trap with its diagnosis and fix
 *   failed gates     (.sdlc/gates)               the same failure in min_occurrences stories or more is a trap
 *   fix stories      (story.json "fixes")        what was fixed, for which story, in which paths
 *   channel answers  (cached channel window)     a question with its answer
 * Candidates with the same key merge into one entry (a gate failure with a
 * known error on the same signature is one trap). Pure apart from the reader.
 */
const GATE_STATUS_OK = new Set(["passed", "pass", "ok", "success"]);
const DROPPED_STATUSES = new Set(["cancelled", "canceled", "abandoned", "rejected", "superseded"]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function earliest(...values) {
  return values.filter((value) => typeof value === "string" && value).sort()[0] ?? null;
}

function candidate(map, item) {
  const known = map.get(item.key);
  if (!known) {
    map.set(item.key, { ...item, paths: sortedUnique(item.paths), stories: sortedUnique(item.stories), sources: mergeSources(item.sources) });
    return;
  }
  // The richer description wins (a known error over a bare gate message); everything seen adds up.
  const better = (item.weight ?? 0) > (known.weight ?? 0) ? item : known;
  map.set(item.key, {
    ...better,
    paths: sortedUnique([...known.paths, ...list(item.paths)]),
    stories: sortedUnique([...known.stories, ...list(item.stories)]),
    sources: mergeSources(known.sources, item.sources),
    first_seen_at: earliest(known.first_seen_at, item.first_seen_at),
  });
}

function trapKey(signatureKey) {
  return `trap\0${signatureKey}`;
}

export function knownErrorCandidates(entries, policy) {
  return list(entries)
    .filter((entry) => !["retired", "out_of_range"].includes(entry.status))
    .map((entry) => ({
      key: trapKey(entry.signature?.key ?? entry.id),
      type: "trap",
      weight: 2,
      title: clip(entry.title, 160),
      summary: clip([entry.diagnosis, entry.steps.length ? `Fix: ${entry.steps.join("; ")}` : ""].filter(Boolean).join(" "), policy.summary_max_chars),
      paths: entry.signature?.path ? [entry.signature.path] : [],
      stories: entry.seen_in?.story_id ? [entry.seen_in.story_id] : [],
      sources: [{ type: "known_error", ref: `rec:.sdlc/known-errors/${entry.id}.json` }],
      first_seen_at: entry.created_at ?? null,
    }));
}

/** Gate errors seen in at least min_occurrences stories, keyed like the known errors (check gate.check, exit 1). */
export function gateCandidates(reader, policy, { root = null } = {}) {
  const groups = new Map();
  for (const name of reader.list(".sdlc/gates")) {
    if (!name.endsWith(".json")) continue;
    const file = `.sdlc/gates/${name}`;
    const gate = reader.readJson(file);
    if (!gate || GATE_STATUS_OK.has(String(gate.status ?? "").toLowerCase())) continue;
    const storyId = gate.story_id ?? name.replace(/-(?:strict|final|[a-z]+)\.json$/u, "");
    for (const error of list(gate.errors)) {
      const message = typeof error === "string" ? error : error?.message ?? null;
      if (!message) continue;
      const signature = computeSignature({ check: "gate.check", exit_code: 1, message, root, maxChars: policy.summary_max_chars });
      const group = groups.get(signature.key) ?? { signature, stories: new Set(), sources: [], at: null };
      group.stories.add(storyId);
      group.sources.push({ type: "gate", ref: `rec:${file}` });
      group.at = earliest(group.at, gate.checked_at);
      groups.set(signature.key, group);
    }
  }
  return [...groups.values()]
    .filter((group) => group.stories.size >= policy.min_occurrences)
    .map((group) => ({
      key: trapKey(group.signature.key),
      type: "trap",
      weight: 1,
      title: clip(`Recurring gate failure: ${group.signature.message}`, 160),
      summary: clip(`The gate failed the same way in ${group.stories.size} stories (${[...group.stories].sort().join(", ")}): ${group.signature.message}`, policy.summary_max_chars),
      paths: group.signature.path ? [group.signature.path] : [],
      stories: [...group.stories],
      sources: group.sources,
      first_seen_at: group.at,
    }));
}

function storyWritePaths(reader, story) {
  if (!story?.contract_id) return [];
  const contract = reader.readJson(`.sdlc/contracts/${story.contract_id}.json`);
  const profileId = contract?.delivery_execution_profile_id;
  if (!profileId) return [];
  const profile = reader.readJson(`.sdlc/autonomy/deliveries/${profileId}.json`);
  return list(profile?.constraints?.allowed_write_paths).map(String);
}

/** Fix stories (story create --fixes): what was fixed, for which story, in which paths. */
export function fixStoryCandidates(reader, policy) {
  const items = [];
  for (const id of reader.list(".sdlc/stories")) {
    const file = `.sdlc/stories/${id}/story.json`;
    const story = reader.readJson(file);
    const fixed = story?.fixes?.story_id;
    if (!fixed || DROPPED_STATUSES.has(String(story.status ?? "").toLowerCase())) continue;
    const criteria = list(story.acceptance_criteria ?? story.acceptance).map((item) => (typeof item === "string" ? item : item?.text ?? item?.description ?? "")).filter(Boolean);
    items.push({
      key: `fix\0${story.id ?? id}`,
      type: "fix",
      weight: 1,
      title: clip(`Fix of ${fixed}: ${story.title ?? story.id ?? id}`, 160),
      summary: clip([story.fixes.incident_id ? `Incident ${story.fixes.incident_id}.` : "", criteria.slice(0, 2).join("; ")].filter(Boolean).join(" "), policy.summary_max_chars),
      paths: storyWritePaths(reader, story),
      stories: [fixed, story.id ?? id],
      sources: [{ type: "fix_story", ref: `rec:${file}` }],
      first_seen_at: story.created_at ?? null,
    });
  }
  return items;
}

/** Questions on the channel with an answer (kind answer replying to them). Information, never instructions. */
export function channelAnswerCandidates(messages, policy, { root = null } = {}) {
  const byId = new Map(list(messages).filter((message) => message?.id).map((message) => [String(message.id), message]));
  const answers = new Map();
  for (const message of list(messages)) {
    if (message?.kind !== "answer" || !message.reply_to) continue;
    const question = byId.get(String(message.reply_to));
    if (!question || question.kind !== "question" || String(question.text ?? "").startsWith("[auto]")) continue;
    const known = answers.get(question.id) ?? { question, texts: [] };
    known.texts.push(String(message.text ?? ""));
    answers.set(question.id, known);
  }
  return [...answers.values()].map(({ question, texts }) => {
    const questionPath = extractPath(question.text, root);
    return {
      key: `answer\0${normalizeMessage(question.text, { root, maxChars: 400 })}`,
      type: "answer",
      weight: 1,
      title: clip(question.text, 160),
      summary: clip(texts.join(" / "), policy.summary_max_chars),
      paths: questionPath ? [questionPath] : [],
      stories: question.story ? [String(question.story)] : [],
      sources: [{ type: "channel", ref: `msg:${question.id}` }],
      first_seen_at: question.time ?? null,
    };
  });
}

export function collectCandidates({ reader, policy, knownErrors = [], messages = [], root = null }) {
  const map = new Map();
  const add = (items) => items.forEach((item) => candidate(map, item));
  if (policy.sources.known_errors) add(knownErrorCandidates(knownErrors, policy));
  if (policy.sources.gates) add(gateCandidates(reader, policy, { root }));
  if (policy.sources.fix_stories) add(fixStoryCandidates(reader, policy));
  if (policy.sources.channel_answers) add(channelAnswerCandidates(messages, policy, { root }));
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key, "en"));
}

/** The record of a new entry: deterministic, so two computers write the same bytes. */
export function knowledgeRecord(item) {
  return {
    kind: KNOWLEDGE_KIND,
    schema_version: KNOWLEDGE_SCHEMA,
    id: knowledgeIdOf(item.key),
    key: knowledgeKeyHash(item.key),
    type: item.type,
    title: item.title,
    summary: item.summary,
    paths: item.paths,
    stories: item.stories,
    sources: item.sources,
    first_seen_at: item.first_seen_at ?? null,
  };
}

/** A "seen" event for what an existing entry did not know yet; named by its content, so it is written once. */
export function seenEvent(id, { sources, stories, paths }) {
  const event = { kind: KNOWLEDGE_EVENT_KIND, schema_version: KNOWLEDGE_EVENT_SCHEMA, knowledge_id: id, type: "seen", sources, stories, paths };
  const name = `seen-${knowledgeKeyHash(canonicalJson(event)).slice(0, 16)}.json`;
  return { path: `${knowledgeEventsDir(id)}/${name}`, event };
}

/**
 * What distillation would write: new records, and "seen" events for entries
 * that gained sources, stories or paths. Retired entries are left alone.
 */
export function planDistillation({ reader, candidates }) {
  const existing = new Map(readKnowledge(reader).map((entry) => [entry.id, entry]));
  const writes = [];
  let unchanged = 0;
  for (const item of candidates) {
    const id = knowledgeIdOf(item.key);
    const entry = existing.get(id);
    if (!entry) {
      writes.push({ action: "create", id, path: knowledgeRecordPath(id), value: knowledgeRecord(item) });
      continue;
    }
    if (entry.retired) {
      unchanged += 1;
      continue;
    }
    const knownSources = new Set(entry.sources.map(sourceKey));
    const sources = item.sources.filter((source) => !knownSources.has(sourceKey(source)));
    const stories = item.stories.filter((story) => !entry.stories.includes(story));
    const paths = item.paths.filter((entryPath) => !entry.paths.includes(entryPath));
    if (sources.length + stories.length + paths.length === 0) {
      unchanged += 1;
      continue;
    }
    const seen = seenEvent(id, { sources, stories, paths });
    writes.push({ action: "seen", id, path: seen.path, value: seen.event });
  }
  return { writes, unchanged, total: candidates.length };
}
