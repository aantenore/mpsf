#!/usr/bin/env node
// Bridge left under the old plugin name: installs mpsf@<marketplace> and uninstalls agentic-sdlc@<marketplace>.
// Self-contained on purpose: the plugin cache holds only this folder. Never blocks the session (exit 0).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLD = "agentic-sdlc";
const NEW = "mpsf";
// <...>/plugins/cache/<marketplace>/agentic-sdlc/<version>; any other layout uses the default marketplace.
const marketplace = process.env.MPSF_MARKETPLACE
  || (path.basename(path.dirname(path.dirname(path.dirname(ROOT)))) === "cache" ? path.basename(path.dirname(path.dirname(ROOT))) : "aantenore");
const claude = process.env.AGENTIC_SDLC_AUTO_UPDATE_CLAUDE_BIN || process.env.MPSF_AUTO_UPDATE_CLAUDE_BIN || "claude";

function run(...args) {
  const result = spawnSync(claude, args, { encoding: "utf8", timeout: 50_000, windowsHide: true, shell: process.platform === "win32" });
  return { ok: !result.error && result.status === 0, text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function say(text) {
  process.stdout.write(`${JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } })}\n`);
}

const manual = `claude plugin marketplace update ${marketplace} && claude plugin install ${NEW}@${marketplace} && claude plugin uninstall ${OLD}@${marketplace}`;
try {
  const installed = run("plugin", "install", `${NEW}@${marketplace}`);
  const already = /already installed/iu.test(installed.text);
  if (!installed.ok && !already) {
    say(`agentic-sdlc is now mpsf (My Personal Software Factory), but installing ${NEW}@${marketplace} failed: ${installed.text.slice(0, 300)}. Run: ${manual}`);
  } else {
    const removed = run("plugin", "uninstall", `${OLD}@${marketplace}`);
    say(`agentic-sdlc is now mpsf (My Personal Software Factory): ${NEW}@${marketplace} installed${removed.ok ? ` and ${OLD}@${marketplace} removed` : `; remove the old entry with: claude plugin uninstall ${OLD}@${marketplace}`}. Run /reload-plugins (or restart Claude Code) to load it.`);
  }
} catch (error) {
  say(`agentic-sdlc is now mpsf (My Personal Software Factory). Run: ${manual}`);
}
process.exit(0);
