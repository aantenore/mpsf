/**
 * One order for story work everywhere (`next`, keep-going, offers, status,
 * Observatory): P1 > P2 > P3 > no priority, then the oldest story, then the
 * id. `priority` is optional in story.json, so older records sort last and
 * older plugins simply ignore the field.
 */

import { Date } from "../runtime/host.mjs";

export const STORY_PRIORITIES = Object.freeze(["P1", "P2", "P3"]);

// Incident severity (sev1 most severe) mapped onto story priority.
const SEVERITY_PRIORITY = Object.freeze({ sev1: "P1", sev2: "P2", sev3: "P3", sev4: "P3" });

/** The priority a fix story inherits from its incident's severity; null when unknown. */
export function priorityFromSeverity(severity) {
  return SEVERITY_PRIORITY[String(severity ?? "").toLowerCase()] ?? null;
}

/** The story's valid priority, or null. */
export function storyPriority(story) {
  const value = String(story?.priority ?? "").toUpperCase();
  return STORY_PRIORITIES.includes(value) ? value : null;
}

/** 0 for P1 ... 3 for no priority. */
export function storyPriorityRank(story) {
  const priority = storyPriority(story);
  return priority ? STORY_PRIORITIES.indexOf(priority) : STORY_PRIORITIES.length;
}

function createdMs(story) {
  const ms = Date.parse(String(story?.created_at ?? ""));
  return Number.isFinite(ms) ? ms : Infinity;
}

/** Comparator for story records (objects with id, priority, created_at). */
export function compareStoriesByPriority(left, right) {
  const rank = storyPriorityRank(left) - storyPriorityRank(right);
  if (rank !== 0) return rank;
  const leftMs = createdMs(left);
  const rightMs = createdMs(right);
  if (leftMs !== rightMs) return leftMs < rightMs ? -1 : 1;
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

/** Story ids in priority order; `storyOf(id)` returns the record or null. */
export function orderStoryIdsByPriority(ids, storyOf) {
  return [...ids]
    .map((id) => ({ ...(storyOf(id) ?? {}), id }))
    .sort(compareStoriesByPriority)
    .map((story) => story.id);
}
