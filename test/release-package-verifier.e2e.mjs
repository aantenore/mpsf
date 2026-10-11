import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUILD_PROVENANCE_RELATIVE_PATH,
  computeBuildFingerprint,
  discoverDistributedFiles,
} from "../lib/build-identity.mjs";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

const pythonProbe = String.raw`
import importlib.util
import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()

def load_module(name, relative_path):
    module_path = root / relative_path
    specification = importlib.util.spec_from_file_location(name, module_path)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Could not load {module_path}")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module

v1 = load_module(
    "distribution_contract_installer_v1",
    "scripts/install-personal-marketplace.py",
)
v2 = load_module(
    "distribution_contract_installer_v2",
    "scripts/install-personal-marketplace-v2.py",
)
allowlist = v1._read_package_allowlist(root)
destination = root.parent / ".agentic-sdlc-distribution-contract-destination"
entries = v1._collect_allowlisted_source_files(root, destination, allowlist)
augmented, _provenance_payload, identity = v2._source_entries_with_provenance(
    root,
    entries,
)
print(json.dumps({
    "paths": [str(entry["path"]) for entry in entries],
    "augmented_paths": [str(entry["path"]) for entry in augmented],
    "fingerprint": v2._distribution_fingerprint(root, entries),
    "identity_fingerprint": identity["build_fingerprint"],
    "provenance_path": identity["provenance_file"],
}, separators=(",", ":"), sort_keys=True))
`;


function npmCliPath() {
  const candidates = [
    process.env.TEST_NPM_CLI,
    process.env.npm_execpath,
    process.platform === "win32"
      ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
      : path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error("npm-cli.js was not found; set TEST_NPM_CLI for this test");
}


function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
  });
  assert.equal(
    result.status,
    0,
    `${path.basename(executable)} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}


// Merged scenario: one real npm pack serves both
// "npm pack, build identity, and the reversible installer share one distribution surface"
// (formerly test/distribution-surface-contract.e2e.mjs) and
// "verifies a real npm pack through offline install and installed-package smoke tests".
test("verifies a real npm pack through offline install and installed-package smoke tests, and npm pack, build identity, and the reversible installer share one distribution surface", { timeout: 360_000 }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "release-package-e2e-"));
  try {
    // Transient Python bytecode exists only while the surface is discovered and packed,
    // so a concurrent pack elsewhere in the suite sees it as briefly as possible.
    const transientFixtureRoot = path.join(
      repoRoot,
      "scripts",
      `.distribution-contract-${process.pid}`,
    );
    const packDestination = path.join(temporary, "artifacts");
    const packCache = path.join(temporary, "pack-cache");
    mkdirSync(packDestination, { recursive: true });
    const npmCli = npmCliPath();
    let javascriptPaths;
    let javascriptFingerprint;
    let pythonResult;
    let pack;
    try {
      const transientDirectory = path.join(transientFixtureRoot, "__pycache__");
      const transientArtifacts = [
        path.join(transientDirectory, "fixture.pyc"),
        path.join(transientDirectory, "fixture.pyo"),
      ];
      mkdirSync(transientDirectory, { recursive: true });
      for (const artifactPath of transientArtifacts) {
        writeFileSync(artifactPath, "transient Python bytecode fixture\n");
      }

      javascriptPaths = discoverDistributedFiles(repoRoot)
        .map((entry) => entry.relative_path);
      javascriptFingerprint = computeBuildFingerprint(repoRoot);

      const pythonExecutable = process.env.PYTHON
        || (process.platform === "win32" ? "python" : "python3");
      const python = spawnSync(
        pythonExecutable,
        ["-c", pythonProbe, repoRoot],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
          maxBuffer: MAX_PROBE_OUTPUT_BYTES,
          shell: false,
        },
      );
      assert.equal(
        python.status,
        0,
        `Python distribution probe failed\nSTDOUT:\n${python.stdout}\nSTDERR:\n${python.stderr}`,
      );
      assert.equal(python.signal, null);
      pythonResult = JSON.parse(python.stdout);

      pack = run(process.execPath, [
        npmCli,
        "pack",
        "--json",
        "--ignore-scripts",
        "--offline",
        "--cache",
        packCache,
        "--pack-destination",
        packDestination,
      ], {
        env: {
          ...process.env,
          CI: "1",
          NO_UPDATE_NOTIFIER: "1",
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_offline: "true",
          npm_config_update_notifier: "false",
        },
      });
    } finally {
      rmSync(transientFixtureRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
    assert.equal(pack.signal, null);
    const packResult = JSON.parse(pack.stdout);
    assert.equal(packResult.length, 1);
    const packReport = packResult[0];
    const npmPaths = packReport.files
      .map((entry) => entry.path)
      .sort();
    assert.equal(
      npmPaths.some((filePath) =>
        filePath.includes("__pycache__")
        || filePath.endsWith(".pyc")
        || filePath.endsWith(".pyo")),
      false,
    );

    assert.deepEqual(pythonResult.paths, javascriptPaths);
    assert.deepEqual(npmPaths, javascriptPaths);
    assert.equal(pythonResult.fingerprint, javascriptFingerprint);
    assert.equal(pythonResult.identity_fingerprint, javascriptFingerprint);
    assert.equal(
      pythonResult.provenance_path,
      BUILD_PROVENANCE_RELATIVE_PATH,
    );
    assert.deepEqual(
      pythonResult.augmented_paths,
      [...javascriptPaths, BUILD_PROVENANCE_RELATIVE_PATH].sort(),
    );

    assert.equal(packReport.name, packageJson.name);
    assert.equal(packReport.version, packageJson.version);
    assert.ok(packReport.files.some((file) => file.path === "config/release-artifact-policy.json"));

    const artifact = path.join(packDestination, packReport.filename);
    const verifierArgs = [
      path.join(repoRoot, "scripts", "verify-release-package.mjs"),
      "--artifact",
      artifact,
      "--tag",
      `v${packageJson.version}`,
      "--policy",
      path.join(repoRoot, "config", "release-artifact-policy.json"),
      "--npm-cli",
      npmCli,
      "--json",
    ];
    if (process.env.PYTHON) verifierArgs.push("--python", process.env.PYTHON);
    const verified = run(process.execPath, verifierArgs);
    const report = JSON.parse(verified.stdout);
    assert.equal(report.status, "passed");
    assert.equal(report.package.name, packageJson.name);
    assert.equal(report.package.version, packageJson.version);
    assert.equal(report.package.tag, `v${packageJson.version}`);
    assert.equal(report.archive.file_count, packReport.files.length);
    assert.match(report.artifact.sha256, /^[0-9a-f]{64}$/u);
    assert.match(report.artifact.snapshot_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(report.smoke.npm_install, "passed");
    assert.equal(report.smoke.cli_help, "passed");
    assert.equal(report.smoke.doctor, "passed");
    assert.equal(report.smoke.installer_plan, "passed");
    assert.equal(report.smoke.installer_zero_write, true);
    assert.equal(report.smoke.installer_v2_plan, "passed");
    assert.equal(report.smoke.installer_v2_zero_write, true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
