import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Read port of the context module. The pack builder sees the project's
 * records only through this interface, so the filesystem reader below can be
 * swapped for a RecordStore-backed one without touching the builder:
 *
 *   list(dir)            sorted entry names of a project-relative folder ([] when missing)
 *   readJson(file)       parsed JSON of a project-relative file, or null
 *   readText(file, max)  UTF-8 text (at most `max` bytes), or null
 *   readLines(file, fn)  calls fn(line) for each line of a JSONL file; false when missing
 *   hash(file)           sha256 hex of the file bytes, or null
 *   observed()           { files: {path: sha256|null}, dirs: {path: [names]} } read so far
 *
 * Every path is project-relative with forward slashes. The reader records
 * what it saw so the cache can tell, without rebuilding, whether any input
 * changed (a new record in a listed folder counts as a change).
 */
export function createFsRecordReader(root) {
  const files = new Map();
  const dirs = new Map();
  let cachedRealRoot = null;
  const realRoot = () => {
    if (cachedRealRoot === null) {
      try {
        cachedRealRoot = fs.realpathSync.native(root);
      } catch {
        cachedRealRoot = path.resolve(root);
      }
    }
    return cachedRealRoot;
  };
  const absolute = (relative) => {
    const resolved = path.resolve(root, relative);
    const base = path.resolve(root);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error(`Path outside the project: ${relative}`);
    // A symbolic link inside the project must not lead the reader outside it.
    let real;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      return resolved; // missing: the read itself reports it
    }
    const realBase = realRoot();
    if (real !== realBase && !real.startsWith(`${realBase}${path.sep}`)) throw new Error(`Path outside the project: ${relative}`);
    return resolved;
  };
  const note = (relative, bytes) => {
    files.set(relative, bytes === null ? null : crypto.createHash("sha256").update(bytes).digest("hex"));
  };
  const readBytes = (relative) => {
    try {
      const bytes = fs.readFileSync(absolute(relative));
      note(relative, bytes);
      return bytes;
    } catch {
      note(relative, null);
      return null;
    }
  };
  return {
    kind: "fs",
    root,
    list(relative) {
      let names = [];
      try {
        names = fs.readdirSync(absolute(relative)).filter((name) => !name.startsWith(".")).sort();
      } catch {
        names = [];
      }
      dirs.set(relative, names);
      return names;
    },
    readJson(relative) {
      const bytes = readBytes(relative);
      if (bytes === null) return null;
      try {
        return JSON.parse(bytes.toString("utf8"));
      } catch {
        return null;
      }
    },
    readText(relative, max = 65_536) {
      const bytes = readBytes(relative);
      return bytes === null ? null : bytes.subarray(0, max).toString("utf8");
    },
    readLines(relative, visit) {
      const bytes = readBytes(relative);
      if (bytes === null) return false;
      for (const line of bytes.toString("utf8").split(/\r?\n/u)) if (line.trim()) visit(line);
      return true;
    },
    hash(relative) {
      if (!files.has(relative)) readBytes(relative);
      return files.get(relative);
    },
    observed() {
      return {
        files: Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b, "en"))),
        dirs: Object.fromEntries([...dirs.entries()].sort(([a], [b]) => a.localeCompare(b, "en"))),
      };
    },
  };
}

// Project-relative paths the RecordStore port addresses, with the kind and key they map to.
const STORE_ROUTES = Object.freeze([
  { pattern: /^\.sdlc\/stories\/([^/]+)\/story\.json$/u, kind: "story", key: (m) => ({ id: m[1] }) },
  { pattern: /^\.sdlc\/stories\/([^/]+)\/steps\/([^/]+)\.json$/u, kind: "story-step", key: (m) => ({ parent: m[1], id: m[2] }) },
  { pattern: /^\.sdlc\/gates\/([^/]+)\.json$/u, kind: "gate-report", key: (m) => ({ id: m[1] }) },
]);
const STEP_DIR = /^\.sdlc\/stories\/([^/]+)\/steps$/u;
const TRACE_FILE = /^\.sdlc\/traces\/([^/]+)\.jsonl$/u;

function digest(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Reader over the RecordStore port (lib/adapters/records/port.mjs): story,
 * story steps, gate reports and traces come from `store.read/list/readTrace`,
 * every other record from `fallback` (the filesystem reader) until the port
 * addresses its kind. Hashes of store records are taken over their JSON, so
 * the cache check must use a reader built the same way (see `readerFactory`).
 */
export function createRecordStoreReader(store, { fallback }) {
  const files = new Map();
  const dirs = new Map();
  const route = (relative) => {
    for (const candidate of STORE_ROUTES) {
      const match = candidate.pattern.exec(relative);
      if (match) return { kind: candidate.kind, key: candidate.key(match) };
    }
    return null;
  };
  const readRecord = (relative, target) => {
    let record = null;
    try {
      record = store.read(target.kind, target.key);
    } catch {
      record = null;
    }
    files.set(relative, record === null ? null : digest(JSON.stringify(record)));
    return record;
  };
  const traceText = (relative, stream) => {
    let events = [];
    try {
      events = store.readTrace(stream);
    } catch {
      events = [];
    }
    const text = events.map((event) => JSON.stringify(event)).join("\n");
    files.set(relative, events.length === 0 ? null : digest(text));
    return events.length === 0 ? null : text;
  };
  return {
    kind: `record-store:${store.id}`,
    root: fallback.root,
    list(relative) {
      const steps = STEP_DIR.exec(relative);
      if (!steps) return fallback.list(relative);
      let names = [];
      try {
        names = store.list("story-step", { parent: steps[1] }).map((id) => `${id}.json`).sort();
      } catch {
        names = [];
      }
      dirs.set(relative, names);
      return names;
    },
    readJson(relative) {
      const target = route(relative);
      return target ? readRecord(relative, target) : fallback.readJson(relative);
    },
    readText(relative, max) {
      const target = route(relative);
      if (!target) return fallback.readText(relative, max);
      const record = readRecord(relative, target);
      return record === null ? null : JSON.stringify(record, null, 2).slice(0, max);
    },
    readLines(relative, visit) {
      const trace = TRACE_FILE.exec(relative);
      if (!trace) return fallback.readLines(relative, visit);
      const text = traceText(relative, trace[1]);
      if (text === null) return false;
      for (const line of text.split("\n")) if (line.trim()) visit(line);
      return true;
    },
    hash(relative) {
      if (files.has(relative)) return files.get(relative);
      const trace = TRACE_FILE.exec(relative);
      if (trace) {
        traceText(relative, trace[1]);
        return files.get(relative);
      }
      const target = route(relative);
      if (target) {
        readRecord(relative, target);
        return files.get(relative);
      }
      return fallback.hash(relative);
    },
    observed() {
      const base = fallback.observed();
      return {
        files: Object.fromEntries([...Object.entries(base.files), ...files.entries()].sort(([a], [b]) => a.localeCompare(b, "en"))),
        dirs: Object.fromEntries([...Object.entries(base.dirs), ...dirs.entries()].sort(([a], [b]) => a.localeCompare(b, "en"))),
      };
    },
  };
}

/** True when what a reader observed earlier is still what the reader sees now (cache validity check). */
export function observationStillValid(root, observed, createReader = createFsRecordReader) {
  const probe = createReader(root);
  for (const [dir, names] of Object.entries(observed?.dirs ?? {})) {
    if (JSON.stringify(probe.list(dir)) !== JSON.stringify(names)) return false;
  }
  for (const [file, hash] of Object.entries(observed?.files ?? {})) {
    if (probe.hash(file) !== hash) return false;
  }
  return true;
}
