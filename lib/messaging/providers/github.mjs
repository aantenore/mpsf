import { childProcess, Date, crypto, process } from "../../runtime/host.mjs";
import { DEFAULT_MESSAGING, writeLocalMessaging } from "../config.mjs";
import { cursorOf, resolveSince } from "../cursor.mjs";
import { KINDS } from "../kinds.mjs";
import { associationTrust, signedTrust, signFields, TRUST, trustContext } from "../signature.mjs";

/**
 * GitHub messaging adapter. The channel is one issue of the project's
 * repository; a message is a comment on it, read and written through the
 * `gh` CLI the person is already signed in with (the plugin holds no token).
 *
 * A comment is readable by people and carries machine-readable fields in a
 * trailing hidden comment:
 *
 *   **PC3** · request · re #123 · ST-X · to PC4
 *
 *   <text>
 *
 *   <!-- agentic-sdlc:{"v":1,"id":"...","from":"PC3",...} -->
 *
 * The message id is the GitHub comment id. A comment without that trailer,
 * written by a person, reads as an `info` message from the author's login.
 */
export { GITHUB_PROVIDER_ID } from "../../adapters/messaging/ids.mjs";
import { GITHUB_PROVIDER_ID } from "../../adapters/messaging/ids.mjs";
// Comments reach every clone, comment ids only grow, and GitHub authenticates the author.
export const GITHUB_GUARANTEES = Object.freeze(["cross_host_delivery", "ordered_ids", "authenticated_sender"]);
const META_PREFIX = "agentic-sdlc:";
const META_PATTERN = /\s*<!-- agentic-sdlc:(\{[^\n]*\}) -->\s*$/u;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_ISSUE_PAGES = 5;
const CALL_TIMEOUT_MS = 20_000;
const DEFAULT_LISTEN_SECONDS = 30;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const META_VERSION = 1;
const GH_MISSING = "The GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com, then run: gh auth login";
const GH_AUTH = "The GitHub CLI (gh) is not signed in. Run: gh auth login";
const CHANNEL_BODY = "Channel used by the Agentic SDLC plugin so the computers working on this project can exchange short coordination notes. "
  + "Each comment is a message; do not close or delete this issue, and never post secrets here. Anyone who can read this repository can read it.";

function setupError(message) {
  const error = new Error(message);
  error.setup = true;
  return error;
}

/** Runs `gh`; resolves with { code, stdout, stderr } and rejects when it cannot start or the signal aborts. */
export function runGh(args, { signal, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile("gh", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: CALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      signal,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    }, (error, stdout, stderr) => {
      if (error && (error.code === "ENOENT" || error.name === "AbortError")) return reject(error);
      if (error?.killed) return reject(Object.assign(new Error("gh did not answer in time"), { name: "TimeoutError" }));
      return resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/** Splits `gh api -i` output into status, lower-cased headers and body. */
export function parseHttpResponse(text) {
  const match = /^HTTP\/\S+\s+(\d{3})[^\n]*\r?\n/u.exec(text);
  if (!match) return null;
  const rest = text.slice(match[0].length);
  const split = /\r?\n\r?\n/u.exec(rest);
  const head = split ? rest.slice(0, split.index) : rest;
  const headers = {};
  for (const line of head.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(match[1]), headers, body: split ? rest.slice(split.index + split[0].length) : "" };
}

function retryAfterMs(response, now) {
  const retry = Number(response.headers["retry-after"]);
  if (Number.isFinite(retry) && retry >= 0) return Math.min(retry * 1000, MAX_RETRY_AFTER_MS);
  if (response.headers["x-ratelimit-remaining"] === "0") {
    const reset = Number(response.headers["x-ratelimit-reset"]);
    if (Number.isFinite(reset)) return Math.min(Math.max(0, reset * 1000 - now), MAX_RETRY_AFTER_MS);
  }
  return null;
}

function apiMessage(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed?.message) return String(parsed.message).replace(/\s+/gu, " ").slice(0, 200);
  } catch {
    // Not JSON: the status alone is enough.
  }
  return "";
}

function failedResponse(response, action, now) {
  const detail = apiMessage(response.body);
  const wait = retryAfterMs(response, now);
  const limited = response.status === 429
    || (response.status === 403 && (wait !== null || /rate limit|abuse|secondary/iu.test(detail)));
  const error = new Error(`GitHub ${action} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  error.status = response.status;
  error.rateLimited = limited;
  if (limited && wait !== null) error.retryAfterMs = wait;
  if (response.status === 401) error.setup = true;
  return error;
}

// ---- comment format -------------------------------------------------------------------------------------------

function jsonForComment(value) {
  // Nothing in the data can close the HTML comment early.
  return JSON.stringify(value).replace(/>/gu, "\\u003e").replace(/--/gu, "-\\u002d");
}

/** The fields a GitHub message signs (../signature.mjs): what reads back from the comment unchanged. */
function signableFields({ from, host, story, text, kind, replyTo, reply_to: replyToField, to, version, stories, until }, id) {
  return { mid: id, from, host, story, kind: kind ?? "info", reply_to: replyTo ?? replyToField ?? null, to, version, stories: Array.isArray(stories) ? stories : null, until, text };
}

export function toGithubBody({ from, host, story, text, kind, replyTo, to, version, ghLogin, stories, until }, id = crypto.randomBytes(8).toString("hex"), signature = null) {
  const header = [`**${from}**${ghLogin ? ` (${ghLogin})` : ""}`];
  if (kind && kind !== "info") header.push(kind);
  if (replyTo) header.push(`re #${replyTo}`);
  if (story) header.push(story);
  if (to) header.push(`to ${to}`);
  const meta = { v: META_VERSION, id, from, host: host ?? null, kind: kind ?? "info", reply_to: replyTo ?? null, to: to ?? null, story: story ?? null, version: version ?? null, gh_login: ghLogin ?? null, stories: Array.isArray(stories) ? stories : null, until: until ?? null };
  for (const key of Object.keys(meta)) if (meta[key] === null) delete meta[key];
  if (signature?.sig) Object.assign(meta, { machine: signature.machine, key: signature.key, pub: signature.pub, sig: signature.sig });
  // A message text can never pose as the trailer.
  const safeText = String(text ?? "").replaceAll("<!--", "&lt;!--");
  return `${header.join(" · ")}\n\n${safeText}\n\n<!-- ${META_PREFIX}${jsonForComment(meta)} -->`;
}

function textField(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Trust of a comment (see ../signature.mjs). A signed plugin message is
 * checked against its signature: a wrong one is untrusted. Otherwise GitHub
 * itself vouches for the author: members of the repository (owner, member,
 * collaborator) are trusted, anyone else is not.
 *
 * The signature covers the message, not the comment, so anyone who can comment
 * could copy a signed body into a new comment. Two checks close that replay: a
 * signed comment posted by someone outside the repository is untrusted, and a
 * second comment carrying an already seen signed message (`seen`, one read) is
 * untrusted too.
 */
function commentTrust(comment, meta, text, trust, seen = null) {
  // Without the field (a transport that does not report it) nothing can be said.
  if (comment.author_association === undefined && !meta?.sig) return null;
  const byAssociation = associationTrust(comment.author_association);
  if (!meta?.sig) return byAssociation;
  const signed = signedTrust({ ...signableFields({ ...meta, text }, meta.id), machine: meta.machine, key: meta.key, pub: meta.pub, sig: meta.sig }, trust);
  if (signed === TRUST.untrusted) return TRUST.untrusted;
  if (comment.author_association !== undefined && byAssociation !== TRUST.trusted) return TRUST.untrusted;
  if (seen) {
    const signedId = `${meta.machine}:${meta.id}`;
    const first = seen.get(signedId);
    if (first !== undefined && first !== String(comment.id)) return TRUST.untrusted;
    seen.set(signedId, String(comment.id));
  }
  return signed === TRUST.trusted || byAssociation === TRUST.trusted ? TRUST.trusted : TRUST.unverified;
}

/**
 * A comment as a normalized message; with `trust` (from trustContext) it also carries `trust` and the signer `machine`.
 * `seen` (a Map shared by one read, comments in id order) marks a repeated signed message as a replay.
 */
export function fromGithubComment(comment, trust = null, seen = null) {
  if (!comment || comment.id === undefined || comment.id === null) return null;
  const body = String(comment.body ?? "");
  const time = typeof comment.created_at === "string" ? comment.created_at : null;
  let meta = null;
  const found = META_PATTERN.exec(body);
  if (found) {
    try {
      const parsed = JSON.parse(found[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed;
    } catch {
      meta = null;
    }
  }
  const login = textField(comment.user?.login);
  if (!meta) {
    const verdict = trust ? commentTrust(comment, null, null, trust) : null;
    return {
      id: String(comment.id), time, from: login, host: null, story: null, kind: "info", reply_to: null, to: null, version: null, gh_login: null, stories: null,
      text: body.trim(), title: null, plugin_message: false,
      ...(verdict ? { trust: verdict } : {}),
    };
  }
  const visible = body.slice(0, found.index).replace(/^[^\n]*\n\n?/u, "");
  const kind = KINDS.includes(meta.kind) ? meta.kind : "info";
  const text = visible.replaceAll("&lt;!--", "<!--").trim();
  const verdict = trust ? commentTrust(comment, meta, text, trust, seen) : null;
  return {
    id: String(comment.id),
    time,
    from: textField(meta.from) ?? login,
    host: textField(meta.host),
    story: textField(meta.story),
    kind,
    reply_to: textField(meta.reply_to),
    to: textField(meta.to),
    version: textField(meta.version),
    gh_login: login ?? textField(meta.gh_login),
    stories: Array.isArray(meta.stories) ? meta.stories.map(String).slice(0, 20) : null,
    ...(textField(meta.until) ? { until: textField(meta.until) } : {}),
    text,
    title: null,
    plugin_message: true,
    ...(verdict ? { trust: verdict, ...(textField(meta.machine) ? { machine: meta.machine } : {}) } : {}),
  };
}

// ---- reading position -----------------------------------------------------------------------------------------

export { resolveSince };

// ---- provider -------------------------------------------------------------------------------------------------

export function createGithubProvider({ exec = runGh, sleep, now = () => Date.now() } = {}) {
  const wait = sleep ?? ((ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  }));
  const channels = new Map();

  async function call(action, method, endpoint, { fields = [], signal } = {}) {
    const args = ["api", "-i", "--method", method, endpoint];
    for (const [key, value] of fields) args.push("-f", `${key}=${value}`);
    let result;
    try {
      result = await exec(args, { signal });
    } catch (error) {
      if (error?.code === "ENOENT") throw setupError(GH_MISSING);
      throw error;
    }
    const response = parseHttpResponse(result.stdout);
    if (!response) {
      const detail = String(result.stderr || result.stdout || "").trim();
      if (/gh auth login|not logged in|authentication required|GH_TOKEN/iu.test(detail)) throw setupError(GH_AUTH);
      throw new Error(`GitHub ${action} failed: ${detail.split("\n")[0].slice(0, 200) || `gh exited with code ${result.code}`}`);
    }
    if (response.status >= 400) {
      const error = failedResponse(response, action, now());
      if (response.status === 401) error.message = `${error.message}. ${GH_AUTH}`;
      throw error;
    }
    let json = null;
    try {
      json = response.body.trim() ? JSON.parse(response.body) : null;
    } catch {
      json = null;
    }
    return json;
  }

  async function listIssues(repo, query, signal) {
    const found = [];
    for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
      const issues = await call("find the channel", "GET", `repos/${repo}/issues?state=all&per_page=${PAGE_SIZE}&page=${page}${query}`, { signal });
      if (!Array.isArray(issues)) break;
      found.push(...issues.filter((issue) => issue && !issue.pull_request));
      if (issues.length < PAGE_SIZE) break;
    }
    return found;
  }

  const lowest = (issues) => issues.reduce((best, issue) => (!best || issue.number < best.number ? issue : best), null);

  async function findChannel(repo, signal) {
    const labelled = lowest(await listIssues(repo, `&labels=${encodeURIComponent(DEFAULT_MESSAGING.label)}`, signal));
    if (labelled) return labelled;
    return lowest((await listIssues(repo, "", signal)).filter((issue) => issue.title === DEFAULT_MESSAGING.title));
  }

  /**
   * The channel issue number. Uses the configured one; otherwise finds the issue (label, then title) or creates it
   * once. Two computers creating it together settle on the lowest number, and the extra issue is closed. The result
   * is stored in the clone's local settings.
   */
  async function ensureChannel({ config, signal, verify = false }) {
    const cacheKey = config.repo;
    let issue = config.issue ?? channels.get(cacheKey) ?? null;
    let created = false;
    if (issue && verify) {
      const existing = await call("check the channel", "GET", `repos/${config.repo}/issues/${issue}`, { signal });
      if (existing?.pull_request) throw new Error(`#${issue} in ${config.repo} is a pull request, not an issue.`);
    }
    if (!issue) {
      let found = await findChannel(config.repo, signal);
      if (!found) {
        const made = await call("create the channel", "POST", `repos/${config.repo}/issues`, {
          fields: [["title", DEFAULT_MESSAGING.title], ["body", CHANNEL_BODY], ["labels[]", DEFAULT_MESSAGING.label]],
          signal,
        });
        created = true;
        found = (await findChannel(config.repo, signal)) ?? made;
        if (made?.number && found?.number !== made.number) {
          try {
            await call("close a duplicate channel", "PATCH", `repos/${config.repo}/issues/${made.number}`, { fields: [["state", "closed"], ["state_reason", "not_planned"]], signal });
          } catch {
            // The duplicate is harmless; the lowest number is the one in use.
          }
          created = false;
        }
      }
      issue = found?.number ?? null;
      if (!issue) throw new Error(`Could not find or create the channel issue in ${config.repo}.`);
      if (config.local_path) {
        try {
          writeLocalMessaging(config.local_path, { provider: GITHUB_PROVIDER_ID, repo: config.repo, issue });
        } catch {
          // Found again next time.
        }
      }
    }
    channels.set(cacheKey, issue);
    return { issue, created, url: `https://github.com/${config.repo}/issues/${issue}` };
  }

  async function publish({ config, message, signal }) {
    const { issue } = await ensureChannel({ config, signal });
    const id = crypto.randomBytes(8).toString("hex");
    const signature = signFields(signableFields({ ...message, text: String(message?.text ?? "").trim() }, id));
    const comment = await call("send", "POST", `repos/${config.repo}/issues/${issue}/comments`, {
      fields: [["body", toGithubBody(message, id, signature)]],
      signal,
    });
    return fromGithubComment(comment, config.root ? trustContext(config.root) : null);
  }

  async function poll({ config, since, signal }) {
    const { issue } = await ensureChannel({ config, signal });
    const { iso, afterId } = resolveSince(since, now());
    const messages = [];
    const trust = trustContext(config.root);
    const seen = new Map();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const comments = await call("read", "GET", `repos/${config.repo}/issues/${issue}/comments?${iso ? `since=${iso}&` : ""}per_page=${PAGE_SIZE}&page=${page}`, { signal });
      if (!Array.isArray(comments)) break;
      for (const comment of comments) {
        const message = fromGithubComment(comment, trust, seen);
        if (message && (afterId === null || Number(message.id) > afterId)) messages.push(message);
      }
      if (comments.length < PAGE_SIZE) break;
    }
    return messages;
  }

  /** Delivers new messages until the signal aborts, reading every few seconds (the API has no push). */
  async function subscribe({ config, since, signal, onMessage, onError, intervalSeconds = DEFAULT_LISTEN_SECONDS }) {
    let cursor = since ?? `${new Date(now()).toISOString().replace(/\.\d{3}Z$/u, "Z")}`;
    while (!signal?.aborted) {
      let pause = intervalSeconds * 1000;
      try {
        const messages = await poll({ config, since: cursor, signal });
        for (const message of messages) {
          cursor = cursorOf(message) ?? cursor;
          if ((await onMessage(message)) === false) return;
        }
      } catch (error) {
        if (signal?.aborted) return;
        onError?.(error);
        if (Number.isFinite(error?.retryAfterMs)) pause = Math.max(pause, error.retryAfterMs);
      }
      if (signal?.aborted) return;
      await wait(pause, signal);
    }
  }

  /** The GitHub login the gh CLI is signed in as, or null. */
  async function whoami({ signal } = {}) {
    const user = await call("read the signed-in user", "GET", "user", { signal });
    return textField(user?.login);
  }

  /** The channel issue already in use in `repo`, or null; never creates one (used by `message setup` to keep existing projects on it). */
  async function existingChannel({ repo, signal }) {
    return (await findChannel(repo, signal))?.number ?? null;
  }

  return Object.freeze({ id: GITHUB_PROVIDER_ID, guarantees: GITHUB_GUARANTEES, publish, poll, subscribe, ensureChannel, whoami, existingChannel });
}
