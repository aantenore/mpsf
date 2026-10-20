import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  RTK_GAIN_CONTRACT,
  RTK_MINIMUM_VERSION,
  buildRtkGainArgv,
  collectRtkOptimizationTelemetry,
  detectRtk,
  normalizeRtkGainReport,
  parseRtkVersion,
  routeRtkCommand,
} from "../../lib/rtk-optimization-adapter.mjs";

function gainReport(overrides = {}) {
  return {
    summary: {
      total_commands: 17,
      total_input: 15_052,
      total_output: 4_094,
      total_saved: 10_977,
      avg_savings_pct: 72.9271857560457,
      total_time_ms: 256_724,
      avg_time_ms: 15_101,
      ...overrides,
    },
  };
}

function virtualWindowsFs(files, realpaths = {}) {
  const entries = new Map(
    Object.entries(files).map(([filePath, contents]) => [
      path.win32.normalize(filePath).toLowerCase(),
      String(contents),
    ]),
  );
  const canonicalPaths = new Map(
    Object.entries(realpaths).map(([filePath, canonicalPath]) => [
      path.win32.normalize(filePath).toLowerCase(),
      path.win32.normalize(canonicalPath),
    ]),
  );
  const lookup = (filePath) => {
    const key = path.win32.normalize(filePath).toLowerCase();
    if (!entries.has(key)) {
      const error = new Error(`ENOENT: ${filePath}`);
      error.code = "ENOENT";
      throw error;
    }
    return entries.get(key);
  };
  return {
    lstatSync(filePath) {
      const contents = lookup(filePath);
      return {
        size: Buffer.byteLength(contents),
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    },
    readFileSync(filePath) {
      return lookup(filePath);
    },
    realpathSync(filePath) {
      const normalized = path.win32.normalize(filePath);
      return canonicalPaths.get(normalized.toLowerCase()) ?? normalized;
    },
  };
}

test("RTK identity is strict and the adapter floor cannot be configured below 0.43.0", async () => {
  const supported = parseRtkVersion("rtk 0.43.0");
  assert.equal(supported.version, "0.43.0");
  assert.equal(supported.minimum_version, RTK_MINIMUM_VERSION);
  assert.equal(supported.supported, true);
  assert.equal(supported.gain_contract, RTK_GAIN_CONTRACT);

  assert.equal(parseRtkVersion("rtk v0.44.1+build.7").supported, true);
  assert.throws(
    () => parseRtkVersion("other-tool 0.43.0"),
    /expected 'rtk <semver>' identity/u,
  );
  assert.throws(
    () => parseRtkVersion("RTK ready: 0.43.0"),
    /expected 'rtk <semver>' identity/u,
  );

  const belowHardFloor = parseRtkVersion("rtk 0.42.99", "0.1.0");
  assert.equal(belowHardFloor.supported, false);
  assert.equal(belowHardFloor.gain_contract, null);
  assert.equal(parseRtkVersion("rtk 0.43.0-rc.1").supported, false);

  const detected = await detectRtk({
    minimum_version: "0.1.0",
    executor: async () => ({ stdout: "rtk 0.42.99\n", stderr: "" }),
  });
  assert.equal(detected.available, true);
  assert.equal(detected.supported, false);
});

test("gain counters are independent estimates rather than an input minus output identity", () => {
  const normalized = normalizeRtkGainReport(gainReport());
  assert.deepEqual(normalized, {
    total_commands: 17,
    estimated_input_tokens: 15_052,
    estimated_output_tokens: 4_094,
    estimated_tokens_avoided: 10_977,
    estimated_savings_percent: 72.9271857560457,
    total_time_ms: 256_724,
    average_time_ms: 15_101,
  });
  assert.notEqual(
    normalized.estimated_tokens_avoided,
    normalized.estimated_input_tokens - normalized.estimated_output_tokens,
  );

  const expandedFailureOutput = normalizeRtkGainReport(gainReport({
    total_commands: 1,
    total_input: 3,
    total_output: 10,
    total_saved: 0,
    avg_savings_pct: 0,
  }));
  assert.equal(expandedFailureOutput.estimated_input_tokens, 3);
  assert.equal(expandedFailureOutput.estimated_output_tokens, 10);
  assert.equal(expandedFailureOutput.estimated_tokens_avoided, 0);
});

test("telemetry collection uses a shell-free configured command and preserves source provenance", async () => {
  const calls = [];
  const report = gainReport();
  const executable = process.execPath;
  const prefixArgs = ["/opt/rtk/rtk-entry.mjs"];
  const executor = async (actualExecutable, argv, options) => {
    calls.push({ executable: actualExecutable, argv: [...argv], options });
    assert.equal(options.shell, false);
    assert.equal(options.cwd, "/workspace/shopfront");
    if (argv.at(-1) === "--version") {
      return { stdout: "rtk 0.43.0\n", stderr: "" };
    }
    return { stdout: JSON.stringify(report), stderr: "" };
  };

  assert.deepEqual(buildRtkGainArgv(), ["gain", "--project", "--format", "json"]);
  const telemetry = await collectRtkOptimizationTelemetry({
    executable,
    prefix_args: prefixArgs,
    executor,
    cwd: "/workspace/shopfront",
  });

  assert.equal(telemetry.status, "operational");
  assert.equal(telemetry.classification, "estimated");
  assert.equal(telemetry.enforcement, "advisory");
  assert.equal(telemetry.trusted_exact, false);
  assert.equal(telemetry.usage_credit_tokens, 0);
  assert.deepEqual(telemetry.source.command, [executable, ...prefixArgs, ...buildRtkGainArgv()]);
  assert.equal(telemetry.source.shell, false);
  assert.deepEqual(calls.map(({ argv }) => argv), [
    [...prefixArgs, "--version"],
    [...prefixArgs, ...buildRtkGainArgv()],
  ]);

  assert.match(telemetry.source.report_hash, /^[a-f0-9]{64}$/u);
});

test("automatic routing optimizes safe vectors, preserves machine output natively, and rejects other commands", () => {
  const routeLinux = (command, options = {}) => routeRtkCommand(command, {
    ...options,
    platform: "linux",
  });
  assert.deepEqual(routeLinux(["npm", "test"]), {
    mode: "rtk",
    profile: "test",
    command: ["npm", "test"],
    execution_command: ["npm", "test"],
    rtk_arguments: ["test", "npm", "test"],
    reason: "automatic_supported_route",
  });
  assert.deepEqual(routeLinux(["git", "status", "--short"]), {
    mode: "rtk",
    profile: "git",
    command: ["git", "status", "--short"],
    execution_command: ["git", "status", "--short"],
    rtk_arguments: ["git", "status", "--short"],
    reason: "automatic_supported_route",
  });
  const rg = routeLinux(["rg", "needle", "lib"]);
  assert.equal(rg.profile, "rg");
  assert.deepEqual(rg.rtk_arguments, ["rg", "--no-config", "needle", "lib"]);

  const gitDiff = routeLinux(["git", "diff", "README.md"]);
  assert.deepEqual(gitDiff.rtk_arguments, [
    "git", "diff", "--no-ext-diff", "--no-textconv", "README.md",
  ]);
  const gitLog = routeLinux(["git", "log", "--oneline"]);
  assert.deepEqual(gitLog.rtk_arguments, [
    "git", "log", "--no-ext-diff", "--no-textconv", "--oneline",
  ]);

  for (const command of [
    ["git", "log", "--format=%H"],
    ["rg", "needle", "--json"],
    ["rg", "needle", "-0l"],
    ["rg", "needle", "--vimgrep"],
  ]) {
    const route = routeLinux(command);
    assert.equal(route.mode, "native", JSON.stringify(command));
    assert.equal(route.profile, "native", JSON.stringify(command));
    assert.deepEqual(route.command, command);
    if (command[0] === "rg") assert.equal(route.execution_command[1], "--no-config");
    if (command[0] === "git") {
      assert.deepEqual(route.execution_command.slice(2, 4), ["--no-ext-diff", "--no-textconv"]);
    }
    assert.equal(route.rtk_arguments, null);
  }

  for (const command of [
    ["node", "--test", "test/unit/example.test.mjs"],
    ["pytest", "-q"],
    ["npm", "run", "test", "--", "--watch"],
    ["node", "--version"],
    ["git", "push", "origin", "main"],
    ["git", "diff", "--output=/tmp/unsafe.patch"],
    ["git", "diff", "--no-index", "--ext", "/dev/null", "README.md"],
    ["git", "diff", "--no-index", "--ext-d", "/dev/null", "README.md"],
    ["git", "diff", "--no-index", "--textc", "/dev/null", "README.md"],
    ["git", "show", "--show-signature"],
    ["git", "log", "--format=%G?"],
    ["git", "log", "--pretty", "%GS"],
    ["rg", "needle", "--pre", "printf unsafe"],
    ["rg", "needle", "--hostname-bin=printf"],
    ["rg", "needle", "--search-zip"],
    ["rg", "needle", "-zi"],
  ]) {
    assert.throws(() => routeLinux(command), /accepts only|gateway/iu, JSON.stringify(command));
  }

  assert.equal(routeLinux(["git", "diff", "--no-ext-diff", "--no-textconv"]).profile, "git");
  assert.equal(routeLinux(["rg", "needle", "--no-search-zip", "--no-pre"]).profile, "rg");

  const exact = routeLinux(["git", "show", "--format=raw"], { exact: true });
  assert.equal(exact.mode, "native");
  assert.equal(exact.reason, "exact_output_requested");
  assert.deepEqual(exact.execution_command, [
    "git", "show", "--no-ext-diff", "--no-textconv", "--format=raw",
  ]);

  const preserved = routeLinux(["rg", "  padded  ", ""], { exact: true });
  assert.deepEqual(preserved.command, ["rg", "  padded  ", ""]);
  assert.deepEqual(preserved.execution_command, ["rg", "--no-config", "  padded  ", ""]);
});

test("an explicitly requested unsafe test profile is rejected instead of invoking a shell-like wrapper", () => {
  const routeLinux = (command, options = {}) => routeRtkCommand(command, {
    ...options,
    platform: "linux",
  });
  assert.throws(
    () => routeLinux(["node", "--test", "test/unit/example.test.mjs"], { profile: "test" }),
    /accepts only fixed test commands/u,
  );
  assert.throws(
    () => routeLinux(["pytest", "-q"], { profile: "test" }),
    /accepts only fixed test commands/u,
  );
  assert.throws(
    () => routeLinux(["git", "commit", "-m", "message"], { profile: "git" }),
    /read-only/u,
  );
  assert.throws(
    () => routeLinux(["rg", "needle", "--json"], { profile: "rg" }),
    /machine-readable/u,
  );
  assert.throws(
    () => routeLinux(["/missing; printf INJECT >&2; /tmp/npm", "test"]),
    /bare command name/u,
  );
});

test("explicit executable suffixes normalize to the same safe RTK routes", () => {
  const npm = routeRtkCommand(["npm.cmd", "test"], { platform: "linux" });
  assert.equal(npm.mode, "rtk");
  assert.equal(npm.profile, "test");
  assert.deepEqual(npm.rtk_arguments, ["test", "npm.cmd", "test"]);

  const git = routeRtkCommand(["git.exe", "status", "--short"], { platform: "linux" });
  assert.equal(git.mode, "rtk");
  assert.equal(git.profile, "git");
  assert.deepEqual(git.rtk_arguments, ["git", "status", "--short"]);

  const rg = routeRtkCommand(["rg.com", "needle"], { platform: "linux" });
  assert.equal(rg.mode, "rtk");
  assert.equal(rg.profile, "rg");
  assert.deepEqual(rg.rtk_arguments, ["rg", "--no-config", "needle"]);
});

test("Windows shell shims without an explicit shell-free adapter fail closed", () => {
  for (const command of [
    ["git.cmd", "status", "--short"],
    ["rg.bat", "needle"],
    ["node.cmd", "--test"],
    ["pytest.bat"],
    ["bun.cmd", "test"],
  ]) {
    assert.throws(
      () => routeRtkCommand(command, { platform: "win32" }),
      /shell shim.*cannot execute safely/u,
      command.join(" "),
    );
  }
});

test("Windows gateway resolution is PATH-only and absolute for every supported executable", () => {
  const commandVectors = new Map([
    ["npm", ["npm", "test"]],
    ["pnpm", ["pnpm", "test"]],
    ["yarn", ["yarn", "test"]],
    ["bun", ["bun", "test"]],
    ["node", ["node", "--test"]],
    ["pytest", ["pytest"]],
    ["jest", ["jest"]],
    ["vitest", ["vitest"]],
    ["git", ["git", "status", "--short"]],
    ["rg", ["rg", "needle"]],
  ]);
  const files = {};
  for (const executableName of commandVectors.keys()) {
    files[`C:\\workspace\\${executableName}.com`] = "project shadow";
    files[`C:\\Tools\\${executableName}.exe`] = "host executable";
  }
  files["\\workspace\\git.exe"] = "root-relative project shadow";
  files["\\\\?\\C:\\workspace\\git.com"] = "extended-path project shadow";
  files["\\\\.\\C:\\workspace\\git.com"] = "device-path project shadow";
  files["\\\\localhost\\C$\\workspace\\git.com"] = "UNC project shadow";
  const fsModule = virtualWindowsFs(files);
  const options = {
    platform: "win32",
    cwd: "C:\\workspace",
    env: { PATH: "C:\\Tools" },
    node_executable: "C:\\Node\\node.exe",
    fs_module: fsModule,
  };

  for (const [executableName, command] of commandVectors) {
    const route = routeRtkCommand(command, options);
    assert.equal(
      route.execution_command[0],
      `C:\\Tools\\${executableName}.exe`,
      executableName,
    );
    if (["git", "rg"].includes(executableName)) {
      assert.equal(route.mode, "native", executableName);
      assert.equal(route.reason, "windows_absolute_executable_required", executableName);
      assert.equal(route.rtk_arguments, null, executableName);
    } else {
      assert.equal(route.mode, "rtk", executableName);
      assert.equal(route.profile, "test", executableName);
      assert.equal(route.rtk_arguments.includes(route.execution_command[0]), true, executableName);
    }
  }

  const explicitCom = routeRtkCommand(["git.com", "status"], {
    ...options,
    env: { PATH: "C:\\ComTools" },
    fs_module: virtualWindowsFs({
      "C:\\ComTools\\git.com": "host executable",
    }),
  });
  assert.deepEqual(explicitCom.execution_command, [
    "C:\\ComTools\\git.com",
    "status",
  ]);
  assert.equal(explicitCom.mode, "native");

  assert.throws(
    () => routeRtkCommand(["git", "status"], {
      ...options,
      env: { PATH: "" },
      fs_module: virtualWindowsFs({
        "C:\\workspace\\git.exe": "project shadow",
      }),
    }),
    /could not be resolved to a PATH executable/u,
  );

  for (const unsafePath of [
    ".;C:\\Tools",
    "bin;C:\\Tools",
    "C:bin;C:\\Tools",
    "\\workspace;C:\\Tools",
    "\\\\?\\C:\\workspace;C:\\Tools",
    "\\\\.\\C:\\workspace;C:\\Tools",
    "\\\\localhost\\C$\\workspace;C:\\Tools",
    "C:\\workspace;C:\\Tools",
    "C:\\workspace\\bin;C:\\Tools",
  ]) {
    const route = routeRtkCommand(["git", "status"], {
      ...options,
      env: { PATH: unsafePath },
    });
    assert.equal(route.execution_command[0], "C:\\Tools\\git.exe", unsafePath);
  }

  const junctionRoute = routeRtkCommand(["git", "status"], {
    ...options,
    env: { PATH: "C:\\ExternalAlias;C:\\Tools" },
    fs_module: virtualWindowsFs({
      "C:\\workspace\\bin\\git.exe": "project shadow through junction",
      "C:\\Tools\\git.exe": "host executable",
    }, {
      "C:\\ExternalAlias": "C:\\workspace\\bin",
    }),
  });
  assert.equal(junctionRoute.execution_command[0], "C:\\Tools\\git.exe");

  for (const [mappedPath, canonicalPath] of [
    ["Z:\\ProjectTools", "C:\\workspace\\bin"],
    ["Y:\\ProjectTools", "\\\\localhost\\C$\\workspace\\bin"],
  ]) {
    const mappedRoute = routeRtkCommand(["git", "status"], {
      ...options,
      env: { PATH: `${mappedPath};C:\\Tools` },
      fs_module: virtualWindowsFs({
        [`${canonicalPath}\\git.exe`]: "mapped project shadow",
        "C:\\Tools\\git.exe": "host executable",
      }, {
        [mappedPath]: canonicalPath,
      }),
    });
    assert.equal(mappedRoute.execution_command[0], "C:\\Tools\\git.exe", mappedPath);
  }

  assert.throws(
    () => routeRtkCommand(["git", "status"], {
      ...options,
      cwd: "\\\\server\\share\\workspace",
    }),
    /project root must exist and support canonical path resolution/u,
  );
});

test("Windows test shims resolve to shell-free Node launchers for RTK and native fallback", () => {
  const nodeExecutable = "C:\\Node\\node.exe";
  const npmLauncher = "C:\\Tools\\node_modules\\npm\\bin\\npm-cli.js";
  const fsModule = virtualWindowsFs({
    [nodeExecutable]: "",
    "C:\\Tools\\npm.cmd": [
      "@ECHO off",
      'SET "NODE_EXE=%~dp0\\node.exe"',
      'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
      '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
      "",
    ].join("\r\n"),
    [npmLauncher]: "",
  });
  const options = {
    platform: "win32",
    cwd: "C:\\workspace",
    env: { Path: "C:\\Tools" },
    node_executable: nodeExecutable,
    fs_module: fsModule,
  };

  const optimized = routeRtkCommand(["npm", "test"], options);
  assert.deepEqual(optimized.command, ["npm", "test"]);
  assert.deepEqual(optimized.execution_command, [
    nodeExecutable,
    npmLauncher,
    "test",
  ]);
  assert.deepEqual(optimized.rtk_arguments, [
    "test",
    nodeExecutable,
    npmLauncher,
    "test",
  ]);
  assert.equal(optimized.execution_command.some((entry) => /\.cmd$/iu.test(entry)), false);
  assert.equal(optimized.rtk_arguments.some((entry) => /\.cmd$/iu.test(entry)), false);

  const native = routeRtkCommand(["npm.cmd", "test"], {
    ...options,
    profile: "native",
  });
  assert.equal(native.mode, "native");
  assert.deepEqual(native.execution_command, [
    nodeExecutable,
    npmLauncher,
    "test",
  ]);
  assert.equal(native.rtk_arguments, null);
});

test("Windows routing prefers real executables and fails closed for opaque command shims", () => {
  const executableFs = virtualWindowsFs({
    "C:\\Tools\\pnpm.exe": "",
  });
  const executable = routeRtkCommand(["pnpm", "test"], {
    platform: "win32",
    cwd: "C:\\workspace",
    env: { PATH: "C:\\Tools" },
    node_executable: "C:\\Node\\node.exe",
    fs_module: executableFs,
  });
  assert.deepEqual(executable.execution_command, [
    "C:\\Tools\\pnpm.exe",
    "test",
  ]);
  assert.deepEqual(executable.rtk_arguments, [
    "test",
    "C:\\Tools\\pnpm.exe",
    "test",
  ]);

  const opaqueShimFs = virtualWindowsFs({
    "C:\\Node\\node.exe": "",
    "C:\\Node\\node_modules\\npm\\bin\\npm-cli.js": "",
    "C:\\Tools\\npm.cmd": "@ECHO off\r\nnpm %*\r\n",
  });
  assert.throws(
    () => routeRtkCommand(["npm", "test"], {
      platform: "win32",
      cwd: "C:\\workspace",
      env: { PATH: "C:\\Tools" },
      node_executable: "C:\\Node\\node.exe",
      fs_module: opaqueShimFs,
    }),
    /without a safe shell-free Node launcher/u,
  );
});

test("Windows PATH lookup is directory-major and honors only safe PATHEXT entries", () => {
  const nodeExecutable = "C:\\Node\\node.exe";
  const trustedLauncher = "C:\\Trusted\\npm-cli.js";
  const directoryMajorFs = virtualWindowsFs({
    [nodeExecutable]: "",
    "C:\\Trusted\\npm.cmd": [
      "@ECHO off",
      '"%~dp0\\node.exe" "%~dp0\\npm-cli.js" %*',
      "",
    ].join("\r\n"),
    [trustedLauncher]: "",
    "C:\\Later\\npm.exe": "",
  });
  const directoryMajor = routeRtkCommand(["npm", "test"], {
    platform: "win32",
    cwd: "C:\\workspace",
    env: {
      PATH: "C:\\Trusted;C:\\Later",
      PATHEXT: ".CMD;.EXE;.JS;.CMD",
    },
    node_executable: nodeExecutable,
    fs_module: directoryMajorFs,
  });
  assert.deepEqual(directoryMajor.execution_command, [
    nodeExecutable,
    trustedLauncher,
    "test",
  ]);

  const filteredFs = virtualWindowsFs({
    "C:\\Trusted\\npm.js": "process.exitCode = 99;",
    "C:\\Later\\npm.exe": "",
  });
  const filtered = routeRtkCommand(["npm", "test"], {
    platform: "win32",
    cwd: "C:\\workspace",
    env: {
      PATH: "C:\\Trusted;C:\\Later",
      PATHEXT: ".JS;EXE",
    },
    node_executable: nodeExecutable,
    fs_module: filteredFs,
  });
  assert.deepEqual(filtered.execution_command, [
    "C:\\Later\\npm.exe",
    "test",
  ]);
});

test("Windows generated Node shims require an actual recognized Node invocation", () => {
  const nodeExecutable = "C:\\Tools\\node.exe";
  const npmLauncher = "C:\\Tools\\node_modules\\npm\\bin\\npm-cli.js";
  const fsModule = virtualWindowsFs({
    [nodeExecutable]: "",
    [npmLauncher]: "",
    "C:\\Tools\\npm.cmd": [
      "@ECHO off",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      ")",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*',
      "",
    ].join("\r\n"),
  });
  const route = routeRtkCommand(["npm", "test"], {
    platform: "win32",
    cwd: "C:\\workspace",
    env: { PATH: "C:\\Tools", PATHEXT: ".CMD;.EXE" },
    node_executable: "C:\\Node\\node.exe",
    fs_module: fsModule,
  });
  assert.deepEqual(route.execution_command, [
    nodeExecutable,
    npmLauncher,
    "test",
  ]);
});

test("Windows npm shims with dynamic prefix selection use only the known installation launcher", () => {
  const nodeExecutable = "C:\\Node\\node.exe";
  const npmLauncher = "C:\\Node\\node_modules\\npm\\bin\\npm-cli.js";
  const fsModule = virtualWindowsFs({
    [nodeExecutable]: "",
    [npmLauncher]: "",
    "C:\\Node\\npm.cmd": [
      ":: Created by npm, please don't edit manually.",
      "@ECHO off",
      "SETLOCAL",
      'SET "NODE_EXE=%~dp0\\node.exe"',
      'IF NOT EXIST "%NODE_EXE%" (',
      '  SET "NODE_EXE=node"',
      ")",
      'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
      'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_CLI_JS%" prefix -g\') DO (',
      '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
      ")",
      'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
      '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
      ")",
      '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
      "",
    ].join("\r\n"),
  });
  const route = routeRtkCommand(["npm", "test"], {
    platform: "win32",
    cwd: "C:\\workspace",
    env: { PATH: "C:\\Node", PATHEXT: ".CMD;.EXE" },
    node_executable: nodeExecutable,
    fs_module: fsModule,
  });
  assert.deepEqual(route.execution_command, [
    nodeExecutable,
    npmLauncher,
    "test",
  ]);
});

test("Windows shim parsing rejects commented, echoed, or reassigned JavaScript references", () => {
  const nodeExecutable = "C:\\Node\\node.exe";
  const payload = "C:\\Tools\\payload.js";
  const opaqueSources = [
    '@REM "%~dp0\\payload.js" %*',
    '@echo "%~dp0\\payload.js" %*',
    ':: "%~dp0\\payload.js" %*',
    [
      '@SET "PAYLOAD=%~dp0\\payload.js"',
      '@ECHO "%PAYLOAD%" %*',
    ].join("\r\n"),
    [
      '@SET "NODE_EXE=node"',
      '@SET "PAYLOAD=%~dp0\\payload.js"',
      '@SET "PAYLOAD=ignored.txt"',
      '"%NODE_EXE%" "%PAYLOAD%" %*',
    ].join("\r\n"),
    [
      '@SET "NODE_EXE=node"',
      '@SET "NODE_EXE=not-node.exe"',
      '@SET "PAYLOAD=%~dp0\\payload.js"',
      '"%NODE_EXE%" "%PAYLOAD%" %*',
    ].join("\r\n"),
  ];
  for (const source of opaqueSources) {
    const fsModule = virtualWindowsFs({
      [nodeExecutable]: "",
      [payload]: "process.exitCode = 99;",
      "C:\\Tools\\npm.cmd": `${source}\r\n`,
    });
    assert.throws(
      () => routeRtkCommand(["npm", "test"], {
        platform: "win32",
        cwd: "C:\\workspace",
        env: { PATH: "C:\\Tools", PATHEXT: ".CMD" },
        node_executable: nodeExecutable,
        fs_module: fsModule,
      }),
      /without a safe shell-free Node launcher/u,
      source,
    );
  }
});

test("Windows npm routing can use the Node installation launcher without an implicit cwd lookup", () => {
  const nodeExecutable = "C:\\Node\\node.exe";
  const npmLauncher = "C:\\Node\\node_modules\\npm\\bin\\npm-cli.js";
  const fsModule = virtualWindowsFs({
    [nodeExecutable]: "",
    [npmLauncher]: "",
    "C:\\workspace\\npm.exe": "",
  });
  const route = routeRtkCommand(["npm", "test"], {
    platform: "win32",
    cwd: "C:\\workspace",
    env: { PATH: "" },
    node_executable: nodeExecutable,
    fs_module: fsModule,
  });
  assert.deepEqual(route.execution_command, [
    nodeExecutable,
    npmLauncher,
    "test",
  ]);
  assert.deepEqual(route.rtk_arguments, [
    "test",
    nodeExecutable,
    npmLauncher,
    "test",
  ]);
});
