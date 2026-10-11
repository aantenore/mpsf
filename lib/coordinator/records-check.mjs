import { childProcess } from "../runtime/host.mjs";
import { STORY_PRIORITIES } from "../engine/story-priority.mjs";
import { checkRecordSchemaVersion } from "../record-schema-version.mjs";

/**
 * Consistency of the story records on one git ref (the base branch by
 * default): offline, read-only, from git objects only, so it checks what
 * every computer sees, not this checkout. Errors make the command fail;
 * warnings are shown only.
 */
const BATCH_MAX_BUFFER = 256 * 1024 * 1024;

function issue(level, code, story, path, detail) {
  return { level, code, story, path, detail };
}

function parse(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/** Warns about a record written in a format newer than this plugin knows. */
function newerFormat(issues, story, recordPath, record, kind) {
  const format = checkRecordSchemaVersion(record, { kind });
  if (format.newer) {
    issues.push(issue("warning", "newer_record_format", story, recordPath, `format ${format.version} of ${format.kind}, this plugin knows up to ${format.supported}: update the plugin`));
  }
}

/**
 * Pure check. `paths` lists every file under <sdlc>/stories on the ref;
 * `files` maps the JSON paths it needs (story.json, claim.json, steps/*.json)
 * to their text.
 */
export function checkStoryRecords({ paths = [], files = new Map(), sdlcFolder = ".sdlc" }) {
  const prefix = `${sdlcFolder.replace(/\/$/u, "")}/stories/`;
  const byStory = new Map();
  for (const item of paths) {
    if (!item.startsWith(prefix)) continue;
    const [dir, ...rest] = item.slice(prefix.length).split("/");
    if (!dir || rest.length === 0) continue;
    if (!byStory.has(dir)) byStory.set(dir, []);
    byStory.get(dir).push(rest.join("/"));
  }
  const issues = [];
  const known = new Set(byStory.keys());
  for (const [dir, inside] of [...byStory.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const base = `${prefix}${dir}`;
    const has = new Set(inside);
    const steps = inside.filter((item) => item.startsWith("steps/") && item.endsWith(".json"));
    for (const name of ["claim.json", ...steps]) {
      if (!has.has(name)) continue;
      const parsed = parse(files.get(`${base}/${name}`) ?? "");
      if (parsed.error) issues.push(issue("error", "invalid_json", dir, `${base}/${name}`, parsed.error));
      else if (name === "claim.json") newerFormat(issues, dir, `${base}/${name}`, parsed.value, "claim");
    }
    if (!has.has("story.json")) {
      issues.push(issue("error", "missing_story", dir, `${base}/story.json`, "story workspace without story.json"));
      continue;
    }
    const parsed = parse(files.get(`${base}/story.json`) ?? "");
    if (parsed.error || !parsed.value || typeof parsed.value !== "object") {
      issues.push(issue("error", "invalid_json", dir, `${base}/story.json`, parsed.error ?? "not an object"));
      continue;
    }
    const story = parsed.value;
    newerFormat(issues, dir, `${base}/story.json`, story, "story");
    if (String(story.id ?? "") !== dir) issues.push(issue("error", "id_mismatch", dir, `${base}/story.json`, `id is ${JSON.stringify(story.id ?? null)}`));
    if (story.priority !== undefined && story.priority !== null && !STORY_PRIORITIES.includes(String(story.priority).toUpperCase())) {
      issues.push(issue("warning", "invalid_priority", dir, `${base}/story.json`, `priority ${JSON.stringify(story.priority)}`));
    }
    if (steps.length > 0 && !has.has("claim.json")) issues.push(issue("error", "steps_without_claim", dir, `${base}/claim.json`, "completed steps but no claim"));
    if (String(story.status ?? "").toLowerCase() === "done" && steps.length === 0) issues.push(issue("warning", "done_without_steps", dir, `${base}/steps/`, "done with no completed step"));
    const fixed = story.fixes?.story_id;
    if (fixed && !known.has(String(fixed))) issues.push(issue("warning", "unknown_fixed_story", dir, `${base}/story.json`, `fixes ${fixed}, not on this ref`));
  }
  return {
    stories: byStory.size,
    errors: issues.filter((item) => item.level === "error").length,
    warnings: issues.filter((item) => item.level === "warning").length,
    issues,
  };
}

function git(root, args, input = "") {
  return childProcess.spawnSync("git", ["-C", root, ...args], { input, maxBuffer: BATCH_MAX_BUFFER, timeout: 60_000 });
}

/** The ref to check: <remote>/<base> when present, else HEAD. */
export function defaultRecordsRef(root, { remote, baseBranch }) {
  const candidate = `${remote}/${baseBranch}`;
  return git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]).status === 0 ? candidate : "HEAD";
}

/** Reads the story record paths and JSON files of `ref` with two git calls. */
export function readRefStoryRecords(root, ref, sdlcFolder = ".sdlc") {
  const listed = git(root, ["ls-tree", "-r", "-z", "--name-only", ref, "--", `${sdlcFolder}/stories`]);
  if (listed.status !== 0) {
    const error = new Error(`cannot read ${ref}: ${String(listed.stderr ?? "").trim().split("\n")[0]}`);
    error.code = "RECORDS_REF_UNREADABLE";
    throw error;
  }
  const paths = String(listed.stdout).split("\0").filter(Boolean);
  const wanted = paths.filter((item) => /\/(?:story|claim)\.json$/u.test(item) || /\/steps\/[^/]+\.json$/u.test(item));
  const files = new Map();
  if (wanted.length > 0) {
    const batch = git(root, ["cat-file", "--batch"], wanted.map((item) => `${ref}:${item}`).join("\n") + "\n");
    const out = Buffer.from(batch.stdout ?? "");
    let offset = 0;
    for (const item of wanted) {
      const end = out.indexOf(0x0a, offset);
      if (end < 0) break;
      const header = out.subarray(offset, end).toString("utf8");
      offset = end + 1;
      const size = Number(header.split(" ")[2]);
      if (header.endsWith(" missing") || !Number.isFinite(size)) continue;
      files.set(item, out.subarray(offset, offset + size).toString("utf8"));
      offset += size + 1;
    }
  }
  return { paths, files };
}
