/**
 * RecordStore port: where the SDLC records live.
 *
 * Records are addressed by kind and key, never by a path the caller builds:
 *
 *   read(kind, key)                    -> record object, or null when missing or unreadable
 *   write(kind, key, record, { mode }) -> { location, created }
 *                                         mode "create" (default) refuses to overwrite;
 *                                         "replace" is refused for immutable kinds
 *   list(kind, parentKey)              -> ids, sorted
 *   location(kind, key)                -> where the record lives, for messages and evidence links
 *   appendTrace(stream, event)         -> sealed event (hash chain + checkpoint when the store has hash_chain)
 *   readTrace(stream)                  -> events, oldest first
 *   verifyTrace(stream)                -> { valid, errors }
 *   sharedState.namespaces             -> namespaces this store shares between computers
 *   sharedState.read(namespace, opts)  -> { records, note }
 *   sharedState.write(namespace, payload) -> { written, ... } (create-only)
 *   publish(request)                   -> { published, ... } brings local records to where the others read them
 *   guarantees                         -> RECORD_GUARANTEES the store gives (lib/adapters/capabilities.mjs)
 *   id                                 -> provider id
 *
 * `key` is { id } or { parent, id }. Ids are single path-safe segments.
 * The code itself (source, pull requests, the base branch) always stays in
 * git; a store only decides where the process records go.
 */
export const RECORD_STORE_METHODS = Object.freeze(["read", "write", "list", "location", "appendTrace", "readTrace", "verifyTrace", "publish"]);
export const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Kinds of record the port addresses, with their place under the records
 * folder. Immutable kinds are written once: a correction is a new record.
 */
export const RECORD_KINDS = Object.freeze({
  story: Object.freeze({ path: "stories/{id}/story.json", immutable: false }),
  "story-step": Object.freeze({ path: "stories/{parent}/steps/{id}.json", immutable: false }),
  "story-parking": Object.freeze({ path: "stories/{parent}/parking/{id}.json", immutable: true }),
  delegation: Object.freeze({ path: "autonomy/delegations/{id}/delegation.json", immutable: true }),
  "delegation-revocation": Object.freeze({ path: "autonomy/delegations/{id}/revocation.json", immutable: true }),
  "delegation-use": Object.freeze({ path: "autonomy/delegations/{parent}/uses/{id}.json", immutable: true }),
  "gate-report": Object.freeze({ path: "gates/{id}.json", immutable: false }),
});
// Trace streams: one per story, plus "project".
export const TRACE_PATH = "traces/{id}.jsonl";

export class RecordStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecordStoreError";
    this.code = code;
  }
}

function segment(value, label) {
  const text = String(value ?? "");
  if (!SEGMENT_PATTERN.test(text) || text.includes("..")) throw new RecordStoreError("invalid_key", `${label} '${text}' is not a valid record id.`);
  return text;
}

export function kindSpec(kind) {
  const spec = Object.hasOwn(RECORD_KINDS, kind) ? RECORD_KINDS[kind] : null;
  if (!spec) throw new RecordStoreError("unknown_kind", `Unknown record kind '${kind}' (known: ${Object.keys(RECORD_KINDS).join(", ")}).`);
  return spec;
}

/** The relative path of a record under the records folder, from its kind's template. */
export function relativeRecordPath(template, key) {
  const value = typeof key === "string" ? { id: key } : key ?? {};
  return template
    .replace("{parent}", () => segment(value.parent, "parent"))
    .replace("{id}", () => segment(value.id, "id"));
}

/** Throws when `store` does not implement the port; returns it otherwise. */
export function assertRecordStore(store) {
  if (!store || typeof store !== "object") throw new TypeError("A record store must be an object.");
  if (typeof store.id !== "string" || !store.id) throw new TypeError("A record store needs an id.");
  for (const method of RECORD_STORE_METHODS) {
    if (typeof store[method] !== "function") throw new TypeError(`Record store '${store.id}' does not implement ${method}().`);
  }
  if (!Array.isArray(store.guarantees)) throw new TypeError(`Record store '${store.id}' must list its guarantees.`);
  if (!store.sharedState || typeof store.sharedState.read !== "function" || typeof store.sharedState.write !== "function" || !Array.isArray(store.sharedState.namespaces)) {
    throw new TypeError(`Record store '${store.id}' must expose sharedState { namespaces, read, write }.`);
  }
  return store;
}
