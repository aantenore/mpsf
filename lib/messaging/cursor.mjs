import { Date } from "../runtime/host.mjs";

/**
 * Read position in the channel. A cursor names the last message seen as
 * "<created time>|<comment id>": the time narrows the request (GitHub's
 * `since`), the id drops what was already seen, because comment ids only grow.
 */
export const CURSOR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\|\d{1,20}$/u;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

export function isCursor(value) {
  return typeof value === "string" && CURSOR_PATTERN.test(value);
}

/** A provider may hand its own read position (`cursor`, same format); otherwise "<time>|<id>". */
export function cursorOf(message) {
  if (isCursor(message?.cursor)) return message.cursor;
  return message?.id && message?.time ? `${message.time}|${message.id}` : null;
}

export function parseCursor(value) {
  if (!isCursor(value)) return null;
  const [time, id] = value.split("|");
  return { time, id: Number(id) };
}

/** Turns a `since` value into a timestamp filter and the id already seen (any provider with numeric, growing ids). */
export function resolveSince(since, now) {
  if (since === undefined || since === null || since === "all") return { iso: null, afterId: null };
  const text = String(since);
  const cursor = parseCursor(text);
  if (cursor) return { iso: cursor.time, afterId: cursor.id };
  if (TIMESTAMP_PATTERN.test(text)) return { iso: text, afterId: null };
  const duration = /^(\d{1,6})([smhd])$/u.exec(text);
  if (duration) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2]];
    return { iso: new Date(now - Number(duration[1]) * unit).toISOString().replace(/\.\d{3}Z$/u, "Z"), afterId: null };
  }
  if (/^\d{1,12}$/u.test(text)) return { iso: new Date(Number(text) * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z"), afterId: null };
  return { iso: null, afterId: null };
}
