#!/usr/bin/env node
// Copy the package.json version into every plugin manifest (host packagings, marketplace entries, legacy bridges).
// Runs as `npm run sync-version` and from scripts/release.mjs, so a bump never leaves a manifest behind.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];
const MARKETPLACE = ".claude-plugin/marketplace.json";
const LEGACY_DIR = "legacy";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function legacyManifests(root) {
  const dir = path.join(root, LEGACY_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => path.join(LEGACY_DIR, name, ".claude-plugin", "plugin.json"))
    .filter((file) => fs.existsSync(path.join(root, file)));
}

/** Set `version` (default: package.json's) in every manifest; returns the files that changed. */
export function syncManifestVersions(root = process.cwd(), version = readJson(path.join(root, "package.json")).version) {
  const changed = [];
  for (const file of [...MANIFESTS, ...legacyManifests(root)]) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    const manifest = readJson(full);
    if (manifest.version === version) continue;
    manifest.version = version;
    writeJson(full, manifest);
    changed.push(file);
  }
  const marketplaceFile = path.join(root, MARKETPLACE);
  if (fs.existsSync(marketplaceFile)) {
    const marketplace = readJson(marketplaceFile);
    const stale = (marketplace.plugins || []).filter((entry) => entry.version !== undefined && entry.version !== version);
    if (stale.length > 0) {
      for (const entry of stale) entry.version = version;
      writeJson(marketplaceFile, marketplace);
      changed.push(MARKETPLACE);
    }
  }
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = syncManifestVersions();
  console.log(changed.length > 0 ? `version synced: ${changed.join(", ")}` : "manifests already at the package version");
}
