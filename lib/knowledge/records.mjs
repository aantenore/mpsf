import { crypto } from "../runtime/host.mjs";
import { pathMatchesApprovedWriteScope } from "../lifecycle/project.mjs";

/**
 * Shared knowledge: one record per piece of knowledge,
 * `.sdlc/knowledge/KN-<12 hex>.json`, plus append-only events under
 * `.sdlc/knowledge/events/<KN-id>/` (seen again, retired). The id comes from
 * a deterministic key (what the knowledge is about, never who found it), and
 * distilled records and "seen" events carry no time or author of their own:
 * the same knowledge distilled on two computers is the same file, byte for
 * byte, so duplicates merge by construction and nothing conflicts on merge.
 *
 * Every path here is project-relative with forward slashes; records are read
 * through a reader with list(dir) and readJson(file) (lib/context/reader.mjs).
 */
export const KNOWLEDGE_DIR = ".sdlc/knowledge";
export const KNOWLEDGE_KIND = "knowledge";
export const KNOWLEDGE_SCHEMA = "knowledge:v1";
export const KNOWLEDGE_EVENT_KIND = "knowledge_event";
export const KNOWLEDGE_EVENT_SCHEMA = "knowledge-event:v1";
export const KNOWLEDGE_EVENT_TYPES = Object.freeze(["seen", "retired"]);
const ID_PATTERN = /^KN-[0-9a-f]{12}$/u;

export function isKnowledgeId(value) {
  return ID_PATTERN.test(String(value || ""));
}

export function knowledgeKeyHash(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

export function knowledgeIdOf(key) {
  return `KN-${knowledgeKeyHash(key).slice(0, 12)}`;
}

export function knowledgeRecordPath(id) {
  return `${KNOWLEDGE_DIR}/${id}.json`;
}

export function knowledgeEventsDir(id) {
  return `${KNOWLEDGE_DIR}/events/${id}`;
}

export function sortedUnique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value !== ""))].sort((a, b) => a.localeCompare(b, "en"));
}

export function sourceKey(source) {
  return `${source?.type ?? ""}\0${source?.ref ?? ""}`;
}

export function mergeSources(...lists) {
  const byKey = new Map();
  for (const list of lists) for (const source of Array.isArray(list) ? list : []) if (source?.type && source?.ref) byKey.set(sourceKey(source), { type: String(source.type), ref: String(source.ref) });
  return [...byKey.values()].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b), "en"));
}

/**
 * Every knowledge entry with its events folded in: sources, stories and
 * paths seen since the record was written, and whether it is retired.
 * Sorted by id.
 */
export function readKnowledge(reader) {
  const entries = [];
  for (const name of reader.list(KNOWLEDGE_DIR)) {
    if (!/^KN-[0-9a-f]{12}\.json$/u.test(name)) continue;
    const record = reader.readJson(`${KNOWLEDGE_DIR}/${name}`);
    if (record?.kind !== KNOWLEDGE_KIND || `${record.id}.json` !== name) continue;
    entries.push(foldKnowledge(record, readKnowledgeEvents(reader, record.id)));
  }
  return entries;
}

export function readKnowledgeEvents(reader, id) {
  const dir = knowledgeEventsDir(id);
  return reader.list(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ event: reader.readJson(`${dir}/${name}`), path: `${dir}/${name}` }))
    .filter(({ event }) => event?.kind === KNOWLEDGE_EVENT_KIND && event.knowledge_id === id && KNOWLEDGE_EVENT_TYPES.includes(event.type));
}

export function foldKnowledge(record, events = []) {
  const seen = events.filter(({ event }) => event.type === "seen").map(({ event }) => event);
  const retired = events.map(({ event }) => event).filter((event) => event.type === "retired").sort((a, b) => String(a.at).localeCompare(String(b.at), "en")).at(-1) ?? null;
  const sources = mergeSources(record.sources, ...seen.map((event) => event.sources));
  return {
    id: record.id,
    type: record.type,
    title: String(record.title ?? ""),
    summary: String(record.summary ?? ""),
    paths: sortedUnique([...(record.paths ?? []), ...seen.flatMap((event) => event.paths ?? [])]),
    stories: sortedUnique([...(record.stories ?? []), ...seen.flatMap((event) => event.stories ?? [])]),
    sources,
    occurrences: sources.length,
    first_seen_at: record.first_seen_at ?? null,
    retired: retired ? { at: retired.at ?? null, note: retired.note ?? null, actor: retired.actor ?? null } : null,
    record_path: knowledgeRecordPath(record.id),
    event_paths: events.map((item) => item.path).sort(),
  };
}

function overlaps(entryPath, scopePaths) {
  if (scopePaths.length === 0) return false;
  return pathMatchesApprovedWriteScope(entryPath, scopePaths) || scopePaths.some((scope) => pathMatchesApprovedWriteScope(scope, [entryPath]));
}

/**
 * Entries that touch a story: they name the story (or a story it depends on
 * or blocks), or one of their paths overlaps the story's write scope.
 * Retired entries never count. Best first: the story itself, then the most
 * often seen, then id.
 */
export function knowledgeForStory(entries, { storyId, relatedStories = [], scopePaths = [] }) {
  const related = new Set(relatedStories);
  const ranked = [];
  for (const entry of entries) {
    if (entry.retired) continue;
    const direct = entry.stories.includes(storyId);
    const linked = direct || entry.stories.some((story) => related.has(story));
    const scoped = entry.paths.some((entryPath) => overlaps(entryPath, scopePaths));
    if (!linked && !scoped) continue;
    ranked.push({ entry, rank: direct ? 0 : scoped ? 1 : 2 });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || b.entry.occurrences - a.entry.occurrences || a.entry.id.localeCompare(b.entry.id, "en"))
    .map(({ entry }) => entry);
}
