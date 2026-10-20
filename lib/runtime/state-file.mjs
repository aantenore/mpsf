/**
 * Writes a small local state file whole: to a temp file, then renamed over the
 * old one, so a hook running in parallel never reads it half written (and
 * falls back to an empty state that drops what it held).
 */
import crypto from "node:crypto";

import { fs, process } from "./host.mjs";

export function writeStateFile(file, text, { mode = 0o600 } = {}) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, text, { mode });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    // Windows refuses the rename while another process has the file open: write in place.
    if (error?.code !== "EPERM" && error?.code !== "EACCES" && error?.code !== "EBUSY") throw error;
    fs.writeFileSync(file, text, { mode });
  }
}
