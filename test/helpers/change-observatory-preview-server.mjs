import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildNowModel } from "../../lib/change-observatory/now-panel.mjs";
import { buildDemoModel, demoDependencies, demoNowInputs } from "./change-observatory-demo-data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../..");
const uiRoot = resolve(repositoryRoot, "ui/change-observatory");
const fixturePath = resolve(repositoryRoot, "test/fixtures/change-observatory/view-model.json");
// `--demo` serves the sample shop used for the README screenshots instead of the visual-QA fixture.
const demo = process.argv.includes("--demo");
const fixture = demo ? buildDemoModel() : JSON.parse(await readFile(fixturePath, "utf8"));
const knownSources = new Set(fixture.records.map((record) => record.path));

// Synthetic "Now" panel data: claims and chat messages relative to the
// current time, so relative ages read naturally. Sent messages stay in memory.
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const previewClaims = [
  { storyId: "ST-VISUAL-QA", state: "claimed", agent: "claude", holder: "visual-qa-mac", branch: "feature/ST-VISUAL-QA", claimedAt: minutesAgo(95), health: "active" },
  { storyId: "ST-NEXT", state: "parked", agent: "codex", holder: "visual-qa-pc", branch: "feature/ST-NEXT", claimedAt: minutesAgo(300) },
];
const previewMessages = [
  { id: "p1", from: "visual-qa-mac", kind: "info", text: "[auto] status: ST-VISUAL-QA (phase build)", time: minutesAgo(40), trust: "trusted" },
  { id: "p2", from: "visual-qa-pc", kind: "question", story: "ST-VISUAL-QA", text: "Who reviews the visual checks?", time: minutesAgo(25), trust: "trusted" },
  { id: "p3", from: "visual-qa-mac", kind: "answer", reply_to: "p2", text: "I will, after the build.", time: minutesAgo(20), trust: "trusted" },
  { id: "p4", from: "visual-qa-pc", kind: "propose", story: "ST-VISUAL-QA", reply_to: "p2", text: "Hand the review to the Mac\nmpsf-action: {\"action\":\"handoff\",\"story\":\"ST-VISUAL-QA\",\"to_agent\":\"visual-qa-mac\"}", time: minutesAgo(12), trust: "trusted" },
  { id: "d1", from: "visual-qa-pc", kind: "discuss", story: "ST-NEXT", text: "Who picks up ST-NEXT while it is parked?", time: minutesAgo(18), trust: "trusted" },
  { id: "d2", from: "visual-qa-linux", kind: "propose", story: "ST-NEXT", reply_to: "d1", text: "The Linux runner is free and can take it\nmpsf-action: {\"action\":\"claim\",\"story\":\"ST-NEXT\",\"agent\":\"visual-qa-linux\"}", time: minutesAgo(9), trust: "unverified" },
  { id: "p5", from: "visual-qa-linux", kind: "info", text: "Hello everyone, the Linux runner is back.", time: minutesAgo(8), trust: "unverified" },
  { id: "p6", from: "visual-qa-linux", kind: "offer", text: "[auto] free: can take work or help", time: minutesAgo(6), trust: "unverified" },
];
if (demo) {
  const inputs = demoNowInputs();
  previewClaims.splice(0, previewClaims.length, ...inputs.claims);
  previewMessages.splice(0, previewMessages.length, ...inputs.messages);
}
let previewSequence = 0;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function send(response, status, body, contentType) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Security-Policy": CSP,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

export function createPreviewServer() {
  return createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/api/v1/observatory") {
    send(response, 200, JSON.stringify(fixture), "application/json; charset=utf-8");
    return;
  }
  if (demo && url.pathname === "/api/v1/dependencies") {
    send(response, 200, JSON.stringify(demoDependencies()), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/v1/now") {
    const now = buildNowModel({ claims: previewClaims, messages: previewMessages, messaging: "on" });
    // Like the real server, name each story in progress.
    const titles = new Map(fixture.iterations.map((iteration) => [iteration.id, iteration.title]));
    now.work = now.work.map((item) => (titles.has(item.storyId) ? { ...item, title: titles.get(item.storyId) } : item));
    send(response, 200, JSON.stringify(now), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/v1/chat/send" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      send(response, 400, JSON.stringify({ error: { code: "invalid_json", message: "The request body is not a JSON object" } }), "application/json; charset=utf-8");
      return;
    }
    const id = `preview-${++previewSequence}`;
    previewMessages.push({
      id,
      from: demo ? "you" : "visual-qa-browser",
      kind: body.kind || "info",
      story: body.story ?? undefined,
      reply_to: body.replyTo ?? undefined,
      text: String(body.text ?? ""),
      time: new Date().toISOString(),
      trust: "trusted",
    });
    send(response, 200, JSON.stringify({ sent: true, id }), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/v1/source") {
    const path = url.searchParams.get("path");
    if (!knownSources.has(path)) {
      send(response, 404, JSON.stringify({ error: "Unknown visual-QA fixture source." }), "application/json; charset=utf-8");
      return;
    }
    send(
      response,
      200,
      JSON.stringify(
        {
          fixture: true,
          notice: "Synthetic record used only for Change Observatory browser QA.",
          path,
          source: fixture.records.find((record) => record.path === path),
        },
        null,
        2,
      ),
      "application/json; charset=utf-8",
    );
    return;
  }

  const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const target = resolve(uiRoot, relativePath);
  if (target !== uiRoot && !target.startsWith(`${uiRoot}${sep}`)) {
    send(response, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  try {
    const body = await readFile(target);
    send(response, 200, body, MIME[extname(target)] ?? "application/octet-stream");
  } catch {
    send(response, 404, "Not found", "text/plain; charset=utf-8");
  }
  });
}

export function parsePreviewPort(argv = []) {
  const portIndex = argv.indexOf("--port");
  const raw = portIndex === -1 ? "4173" : argv[portIndex + 1];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new TypeError("Preview port must be an integer between 0 and 65535");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Preview port must be an integer between 0 and 65535");
  }
  return port;
}

const isMain = !process.env.NODE_TEST_CONTEXT
  && process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createPreviewServer();
  server.listen(parsePreviewPort(process.argv.slice(2)), "127.0.0.1", () => {
    const address = server.address();
    process.stdout.write(`Change Observatory visual-QA fixture: http://127.0.0.1:${address.port}\n`);
  });
}
