/**
 * Shared coordination state kept by the git-backed store as refs on the
 * project's remote (refs/agentic-sdlc/<namespace>/...). The module that owns a
 * namespace registers how to read and write it, so the store reaches it
 * without importing the owner (and the owner stays free to use the store).
 *
 *   read(root, options)    -> { records, note }
 *   write(root, payload)   -> { status, ... }   create-only
 */
const handlers = new Map();

export function registerSharedNamespace(namespace, handler) {
  if (typeof handler?.read !== "function" || typeof handler?.write !== "function") {
    throw new TypeError(`Shared namespace '${namespace}' needs read and write.`);
  }
  handlers.set(namespace, handler);
}

export function sharedNamespaceHandler(namespace) {
  return handlers.get(namespace) ?? null;
}

export function registeredSharedNamespaces() {
  return [...handlers.keys()].sort();
}
