import path from "node:path";
import { pathToFileURL } from "node:url";
import { Date, fs, process } from "../../runtime/host.mjs";
import { cursorOf, resolveSince } from "../cursor.mjs";
import { KINDS } from "../kinds.mjs";

/**
 * File messaging adapter: the channel is an append-only JSON-lines file in a
 * folder. Meant for tests, offline work and computers that share a folder
 * (a network drive); nothing leaves the machine otherwise. Ids are growing
 * integers handed out under a lock, so read positions work as with any other
 * provider.
 *
 *   <dir>/channel.jsonl   one message per line, oldest first
 *   <dir>/channel.seq     last id handed out
 *   <dir>/channel.lock    held while a message is appended
 */
import { LOCAL_PROVIDER_ID } from "../../adapters/messaging/ids.mjs";
export { LOCAL_PROVIDER_ID };
// Ids only grow; the sender is whatever the computer says, and only computers that share the folder see the messages.
export const LOCAL_GUARANTEES = Object.freeze(["ordered_ids"]);
export const CHANNEL_FILE = "channel.jsonl";
const SEQ_FILE = "channel.seq";
const LOCK_DIR = "channel.lock";
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const DEFAULT_LISTEN_SECONDS = 2;
const MAX_TEXT = 4000;

function setupError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.setup = true;
  return error;
}

function channelDir(config) {
  const dir = config?.local_dir;
  if (typeof dir !== "string" || !dir) throw setupError("The local messaging channel has no folder (set host_policy.adapters.messaging.options.dir or AGENTIC_SDLC_MESSAGING_LOCAL_DIR).");
  return path.resolve(dir);
}

function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function textOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(dir, now, action) {
  const lock = path.join(dir, LOCK_DIR);
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw setupError(`Cannot lock the local channel: ${error.message}`, error);
      try {
        if (now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // Released meanwhile.
      }
      if (now() > deadline) throw setupError("The local channel is locked by another process; try again.");
      sleepSync(20);
    }
  }
  try {
    return action();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Parses the channel file; a damaged line is skipped, never fatal. */
export function readChannel(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, CHANNEL_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw setupError(`Cannot read the local channel: ${error.message}`, error);
  }
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && /^\d{1,20}$/u.test(String(value.id ?? ""))) messages.push(value);
    } catch {
      // A torn or edited line: skipped.
    }
  }
  return messages;
}

export function createLocalProvider({ now = () => Date.now(), sleep } = {}) {
  const wait = sleep ?? ((ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  }));

  async function ensureChannel({ config }) {
    const dir = channelDir(config);
    const created = !fs.existsSync(dir);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw setupError(`Cannot create the local channel folder ${dir}: ${error.message}`, error);
    }
    return { issue: null, created, url: pathToFileURL(path.join(dir, CHANNEL_FILE)).href };
  }

  async function publish({ config, message, signal }) {
    signal?.throwIfAborted?.();
    const text = String(message?.text ?? "");
    if (!text.trim()) throw new Error("A message needs text.");
    if (text.length > MAX_TEXT) throw new Error(`A message is limited to ${MAX_TEXT} characters.`);
    await ensureChannel({ config });
    const dir = channelDir(config);
    return withLock(dir, now, () => {
      let last = 0;
      try {
        last = Number(fs.readFileSync(path.join(dir, SEQ_FILE), "utf8").trim()) || 0;
      } catch {
        last = readChannel(dir).reduce((max, item) => Math.max(max, Number(item.id)), 0);
      }
      const id = String(last + 1);
      const stored = {
        id,
        time: isoSeconds(now()),
        from: textOrNull(message.from),
        host: textOrNull(message.host),
        story: textOrNull(message.story),
        kind: KINDS.includes(message.kind) ? message.kind : "info",
        reply_to: textOrNull(message.replyTo ?? message.reply_to),
        to: textOrNull(message.to),
        version: textOrNull(message.version),
        gh_login: textOrNull(message.ghLogin ?? message.gh_login),
        stories: Array.isArray(message.stories) ? message.stories.map(String).slice(0, 20) : null,
        ...(textOrNull(message.until) ? { until: message.until } : {}),
        text: text.trim(),
        title: null,
        plugin_message: true,
      };
      try {
        fs.appendFileSync(path.join(dir, CHANNEL_FILE), `${JSON.stringify(stored)}\n`, { mode: 0o600 });
        const temp = path.join(dir, `${SEQ_FILE}.${process.pid}.tmp`);
        fs.writeFileSync(temp, `${id}\n`, { mode: 0o600 });
        fs.renameSync(temp, path.join(dir, SEQ_FILE));
      } catch (error) {
        throw setupError(`Cannot write the local channel: ${error.message}`, error);
      }
      return stored;
    });
  }

  async function poll({ config, since, signal }) {
    signal?.throwIfAborted?.();
    const { iso, afterId } = resolveSince(since, now());
    const from = iso ? Date.parse(iso) : null;
    return readChannel(channelDir(config)).filter((message) => {
      if (afterId !== null && Number(message.id) <= afterId) return false;
      if (from !== null && !(Date.parse(message.time ?? "") >= from)) return false;
      return true;
    });
  }

  async function subscribe({ config, since, signal, onMessage, onError, intervalSeconds = DEFAULT_LISTEN_SECONDS }) {
    let cursor = since ?? isoSeconds(now());
    while (!signal?.aborted) {
      try {
        for (const message of await poll({ config, since: cursor, signal })) {
          cursor = cursorOf(message) ?? cursor;
          if ((await onMessage(message)) === false) return;
        }
      } catch (error) {
        if (signal?.aborted) return;
        onError?.(error);
      }
      if (signal?.aborted) return;
      await wait(intervalSeconds * 1000, signal);
    }
  }

  async function whoami() {
    return null;
  }

  return Object.freeze({ id: LOCAL_PROVIDER_ID, guarantees: LOCAL_GUARANTEES, ensureChannel, publish, poll, subscribe, whoami });
}
