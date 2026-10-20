import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Decisions of the plugin's host hooks. The same hooks/hooks.json runs in
 * both supported agent hosts; this module only interprets the hook payload,
 * so it holds no I/O. A hook is a second line of defence: the CLI refuses a
 * standing approval approved, or a story claim taken over, from inside an
 * agent session, records are hash-sealed, and a hook that fails lets the tool
 * call through. The shared refs under refs/agentic-sdlc/ (standing approvals
 * and story claims) are protected by one prefix rule.
 */

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu;
const CLI_INVOCATION = /(?:^|[\s/\\])(?:agentic-sdlc|mpsf)(?:\.mjs)?(?=\s|$)/u;
// The archives that command writes keep records that must never be deleted or rewritten by hand.
const ARCHIVE_TREE = /(?:^|[\s=:/\\])\.sdlc-archive(?=[\s\\/]|$)/iu;
// The acknowledgement of a merge made outside the plugin, kept next to the delivery's start and close.
const EXTERNAL_MERGE_RECORD = /\.sdlc[\\/]+autonomy[\\/]+executions[\\/]+[^\s\\/]+[\\/]+external-merge/iu;
// Any reference to the standing-approval or delivery usage records, including globs such as standing*.
const GLOBBED = "[^\\s/\\\\]*[?*[{][^\\s/\\\\]*";
const STANDING_RECORDS = new RegExp(
  `\\.sdlc[\\\\/]+(?:autonomy|${GLOBBED})[\\\\/]+(?:standing|metering|delegations|actions|${GLOBBED})`
  // The refs that keep revocations, used slots, and claims, stored by git itself (also per worktree).
  + `|\\.git[\\\\/]+(?:worktrees[\\\\/]+[^\\s\\\\/]+[\\\\/]+)?(?:logs[\\\\/]+)?refs[\\\\/]+(?:worktree[\\\\/]+)?agentic|\\.git[\\\\/]+packed-refs`,
  "iu",
);
// The whole record tree, its autonomy branch, the stories folder or one story as a target (restore it, delete it),
// under any path prefix ($PWD/.sdlc, ../p/.sdlc) and with a glob in place of a folder name (.sdlc/auto*).
const RECORD_TREE = new RegExp(
  `(?:^|[\\s=:\\\\/])(?:\\.[\\\\/])?\\.sdlc(?:[\\\\/]+(?:autonomy|${GLOBBED})|[\\\\/]+(?:stories|${GLOBBED})(?:[\\\\/]+[^\\s\\\\/]+)?)?[\\\\/]*(?=\\s|$)`,
  "iu",
);
// A story's claim: the push guard reads it to tell which branches belong to a claimed story.
const CLAIM_PATH = /\.sdlc[\\/]+([^\s\\/]+)[\\/]+[^\s\\/]+[\\/]+([^\s\\/;&|)<>]+)/giu;
const SHARED_REFS = /\brefs\/(?:worktree\/)?agentic-sdlc(?:-shared|-local)?\b/u;
// Refs only the CLI writes in this repository: what it has seen, and the secret-backed proof of its own claims.
const LOCAL_ONLY_REFS = /\brefs\/(?:agentic-sdlc-(?:local|shared)|worktree\/agentic-sdlc)\b/u;
const REF_REWRITING_GIT = new Set(["push", "update-ref", "replace", "branch", "tag", "reflog", "gc", "prune", "filter-branch", "filter-repo", "fetch", "clone"]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const WRITE_COMMANDS = /^(?:rm|rmdir|mv|cp|ln|tee|truncate|unlink|touch|chmod|chown|dd|install|rsync|shred|remove-item|set-content|add-content|out-file|move-item|copy-item|new-item|clear-content|del|erase|move|copy|ren|rename)$/iu;
const INLINE_INTERPRETER = /^(?:node|python3?|ruby|perl|deno|bun|pwsh|powershell)$/iu;
// Clearing or overriding the variables that mark an agent session, in sh or PowerShell.
const MARKER_NAMES = /^(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)=/u;
// "proc(?:ess)" keeps this pattern from reading as a use of the global process object.
const MARKER_CHANGE = /(?:proc(?:ess)\.env|os\.environ|unsetenv|putenv|\bENV\[|\$env)[^;\n]*\b(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b|\b(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b[^;\n]*\b(?:pop|unsetenv|putenv)\b|\bunset\b[^;&|\n]*\b(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b|\benv\b[^;&|\n]*(?:-u\s*|--unset[= ])(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b|\$env:(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\s*=|Env:[\\/]?(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b|SetEnvironmentVariable\s*\(\s*(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)/iu;
// Removing the export of a marker without assigning it: export -n, declare/typeset +x, or a local copy that shadows it.
const MARKER_UNEXPORT = /\b(?:export\s+(?:-\w*\s+)*-\w*n|(?:declare|typeset)\s+(?:[-+]\w*\s+)*\+\w*x|local|declare|typeset)\b[^;&|\n]*\b(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b/u;
// Running a command with an empty or reset environment, which drops the markers with everything else: env -i, env -,
// exec -c, sudo (env_reset), or an inline script that passes its own environment to a child process.
const ENV_CLEARING = /\benv\b[^;&|\n]*(?:\s-\w*i\b|\s-(?=\s)|--ignore-environment)|\bexec\s+-\w*c|\b(?:sudo|doas|su|runuser|systemd-run|setpriv)\b|\b(?:node|python3?|ruby|perl|deno|bun)\b[^;&|\n]*\s-(?:e|c|p)\b[^;&|\n]*\b(?:env|environ|execve|execle|spawn\w*|exec\w*)\b/u;
const WRITING_GIT = new Set(["rm", "mv", "checkout", "restore", "reset", "clean", "stash", "apply", "am", "cherry-pick", "revert", "switch", "merge", "rebase", "pull"]);

// Subcommands only a person runs. They count only when a command actually invokes the CLI with them,
// never when the words sit inside a quoted argument (a message that mentions them, for example).
const PERSON_ONLY = [
  { words: ["autonomy", "standing", "approve"], reason: standingApproveReason },
  { words: ["autonomy", "delivery", "reconcile"], reason: deliveryReconcileReason },
  { words: ["autonomy", "delivery", "evidence", "supersede"], reason: deliveryEvidenceSupersedeReason, delegable: true },
  { words: ["story", "abandon"], reason: storyAbandonReason, delegable: true },
  { words: ["story", "retire"], reason: storyRetireReason, delegable: true },
  // A delegation is granted and revoked only by the person; the agent never writes the authority it would use.
  { words: ["autonomy", "delegation", "grant"], reason: delegationReason },
  { words: ["autonomy", "delegation", "revoke"], reason: delegationReason },
  // The remote the merge and push guard trusts is the person's choice; the agent never picks it.
  { words: ["guard", "trust-remote"], reason: trustRemoteReason },
  // Moving the whole record tree aside is a person's decision; the plan (without --apply) stays open to agents.
  { words: ["project", "archive"], flag: "--apply", reason: projectArchiveReason },
];
const SHELL_INTERPRETERS = /^(?:sh|bash|zsh|dash|ksh|ash)(?:\.exe)?$/iu;
const CLI_WORD = /^(?:.*[\\/])?(?:agentic-sdlc|mpsf)(?:\.mjs)?$/u;
const MAX_NESTING = 4;

/** True when a path component, which may be a glob (`*`, `?`, `[...]`, `{a,b}`), can name `name`. */
function componentCovers(component, name) {
  if (!/[?*[{]/u.test(component)) return component.toLowerCase() === name;
  const source = component.replace(/[.+^$()|\\]/gu, "\\$&")
    .replace(/\*/gu, ".*").replace(/\?/gu, ".")
    .replace(/\{([^}]*)\}/gu, (_, list) => `(?:${list.split(",").join("|")})`);
  try {
    return new RegExp(`^${source}$`, "iu").test(name);
  } catch {
    return true;
  }
}

/** True when the text names a story's claim.json, directly or through a glob. */
function namesClaim(text) {
  return [...String(text).matchAll(CLAIM_PATH)].some((match) => componentCovers(match[1], "stories") && componentCovers(match[2], "claim.json"));
}

function deny(reason) {
  return { decision: "deny", reason };
}

/**
 * Joins line continuations and drops quoting and escapes, so quoting tricks do
 * not hide a command. Backslashes are either removed (shell escapes) or read as
 * path separators (Windows paths); both readings are checked.
 */
export function normalizeShellCommand(command, { backslashes = "remove" } = {}) {
  const joined = String(command || "")
    .replace(/\\\r?\n/gu, " ")
    .replace(/`\r?\n/gu, " ")
    .replace(/\$(?=['"])/gu, "")
    .replace(/["']/gu, "");
  return (backslashes === "remove" ? joined.replace(/\\/gu, "") : joined.replace(/\\/gu, "/"))
    .replace(/[ \t]+/gu, " ");
}

/** Simple command segments: split at ; && || | and newlines. */
function segments(command) {
  return command.split(/&&|\|\||[;|\n]/u).map((segment) => segment.trim()).filter(Boolean);
}

function words(segment) {
  return segment.split(/\s+/u).filter(Boolean);
}

/** The git subcommand of a segment, skipping global options, or null when it is not git. */
function gitSubcommand(segment) {
  const parts = words(segment);
  const start = parts.findIndex((word) => /(?:^|[\\/])git(?:\.exe)?$/iu.test(word));
  if (start === -1) return null;
  for (let index = start + 1; index < parts.length; index += 1) {
    const word = parts[index];
    if (GIT_OPTIONS_WITH_VALUE.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    return word.toLowerCase();
  }
  return null;
}

/** Output redirection targets of a segment, ignoring the null device and stream duplication. */
function redirectTargets(segment) {
  return [...segment.matchAll(/\d*>>?\s*(\S+)/gu)]
    .map((match) => match[1])
    .filter((target) => !/^(?:\/dev\/null|nul|\$null|&\d)$/iu.test(target));
}

/** True when a segment changes files other than through output redirection. */
function segmentWritesFiles(segment) {
  const parts = words(segment.replace(/\d*>>?\s*\S+/gu, " "));
  for (let index = 0; index < parts.length; index += 1) {
    const command = parts[index].split(/[\\/]/u).pop();
    if (WRITE_COMMANDS.test(command)) return true;
    if (/^(?:sed|perl)$/iu.test(command) && parts.slice(index + 1).some((word) => /^-\w*i/u.test(word))) return true;
    if (INLINE_INTERPRETER.test(command) && parts.slice(index + 1).some((word) => /^-(?:e|c|command)$/iu.test(word))
      && /unlink|rmSync|rmdir|remove|writeFile|appendFile|copyFile|rename|truncate|createWriteStream|open\([^)]*\b[wa]\b|os\.system|subprocess|shutil|spawn|exec|Set-Content|Remove-Item/iu.test(segment)) return true;
    if (command === "find" && parts.some((word) => /^-(?:delete|exec|execdir)$/u.test(word))) return true;
  }
  const subcommand = gitSubcommand(segment);
  // Unstaging only touches the index, never the files.
  if (subcommand === "restore" && /\s--staged\b/u.test(segment) && !/\s--worktree\b|\s-W\b/u.test(segment)) return false;
  return WRITING_GIT.has(subcommand);
}

/** Untracked records would be deleted by a forced clean or an untracked stash without a narrower path. */
function removesUntrackedRecords(segment) {
  const subcommand = gitSubcommand(segment);
  const parts = words(segment);
  const afterSubcommand = parts.slice(parts.findIndex((word) => word.toLowerCase() === subcommand) + 1);
  if (subcommand === "stash" && afterSubcommand[0] && /^(?:show|list|apply|pop|drop|branch|clear|create|store)$/u.test(afterSubcommand[0])) return false;
  // Paths after the options, with or without "--": the command is narrowed unless one of them covers the records.
  const pathspec = afterSubcommand.filter((word, index) => !word.startsWith("-") && !/^-e$|^--exclude$/u.test(afterSubcommand[index - 1] || ""));
  const coversRecords = (part) => /^(?::\/|\.\/?|\*+|\*\*.*|\.?\/?\.sdlc.*|:\/.*)$/u.test(part);
  const narrowed = pathspec.length > 0 && !pathspec.some(coversRecords);
  if (subcommand === "clean") {
    // Dry runs and ignored-files-only cleans never delete records.
    if (afterSubcommand.some((word) => /^(?:-\w*n\w*|--dry-run|-\w*X\w*)$/u.test(word))) return false;
    const excludesRecords = /\s(?:-e\s*|--exclude=)(?:\.\/)?\.sdlc\/?(?=\s|$)/u.test(segment);
    return !narrowed && !excludesRecords;
  }
  if (subcommand === "stash") return /\s(?:-u|-a|--include-untracked|--all)\b/u.test(segment) && !narrowed;
  return false;
}

/** Leading VAR=value assignments of a segment, plus export/set/env forms. */
function changesSessionMarker(segment) {
  const parts = words(segment);
  let index = 0;
  if (/^(?:export|set|declare|typeset|readonly|local)$/u.test(parts[0] || "")) index = 1;
  if (parts[0] === "env") {
    for (index = 1; index < parts.length && (parts[index].startsWith("-") || /^\w+=/u.test(parts[index])); index += 1) {
      if (MARKER_NAMES.test(parts[index])) return true;
    }
    return /\s(?:-u\s*|--unset[= ])(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b/u.test(segment);
  }
  for (; index < parts.length && /^\w+=/u.test(parts[index]); index += 1) {
    if (MARKER_NAMES.test(parts[index])) return true;
  }
  return false;
}

// A word the shell expands after the guard reads the command.
const HIDDEN_WORD = /[$`*?[{]/u;

function hiddenSubcommandReason(command) {
  return "The guard cannot read which mpsf subcommand this runs, because part of it is filled in by the shell (a variable, a substitution, a glob or xargs). "
    + `Write the subcommand out literally; person-only subcommands must be run by the user in their own terminal. Command: ${String(command).trim()}`;
}

function deliveryReconcileReason(command) {
  return "Only a person or CI can acknowledge a pull request merged outside the plugin, because it declares the story delivered without the plugin's own merge. "
    + `Explain what GitHub shows and ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
}

function deliveryEvidenceSupersedeReason(command) {
  return "Only a person can declare a recorded evidence file lost or overwritten, because it excuses a change to evidence the audit trail depends on. "
    + `Explain what happened to the file and ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
}

function storyAbandonReason(command) {
  return "Only a person can abandon a story, because it closes the story and cancels its workflow run for good. "
    + `Explain why the story is abandoned and ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
}

function storyRetireReason(command) {
  return "Only a person can retire a story, because it closes the story for good as superseded by its child stories. "
    + `Explain which child stories delivered its work and ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
}

function delegationReason(command) {
  return "Only the user can grant or revoke an approval delegation, because it lets the agent apply person-only approvals on their behalf. "
    + `Explain the scope, actions and expiry and ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
}

function trustRemoteReason(command) {
  return "Only the user chooses the remote URL the merge and push guard trusts for a repository, because the base branch on that remote decides whether the guard applies. "
    + `Ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
}

function projectArchiveReason(command) {
  return "Only a person or CI can archive a project's .sdlc, because it moves the project's permanent approvals and history aside. "
    + "Show the user the plan ('mpsf project archive') and ask them to run this exact command themselves, "
    + `in their own terminal: ${String(command).trim()}`;
}

const ARCHIVE_REASON = "Archives under .sdlc-archive hold the moved project records and their manifest, and are written only by 'mpsf project archive'. "
  + "They are never deleted, moved, or edited by hand.";

function standingApproveReason(command) {
  return "Only the user can approve a standing approval, because it lets later deliveries proceed without asking them. "
    + "Show the user its plain-language limits (autonomy standing explain) and ask them to run this exact command themselves, "
    + `in their own terminal: ${String(command).trim()}`;
}

const RECORDS_REASON = "Standing approval records under .sdlc/autonomy/standing, approval delegations under .sdlc/autonomy/delegations, delivery usage records under .sdlc/autonomy/metering, "
  + "delivery action receipts under .sdlc/autonomy/actions and story claims (.sdlc/stories/<id>/claim.json) "
  + "are append-only and written only by the agentic-sdlc CLI (autonomy standing propose, revoke, sync; budget usage record, "
  + "budget meter start, and budget meter record with --delivery). Use those commands instead of changing the files.";
const REFS_REASON = "The refs under refs/agentic-sdlc/ hold the state every copy of the project shares: standing approvals "
  + "(used deliveries and revocations) and story claims (who works on which story, and when each claim ended); "
  + "refs/agentic-sdlc-shared/, refs/agentic-sdlc-local/, and refs/worktree/agentic-sdlc/ hold what this repository has seen and proof of its own claims. "
  + "They are created only by the agentic-sdlc CLI (story claim, story release, autonomy standing) and are never pushed, deleted, or rewritten by hand; "
  + "mirror or prune pushes would delete them on the remote.";
const MARKER_REASON = "The variables that mark this agent session (CLAUDECODE, CODEX_THREAD_ID, CODEX_AGENT_NAME) tell agentic-sdlc "
  + "that the agent, not the user, is running a command. Clearing or overriding them is not allowed.";
// The project configuration and the keys that switch the merge and push guard.
const PROJECT_CONFIG = /(?:^|[\s=:/\\])\.sdlc[\\/]+config\.json(?=[\s"'\\/;&|)]|$)/iu;
const GUARD_POLICY_KEYS = /protect_base_branch|\bguard\b/u;
// A shell write cannot be compared key by key, so any host_policy change there counts.
const SHELL_GUARD_POLICY_KEYS = /protect_base_branch|host_policy|\bguard\b/u;
const GUARD_POLICY_REASON = "host_policy.guard in .sdlc/config.json decides whether the merge and push guard applies; an agent never changes it. "
  + "Only a person changes it, in a reviewed commit on the base branch.";
// The person's user-level list of trusted remotes (see trusted-remotes.mjs), at its default or any other path.
// The host settings files set the environment the hooks and the CLI read (AGENTIC_SDLC_ALLOW_UNGOVERNED_GIT,
// KEEP_GOING, MAIN_THREAD, TRUSTED_REMOTES_FILE) and can switch the hooks or the plugin off.
const HOST_SETTINGS = /(?:^|[^\w.-])\.(?:claude[\\/]+settings(?:\.local)?\.json|codex[\\/]+config\.toml)(?![\w.-])/iu;
const HOST_SETTINGS_PATH = /\/\.(?:claude\/settings(?:\.local)?\.json|codex\/config\.toml)$/u;
const HOST_SETTINGS_KEYS = /AGENTIC_SDLC_|MPSF_|CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME|disableAllHooks|enabledPlugins|"hooks"|^\s*\[hooks|hooks\s*=|shell_environment_policy|"env"|^\s*\[env|allowManagedHooksOnly/imu;
const HOST_SETTINGS_REASON = "The host settings files (.claude/settings.json, .claude/settings.local.json, .codex/config.toml) set the environment the mpsf hooks and CLI read "
  + "and can turn the hooks or the plugin off, so an agent never changes their env, hooks or plugin entries, and never rewrites them from the shell. "
  + "Tell the user which setting to change and let them edit the file themselves.";
const TRUSTED_REMOTES = /(?:^|[\s=:/\\])trusted-remotes\.json(?![\w.-])/iu;
const TRUSTED_REMOTES_REASON = "trusted-remotes.json records the remote URL the person trusts for each repository; the merge and push guard reads the base branch only from it. "
  + "Only 'mpsf guard trust-remote', run by the person in their own terminal, writes it.";
const CLEAN_REASON = "This would delete uncommitted project records under .sdlc (for example a standing approval's revocation or used deliveries). "
  + "Commit the records first, or limit the command to other paths (for example `git clean -fd -- src/` or `-e .sdlc`).";

function evaluateNormalizedShell(command, rawCommand) {
  if (!command.trim()) return null;
  if (MARKER_CHANGE.test(command)
    || MARKER_UNEXPORT.test(command)
    || segments(command).some(changesSessionMarker)
    || (ENV_CLEARING.test(command) && /agentic|mpsf/iu.test(command))) {
    return deny(MARKER_REASON);
  }
  let insideRecords = false;
  let insideAutonomy = false;
  for (const segment of segments(command)) {
    const cd = /^(?:cd|pushd|Set-Location|sl)\s+(\S+)/iu.exec(segment);
    if (cd) {
      const relative = !/^[\\/~]|^[A-Za-z]:/u.test(cd[1]);
      insideRecords = /\.sdlc/iu.test(cd[1]) || (insideRecords && relative);
      // Every file under .sdlc/autonomy is written by the CLI, so any write from inside it counts.
      insideAutonomy = (insideRecords && /autonomy|[?*[{]/iu.test(cd[1])) || (insideAutonomy && relative && !/^\.\.(?:[\\/]|$)/u.test(cd[1]));
      continue;
    }
    // A path ending in agentic-sdlc (a ref folder) is not a CLI run when the segment deletes or writes files.
    if (CLI_INVOCATION.test(segment) && !segmentWritesFiles(segment)) continue;
    if (["clean", "stash"].includes(gitSubcommand(segment))) {
      if (removesUntrackedRecords(segment)) return deny(CLEAN_REASON);
      continue;
    }
    const touches = (text) => STANDING_RECORDS.test(text)
      || EXTERNAL_MERGE_RECORD.test(text)
      || RECORD_TREE.test(` ${text} `)
      || namesClaim(text)
      || insideAutonomy
      || (insideRecords && /autonomy|standing|metering|delegations|actions|stories|claim|[?*[{]/iu.test(text));
    if (segmentWritesFiles(segment) && ARCHIVE_TREE.test(` ${segment}`)) return deny(ARCHIVE_REASON);
    if (redirectTargets(segment).some((target) => ARCHIVE_TREE.test(` ${target}`))) return deny(ARCHIVE_REASON);
    if ((segmentWritesFiles(segment) && HOST_SETTINGS.test(` ${segment}`)) || redirectTargets(segment).some((target) => HOST_SETTINGS.test(` ${target}`))) {
      return deny(HOST_SETTINGS_REASON);
    }
    if ((segmentWritesFiles(segment) && TRUSTED_REMOTES.test(` ${segment}`)) || redirectTargets(segment).some((target) => TRUSTED_REMOTES.test(` ${target}`))) {
      return deny(TRUSTED_REMOTES_REASON);
    }
    if (SHELL_GUARD_POLICY_KEYS.test(command)
      && ((segmentWritesFiles(segment) && PROJECT_CONFIG.test(` ${segment}`)) || redirectTargets(segment).some((target) => PROJECT_CONFIG.test(` ${target}`)))) {
      return deny(GUARD_POLICY_REASON);
    }
    if (segmentWritesFiles(segment) && touches(segment)) return deny(RECORDS_REASON);
    if (redirectTargets(segment).some(touches)) return deny(RECORDS_REASON);
  }
  // Refs written from a pipe or a file cannot be checked here, so a batch update-ref is refused with them.
  if (/\bupdate-ref\b[^;&|\n]*--stdin/u.test(command)
    && (/agentic/u.test(command) || /\|[^;&|\n]*\bupdate-ref\b[^;&|\n]*--stdin/u.test(command) || /\bupdate-ref\b[^;&|\n]*--stdin[^;&|\n]*</u.test(command))) {
    return deny(REFS_REASON);
  }
  const variableRefs = /\b\w+=\S*refs\/(?:worktree\/)?agentic/u.test(command);
  const rewritesSharedRefs = segments(command).some((segment) => {
    const subcommand = gitSubcommand(segment);
    if (!subcommand) return false;
    if (subcommand === "push" && /\s--(?:mirror|prune)\b/u.test(segment)) return true;
    // A ref name kept in a variable elsewhere in the command still counts.
    if (variableRefs && ["push", "update-ref"].includes(subcommand) && /\$/u.test(segment)) return true;
    if (!SHARED_REFS.test(segment) || !REF_REWRITING_GIT.has(subcommand)) return false;
    // Reading the refs stays allowed: a plain fetch to FETCH_HEAD, or listing branches and tags.
    // Fetching into the CLI's own seen or ownership refs would plant records there.
    if (subcommand === "fetch") return LOCAL_ONLY_REFS.test(segment) || /\s--(?:prune|force)\b|\s\+|\s-f\b/u.test(segment);
    if (subcommand === "clone") return /\s--mirror\b/u.test(segment);
    if (subcommand === "branch" || subcommand === "tag") return /\s-(?:d|D|f|m|M)\b|--delete|--force/u.test(segment);
    return true;
  });
  return rewritesSharedRefs ? deny(REFS_REASON) : null;
}

const HEREDOC_WORD_END = /[\s;&|<>()]/u;

/**
 * The here-document that starts at `index` (the first `<` of `<<`), read like the shell reads it:
 * an optional `-`, blanks, then one whole word up to an unquoted metacharacter; the delimiter is
 * the word with quotes and backslashes removed, and the body is quoted when any part of the word
 * is. Returns null when the word cannot be read exactly (empty, an unclosed quote, an expansion),
 * so the lines that follow are read as commands.
 */
function readHeredoc(text, index) {
  let at = index + 2;
  const stripTabs = text[at] === "-";
  if (stripTabs) at += 1;
  while (text[at] === " " || text[at] === "\t") at += 1;
  let delimiter = "";
  let quoted = false;
  const start = at;
  while (at < text.length && !HEREDOC_WORD_END.test(text[at])) {
    const char = text[at];
    if (char === "'") {
      const close = text.indexOf("'", at + 1);
      if (close === -1 || text.slice(at + 1, close).includes("\n")) return null;
      delimiter += text.slice(at + 1, close);
      quoted = true;
      at = close + 1;
    } else if (char === '"') {
      let close = at + 1;
      let inner = "";
      for (; close < text.length && text[close] !== '"'; close += 1) {
        const current = text[close];
        if (current === "\n" || current === "`" || current === "$") return null;
        if (current === "\\") {
          const next = text[close + 1];
          if (next === undefined || next === "\n") return null;
          inner += /[$`"\\]/u.test(next) ? next : `\\${next}`;
          close += 1;
        } else inner += current;
      }
      if (close >= text.length) return null;
      delimiter += inner;
      quoted = true;
      at = close + 1;
    } else if (char === "\\") {
      const next = text[at + 1];
      if (next === undefined || next === "\n") return null;
      delimiter += next;
      quoted = true;
      at += 2;
    } else if (char === "$" || char === "`") {
      return null;
    } else {
      delimiter += char;
      at += 1;
    }
  }
  if (at === start || delimiter === "") return null;
  return { delimiter, stripTabs, quoted, length: at - index };
}

/**
 * Skips the bodies of the pending here-documents starting at `start` and returns the index after
 * the last delimiter line (or the end of the text when one is never closed, as the shell does).
 * Substitutions in a body with an unquoted delimiter are kept as nested commands.
 */
function skipHeredocBodies(text, start, pending, nested) {
  let index = start;
  for (const { delimiter, stripTabs, quoted } of pending) {
    while (index < text.length) {
      const newline = text.indexOf("\n", index);
      const end = newline === -1 ? text.length : newline;
      const line = text.slice(index, end);
      index = end + 1;
      // A CRLF command keeps the carriage return on both the delimiter word and its closing line.
      if ((stripTabs ? line.replace(/^\t+/u, "") : line).replace(/\r$/u, "") === delimiter.replace(/\r$/u, "")) break;
      if (!quoted) for (const match of line.matchAll(/\$\(([^)]*)\)|`([^`]*)`/gu)) nested.push(match[1] ?? match[2]);
    }
  }
  return Math.min(index, text.length);
}

/**
 * Splits a shell command into simple commands, each a list of words with quotes
 * resolved. Command substitutions inside double quotes are returned as extra commands.
 */
export function parseShellCommands(command, { escapes = true } = {}) {
  const text = String(command || "");
  const commands = [];
  const nested = [];
  let words = [];
  let word = "";
  let started = false;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const heredocs = [];
  let arithmetic = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    // A `#` that starts a word comments out the rest of the line: its quotes and `<<` are not shell syntax.
    if (char === "#" && !started && (index === 0 || /[\s;&|()]/u.test(text[index - 1]))) {
      const newline = text.indexOf("\n", index);
      if (newline === -1) break;
      index = newline - 1;
      continue;
    }
    // `<<` is a here-document only outside quotes and arithmetic, where it is a shift.
    const heredoc = char === "<" && text[index + 1] === "<" && text[index + 2] !== "<" && arithmetic === 0 ? readHeredoc(text, index) : null;
    if (heredoc) {
      // The body is data for the command, not commands; an unquoted body still runs its substitutions.
      heredocs.push(heredoc);
      endWord();
      index += heredoc.length - 1;
    } else if (char === "(" && text[index + 1] === "(") {
      arithmetic += 1;
      endCommand();
      index += 1;
    } else if (char === ")" && text[index + 1] === ")" && arithmetic > 0) {
      arithmetic -= 1;
      endCommand();
      index += 1;
    } else if (char === "\n" && heredocs.length > 0) {
      endCommand();
      index = skipHeredocBodies(text, index + 1, heredocs.splice(0), nested) - 1;
    } else if (char === "\\" && escapes) {
      if (text[index + 1] === "\n") index += 1;
      else if (index + 1 < text.length) {
        word += text[index + 1];
        started = true;
        index += 1;
      }
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      word += text.slice(index + 1, end);
      started = true;
      index = end;
    } else if (char === '"') {
      started = true;
      let inner = "";
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) {
        if (text[index] === "\\" && escapes && index + 1 < text.length) {
          index += 1;
          if (text[index] !== "\n") inner += /[$`"\\]/u.test(text[index]) ? text[index] : `\\${text[index]}`;
        } else inner += text[index];
      }
      for (const match of inner.matchAll(/\$\(([^)]*)\)|`([^`]*)`/gu)) nested.push(match[1] ?? match[2]);
      word += inner;
    } else if (/\s/u.test(char) && char !== "\n") {
      endWord();
    } else if (/[\n;&|(){}`]/u.test(char)) {
      endCommand();
    } else {
      word += char;
      started = true;
    }
  }
  endCommand();
  return { commands, nested };
}

/** The agent applies a person's delegation; the CLI verifies it before anything is recorded. */
function appliesDelegation(args) {
  const source = args.indexOf("--approval-source");
  return source !== -1 && args[source + 1] === "delegated" && args.some((word) => word === "--delegation" || word.startsWith("--delegation="));
}

function containsSequence(words, sequence) {
  return words.some((_, start) => sequence.every((item, offset) => words[start + offset]?.toLowerCase() === item));
}

/** The person-only reason when one simple command, or a shell string it runs, invokes a person-only subcommand. */
function personOnlyInvocation(rawCommand, escapes, depth = 0) {
  if (depth > MAX_NESTING) return null;
  const { commands, nested } = parseShellCommands(rawCommand, { escapes });
  for (const inner of nested) {
    const found = personOnlyInvocation(inner, escapes, depth + 1);
    if (found) return found;
  }
  for (const argv of commands) {
    const cli = argv.findIndex((word) => CLI_WORD.test(word));
    if (cli !== -1) {
      const args = argv.slice(cli + 1);
      const match = PERSON_ONLY.find((item) => containsSequence(args, item.words)
        && (!item.flag || args.includes(item.flag))
        && !(item.delegable && appliesDelegation(args)));
      if (match) return match.reason(rawCommand);
      // A subcommand word the shell fills in later (a variable, a substitution, a glob, xargs) cannot be checked: refused.
      const firstOption = args.findIndex((word) => word.startsWith("-"));
      const positional = (firstOption === -1 ? args : args.slice(0, firstOption)).map((word) => word.toLowerCase());
      const leadsTo = (item, length) => item.words.slice(0, length).join(" ") === positional.slice(0, length).join(" ");
      const hidden = PERSON_ONLY.some((item) => item.words.some((_, at) => at < positional.length && HIDDEN_WORD.test(positional[at]) && leadsTo(item, at)));
      const fedByXargs = (argv[0] || "").split(/[\\/]/u).pop() === "xargs" && PERSON_ONLY.some((item) => positional.length < item.words.length && leadsTo(item, positional.length));
      if (hidden || fedByXargs) return hiddenSubcommandReason(rawCommand);
    } else if (argv.some((word) => HIDDEN_WORD.test(word)) && PERSON_ONLY.some((item) => containsSequence(argv, item.words))) {
      // The CLI itself named through a variable ($MPSF, "$BIN") with a person-only subcommand.
      return hiddenSubcommandReason(rawCommand);
    }
    // A shell run with -c, or eval, executes the string it is given.
    const program = (argv[0] || "").split(/[\\/]/u).pop();
    const script = SHELL_INTERPRETERS.test(program)
      ? argv[argv.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word)) + 1]
      : (program === "eval" ? argv.slice(1).join(" ") : null);
    if (script) {
      const found = personOnlyInvocation(script, escapes, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const MERGE_ESCAPE_VARIABLE = "AGENTIC_SDLC_ALLOW_UNGOVERNED_MERGE";
const GIT_ESCAPE_VARIABLE = "AGENTIC_SDLC_ALLOW_UNGOVERNED_GIT";
const PROTECTED_BASE_BRANCHES = new Set(["main", "master"]);
const COMMAND_WRAPPERS = new Set(["env", "command", "exec", "time", "nohup", "sudo", "rtk"]);
const GH_FLAGS_WITH_VALUE = new Set(["-R", "--repo", "-b", "--body", "-t", "--subject", "-F", "--body-file", "-A", "--author-email", "--match-head-commit"]);
const GH_API_MERGE_PATH = /\/pulls\/(\d+)\/merge(?:[/?#]|$)/u;
const PR_URL_NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/u;

/** The program of one simple command, and its arguments, after variable assignments and wrappers such as env. */
function programOf(argv) {
  let index = 0;
  while (index < argv.length) {
    const word = argv[index];
    if (/^[A-Za-z_]\w*=/u.test(word) || (index > 0 && word.startsWith("-")) || COMMAND_WRAPPERS.has(word.split(/[\\/]/u).pop())) index += 1;
    else break;
  }
  const name = (argv[index] || "").split(/[\\/]/u).pop().replace(/\.exe$/iu, "");
  return { name, args: argv.slice(index + 1), program: argv[index] || "" };
}

function pullRequestReference(value) {
  const text = String(value ?? "");
  const url = PR_URL_NUMBER.exec(text);
  if (url) return { number: Number(url[1]), branch: null };
  if (/^\d+$/u.test(text)) return { number: Number(text), branch: null };
  return text ? { number: null, branch: text.replace(/^[^:]+:/u, "") } : { number: null, branch: null };
}

/** The directories named by `git -C <dir>` options before the subcommand, in order (empty when none). */
function gitDirectories(args) {
  const dirs = [];
  for (let index = 0; index < args.length && args[index] !== "push"; index += 1) {
    if (args[index] === "-C" && args[index + 1] !== undefined) dirs.push(args[index + 1]);
    if (GIT_OPTIONS_WITH_VALUE.has(args[index])) index += 1;
  }
  return dirs;
}

function pushedBranches(args) {
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    if (["-o", "--push-option", "--repo", "--receive-pack", "--exec"].includes(args[index])) index += 1;
    else if (!args[index].startsWith("-")) positional.push(args[index]);
  }
  return positional.slice(1).map((spec) => {
    const target = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
    return target.replace(/^\+/u, "").replace(/^refs\/heads\//u, "");
  });
}

// Built-in subcommands: git and gh never let an alias shadow them, so only other names are looked up as aliases.
const GIT_BUILTINS = new Set(("add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout "
  + "checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential describe diff diff-files diff-index "
  + "diff-tree difftool fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook "
  + "index-pack init instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree "
  + "mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog "
  + "remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-index show-ref "
  + "sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info var "
  + "verify-commit verify-pack verify-tag version whatchanged worktree write-tree lfs").split(" "));
const GH_BUILTINS = new Set(("agent-task alias api attestation auth browse cache co codespace completion config copilot extension gist gpg-key help issue label "
  + "org pr preview project release repo ruleset run search secret ssh-key status variable version workflow").split(" "));
const XARGS_OPTIONS_WITH_VALUE = new Set(["-I", "-n", "-L", "-P", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace", "--max-lines", "--eof"]);
// GitHub API calls that merge a pull request or move a branch without one.
const GH_API_WRITE_PATH = /\/pulls\/[^/\s]+\/merge(?:[/?#\s]|$)|\/merges(?:[/?#\s]|$)|\/git\/refs(?:[/?#\s]|$)|\/contents\/|\/branches\/[^/\s]+\/rename/u;
const GRAPHQL_WRITE = /\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch|updateRefs?|createCommitOnBranch|createRef|deleteRef)\b/u;
// A word the shell fills in after the guard reads the command.
const UNREADABLE = /[$`*?[{]/u;

function unreadable(kind, extra = {}) {
  return { kind, number: null, branch: null, direct: true, unresolved: true, ...extra };
}

/** Variables assigned in the command itself (NAME=value words), so a refspec kept in one can still be read. */
function assignedVariables(commands) {
  const variables = new Map();
  for (const argv of commands) {
    for (const word of argv) {
      const assignment = /^([A-Za-z_]\w*)=(.*)$/su.exec(word);
      if (!assignment) break;
      variables.set(assignment[1], assignment[2]);
    }
  }
  return variables;
}

function expandVariables(word, variables) {
  return word.replace(/\$\{?([A-Za-z_]\w*)\}?/gu, (match, name) => (variables.has(name) && !UNREADABLE.test(variables.get(name)) ? variables.get(name) : match));
}

function shellQuote(word) {
  return `'${String(word).split("'").join("'\\''")}'`;
}

/** The HTTP method of a gh api or curl call: the explicit one, else POST when it sends a body, else GET. */
function httpMethod(args, bodyFlags) {
  for (let index = 0; index < args.length; index += 1) {
    const explicit = /^(?:-X|--method|--request)(?:=(.+))?$/iu.exec(args[index]) || /^-X(.+)$/u.exec(args[index]);
    if (explicit) return String(explicit[1] ?? args[index + 1] ?? "").toUpperCase();
  }
  return args.some((word) => bodyFlags.test(word)) ? "POST" : "GET";
}

function ghAttempts(args, depth, context, variables, viaXargs) {
  const attempts = [];
  const sub = args.find((word) => !word.startsWith("-")) || "";
  if (viaXargs && (!sub || ["pr", "api"].includes(sub))) return [unreadable("gh with arguments filled in by xargs")];
  if (UNREADABLE.test(sub)) return [unreadable("gh with a subcommand the guard cannot read")];
  if (containsSequence(args, ["pr", "merge"])) {
    const rest = args.slice(args.findIndex((word, at) => word === "merge" && args[at - 1] === "pr") + 1);
    const positional = rest.find((word, at) => !word.startsWith("-") && !GH_FLAGS_WITH_VALUE.has(rest[at - 1]));
    const reference = positional === undefined ? positional : expandVariables(positional, variables);
    attempts.push(reference !== undefined && UNREADABLE.test(reference) ? unreadable("gh pr merge") : { kind: "gh pr merge", ...pullRequestReference(reference) });
  } else if (sub === "api") {
    const method = httpMethod(args, /^(?:-f|-F|--field|--raw-field|--input)$/u);
    const text = args.join(" ");
    const mergePath = args.map((word) => GH_API_MERGE_PATH.exec(word)).find(Boolean);
    if (args.includes("graphql")) {
      // A query read from a file cannot be checked.
      if (GRAPHQL_WRITE.test(text) || args.some((word) => /^query=@|^@/u.test(word)) || args.includes("--input")) attempts.push(unreadable("gh api graphql mutation"));
    } else if (mergePath && method === "PUT") {
      attempts.push({ kind: "gh api merge", number: Number(mergePath[1]), branch: null });
    } else if (method !== "GET" && method !== "HEAD") {
      const target = args.slice(args.indexOf("api") + 1).find((word) => !word.startsWith("-")) || "";
      if (GH_API_WRITE_PATH.test(text) || UNREADABLE.test(target)) attempts.push(unreadable("gh api write to a merge or branch endpoint"));
    }
  } else if (sub === "alias" && /^(?:set|import)$/u.test(args[args.indexOf("alias") + 1] || "")) {
    // An alias is checked when it is run only if the hook can resolve it; one that merges is refused when it is defined.
    const definition = args.slice(args.indexOf("alias") + 2).join(" ");
    if (args[args.indexOf("alias") + 1] === "import" || /\bmerge\b|\bapi\b|\bpush\b|(?:^|\s)!/u.test(definition)) attempts.push(unreadable("a gh alias that can merge"));
  } else if (sub && !GH_BUILTINS.has(sub) && typeof context.resolveGhAlias === "function") {
    const expansion = context.resolveGhAlias(sub);
    const rest = args.slice(args.indexOf(sub) + 1);
    if (expansion?.startsWith("!")) attempts.push(...ungovernedMergeAttempts(`${expansion.slice(1)} ${rest.map(shellQuote).join(" ")}`, depth + 1, context));
    else if (expansion) attempts.push(...argvAttempts(["gh", ...words(expansion), ...rest], depth + 1, context, variables, viaXargs));
  }
  return attempts;
}

function gitAttempts(args, depth, context, variables, viaXargs, steersConfig) {
  const inlineAliases = new Map();
  let index = 0;
  for (; index < args.length; index += 1) {
    const word = args[index];
    if (GIT_OPTIONS_WITH_VALUE.has(word)) {
      const alias = word === "-c" ? /^alias\.([^=]+)=(.*)$/isu.exec(args[index + 1] || "") : null;
      if (alias) inlineAliases.set(alias[1].toLowerCase(), alias[2]);
      index += 1;
    } else if (!word.startsWith("-")) break;
  }
  const sub = args[index] || "";
  const before = args.slice(0, index);
  const rest = args.slice(index + 1);
  if (!sub) return viaXargs ? [unreadable("git with its subcommand filled in by xargs")] : [];
  if (UNREADABLE.test(sub)) return [unreadable("git with a subcommand the guard cannot read")];
  const lower = sub.toLowerCase();
  if (lower === "push") return pushAttempts(args, rest.map((word) => expandVariables(word, variables)), viaXargs);
  if (GIT_BUILTINS.has(lower)) return [];
  const expansion = inlineAliases.get(lower)
    ?? (typeof context.resolveGitAlias === "function" ? context.resolveGitAlias(sub, gitDirectories(args)) : null);
  if (expansion?.startsWith("!")) return ungovernedMergeAttempts(`${expansion.slice(1)} ${rest.map(shellQuote).join(" ")}`, depth + 1, context);
  if (expansion) return argvAttempts(["git", ...before, ...words(expansion), ...rest], depth + 1, context, variables, viaXargs);
  // Configuration passed through the environment can define an alias the guard does not see.
  return steersConfig ? [unreadable("git with configuration from the environment")] : [];
}

function pushAttempts(args, push, viaXargs) {
  if (push.includes("--delete")) return [];
  const dirs = gitDirectories(args);
  const branches = pushedBranches(push);
  const attempts = [{ kind: "git push", storyPush: true, branches, dirs }];
  const base = branches.find((branch) => PROTECTED_BASE_BRANCHES.has(branch));
  if (base) attempts.push({ kind: `git push to ${base}`, number: null, branch: null, direct: true, base, dirs });
  // Every branch at once, a refspec the shell fills in, or one xargs appends may include the base branch.
  else if (viaXargs || push.some((word) => /^--(?:all|mirror|branches)$/u.test(word)) || branches.some((branch) => UNREADABLE.test(branch))) {
    attempts.push(unreadable("git push to a branch the guard cannot read", { dirs }));
  // A push with no refspec sends the current branch; the checker resolves it.
  } else if (branches.length === 0) attempts.push({ kind: "git push", number: null, branch: null, direct: true, currentBranchOnly: true, dirs });
  return attempts;
}

/** Unreadable merge or push attempts in interpreter code: any git push, gh merge or GitHub write it names. */
function inlineCodeAttempts(code, source) {
  const attempts = [];
  if (/\bgit\b/u.test(code) && /\bpush\b/u.test(code)) attempts.push(unreadable(`git push from ${source}`));
  if ((/\bgh\b/u.test(code) && /\bmerge\b/u.test(code)) || GRAPHQL_WRITE.test(code) || GH_API_WRITE_PATH.test(code)) attempts.push(unreadable(`a merge from ${source}`));
  return attempts;
}

function argvAttempts(argv, depth, context, variables, viaXargs = false) {
  if (depth > MAX_NESTING) return [];
  const { name, args } = programOf(argv);
  if (SHELL_INTERPRETERS.test(name) || name === "eval") {
    const script = name === "eval" ? args.join(" ") : args[args.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word)) + 1];
    return script ? ungovernedMergeAttempts(script, depth + 1, context) : [];
  }
  if (name === "xargs") {
    let index = 0;
    while (index < args.length && args[index].startsWith("-")) index += XARGS_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1;
    return index < args.length ? argvAttempts(args.slice(index), depth + 1, context, variables, true) : [];
  }
  if (name === "gh") return ghAttempts(args, depth, context, variables, viaXargs);
  if (name === "git") return gitAttempts(args, depth, context, variables, viaXargs, argv.some((word) => /^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)=/u.test(word)));
  if (INLINE_INTERPRETER.test(name)) {
    // A script the interpreter runs from the command line cannot be parsed; one that pushes or merges is refused.
    const flag = args.findIndex((word) => /^-(?:e|c|p|command|-eval)$/iu.test(word));
    return inlineCodeAttempts(flag === -1 ? "" : args.slice(flag + 1).join(" "), "an inline script");
  }
  if (/^(?:curl|wget|http|https|xh)$/u.test(name)) {
    const text = args.join(" ");
    const writes = httpMethod(args, /^(?:-d|--data(?:-\w+)?|-F|--form|--json|-T|--upload-file|--post-data|--post-file)(?:=|$)/u) !== "GET";
    if (/github|\/api\/v3/iu.test(text) && (GRAPHQL_WRITE.test(text) || (writes && GH_API_WRITE_PATH.test(text)))) return [unreadable("a direct GitHub API call that merges or moves a branch")];
  }
  return [];
}

/**
 * The merges one command would perform outside the governed action: gh pr merge, a merge or branch
 * write through the API, and a git push to the protected base branch, also through a git or gh alias
 * (resolved with context.resolveGitAlias / resolveGhAlias), xargs, or an inline script. A form whose
 * target the guard cannot read is returned as an `unresolved` attempt, which no authorization covers.
 * Quoted mentions are not commands.
 */
export function ungovernedMergeAttempts(rawCommand, depth = 0, context = {}) {
  if (depth > MAX_NESTING) return [];
  const attempts = [];
  for (const escapes of [true, false]) {
    const { commands, nested } = parseShellCommands(rawCommand, { escapes });
    const variables = assignedVariables(commands);
    for (const inner of nested) attempts.push(...ungovernedMergeAttempts(inner, depth + 1, context));
    for (const argv of commands) attempts.push(...argvAttempts(argv, depth, context, variables));
  }
  return attempts;
}

function ungovernedMergeReason(attempt) {
  if (attempt.unresolved) {
    return `The guard cannot read what this command targets (${attempt.kind}), so it is treated as a merge or a push to the protected base branch. `
      + "Write the git or gh subcommand, the branch and the pull request out literally, without aliases, variables, xargs or inline scripts. "
      + "Merges and base-branch pushes go through 'mpsf autonomy delivery action --action pull_request.merge ...'. "
      + `A person can allow it deliberately by setting ${MERGE_ESCAPE_VARIABLE}=1 in their own environment; an agent must never set it.`;
  }
  const target = attempt.kind.startsWith("git push")
    ? `${attempt.kind} sends commits to the protected base branch without a reviewed pull request`
    : `${attempt.kind} merges a pull request outside the governed action`;
  return `${target}, and no approved, not yet completed 'pull_request.merge' authorization covers it. `
    + "Run 'mpsf autonomy delivery action --action pull_request.merge ...' first and launch gh pr merge only after the authorization is granted. "
    + "If the governed action was refused, the merge must not happen: report it to the user instead. "
    + `A person can allow an ungoverned merge deliberately by setting ${MERGE_ESCAPE_VARIABLE}=1 in their own environment; an agent must never set it.`;
}

function humanEscape(options) {
  return options?.env?.[MERGE_ESCAPE_VARIABLE] === "1" || options?.env?.[GIT_ESCAPE_VARIABLE] === "1";
}

/** True when the repository the attempt acts on is one the person opted out of the guard (see merge-authorization.mjs). */
function repoOptedOut(options, attempt) {
  return typeof options?.isUngovernedRepo === "function" && options.isUngovernedRepo(attempt) === true;
}

function aliasContext(options) {
  return { resolveGitAlias: options?.resolveGitAlias, resolveGhAlias: options?.resolveGhAlias };
}

function evaluateUngovernedMerge(rawCommand, options) {
  if (typeof options?.isMergeAuthorized !== "function") return null;
  const attempts = ungovernedMergeAttempts(rawCommand, 0, aliasContext(options));
  if (attempts.length === 0) return null;
  if (humanEscape(options)) return null;
  const unauthorized = attempts.find((attempt) => !attempt.storyPush && !repoOptedOut(options, attempt) && !options.isMergeAuthorized(attempt));
  return unauthorized ? deny(ungovernedMergeReason(unauthorized)) : null;
}

function storyPushReason(branches) {
  return `git push to ${branches.length ? branches.join(", ") : "the current branch"} sends a story branch outside the governed action, and no approved, not yet completed 'git.push' authorization covers it. `
    + "Run 'mpsf autonomy delivery action --action git.push ...' first and push only after the authorization is granted. "
    + "If the governed action was refused or failed, the push must not happen: report it to the user instead. "
    + `A person can allow an ungoverned push deliberately by setting ${GIT_ESCAPE_VARIABLE}=1 in their own environment; an agent must never set it.`;
}

function evaluateStoryPush(rawCommand, options) {
  if (typeof options?.isStoryPushAuthorized !== "function" || humanEscape(options)) return null;
  const blocked = ungovernedMergeAttempts(rawCommand, 0, aliasContext(options)).find((attempt) => attempt.storyPush && !repoOptedOut(options, attempt) && !options.isStoryPushAuthorized(attempt));
  return blocked ? deny(storyPushReason(blocked.branches)) : null;
}

// Files git keeps its own state in: written only by git commands, never by hand.
const GIT_INTERNAL = /(?:^|[\\/=:])\.git[\\/]+(?:worktrees[\\/]+[^\\/\s]+[\\/]+)?(?:(?:MERGE_HEAD|MERGE_MSG|MERGE_MODE|HEAD|ORIG_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|AUTO_MERGE|packed-refs|index)(?![\w.-])|refs[\\/])|(?:^|[\\/=:])(?:MERGE_HEAD|MERGE_MSG|MERGE_MODE)$/iu;
const REDIRECT_WORD = /^\d*>>?\|?(.*)$/u;

function gitInternalReason(target) {
  return `Writing ${target} by hand fakes git's own state (an agent did this to fake a merge). Use the git command that owns it (git merge, git merge --abort, git checkout, git update-ref through the governed flow) `
    + `and the governed delivery actions. A person can allow it deliberately by setting ${GIT_ESCAPE_VARIABLE}=1 in their own environment; an agent must never set it.`;
}

/** The git-internal file one command would write by redirection or a write command, or null. */
function gitInternalWrite(rawCommand, depth = 0) {
  if (depth > MAX_NESTING) return null;
  for (const escapes of [true, false]) {
    const { commands, nested } = parseShellCommands(rawCommand, { escapes });
    for (const inner of nested) {
      const found = gitInternalWrite(inner, depth + 1);
      if (found) return found;
    }
    for (const argv of commands) {
      const { name, args } = programOf(argv);
      for (let index = 0; index < argv.length; index += 1) {
        const redirect = REDIRECT_WORD.exec(argv[index]);
        if (!redirect || /^\d*>&/u.test(argv[index])) continue;
        const target = redirect[1] || argv[index + 1] || "";
        if (GIT_INTERNAL.test(target)) return target;
      }
      if (SHELL_INTERPRETERS.test(name) || name === "eval") {
        const script = name === "eval" ? args.join(" ") : args[args.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word)) + 1];
        const found = script ? gitInternalWrite(script, depth + 1) : null;
        if (found) return found;
      } else if (name !== "git" && (WRITE_COMMANDS.test(name) || (/^(?:sed|perl)$/iu.test(name) && args.some((word) => /^-\w*i/u.test(word))))) {
        const hit = args.find((word) => GIT_INTERNAL.test(word));
        if (hit) return hit;
      }
    }
  }
  return null;
}

function evaluateGitInternalWrite(rawCommand, options) {
  if (humanEscape(options)) return null;
  const target = gitInternalWrite(rawCommand);
  return target ? deny(gitInternalReason(target)) : null;
}

// Script files a command runs: the guard reads the ones the agent may have written and checks them as if typed.
const SCRIPT_SHELL_EXTENSION = /\.(?:sh|bash|zsh|ksh|dash)$/iu;
const SCRIPT_SHEBANG_SHELL = /^#![^\n]*\b(?:sh|bash|zsh|dash|ksh|ash)\b/u;
const INTERPRETER_OPTIONS_WITH_VALUE = /^(?:-r|--require|--import|--loader|--experimental-loader|-W|-X|-I|--input-type|-File|-f)$/iu;
const SCRIPT_RECORD_PATHS = /\.sdlc[\\/]+autonomy\b|claim\.json|trusted-remotes\.json|settings(?:\.local)?\.json|config\.toml|\.sdlc-archive|refs\/(?:worktree\/)?agentic-sdlc/iu;
const SCRIPT_WRITES = /\b(?:write\w*|append\w*|unlink\w*|rm\w*|rename\w*|copy\w*|cp\w*|truncate\w*|open|remove\w*|update-ref|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item)\b/iu;
const SCRIPT_CLI = /agentic-sdlc|mpsf/u;

function scriptReason(file, reason) {
  return `The script ${file} that this command runs was checked as if its lines were typed here: ${reason}`;
}

/** The script files one command runs ({ file, kind: "shell" | "code" | "auto" }), through a shell, source, an interpreter or a path. */
export function scriptFilesRun(rawCommand, depth = 0) {
  if (depth > MAX_NESTING) return [];
  const found = [];
  const { commands, nested } = parseShellCommands(String(rawCommand ?? ""));
  for (const inner of nested) found.push(...scriptFilesRun(inner, depth + 1));
  let bareShell = false;
  for (const argv of commands) {
    const { name, args, program } = programOf(argv);
    if (SHELL_INTERPRETERS.test(name)) {
      const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word));
      if (flag !== -1) {
        if (args[flag + 1]) found.push(...scriptFilesRun(args[flag + 1], depth + 1));
        continue;
      }
      const input = args.findIndex((word) => word.startsWith("<"));
      const file = input !== -1 ? (args[input].length > 1 ? args[input].slice(1) : args[input + 1]) : args.find((word) => !word.startsWith("-"));
      if (file && !file.startsWith("<")) found.push({ file, kind: "shell" });
      else if (input === -1) bareShell = true;
    } else if (name === "source" || name === ".") {
      if (args[0]) found.push({ file: args[0], kind: "shell" });
    } else if (name === "eval") {
      found.push(...scriptFilesRun(args.join(" "), depth + 1));
    } else if (INLINE_INTERPRETER.test(name)) {
      if (args.some((word) => /^-(?:e|c|p|m|command|-eval)$/iu.test(word))) continue;
      let index = 0;
      while (index < args.length && args[index].startsWith("-") && !/^-(?:File|f)$/iu.test(args[index])) index += INTERPRETER_OPTIONS_WITH_VALUE.test(args[index]) ? 2 : 1;
      if (/^-(?:File|f)$/iu.test(args[index] ?? "")) index += 1;
      if (args[index]) found.push({ file: args[index], kind: "code" });
    } else if (/[\\/]/u.test(program) && !CLI_WORD.test(program)) {
      found.push({ file: program, kind: SCRIPT_SHELL_EXTENSION.test(program) ? "shell" : "auto" });
    }
  }
  // A shell reading its commands from a pipe: the files cat feeds it are its script.
  if (bareShell) {
    for (const argv of commands) {
      const { name, args } = programOf(argv);
      if (name === "cat") found.push(...args.filter((word) => !word.startsWith("-")).map((file) => ({ file, kind: "shell" })));
    }
  }
  return found;
}

function evaluateScriptCode(content, file, options) {
  if (MARKER_CHANGE.test(content)) return deny(scriptReason(file, MARKER_REASON));
  if (SCRIPT_CLI.test(content)) {
    const tokens = content.toLowerCase().split(/[^\w-]+/u);
    const match = PERSON_ONLY.find((item) => containsSequence(tokens, item.words) && (!item.flag || content.includes(item.flag)));
    if (match) return deny(scriptReason(file, match.reason(`(the command in ${file})`)));
  }
  if (SCRIPT_RECORD_PATHS.test(content) && SCRIPT_WRITES.test(content)) return deny(scriptReason(file, RECORDS_REASON));
  if (typeof options?.isMergeAuthorized !== "function" || humanEscape(options)) return null;
  const attempts = inlineCodeAttempts(content, `a script file (${file})`);
  const unauthorized = attempts.find((attempt) => !repoOptedOut(options, attempt) && !options.isMergeAuthorized(attempt));
  return unauthorized ? deny(scriptReason(file, ungovernedMergeReason(unauthorized))) : null;
}

/** The verdict for the script files a command runs, read through options.readScript. */
function evaluateScriptFiles(rawCommand, options, depth) {
  if (typeof options?.readScript !== "function" || depth > MAX_NESTING) return null;
  for (const { file, kind } of scriptFilesRun(rawCommand)) {
    const script = options.readScript(file);
    if (!script) continue;
    if (script.missing) {
      // Written by this same command (a here-document, echo >) and run before the guard could read it.
      if (String(rawCommand).split(file).length > 2) return deny(scriptReason(file, "it is created and run in one command, so its lines cannot be read. Write the script in one call and run it in the next."));
      continue;
    }
    if (script.tooLarge) return deny(scriptReason(file, "it is too large to read. Run its commands directly."));
    const content = String(script.content ?? "");
    const shell = kind === "shell" || (kind === "auto" && (SCRIPT_SHEBANG_SHELL.test(content) || !content.startsWith("#!")));
    const verdict = shell ? evaluateShell(content, options, depth + 1) : evaluateScriptCode(content, file, options);
    if (verdict) return shell ? deny(scriptReason(file, verdict.reason)) : verdict;
  }
  return null;
}

function evaluateShell(rawCommand, options, depth = 0) {
  const reason = personOnlyInvocation(rawCommand, true) || personOnlyInvocation(rawCommand, false);
  if (reason) return deny(reason);
  return evaluateNormalizedShell(normalizeShellCommand(rawCommand), rawCommand)
    || evaluateNormalizedShell(normalizeShellCommand(rawCommand, { backslashes: "separator" }), rawCommand)
    || evaluateUngovernedMerge(rawCommand, options)
    || evaluateStoryPush(rawCommand, options)
    || evaluateGitInternalWrite(rawCommand, options)
    || evaluateScriptFiles(rawCommand, options, depth);
}

/** Normalizes a file path for matching: forward slashes, no `.`/`..` segments, lower case. */
export function normalizeEditedPath(filePath) {
  const parts = [];
  for (const part of String(filePath).replace(/\\/gu, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`.toLowerCase();
}

const DIRECTORY_OPTIONS = new Set(["--root", "-C", "--git-dir", "--work-tree", "--cwd", "cd", "pushd", "Set-Location", "sl"]);

/**
 * Paths a tool call aims at besides its working directory: the files a file tool
 * writes and the folders a shell command names (`--root`, `git -C`, `cd`, ...).
 * The hook uses them to find a governed project when the session runs elsewhere.
 */
export function targetedPaths(payload = {}) {
  const toolName = String(payload.tool_name ?? "");
  const toolInput = payload.tool_input ?? {};
  const found = editedPaths(toolName, toolInput);
  if (typeof toolInput.command === "string" && toolName !== "apply_patch") {
    const { commands, nested } = parseShellCommands(toolInput.command);
    const all = [...commands, ...nested.flatMap((inner) => parseShellCommands(inner).commands)];
    for (const words of all) {
      words.forEach((word, index) => {
        if (index > 0 && DIRECTORY_OPTIONS.has(words[index - 1])) found.push(word);
        const inline = /^--(?:root|git-dir|work-tree|cwd)=(.+)$/u.exec(word);
        if (inline) found.push(inline[1]);
        // An absolute path anywhere in the command (a script, a redirect target, a file to copy).
        else if (path.isAbsolute(word) || /^~[\\/]/u.test(word)) found.push(word);
      });
    }
  }
  return [...new Set(found.filter((item) => typeof item === "string" && item.trim() !== ""))];
}

/** Paths a file tool would write, in either host's payload shape. */
export function editedPaths(toolName, toolInput = {}) {
  if (FILE_TOOLS.has(toolName)) {
    return [toolInput.file_path, toolInput.notebook_path, toolInput.path].filter((value) => typeof value === "string");
  }
  if (toolName === "apply_patch") {
    const patch = String(toolInput.command ?? toolInput.patch ?? toolInput.input ?? "");
    return [...patch.matchAll(PATCH_PATH)].map((match) => match[1].trim());
  }
  return [];
}

function guardPolicyOf(file) {
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))?.host_policy?.guard ?? null);
  } catch {
    return null;
  }
}

function settingsKeyLines(text) {
  return String(text ?? "").split(/\r?\n/u).map((line) => line.trim()).filter((line) => HOST_SETTINGS_KEYS.test(line)).join("\n");
}

/** True when a file tool would change the env, hooks or plugin entries of a host settings file. */
function editsHostSettings(toolName, toolInput, edited, cwd) {
  const settings = edited.filter((filePath) => HOST_SETTINGS_PATH.test(normalizeEditedPath(filePath)));
  if (settings.length === 0) return false;
  if (toolName === "apply_patch") return HOST_SETTINGS_KEYS.test(String(toolInput.command ?? toolInput.patch ?? toolInput.input ?? ""));
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [toolInput];
  if (edits.some((edit) => HOST_SETTINGS_KEYS.test(`${edit?.old_string ?? ""}\n${edit?.new_string ?? ""}`))) return true;
  if (typeof toolInput.content !== "string") return false;
  const next = settingsKeyLines(toolInput.content);
  return settings.some((filePath) => {
    let current = "";
    try {
      current = settingsKeyLines(fs.readFileSync(path.resolve(String(cwd || process.cwd()), filePath), "utf8"));
    } catch {
      current = "";
    }
    return current !== next;
  });
}

/**
 * True when a file tool would change host_policy.guard in .sdlc/config.json: an edit whose old or
 * new text names the keys, or a whole-file write whose guard policy differs from the file's own
 * (or cannot be compared and names the keys).
 */
function editsGuardPolicy(toolName, toolInput, edited, cwd) {
  const configs = edited.filter((filePath) => /\/\.sdlc\/config\.json$/u.test(normalizeEditedPath(filePath)));
  if (configs.length === 0) return false;
  if (toolName === "apply_patch") return GUARD_POLICY_KEYS.test(String(toolInput.command ?? toolInput.patch ?? toolInput.input ?? ""));
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [toolInput];
  if (edits.some((edit) => GUARD_POLICY_KEYS.test(`${edit?.old_string ?? ""}\n${edit?.new_string ?? ""}`))) return true;
  if (typeof toolInput.content !== "string") return false;
  let next = null;
  try {
    next = JSON.stringify(JSON.parse(toolInput.content)?.host_policy?.guard ?? null);
  } catch {
    return GUARD_POLICY_KEYS.test(toolInput.content);
  }
  return configs.some((filePath) => {
    const current = guardPolicyOf(path.resolve(String(cwd || process.cwd()), filePath));
    return current === null ? next !== "null" : current !== next;
  });
}

/**
 * PreToolUse decision for one tool call, or null to let the host's normal
 * permission flow decide.
 */
export function evaluatePreToolUse(payload, options = {}) {
  const toolName = String(payload?.tool_name || "");
  const toolInput = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (SHELL_TOOLS.has(toolName)) return evaluateShell(String(toolInput.command ?? ""), options);
  const edited = editedPaths(toolName, toolInput);
  const protectedPaths = edited
    .filter((filePath) => /\/\.sdlc\/autonomy\/standing(?:\/|$)/u.test(normalizeEditedPath(filePath)));
  if (protectedPaths.length > 0) {
    return deny(
      `Standing approval records are immutable and written only by the agentic-sdlc CLI; this edit would change ${protectedPaths.join(", ")}. `
      + "Propose a new standing approval or revoke the existing one through the CLI instead.",
    );
  }
  if (edited.some((filePath) => TRUSTED_REMOTES.test(normalizeEditedPath(filePath)))) return deny(TRUSTED_REMOTES_REASON);
  if (editsHostSettings(toolName, toolInput, edited, payload?.cwd)) return deny(HOST_SETTINGS_REASON);
  if (editsGuardPolicy(toolName, toolInput, edited, payload?.cwd)) return deny(GUARD_POLICY_REASON);
  const archivePaths = edited.filter((filePath) => /\/\.sdlc-archive(?:\/|$)/u.test(normalizeEditedPath(filePath)));
  if (archivePaths.length > 0) {
    return deny(`Archived project records are written only by 'mpsf project archive'; this edit would change ${archivePaths.join(", ")}.`);
  }
  const externalMergePaths = edited
    .filter((filePath) => /\/\.sdlc\/autonomy\/executions\/[^/]+\/external-merge/u.test(normalizeEditedPath(filePath)));
  if (externalMergePaths.length > 0) {
    return deny(
      `The acknowledgement of a merge made outside the plugin is written only by 'autonomy delivery reconcile', run by a person or CI; this edit would change ${externalMergePaths.join(", ")}.`,
    );
  }
  // Delivery action receipts authorize gh pr merge and git push; claims tell which branches are story branches.
  const authorityPaths = edited.filter((filePath) => /\/\.sdlc\/autonomy\/actions(?:\/|$)|\/\.sdlc\/stories\/[^/]+\/claim\.json$/u.test(normalizeEditedPath(filePath)));
  if (authorityPaths.length > 0) {
    return deny(
      `Delivery action receipts and story claims are written only by the mpsf CLI; the merge and push guard reads them, so this edit would change ${authorityPaths.join(", ")}. `
      + "Use 'mpsf autonomy delivery action' and 'mpsf story claim' / 'story release' instead.",
    );
  }
  const usagePaths = edited
    .filter((filePath) => /\/\.sdlc\/autonomy\/metering(?:\/|$)/u.test(normalizeEditedPath(filePath)));
  if (usagePaths.length > 0) {
    return deny(
      `Delivery usage records are append-only and written only by the agentic-sdlc CLI; this edit would change ${usagePaths.join(", ")}. `
      + "Record usage with budget usage record or budget meter record --delivery instead; removing or editing a record would hide spent cost.",
    );
  }
  return null;
}

/** Short context about standing approvals for the start of a session. */
export function sessionStartContext(status) {
  const approvals = Array.isArray(status?.standing_approvals) ? status.standing_approvals : [];
  if (approvals.length === 0) return "";
  const lines = approvals.slice(0, 10).map((item) => {
    const shared = item.shared_state?.scope === "shared"
      ? (item.shared_state.checked
          ? `shared through '${item.shared_state.remote}'`
          : `shared remote '${item.shared_state.remote}' unreachable, so it covers nothing right now`)
      : "kept on this computer only";
    const signed = item.assurance === "host_verified" ? "; approval signed by the trusted host" : "";
    return `- ${item.id}: ${item.status}, ${item.used} of ${item.max_deliveries} deliveries used, expires ${item.expires_at}; ${shared}${signed}.`;
  });
  if (approvals.length > lines.length) lines.push(`- and ${approvals.length - lines.length} more (autonomy standing status).`);
  return [
    "MPSF standing approvals in this project:",
    ...lines,
    "Rely on one only through `--standing-approval` on the CLI. When a step is not covered, show the reason and ask the user for the normal confirmation. Only the user approves a standing approval, in their own terminal.",
  ].join("\n");
}

const MAIN_THREAD_MODES = new Set(["free", "orchestrator", "strict"]);
const ORCHESTRATOR_EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const STRICT_DENY_REASON = "MPSF strict main-thread mode: the main thread only coordinates; delega a un subagent (Agent tool) o lancia il comando in background (run_in_background).";

const GIT_PREFIX = String.raw`git(?:\s+-C\s+\S+)?\s+`;
const CLI_PREFIX = String.raw`(?:rtk\s+)?(?:agentic-sdlc|mpsf|node\s+\S*(?:agentic-sdlc|mpsf)\.mjs)\s+`;
/** Segments (one simple command) that the strict main thread may run in the foreground. */
export const STRICT_DEFAULT_ALLOW = [
  String.raw`(?:ls|cat|head|tail|wc|grep|rg|jq|ps|pwd|echo|date|which)(?:\s|$)`,
  String.raw`find(?!.*\s(?:-exec|-execdir|-delete|-ok|-fprint\w*)\b)(?:\s|$)`,
  String.raw`${GIT_PREFIX}(?:status|log|diff|show|fetch|rev-parse|ls-tree)(?:\s|$)`,
  String.raw`${GIT_PREFIX}branch(?!.*\s(?:-[dDmMcC]|--delete|--move|--copy|--set-upstream-to|--unset-upstream)\b)(?:\s|$)`,
  String.raw`${GIT_PREFIX}worktree\s+list(?:\s|$)`,
  String.raw`gh\s+pr\s+(?:view|list|checks)(?:\s|$)`,
  String.raw`${CLI_PREFIX}(?:message\s+(?:send|read|who)|story\s+working|status)(?:\s|$)`,
  String.raw`claude\s+plugin(?:s)?(?:\s|$)`,
];

/** The effective main-thread mode: AGENTIC_SDLC_MAIN_THREAD (user level) wins over `host_policy.main_thread`; "free" when absent or unknown. */
export function mainThreadMode(config, env = {}) {
  const fromEnv = String(env?.AGENTIC_SDLC_MAIN_THREAD || "").trim().toLowerCase();
  if (MAIN_THREAD_MODES.has(fromEnv)) return fromEnv;
  const value = config?.host_policy?.main_thread;
  return MAIN_THREAD_MODES.has(value) ? value : "free";
}

function strictAllowPatterns(env) {
  const extra = String(env?.AGENTIC_SDLC_MAIN_THREAD_ALLOW || "").split(/\n|;;/u).map((item) => item.trim()).filter(Boolean);
  const patterns = [];
  for (const source of [...STRICT_DEFAULT_ALLOW.map((item) => `^(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:${item})`), ...extra]) {
    try {
      patterns.push(new RegExp(source, "u"));
    } catch {
      // an invalid custom pattern allows nothing
    }
  }
  return patterns;
}

/**
 * Splits a shell command into simple-command segments on |, ||, && and ;,
 * outside quotes. Returns null when it holds anything not statically
 * checkable: command substitution, a background `&`, or a redirection to
 * anything but /dev/null.
 */
function shellSegments(command) {
  const text = String(command || "").replace(/(?:&>|\d?>>?)\s*\/dev\/null\b|\d?>&\d\b/gu, " ");
  const segments = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      if (char === "\\" && quote === '"') {
        current += char + (next ?? "");
        index += 1;
        continue;
      }
      if (quote === '"' && (char === "`" || (char === "$" && next === "("))) return null;
      if (char === quote) quote = "";
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (next ?? "");
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "`" || (char === "$" && next === "(") || char === ">" || char === "<" || char === "(" || char === ")") return null;
    if (char === "&" && next !== "&") return null;
    if (char === "&" || char === "|" || char === ";" || char === "\n") {
      if ((char === "&" || char === "|") && next === char) index += 1;
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) return null;
  segments.push(current);
  return segments.map((item) => item.trim()).filter(Boolean);
}

/** True when a Bash command is read-only or quick enough for the strict main thread. */
export function strictShellAllowed(command, env = {}) {
  const segments = shellSegments(command);
  if (!segments || segments.length === 0) return false;
  const patterns = strictAllowPatterns(env);
  return segments.every((segment) => patterns.some((pattern) => pattern.test(segment)));
}

function realPathOf(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  // `..cache/x` is a folder inside the tree; only `..` itself or `../` leaves it.
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * True when an edit targets a file outside the governed project and its
 * worktrees (`roots`), for example the agent's own memory files under
 * ~/.claude or the session scratchpad. Without `roots` nothing is outside.
 */
function editOutsideGovernedTree(payload, roots, env) {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  const input = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const file = input.file_path ?? input.notebook_path;
  if (typeof file !== "string" || file === "") return false;
  const target = realPathOf(path.resolve(String(payload?.cwd || process.cwd()), file));
  const home = String(env?.HOME || os.homedir() || "");
  if (home && isInside(realPathOf(path.join(home, ".claude")), target)) return true;
  return !roots.some((root) => isInside(realPathOf(root), target));
}

/**
 * Strict mode verdict for the main thread (no `agent_id`): a deny for file
 * edits and for foreground shell commands that are not on the allowlist,
 * null otherwise. Subagents and every other tool are never touched.
 */
export function strictMainThreadVerdict(payload, mode, env = {}, { roots = null } = {}) {
  if (mode !== "strict" || payload?.agent_id) return null;
  const toolName = String(payload?.tool_name || "");
  if (ORCHESTRATOR_EDIT_TOOLS.has(toolName)) return editOutsideGovernedTree(payload, roots, env) ? null : deny(STRICT_DENY_REASON);
  if (!SHELL_TOOLS.has(toolName)) return null;
  const input = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (input.run_in_background === true) return null;
  return strictShellAllowed(input.command, env) ? null : deny(STRICT_DENY_REASON);
}

/** Session instruction for the orchestrator mode, or "" in any other mode. */
export const STORY_LABEL_INSTRUCTION = "When you name a story or a requirement, add a short description (e.g. ST-X (what it does)).";

/** Session instruction, for governed projects: where to read a story's context without opening records one by one. */
export const CONTEXT_PACK_INSTRUCTION = "Story context: `mpsf context pack --story <id> [--phase <phase>]` (details with `mpsf context get <ref>`); do not re-read .sdlc records one by one.";

/** Session instruction, in every main-thread mode, for commands that can outlive the work. */
export const PROCESS_HYGIENE_INSTRUCTION = "Long commands: use `mpsf run --timeout <duration> -- <cmd>` or start them in the background with a deadline; never `nohup` or `&` without a deadline. When you finish, run `mpsf processes reap`.";

/** Session instruction, in every main-thread mode: an idle agent keeps a background watch armed. */
export const WATCH_INSTRUCTION = "When you run out of work, always keep `mpsf watch --timeout 30m` armed in the background (Claude Code: Bash run_in_background; other hosts: a background process with a deadline) and re-arm it every time it exits: it wakes you for new messages, free stories and plugin releases.";

export function orchestratorSessionContext(mode) {
  if (mode !== "orchestrator" && mode !== "strict") return "";
  const strict = mode === "strict";
  return [
    strict
      ? "MPSF strict main-thread mode (AGENTIC_SDLC_MAIN_THREAD or host_policy.main_thread), enforced: on the main thread Edit, Write, NotebookEdit and any foreground Bash command outside a read-only allowlist are denied; delegate to a subagent (Agent tool) or run the command with run_in_background."
      : "",
    "MPSF orchestrator mode (host_policy.main_thread): this main thread only coordinates.",
    STORY_LABEL_INSTRUCTION,
    "It reads messages and notifications, sends short messages, decides, and checks results; a single quick read-only command is fine inline.",
    "The main thread must never block: any command that might take more than about 10 seconds (tests, builds, plugin updates, publish, fetch) is launched in the background (Claude Code: Bash run_in_background, Codex: the equivalent) or delegated to a subagent; only quick read-only commands run in the foreground.",
    "Work that needs reasoning (code, fixes, story delivery, review) goes to background subagents.",
    "Mechanical work (builds, test suites, dev servers, long commands) goes to controlled background processes: an explicit deadline (for example a 10-minute timeout), no orphaned nohup or &, output in a file the main thread reads at the end, and a final check that no process is left running.",
  ].filter(Boolean).join("\n");
}

/**
 * Warning (never a block) for a file edit made from the main thread in the
 * orchestrator mode, or "" otherwise. The host adds `agent_id` to the payload
 * of a hook that fires inside a subagent and leaves it out on the main thread.
 */
export function orchestratorEditWarning(payload, mode) {
  if (mode !== "orchestrator") return "";
  if (!ORCHESTRATOR_EDIT_TOOLS.has(String(payload?.tool_name || ""))) return "";
  if (payload?.agent_id) return "";
  return "MPSF orchestrator mode: this edit runs on the main thread, which only coordinates. Hand the change to a background subagent instead.";
}
