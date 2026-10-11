import path from "node:path";
import { crypto, fs, process } from "../../runtime/host.mjs";
import { sealTraceEvent, verifyTraceIntegrity } from "../../trace-integrity.mjs";
import { kindSpec, RecordStoreError, relativeRecordPath, TRACE_PATH } from "./port.mjs";

/**
 * Records as JSON files under one folder, shared by the git-backed store
 * (the folder is `.sdlc/`, history and sharing come from git) and the plain
 * local store (no git). Traces are sealed in the local hash chain of
 * lib/trace-integrity.mjs.
 */
export function createFileRecordStore({ id, root, sdlcRoot, guarantees, sharedState, publish }) {
  const projectRoot = path.resolve(String(root));
  const recordsRoot = path.resolve(String(sdlcRoot ?? path.join(projectRoot, ".sdlc")));

  const absolute = (relative) => path.join(recordsRoot, ...relative.split("/"));

  function location(kind, key) {
    return path.relative(projectRoot, absolute(relativeRecordPath(kindSpec(kind).path, key))).split(path.sep).join("/");
  }

  function read(kind, key) {
    const file = absolute(relativeRecordPath(kindSpec(kind).path, key));
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  function write(kind, key, record, { mode = "create" } = {}) {
    const spec = kindSpec(kind);
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new RecordStoreError("invalid_record", "A record must be a JSON object.");
    if (!["create", "replace"].includes(mode)) throw new RecordStoreError("invalid_mode", `Unknown write mode '${mode}'.`);
    if (mode === "replace" && spec.immutable) throw new RecordStoreError("immutable", `Records of kind '${kind}' are written once; record a new one instead.`);
    const target = absolute(relativeRecordPath(spec.path, key));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    try {
      if (mode === "create") {
        try {
          fs.linkSync(temp, target);
        } catch (error) {
          if (error?.code === "EEXIST") throw new RecordStoreError("exists", `${location(kind, key)} already exists.`);
          throw error;
        }
        return { location: location(kind, key), created: true };
      }
      const existed = fs.existsSync(target);
      fs.renameSync(temp, target);
      return { location: location(kind, key), created: !existed };
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  function list(kind, parentKey = null) {
    const template = kindSpec(kind).path;
    const [before, after] = template.split("{id}");
    const parent = typeof parentKey === "string" ? parentKey : parentKey?.parent ?? null;
    const folder = before.includes("{parent}") ? relativeRecordPath(before.replace(/\/$/u, ""), { parent, id: "unused" }) : before.replace(/\/$/u, "");
    const directory = absolute(folder);
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids = [];
    for (const entry of entries) {
      if (after.startsWith("/")) {
        if (entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, ...after.slice(1).split("/")))) ids.push(entry.name);
      } else if (entry.isFile() && entry.name.endsWith(after)) {
        ids.push(entry.name.slice(0, -after.length));
      }
    }
    return ids.sort();
  }

  const tracePath = (stream) => absolute(relativeRecordPath(TRACE_PATH, { id: stream }));

  function appendTrace(stream, event) {
    const file = tracePath(stream);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return sealTraceEvent({ boundaryRoot: projectRoot, tracePath: file, event });
  }

  function readTrace(stream) {
    let text;
    try {
      text = fs.readFileSync(tracePath(stream), "utf8");
    } catch {
      return [];
    }
    return text.split(/\r?\n/u).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "invalid" };
      }
    });
  }

  function verifyTrace(stream) {
    if (!fs.existsSync(tracePath(stream))) return { valid: true, errors: [], missing: true };
    const result = verifyTraceIntegrity({ boundaryRoot: projectRoot, tracePath: tracePath(stream) });
    return { valid: result.valid === true, errors: result.errors ?? [] };
  }

  return Object.freeze({
    id,
    guarantees: Object.freeze([...guarantees]),
    root: projectRoot,
    recordsRoot,
    location,
    read,
    write,
    list,
    appendTrace,
    readTrace,
    verifyTrace,
    sharedState,
    publish,
  });
}
