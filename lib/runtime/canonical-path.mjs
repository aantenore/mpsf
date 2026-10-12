import path from "node:path";

import { fs, process } from "../runtime/host.mjs";

/**
 * One spelling per file system location, for comparing paths that reach the
 * same place by different routes: absolute, symbolic links resolved and, on
 * Windows, 8.3 short names (C:\Users\RUNNER~1) expanded to their long form and
 * case folded. The native realpath is the one that expands short names; the
 * JavaScript one keeps every component as written. A path that does not exist
 * is returned resolved but otherwise as written.
 */
export function canonicalPath(target) {
  let resolved = path.resolve(String(target));
  try {
    resolved = (fs.realpathSync.native ?? fs.realpathSync)(resolved);
  } catch {
    // a path that does not exist is compared as written
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when both paths name the same location (see canonicalPath). */
export function samePath(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}
