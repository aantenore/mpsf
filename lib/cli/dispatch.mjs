import { COMMAND_CATALOG } from "./command-catalog.mjs";

const MUTATION_MODES = new Set(["always", "never", "when-option"]);
const CONDITION_OPERATORS = new Set(["equals", "present", "truthy"]);

export class CliDispatchMetadataError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliDispatchMetadataError";
    this.code = "CLI_DISPATCH_METADATA_INVALID";
  }
}

function normalizeTokens(value) {
  const tokens = Array.isArray(value)
    ? value
    : String(value ?? "").trim().split(/\s+/u).filter(Boolean);
  const normalized = tokens.map((token) => String(token).trim()).filter(Boolean);
  if (normalized[0] === "agentic-sdlc" || normalized[0] === "mpsf") normalized.shift();
  return normalized;
}

function commandNodes(catalog = COMMAND_CATALOG) {
  const commands = [];
  const visit = (node) => {
    if (node?.kind === "command") commands.push(node);
    for (const child of node?.children ?? []) visit(child);
  };
  visit(catalog);
  return commands;
}

function validateCanonicalAction(node) {
  if (typeof node?.canonical_action !== "string" || !node.canonical_action.trim()) {
    throw new CliDispatchMetadataError(
      `Command '${node?.path_text || "(unknown)"}' is missing canonical_action`,
    );
  }
  return node.canonical_action;
}

function validateMutationMetadata(node) {
  const mutation = node?.mutation;
  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
    throw new CliDispatchMetadataError(
      `Command '${node?.path_text || "(unknown)"}' is missing mutation metadata`,
    );
  }
  if (!MUTATION_MODES.has(mutation.mode)) {
    throw new CliDispatchMetadataError(
      `Command '${node.path_text}' has unsupported mutation mode '${mutation.mode}'`,
    );
  }
  if (mutation.mode !== "when-option") return mutation;
  if (!Array.isArray(mutation.conditions) || mutation.conditions.length === 0) {
    throw new CliDispatchMetadataError(
      `Command '${node.path_text}' needs at least one mutation condition`,
    );
  }
  if (!new Set(["all", "any"]).has(mutation.match)) {
    throw new CliDispatchMetadataError(
      `Command '${node.path_text}' needs mutation match 'all' or 'any'`,
    );
  }
  for (const condition of mutation.conditions) {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
      throw new CliDispatchMetadataError(`Command '${node.path_text}' has an invalid mutation condition`);
    }
    if (typeof condition.option !== "string" || !condition.option.trim()) {
      throw new CliDispatchMetadataError(`Command '${node.path_text}' has a mutation condition without an option`);
    }
    if (!CONDITION_OPERATORS.has(condition.operator)) {
      throw new CliDispatchMetadataError(
        `Command '${node.path_text}' has unsupported mutation operator '${condition.operator}'`,
      );
    }
    if (condition.operator === "equals" && !Object.hasOwn(condition, "value")) {
      throw new CliDispatchMetadataError(
        `Command '${node.path_text}' has an equals mutation condition without a value`,
      );
    }
  }
  return mutation;
}

function commandCandidates(catalog = COMMAND_CATALOG) {
  const candidates = [];
  const aliases = new Map();
  for (const node of commandNodes(catalog)) {
    validateCanonicalAction(node);
    validateMutationMetadata(node);
    candidates.push({ tokens: [...node.path], node, alias: false });
    for (const aliasValue of node.aliases ?? []) {
      const tokens = normalizeTokens(aliasValue);
      if (tokens.length === 0) {
        throw new CliDispatchMetadataError(`Command '${node.path_text}' has an empty alias`);
      }
      const key = tokens.join(" ");
      const previous = aliases.get(key);
      if (previous && previous.canonical_action !== node.canonical_action) {
        throw new CliDispatchMetadataError(
          `Alias '${key}' maps to both '${previous.canonical_action}' and '${node.canonical_action}'`,
        );
      }
      aliases.set(key, node);
    }
  }
  for (const [alias, node] of aliases) {
    const existing = candidates.find((candidate) => candidate.tokens.join(" ") === alias);
    if (existing) {
      if (existing.node.canonical_action !== node.canonical_action) {
        throw new CliDispatchMetadataError(
          `Alias '${alias}' conflicts with command '${existing.node.path_text}'`,
        );
      }
      continue;
    }
    candidates.push({ tokens: alias.split(" "), node, alias: true });
  }
  return candidates.sort((left, right) => right.tokens.length - left.tokens.length
    || left.tokens.join(" ").localeCompare(right.tokens.join(" "), "en"));
}

export function resolveCommand(positionals, { catalog = COMMAND_CATALOG } = {}) {
  const tokens = normalizeTokens(positionals);
  for (const candidate of commandCandidates(catalog)) {
    if (candidate.tokens.length > tokens.length) continue;
    if (!candidate.tokens.every((token, index) => token === tokens[index])) continue;
    return Object.freeze({
      command: candidate.node,
      canonical_action: candidate.node.canonical_action,
      canonical_path: Object.freeze([...candidate.node.path]),
      matched_path: Object.freeze([...candidate.tokens]),
      alias: candidate.alias,
      args: Object.freeze(tokens.slice(candidate.tokens.length)),
      input: Object.freeze(tokens),
    });
  }
  return null;
}

function conditionMatches(condition, options) {
  const present = Object.hasOwn(options, condition.option) && options[condition.option] !== undefined;
  if (condition.operator === "present") return present;
  if (condition.operator === "truthy") return Boolean(options[condition.option]);
  if (condition.operator === "equals") return present && options[condition.option] === condition.value;
  throw new CliDispatchMetadataError(`Unsupported mutation operator '${condition.operator}'`);
}

export function commandMutationIntent(commandOrResolution, options = {}) {
  const node = commandOrResolution?.command ?? commandOrResolution;
  const mutation = validateMutationMetadata(node);
  if (mutation.mode === "never") return false;
  if (mutation.mode === "always") return true;
  const matches = mutation.conditions.map((condition) => conditionMatches(condition, options));
  return mutation.match === "all" ? matches.every(Boolean) : matches.some(Boolean);
}

export function catalogOptionMetadata(catalog = COMMAND_CATALOG) {
  const descriptors = new Map();
  const visit = (node) => {
    for (const descriptor of node?.options ?? []) {
      const previous = descriptors.get(descriptor.name);
      if (previous) {
        if (Boolean(previous.boolean) !== Boolean(descriptor.boolean)
          || Boolean(previous.repeatable) !== Boolean(descriptor.repeatable)) {
          throw new CliDispatchMetadataError(
            `Option '--${descriptor.name}' has conflicting parser metadata`,
          );
        }
      } else {
        descriptors.set(descriptor.name, descriptor);
      }
    }
    for (const child of node?.children ?? []) visit(child);
  };
  visit(catalog);
  return Object.freeze({
    known: Object.freeze([...descriptors.keys()].sort((left, right) => left.localeCompare(right, "en"))),
    boolean: Object.freeze([...descriptors.values()]
      .filter((descriptor) => descriptor.boolean === true)
      .map((descriptor) => descriptor.name)
      .sort((left, right) => left.localeCompare(right, "en"))),
    repeatable: Object.freeze([...descriptors.values()]
      .filter((descriptor) => descriptor.repeatable === true)
      .map((descriptor) => descriptor.name)
      .sort((left, right) => left.localeCompare(right, "en"))),
  });
}

function normalizeHandlerEntry(action, value) {
  if (typeof value === "function") return Object.freeze({ action, stage: "project", handle: value });
  if (!value || typeof value !== "object" || typeof value.handle !== "function") {
    throw new CliDispatchMetadataError(`Handler '${action}' must be a function or handler descriptor`);
  }
  if (typeof value.stage !== "string" || !value.stage.trim()) {
    throw new CliDispatchMetadataError(`Handler '${action}' is missing a stage`);
  }
  return Object.freeze({ action, stage: value.stage, handle: value.handle });
}

export function createCommandHandlerRegistry(handlers, { catalog = COMMAND_CATALOG } = {}) {
  const supplied = handlers instanceof Map ? [...handlers.entries()] : Object.entries(handlers ?? {});
  const entries = new Map();
  for (const [action, value] of supplied) {
    if (entries.has(action)) throw new CliDispatchMetadataError(`Duplicate handler '${action}'`);
    entries.set(action, normalizeHandlerEntry(action, value));
  }

  const expected = new Set(commandNodes(catalog).map((node) => validateCanonicalAction(node)));
  const missing = [...expected].filter((action) => !entries.has(action)).sort();
  const extra = [...entries.keys()].filter((action) => !expected.has(action)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new CliDispatchMetadataError([
      missing.length > 0 ? `Missing handlers: ${missing.join(", ")}` : null,
      extra.length > 0 ? `Unknown handlers: ${extra.join(", ")}` : null,
    ].filter(Boolean).join("; "));
  }

  return Object.freeze({
    actions: Object.freeze([...entries.keys()].sort()),
    get(action) {
      return entries.get(action) ?? null;
    },
    async dispatch(resolution, invocation = {}) {
      const entry = entries.get(resolution?.canonical_action);
      if (!entry) {
        throw new CliDispatchMetadataError(
          `No handler is registered for '${resolution?.canonical_action || "(unknown)"}'`,
        );
      }
      return entry.handle({ ...invocation, resolution, args: resolution.args });
    },
  });
}

export function listCanonicalActions(catalog = COMMAND_CATALOG) {
  return Object.freeze([...new Set(commandNodes(catalog).map((node) => validateCanonicalAction(node)))].sort());
}
