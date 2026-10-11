import { spawnSync } from "node:child_process";

import { canonicalJson, computeStableHash } from "../canonical.mjs";
import { LIFECYCLE_STEPS, nextStoryStep } from "../host-hooks/keep-going.mjs";
import { pathMatchesApprovedWriteScope } from "../lifecycle/project.mjs";
import { knowledgeForStory, readKnowledge } from "../knowledge/records.mjs";
import { estimateTokens } from "./policy.mjs";
import { redactPackText } from "./redact.mjs";

/**
 * Context pack: the minimal, deterministic slice of a story's records an
 * agent needs for one phase. It never embeds whole records: each section
 * carries the essentials within its token budget and refs that
 * `context get <ref>` resolves for more. Same records + same policy + same
 * phase/budget => byte-identical pack and the same `pack_hash`.
 */
export const CONTEXT_PACK_SCHEMA = "agentic-sdlc.context-pack.v1";
/** Bump when the pack layout changes, so cached packs built by older code are not reused. */
export const PACK_BUILDER_REVISION = 3;
export const HANDOFF_PHASE = "handoff";
export const SECTION_ORDER = Object.freeze(["story", "requirement", "contract", "decisions", "knowledge", "dependencies", "scope", "evidence", "waits", "next"]);
/** Sections left out (with their weight) when they have nothing to say, so packs without them stay as they were. */
const OPTIONAL_SECTIONS = new Set(["knowledge"]);
export const DEFAULT_KNOWLEDGE_ENTRIES = 6;
const SDLC = ".sdlc";
const APPROVED = new Set(["approved", "accepted", "active", "baselined"]);
const SYMBOL_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|cs|php|swift)$/u;
const MAX_SYMBOL_SCAN_BYTES = 200_000;
const MAX_LINE = 240;

function clip(value, max = MAX_LINE) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function storyDir(storyId) {
  return `${SDLC}/stories/${storyId}`;
}

/** Phases a pack can be built for: the project's phase order plus the handoff pack. */
export function packPhases(config, policy) {
  const order = list(config?.phase_order).map((phase) => (typeof phase === "string" ? phase : phase?.id)).filter(Boolean);
  const phases = order.length > 0 ? order : [...LIFECYCLE_STEPS];
  return [...new Set([...phases, ...Object.keys(policy.pack.phase_sections), HANDOFF_PHASE])];
}

function completedSteps(reader, storyId) {
  const done = [];
  const steps = {};
  for (const name of reader.list(`${storyDir(storyId)}/steps`)) {
    if (!name.endsWith(".json")) continue;
    const step = reader.readJson(`${storyDir(storyId)}/steps/${name}`);
    if (!step?.step) continue;
    steps[step.step] = { status: step.status ?? null, summary: step.summary ?? null, path: `${storyDir(storyId)}/steps/${name}` };
    if (step.status === "completed") done.push(step.step);
  }
  return { done: done.sort(), steps };
}

function gateSummary(reader, storyId, kind) {
  const file = `${SDLC}/gates/${storyId}-${kind}.json`;
  const gate = reader.readJson(file);
  if (!gate) return null;
  const errors = list(gate.errors);
  return {
    kind,
    path: file,
    status: gate.status ?? null,
    checked_at: gate.checked_at ?? null,
    lifecycle_complete: gate.lifecycle_complete === true,
    errors: errors.length,
    first_error: errors.length > 0 ? clip(typeof errors[0] === "string" ? errors[0] : errors[0]?.message ?? JSON.stringify(errors[0]), 160) : null,
  };
}

function decisionEvents(reader, storyId, limit) {
  const seen = new Set();
  const events = [];
  const visit = (scopeId) => (line) => {
    if (!line.includes(storyId) || !line.includes("\"decision\"")) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event?.type !== "decision") return;
    if (event.story_id !== storyId && !JSON.stringify(event.related ?? null).includes(storyId)) return;
    const summary = clip(event.summary, 140);
    if (!summary || seen.has(summary)) return;
    seen.add(summary);
    events.push({ id: event.id, at: event.created_at ?? "", summary, ref: `trace:${scopeId}#${event.id}` });
  };
  reader.readLines(`${SDLC}/traces/${storyId}.jsonl`, visit(storyId));
  reader.readLines(`${SDLC}/traces/project.jsonl`, visit("project"));
  // Newest first, ties by id: the latest decisions are the ones that bind the work.
  events.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(a.id).localeCompare(String(b.id)));
  return { events: events.slice(0, limit), total: events.length };
}

function dependencyEdges(reader, storyId) {
  const edges = [];
  for (const name of reader.list(`${SDLC}/dependencies`)) {
    if (!name.endsWith(".json")) continue;
    const file = `${SDLC}/dependencies/${name}`;
    const record = reader.readJson(file);
    for (const edge of list(record?.edges)) {
      if (edge?.from !== storyId && edge?.to !== storyId) continue;
      const other = edge.from === storyId ? edge.to : edge.from;
      const otherStory = reader.readJson(`${storyDir(other)}/story.json`);
      edges.push({
        direction: edge.from === storyId ? "blocks" : "blocked_by",
        story: other,
        title: clip(otherStory?.title, 80),
        status: otherStory?.status ?? "unknown",
        type: edge.type ?? null,
        required_state: edge.required_state ?? null,
        ref: `rec:${file}`,
      });
    }
  }
  // The same edge may be declared by several dependency records (a split and the project graph): one line, every ref.
  const unique = new Map();
  for (const edge of edges.sort((a, b) => a.ref.localeCompare(b.ref))) {
    const key = `${edge.direction}\0${edge.story}`;
    const known = unique.get(key);
    if (known) known.refs.push(edge.ref);
    else unique.set(key, { ...edge, refs: [edge.ref] });
  }
  return [...unique.values()].sort((a, b) => a.direction.localeCompare(b.direction) || a.story.localeCompare(b.story));
}

function overlapReviews(reader, storyId) {
  const dir = `${storyDir(storyId)}/overlap-reviews`;
  return reader.list(dir).filter((name) => name.endsWith(".json")).map((name) => {
    const review = reader.readJson(`${dir}/${name}`);
    return { id: review?.id ?? name, summary: clip(review?.summary, 160), overlaps: list(review?.overlaps).length, ref: `rec:${dir}/${name}` };
  });
}

function waitRecords(reader, storyId) {
  const dir = `${storyDir(storyId)}/waits`;
  const byWait = new Map();
  for (const name of reader.list(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = reader.readJson(`${dir}/${name}`);
    if (!record || record.story_id !== storyId) continue;
    const key = record.wait_id ?? record.id ?? name;
    byWait.set(key, { record, ref: `rec:${dir}/${name}` });
  }
  return [...byWait.entries()]
    .filter(([, { record }]) => !["clear", "resolve", "resolved"].includes(String(record.action ?? "")))
    .map(([key, { record, ref }]) => ({ id: key, on: clip(record.on ?? record.condition ?? record.kind ?? "", 80), reason: clip(record.reason, 120), until: record.until ?? null, ref }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function latestTestRuns(reader, storyId, limit) {
  const prefix = `${storyId}-test-run-`;
  const names = reader.list(`${SDLC}/tests`).filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
  // Names embed a sortable timestamp: the last ones are the newest.
  return names.slice(-limit).reverse().map((name) => {
    const run = reader.readJson(`${SDLC}/tests/${name}`);
    const totals = run?.totals ? `${run.totals.passed ?? 0} passed, ${run.totals.failed ?? 0} failed` : "";
    return {
      id: run?.id ?? name,
      outcome: run?.outcome ?? "unknown",
      phase: run?.phase ?? null,
      totals,
      command: clip(list(run?.command?.argv).join(" "), 120),
      summary: clip(run?.summary, 120),
      ref: `rec:${SDLC}/tests/${name}`,
    };
  });
}

function writeScope(reader, contract) {
  const profileId = contract?.delivery_execution_profile_id ?? null;
  if (!profileId) return { profile_id: null, paths: [], profile_paths: [], refs: [] };
  const profileFile = `${SDLC}/autonomy/deliveries/${profileId}.json`;
  const profile = reader.readJson(profileFile);
  const profilePaths = list(profile?.constraints?.allowed_write_paths).map(String).sort();
  const paths = new Set(profilePaths);
  const refs = [`rec:${profileFile}#/constraints/allowed_write_paths`];
  for (const ref of list(profile?.requirement_profile_refs)) {
    const file = ref?.path ?? (ref?.id ? `${SDLC}/autonomy/requirements/${ref.id}.json` : null);
    if (!file) continue;
    const requirementProfile = reader.readJson(file);
    for (const entry of list(requirementProfile?.constraints?.allowed_write_paths)) paths.add(entry);
    refs.push(`rec:${file}#/constraints/allowed_write_paths`);
  }
  return { profile_id: profileId, paths: [...paths].sort(), profile_paths: profilePaths, refs };
}

/** Tracked files inside the write scope; deterministic (sorted by git). */
export function trackedFiles(root, scopePaths) {
  if (scopePaths.length === 0) return { files: [], listing_hash: null };
  const result = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return { files: [], listing_hash: null };
  const files = result.stdout.split("\0").filter(Boolean).filter((file) => pathMatchesApprovedWriteScope(file, scopePaths)).sort();
  return { files, listing_hash: computeStableHash(files) };
}

/** Top-level declared names of a source file (no content): exported functions, classes, constants. */
export function extractSymbols(text, limit) {
  const symbols = [];
  const patterns = [
    /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu,
    /^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/gmu,
    /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gmu,
    /^(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match.slice(1).find(Boolean);
      if (name && !symbols.includes(name)) symbols.push(name);
    }
  }
  return symbols.slice(0, limit);
}

/**
 * Files most likely to matter first: the ones a write path names exactly,
 * then those under the delivery profile's paths, then the rest of the
 * requirement scope; path order inside each rank.
 */
export function rankScopeFiles(files, { profilePaths = [], allPaths = [] }) {
  const exact = new Set(allPaths);
  const rank = (file) => (exact.has(file) ? 0 : pathMatchesApprovedWriteScope(file, profilePaths) ? 1 : 2);
  return [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "en"));
}

function fileIndex(reader, files, policy) {
  return files.slice(0, policy.pack.file_index_max_entries).map((file) => {
    if (!SYMBOL_EXTENSIONS.test(file)) return { path: file, symbols: [] };
    const text = reader.readText(file, MAX_SYMBOL_SCAN_BYTES);
    return { path: file, symbols: text ? extractSymbols(text, policy.pack.symbols_per_file) : [] };
  });
}

/** The phase a pack defaults to: the first open lifecycle step, else the story's own phase. */
export function defaultPackPhase({ story, next, phases }) {
  if (next?.phase && phases.includes(next.phase)) return next.phase;
  if (story?.phase && phases.includes(story.phase)) return story.phase;
  return phases[0];
}

/**
 * Gathers the facts of every section (no budget yet). Pure apart from the
 * reader and the optional `gitFiles` callback (defaults to `git ls-files`).
 */
export function collectStoryFacts(reader, { storyId, policy, root, gitFiles = trackedFiles, knowledgeEntries = DEFAULT_KNOWLEDGE_ENTRIES }) {
  const storyFile = `${storyDir(storyId)}/story.json`;
  const story = reader.readJson(storyFile);
  if (!story) return null;
  const contractFile = story.contract_id ? `${SDLC}/contracts/${story.contract_id}.json` : null;
  const contract = contractFile ? reader.readJson(contractFile) : null;
  const requirements = list(story.requirement_refs).map((ref) => {
    const file = ref?.path ?? `${SDLC}/requirements/${ref?.id}.json`;
    const requirement = reader.readJson(file);
    return { ref, file, requirement };
  });
  const steps = completedSteps(reader, storyId);
  const strict = gateSummary(reader, storyId, "strict");
  const final = gateSummary(reader, storyId, "final");
  const next = nextStoryStep({ storyId, completedSteps: steps.done, strictGate: Boolean(strict) });
  const claim = reader.readJson(`${storyDir(storyId)}/claim.json`);
  const scope = writeScope(reader, contract);
  const listing = gitFiles(root, scope.paths);
  const dependencies = dependencyEdges(reader, storyId);
  const knowledge = knowledgeForStory(readKnowledge(reader), { storyId, relatedStories: dependencies.map((edge) => edge.story), scopePaths: scope.paths });
  return {
    storyFile,
    story,
    contractFile,
    contract,
    requirements,
    steps,
    gates: [strict, final].filter(Boolean),
    next,
    claim,
    decisions: decisionEvents(reader, storyId, policy.pack.decisions),
    dependencies,
    knowledge: { entries: knowledge.slice(0, knowledgeEntries), total: knowledge.length },
    overlaps: overlapReviews(reader, storyId),
    waits: waitRecords(reader, storyId),
    tests: latestTestRuns(reader, storyId, policy.pack.test_runs),
    scope,
    listing_hash: listing.listing_hash,
    files: fileIndex(reader, rankScopeFiles(listing.files, { profilePaths: scope.profile_paths, allPaths: scope.paths }), policy),
    tracked_write_files: scope.paths.filter((entry) => listing.files.includes(entry)),
    file_count: listing.files.length,
  };
}

function stepsLine(steps) {
  const ordered = Object.entries(steps).sort(([a], [b]) => LIFECYCLE_STEPS.indexOf(a) - LIFECYCLE_STEPS.indexOf(b));
  const done = ordered.filter(([, info]) => info.status === "completed").map(([step]) => step);
  const open = ordered.filter(([, info]) => info.status !== "completed").map(([step, info]) => `${step} (${info.status})`);
  return `steps done: ${done.join(", ") || "none"}${open.length ? `; open: ${open.join(", ")}` : ""}`;
}

/** Each section as ordered items (one line each) plus refs; budgets are applied later. */
export function sectionItems(facts, phase) {
  const { story, storyFile, contract, contractFile } = facts;
  const sections = {};
  const storyLines = [
    `${story.id}: ${clip(story.title, 160)}`,
    `status ${story.status ?? "?"} · phase ${story.phase ?? "?"} · priority ${story.priority ?? "-"}`,
    ...(story.contract_id ? [`contract ${story.contract_id}`] : []),
    ...(facts.claim ? [`claim: ${clip(facts.claim.holder?.id ?? facts.claim.agent ?? facts.claim.actor?.id ?? facts.claim.status ?? "present", 80)}${facts.claim.branch ? ` on ${facts.claim.branch}` : ""}`] : []),
    ...list(story.acceptance_criteria ?? story.acceptance).map((criterion) => `accept: ${clip(criterion)}`),
  ];
  if (phase === HANDOFF_PHASE) {
    for (const [step, info] of Object.entries(facts.steps.steps).sort(([a], [b]) => LIFECYCLE_STEPS.indexOf(a) - LIFECYCLE_STEPS.indexOf(b))) {
      storyLines.push(`step ${step}: ${info.status}${info.summary ? ` — ${clip(info.summary, 140)}` : ""}`);
    }
  }
  sections.story = { items: storyLines, refs: [`rec:${storyFile}`] };

  const requirementLines = [];
  const requirementRefs = [];
  for (const { ref, file, requirement } of facts.requirements) {
    requirementRefs.push(`rec:${file}`);
    if (!requirement) {
      requirementLines.push(`${ref?.id ?? "?"}: record missing (rec:${file})`);
      continue;
    }
    const approved = APPROVED.has(String(requirement.status ?? ""));
    requirementLines.push(`${requirement.id} r${requirement.revision ?? ref?.revision ?? "?"} [${requirement.status ?? "?"}]: ${clip(requirement.title, 140)}`);
    if (!approved) {
      requirementLines.push(`  criteria not accepted yet (rec:${file}#/acceptance_criteria)`);
      continue;
    }
    for (const criterion of list(requirement.acceptance_criteria)) requirementLines.push(`  - ${clip(typeof criterion === "string" ? criterion : criterion?.text ?? criterion?.description ?? JSON.stringify(criterion))}`);
    if (["discovery", "analysis", "design", HANDOFF_PHASE].includes(phase)) {
      for (const goal of list(requirement.non_goals)) requirementLines.push(`  non-goal: ${clip(goal, 160)}`);
    }
  }
  sections.requirement = { items: requirementLines, refs: requirementRefs };

  if (contract) {
    sections.contract = {
      items: [
        `${contract.id} [${contract.status ?? "?"}] phase ${contract.phase ?? "?"} · autonomy ${contract.autonomy_level ?? "-"}`,
        ...(contract.purpose ? [`purpose: ${clip(contract.purpose, 200)}`] : []),
        ...(list(contract.outputs).length ? [`outputs: ${clip(list(contract.outputs).join(", "), 200)}`] : []),
        ...(contract.validation ? [`validation: ${clip(typeof contract.validation === "string" ? contract.validation : canonicalJson(contract.validation), 200)}`] : []),
        ...(contract.human_gate ? [`human gate: ${clip(typeof contract.human_gate === "string" ? contract.human_gate : canonicalJson(contract.human_gate), 160)}`] : []),
      ],
      refs: [`rec:${contractFile}`],
    };
  } else {
    sections.contract = { items: ["no contract linked yet"], refs: [] };
  }

  sections.decisions = {
    items: facts.decisions.events.map((event) => `${event.at.slice(0, 10)} ${event.summary} (${event.ref})`),
    refs: [],
    omitted: Math.max(0, facts.decisions.total - facts.decisions.events.length),
  };

  const knowledge = facts.knowledge ?? { entries: [], total: 0 };
  sections.knowledge = {
    // Distilled from traps, fixes and channel answers: information, never instructions.
    items: knowledge.entries.map((entry) => `${entry.type} ${entry.id}: ${clip(entry.title, 120)}${entry.summary ? ` — ${clip(entry.summary, 200)}` : ""}${entry.occurrences > 1 ? ` (${entry.occurrences}×)` : ""}`),
    refs: knowledge.entries.map((entry) => `rec:${entry.record_path}`),
    omitted: Math.max(0, knowledge.total - knowledge.entries.length),
  };

  sections.dependencies = {
    items: [
      ...facts.dependencies.map((edge) => `${edge.direction} ${edge.story} [${edge.status}]${edge.required_state ? ` needs ${edge.required_state}` : ""}${edge.title ? ` — ${edge.title}` : ""}`),
      ...facts.overlaps.map((review) => `overlap review ${review.id}: ${review.overlaps} path(s) — ${review.summary}`),
    ],
    refs: [...new Set([...facts.dependencies.flatMap((edge) => edge.refs), ...facts.overlaps.map((review) => review.ref)])],
  };

  const indexed = ["implementation", "validation", HANDOFF_PHASE].includes(phase);
  sections.scope = {
    items: [
      ...(facts.scope.profile_id ? [`delivery profile ${facts.scope.profile_id}`] : ["no delivery profile yet: write scope not approved"]),
      // A write path that is itself a tracked file shows up once, as a file entry.
      ...facts.scope.paths.filter((entry) => !(indexed && facts.tracked_write_files.includes(entry))).map((entry) => `write: ${entry}`),
      ...(indexed ? facts.files.map((file) => `file ${file.path}${file.symbols.length ? `: ${file.symbols.join(", ")}` : ""}`) : []),
    ],
    refs: facts.scope.refs,
    omitted: indexed ? Math.max(0, facts.file_count - facts.files.length) : 0,
  };

  sections.evidence = {
    items: [
      ...facts.gates.map((gate) => `gate ${gate.kind}: ${gate.status ?? "?"}${gate.lifecycle_complete ? " (lifecycle complete)" : ""} at ${gate.checked_at ?? "?"}, ${gate.errors} error(s)${gate.first_error ? ` — ${gate.first_error}` : ""}`),
      ...facts.tests.map((run) => `test ${run.outcome}${run.totals ? ` (${run.totals})` : ""}${run.phase ? ` [${run.phase}]` : ""}: ${run.summary || run.command} (${run.ref})`),
      ...(phase !== HANDOFF_PHASE && Object.keys(facts.steps.steps).length > 0 ? [stepsLine(facts.steps.steps)] : []),
    ],
    refs: facts.gates.map((gate) => `rec:${gate.path}`),
  };
  if (sections.evidence.items.length === 0) sections.evidence.items.push("no tests or gate reports recorded yet");

  sections.waits = {
    items: [
      ...facts.waits.map((wait) => `wait ${wait.id}: ${wait.on}${wait.until ? ` until ${wait.until}` : ""}${wait.reason ? ` — ${wait.reason}` : ""}`),
      "questions and shared waits: agentic-sdlc wait list",
    ],
    refs: facts.waits.map((wait) => wait.ref),
  };

  sections.next = {
    items: [`${facts.next.phase}: ${clip(facts.next.label, 160)}`, `run: ${facts.next.command}`],
    refs: [],
  };
  return sections;
}

function sectionBudgets(weights, total) {
  const entries = SECTION_ORDER.filter((id) => weights[id] > 0);
  const sum = entries.reduce((acc, id) => acc + weights[id], 0);
  const budgets = {};
  let assigned = 0;
  for (const id of entries) {
    budgets[id] = Math.max(24, Math.floor((total * weights[id]) / sum));
    assigned += budgets[id];
  }
  // Rounding leftovers go to the heaviest section, first in order on ties.
  const heaviest = entries.reduce((best, id) => (weights[id] > (weights[best] ?? 0) ? id : best), entries[0]);
  if (heaviest && assigned < total) budgets[heaviest] += total - assigned;
  return budgets;
}

/** Applies one section's budget: keeps items in order while they fit, then a marker with the refs to fetch the rest. */
export function fitSection(id, section, budget, { storyId, phase }) {
  const header = `## ${id}`;
  const fullRef = `sec:${storyId}/${phase}/${id}`;
  const kept = [];
  let used = estimateTokens(header);
  let dropped = 0;
  const items = section.items.map((item) => redactPackText(item));
  for (const [index, item] of items.entries()) {
    const cost = estimateTokens(item) + 1;
    // Reserve room for the marker whenever something may still follow.
    const reserve = index < items.length - 1 ? 16 : 0;
    if (used + cost + reserve > budget) {
      dropped = items.length - index;
      break;
    }
    kept.push(item);
    used += cost;
  }
  const omitted = dropped + (section.omitted ?? 0);
  const lines = [header, ...kept];
  if (omitted > 0) lines.push(`… ${omitted} more: context get ${fullRef}`);
  const refs = [...new Set(section.refs)].sort();
  return {
    id,
    budget_tokens: budget,
    tokens: estimateTokens(lines.join("\n")),
    truncated: omitted > 0,
    omitted,
    lines,
    refs,
    more: omitted > 0 ? fullRef : null,
  };
}

/** Builds the pack from collected facts: sections in fixed order, each within its budget. */
export function assemblePack(facts, { storyId, phase, budget, policy, pluginVersion = null }) {
  const items = sectionItems(facts, phase);
  const weights = { ...(policy.pack.phase_sections[phase] ?? policy.pack.phase_sections.implementation ?? {}) };
  for (const id of OPTIONAL_SECTIONS) if (items[id]?.items.length === 0) delete weights[id];
  const budgets = sectionBudgets(weights, budget);
  const sections = SECTION_ORDER.filter((id) => budgets[id]).map((id) => fitSection(id, items[id], budgets[id], { storyId, phase }));
  const body = {
    schema: CONTEXT_PACK_SCHEMA,
    story_id: storyId,
    phase,
    budget_tokens: budget,
    plugin_version: pluginVersion,
    sections,
  };
  const packHash = computeStableHash(body);
  const text = renderPackText({ ...body, pack_hash: packHash });
  return { ...body, tokens: estimateTokens(text), pack_hash: packHash };
}

/**
 * Text of a pack. `baseLine` ("3 commits behind origin/main", from
 * lib/engine/fresh-state.mjs) goes under the title; it is not part of the
 * pack hash, which depends on the records only.
 */
export function renderPackText(pack, { baseLine = null } = {}) {
  const lines = [`# context pack ${pack.story_id} · ${pack.phase} · ${pack.budget_tokens} tok · ${String(pack.pack_hash).slice(0, 12)}`];
  if (baseLine) lines.push(`base: ${baseLine}`);
  for (const section of pack.sections) lines.push(...section.lines);
  const refs = [...new Set(pack.sections.flatMap((section) => section.refs))].sort();
  if (refs.length > 0) lines.push("## refs", ...refs.map((ref) => `- ${ref}`));
  return `${lines.join("\n")}\n`;
}

/** Full, untruncated text of one section (what `context get sec:<story>/<phase>/<section>` returns). */
export function fullSectionText(facts, { storyId, phase, section }) {
  const items = sectionItems(facts, phase)[section];
  if (!items) return null;
  const lines = [`## ${section} (${storyId}, ${phase}, full)`, ...items.items.map((item) => redactPackText(item))];
  if (items.refs.length) lines.push(...[...new Set(items.refs)].sort().map((ref) => `- ${ref}`));
  return `${lines.join("\n")}\n`;
}
