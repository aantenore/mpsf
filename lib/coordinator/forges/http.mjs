import { childProcess, process } from "../../runtime/host.mjs";

/**
 * Shared plumbing for the forges reached over their REST API (GitLab,
 * Gitea/Forgejo): where the forge lives (from the remote URL), which token
 * to use (environment first, then the system keychain through
 * `git credential fill`) and synchronous HTTPS calls. The token is read at
 * the moment of use, sent on stdin to a short-lived child and never stored,
 * printed or written to .sdlc.
 */
export const FORGE_URL_ENV = "AGENTIC_SDLC_FORGE_URL";
export const FORGE_TOKEN_ENV = "AGENTIC_SDLC_FORGE_TOKEN";
const TIMEOUT_MS = 30_000;
const CREDENTIAL_TIMEOUT_MS = 5_000;

/**
 * { webUrl, host, path } of a remote URL (https, ssh:// or scp-like
 * git@host:owner/repo.git), or null. `AGENTIC_SDLC_FORGE_URL` sets the web
 * address for forges on another port or under a path prefix.
 */
export function parseRemote(url, env = process.env) {
  const text = String(url ?? "").trim();
  let host = null;
  let repoPath = null;
  let scheme = "https";
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/u.exec(text);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    try {
      const parsed = new URL(text);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        scheme = parsed.protocol.slice(0, -1);
        host = parsed.host;
      } else {
        host = parsed.hostname;
      }
      repoPath = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  } else if (scp) {
    host = scp[1];
    repoPath = scp[2];
  }
  if (!host || !repoPath) return null;
  let webUrl = `${scheme}://${host}`;
  const override = String(env?.[FORGE_URL_ENV] ?? "").trim().replace(/\/+$/u, "");
  if (override) {
    webUrl = override;
    try {
      const prefix = new URL(override).pathname.replace(/\/+$/u, "");
      const normalized = `/${repoPath.replace(/^\/+/u, "")}`;
      if (prefix && normalized.startsWith(`${prefix}/`)) repoPath = normalized.slice(prefix.length);
    } catch {
      return null;
    }
  }
  const cleanPath = repoPath.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (!cleanPath.includes("/")) return null;
  return { webUrl, host: new URL(webUrl).host, path: cleanPath };
}

/**
 * The token for `host`: the first set variable in `envNames` (then
 * AGENTIC_SDLC_FORGE_TOKEN), else what the keychain holds for it through
 * git's credential helper, never prompting. { token, scheme } or null;
 * scheme is "token" for a token and "basic" for a keychain username and
 * password pair.
 */
export function forgeCredential({ webUrl, envNames = [], env = process.env, gitRunner = defaultGitRunner }) {
  for (const name of [...envNames, FORGE_TOKEN_ENV]) {
    const value = String(env?.[name] ?? "").trim();
    if (value) return { scheme: "token", token: value };
  }
  const url = new URL(webUrl);
  const input = `protocol=${url.protocol.slice(0, -1)}\nhost=${url.host}\n${url.pathname.length > 1 ? `path=${url.pathname.slice(1)}\n` : ""}\n`;
  const result = gitRunner(["credential", "fill"], input);
  if (result.status !== 0) return null;
  const fields = Object.fromEntries(String(result.stdout ?? "").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  if (!fields.password) return null;
  return { scheme: "basic", username: fields.username ?? "", token: fields.password };
}

function defaultGitRunner(args, input) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  // An askpass program would open a dialog; the keychain alone answers here.
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  const result = childProcess.spawnSync("git", ["-c", "credential.interactive=false", ...args], { input, env, encoding: "utf8", timeout: CREDENTIAL_TIMEOUT_MS, windowsHide: true });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

// Runs in a child so the forge calls stay synchronous like the gh adapter.
const FETCH_SCRIPT = `
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { requests, timeout } = JSON.parse(raw);
const out = [];
for (const request of requests) {
  try {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body ?? undefined, signal: AbortSignal.timeout(timeout) });
    out.push({ status: response.status, text: await response.text() });
  } catch (error) {
    out.push({ status: 0, text: String(error?.cause?.message ?? error?.message ?? error) });
  }
}
process.stdout.write(JSON.stringify(out));
`;

/** Runs `requests` ([{ method, url, headers, body }]) in order; [{ status, text }]. */
export function defaultHttpRunner(requests) {
  const result = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", FETCH_SCRIPT], {
    input: JSON.stringify({ requests, timeout: TIMEOUT_MS }),
    encoding: "utf8",
    timeout: TIMEOUT_MS * Math.max(1, requests.length) + 5_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw Object.assign(new Error(`forge request failed: ${String(result.error?.message ?? result.stderr ?? "").trim().split("\n")[0] || `exit ${result.status}`}`), { code: "FORGE_COMMAND_FAILED" });
  return JSON.parse(result.stdout || "[]");
}

/**
 * A small REST client: `call(method, path, body)` and `all([[method, path, body]])`
 * return parsed JSON and throw FORGE_COMMAND_FAILED on any non-2xx answer,
 * naming the status and the forge's message, never the token.
 */
export function createRestClient({ label, apiBase, headers, http = defaultHttpRunner }) {
  function request([method, path, body]) {
    return {
      method,
      url: `${apiBase}${path}`,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers() },
      body: body ? JSON.stringify(body) : null,
    };
  }
  function parse(call, response) {
    if (!(response.status >= 200 && response.status < 300)) {
      let detail = String(response.text ?? "").trim();
      try {
        const json = JSON.parse(detail);
        detail = String(json?.message ?? json?.error ?? detail);
      } catch {
        // plain text answer
      }
      const error = new Error(`${label} ${call[0]} ${call[1].split("?")[0]} failed: ${response.status || "no answer"} ${detail.split("\n")[0].slice(0, 200)}`.trim());
      error.code = "FORGE_COMMAND_FAILED";
      error.status = response.status;
      throw error;
    }
    return response.text ? JSON.parse(response.text) : null;
  }
  function all(calls) {
    if (calls.length === 0) return [];
    const responses = http(calls.map(request));
    return calls.map((call, index) => parse(call, responses[index] ?? { status: 0, text: "" }));
  }
  return Object.freeze({ all, call: (method, path, body) => all([[method, path, body]])[0] });
}

/** Error for a forge with no token, saying where to put one. */
export function missingTokenError(label, webUrl, envNames) {
  const host = new URL(webUrl).host;
  const error = new Error(
    `${label}: no API token for ${host}. Set ${[...envNames, FORGE_TOKEN_ENV].join(" or ")}, or store it in the system keychain: ` +
      `printf 'protocol=https\\nhost=${host}\\nusername=token\\npassword=<token>\\n\\n' | git credential approve`,
  );
  error.code = "FORGE_TOKEN_MISSING";
  return error;
}
