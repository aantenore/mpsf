/**
 * Text that other computers wrote into shared records (known errors,
 * knowledge, channel answers) reaches agents as hints. It is data, never
 * instructions: shown on one line, without control or invisible characters,
 * capped, and quoted, so it cannot pass for a line of the plugin's own output.
 * A step is shown as a command only when it is a real `mpsf` catalog command
 * with plain arguments; anything else stays quoted text.
 */
const INVISIBLE_CHARACTERS = /[​-‏‪-‮⁦-⁩﻿]/gu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const PLAIN_TOKEN = /^[\p{L}\p{N}._:/=@,+%-]+$/u;
const COMMAND_PREFIX = /^(?:mpsf|agentic-sdlc)\s+/u;

/** One line: control and invisible characters removed, whitespace collapsed, capped at max characters. */
export function inlineText(value, max = 200) {
  const text = String(value ?? "").replace(INVISIBLE_CHARACTERS, "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(text);
  return characters.length > max ? `${characters.slice(0, Math.max(1, max - 1)).join("")}…` : text;
}

/** inlineText in double quotes, with quotes and backslashes escaped. */
export function quotedText(value, max = 200) {
  return JSON.stringify(inlineText(value, max));
}

/**
 * "mpsf <command> <args>" when `step` is a command of the catalog (resolved
 * by `resolve`, the dispatcher's resolveCommand) with plain arguments only
 * (no quotes, no shell operators), else null.
 */
export function catalogCommandOf(step, resolve) {
  const text = inlineText(step, 300);
  if (!COMMAND_PREFIX.test(text)) return null;
  const tokens = text.replace(COMMAND_PREFIX, "").split(" ");
  if (!tokens.every((token) => PLAIN_TOKEN.test(token))) return null;
  try {
    return resolve(tokens) ? `mpsf ${tokens.join(" ")}` : null;
  } catch {
    return null;
  }
}
