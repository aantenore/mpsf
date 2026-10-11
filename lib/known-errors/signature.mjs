import { crypto } from "../runtime/host.mjs";

/**
 * Deterministic signature of a failure: the same problem on any computer, in
 * any story, at any time gives the same id. Variable parts (story and record
 * ids, hashes, numbers, timestamps, absolute paths) are masked; the project
 * path involved, if any, stays as its own field.
 */
export const SIGNATURE_VERSION = "known-error-signature:v1";

const PATH_PATTERN = /(?:^|[\s'"`(=:])((?:\.{0,2}[\w@+-][\w.@+-]*\/)+[\w.@+-]+)/u;
const RULES = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/gu, "<time>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<uuid>"],
  [/\b[0-9a-f]{7,64}\b/giu, (match) => (/\d/u.test(match) && /[a-f]/iu.test(match) ? "<hash>" : match)],
  [/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[A-Z0-9-]*\b/gu, "<id>"],
  [/\d+(?:\.\d+)*/gu, "<n>"],
];

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

/** The first project-relative path named in `message`, with forward slashes. */
export function extractPath(message, root = null) {
  let source = text(message).replace(/\\/gu, "/");
  if (root) source = source.split(text(root).replace(/\\/gu, "/").replace(/\/$/u, "") + "/").join(" ");
  const match = PATH_PATTERN.exec(source);
  if (!match) return null;
  const found = match[1].replace(/^\.\//u, "");
  if (/^(?:https?|file):/iu.test(found) || found.startsWith("/") || /^[a-z]:\//iu.test(found)) return null;
  return found;
}

/** Message with every variable part masked, whitespace collapsed and capped. */
export function normalizeMessage(message, { root = null, maxChars = 400, path = null } = {}) {
  let value = text(message).replace(/\\/gu, "/");
  if (root) value = value.split(text(root).replace(/\\/gu, "/").replace(/\/$/u, "")).join("<root>");
  if (path) value = value.split(path).join("<path>");
  value = value.replace(/(?:[a-z]:)?(?:\/[\w.@+-]+){2,}/giu, "<abs>");
  for (const [pattern, replacement] of RULES) value = value.replace(pattern, replacement);
  value = value.replace(/\s+/gu, " ").trim();
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function normalizeCommand(command) {
  if (command === undefined || command === null) return null;
  const parts = Array.isArray(command) ? command.map(text) : text(command).split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return null;
  // The executable and its subcommands identify the command; ids and paths in its arguments do not.
  return parts.slice(0, 4).map((part) => normalizeMessage(part, { maxChars: 80 })).join(" ");
}

/**
 * Signature of one failure.
 * input: { check, command, exit_code, message, path, root, maxChars }
 */
export function computeSignature(input = {}) {
  const maxChars = input.maxChars ?? 400;
  const failurePath = input.path ? text(input.path).replace(/\\/gu, "/").replace(/^\.\//u, "") : extractPath(input.message, input.root);
  const exitCode = input.exit_code === undefined || input.exit_code === null || input.exit_code === "" ? null : Number(input.exit_code);
  const signature = {
    version: SIGNATURE_VERSION,
    check: text(input.check) || null,
    command: normalizeCommand(input.command),
    exit_code: Number.isFinite(exitCode) ? exitCode : null,
    message: normalizeMessage(input.message, { root: input.root, maxChars, path: failurePath }),
    path: failurePath || null,
  };
  const key = crypto.createHash("sha256")
    .update(JSON.stringify([signature.version, signature.check, signature.command, signature.exit_code, signature.message, signature.path]))
    .digest("hex");
  return { ...signature, key, id: `KE-${key.slice(0, 12)}` };
}
