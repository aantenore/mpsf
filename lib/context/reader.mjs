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
  const absolute = (relative) => {
    const resolved = path.resolve(root, relative);
    const base = path.resolve(root);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error(`Path outside the project: ${relative}`);
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

/** True when what a reader observed earlier is still what is on disk (cache validity check). */
export function observationStillValid(root, observed) {
  const probe = createFsRecordReader(root);
  for (const [dir, names] of Object.entries(observed?.dirs ?? {})) {
    if (JSON.stringify(probe.list(dir)) !== JSON.stringify(names)) return false;
  }
  for (const [file, hash] of Object.entries(observed?.files ?? {})) {
    if (probe.hash(file) !== hash) return false;
  }
  return true;
}
