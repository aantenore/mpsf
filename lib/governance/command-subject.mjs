import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  compareCanonicalStrings,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  omitKeys,
  requireNonEmptyString,
  requirePlainRecord,
} from "../canonical.mjs";

export const GOVERNANCE_COMMAND_SUBJECT_V1 = "governance-command-subject:v1";

const ACTION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const COMMAND_PATH_PATTERN = /^[a-z0-9][a-z0-9._-]*(?: [a-z0-9][a-z0-9._-]*)*$/;
const REF_KIND_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_REF_ID_PATTERN = /^(?!\.{1,2}(?:\/|$))(?![^@]*@)[A-Za-z0-9.][A-Za-z0-9._:/+-]{0,511}$/;
const SAFE_IDENTITY_ID_PATTERN = /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9.][A-Za-z0-9._:/@+-]{0,511}$/;
const PAYLOAD_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SENSITIVE_PAYLOAD_NAME = /(?:^|[._-])(?:authorization|cookie|credential|key|password|secret|session|token)(?:$|[._-])/u;

/**
 * Builds the only command representation accepted by the governance engine.
 *
 * Scope and evidence are bounded references. Arbitrary command input is never
 * copied into the subject: callers may bind it through payload_refs or payloads,
 * where only a stable hash is retained.
 */
export function createCommandSubject(input) {
  requirePlainRecord(input, "command_subject");
  rejectUnknownKeys(input, new Set([
    "command_path",
    "canonical_action",
    "action",
    "scope_refs",
    "scopes",
    "evidence_refs",
    "evidence",
    "payload_refs",
    "payloads",
  ]), "command_subject");

  const commandPath = normalizeCommandPath(input.command_path);
  const action = normalizeAction(input.canonical_action ?? input.action);
  const scopeRefs = normalizeExactRefs(input.scope_refs ?? input.scopes ?? [], "command_subject.scope_refs");
  const evidenceRefs = normalizeExactRefs(
    input.evidence_refs ?? input.evidence ?? [],
    "command_subject.evidence_refs",
    { requireHash: true },
  );
  const payloadRefs = normalizePayloadRefs(input.payload_refs, input.payloads);
  const base = {
    kind: "governance_command_subject",
    schema_version: GOVERNANCE_COMMAND_SUBJECT_V1,
    version: 1,
    command: {
      path: commandPath,
      action,
    },
    scope_refs: scopeRefs,
    evidence_refs: evidenceRefs,
    payload_refs: payloadRefs,
  };
  return immutableJson({
    ...base,
    subject_hash: computeCommandSubjectHash(base),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function computeCommandSubjectHash(subject) {
  requirePlainRecord(subject, "command_subject");
  return computeStableHash(omitKeys(subject, ["subject_hash", "hash_algorithm"]));
}

export function validateCommandSubjectIntegrity(subject) {
  const errors = [];
  if (!isPlainRecord(subject)) {
    return immutableJson({ valid: false, expected_hash: null, errors: ["command subject must be a plain object"] });
  }
  let normalized = null;
  try {
    normalized = createCommandSubject({
      command_path: subject.command?.path,
      canonical_action: subject.command?.action,
      scope_refs: subject.scope_refs,
      evidence_refs: subject.evidence_refs,
      payload_refs: subject.payload_refs,
    });
  } catch (error) {
    errors.push(error.message);
  }
  const expectedHash = normalized?.subject_hash ?? null;
  if (subject.kind !== "governance_command_subject") {
    errors.push("command subject kind is invalid");
  }
  if (subject.schema_version !== GOVERNANCE_COMMAND_SUBJECT_V1 || subject.version !== 1) {
    errors.push("command subject schema version is unsupported");
  }
  if (subject.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push("command subject hash algorithm is invalid");
  }
  if (expectedHash && subject.subject_hash !== expectedHash) {
    errors.push("command subject hash does not match its content");
  }
  if (normalized && computeStableHash(subject) !== computeStableHash(normalized)) {
    errors.push("command subject is not in canonical form");
  }
  return immutableJson({ valid: errors.length === 0, expected_hash: expectedHash, errors });
}

export function normalizeGovernanceRef(raw, label = "reference", options = {}) {
  requirePlainRecord(raw, label);
  rejectUnknownKeys(raw, new Set(["kind", "id", "hash"]), label);
  const kind = normalizePatternString(raw.kind, `${label}.kind`, REF_KIND_PATTERN);
  const id = normalizePatternString(raw.id, `${label}.id`, SAFE_REF_ID_PATTERN, false);
  const hash = raw.hash === undefined || raw.hash === null
    ? null
    : normalizeSha256(raw.hash, `${label}.hash`);
  if (options.requireHash === true && hash === null) {
    throw new DomainValidationError(`${label}.hash is required`);
  }
  return immutableJson(hash === null ? { kind, id } : { kind, id, hash });
}

export function normalizeExactRefs(value, label = "references", options = {}) {
  if (!Array.isArray(value)) {
    throw new DomainValidationError(`${label} must be an array`);
  }
  const byKey = new Map();
  value.forEach((item, index) => {
    const normalized = normalizeGovernanceRef(item, `${label}[${index}]`, options);
    const key = computeStableHash(normalized);
    if (byKey.has(key)) {
      throw new DomainValidationError(`${label} must not contain duplicate references`);
    }
    byKey.set(key, normalized);
  });
  return immutableJson(Array.from(byKey.values()).sort(compareRefs));
}

export function normalizeActorIdentity(raw, label = "actor") {
  requirePlainRecord(raw, label);
  const type = normalizePatternString(raw.type, `${label}.type`, REF_KIND_PATTERN);
  const id = normalizePatternString(raw.id, `${label}.id`, SAFE_IDENTITY_ID_PATTERN, false);
  const issuer = raw.issuer === undefined || raw.issuer === null
    ? null
    : normalizePatternString(raw.issuer, `${label}.issuer`, SAFE_IDENTITY_ID_PATTERN, false);
  return immutableJson(issuer === null ? { type, id } : { type, id, issuer });
}

export function computeActorIdentityHash(actor) {
  return computeStableHash(normalizeActorIdentity(actor));
}

export function hashCommandPayload(value) {
  return computeStableHash(value);
}

function normalizePayloadRefs(explicitRefs, payloads) {
  if (explicitRefs !== undefined && payloads !== undefined) {
    throw new DomainValidationError("command_subject must use payload_refs or payloads, not both");
  }
  const refs = [];
  if (explicitRefs !== undefined) {
    if (!Array.isArray(explicitRefs)) {
      throw new DomainValidationError("command_subject.payload_refs must be an array");
    }
    explicitRefs.forEach((raw, index) => {
      requirePlainRecord(raw, `command_subject.payload_refs[${index}]`);
      rejectUnknownKeys(raw, new Set(["name", "hash"]), `command_subject.payload_refs[${index}]`);
      refs.push(normalizePayloadRef(raw.name, raw.hash, `command_subject.payload_refs[${index}]`));
    });
  }
  if (payloads !== undefined) {
    requirePlainRecord(payloads, "command_subject.payloads");
    Object.entries(payloads).forEach(([name, value], index) => {
      refs.push(normalizePayloadRef(name, hashCommandPayload(value), `command_subject.payloads[${index}]`));
    });
  }
  const byName = new Map();
  for (const ref of refs) {
    if (byName.has(ref.name)) {
      throw new DomainValidationError(`command_subject.payload_refs contains duplicate name '${ref.name}'`);
    }
    byName.set(ref.name, ref);
  }
  return immutableJson(Array.from(byName.values()).sort((left, right) => compareCanonicalStrings(left.name, right.name)));
}

function normalizePayloadRef(nameValue, hashValue, label) {
  const name = normalizePatternString(nameValue, `${label}.name`, PAYLOAD_NAME_PATTERN);
  if (SENSITIVE_PAYLOAD_NAME.test(name)) {
    throw new DomainValidationError(`${label}.name is sensitive and must not be represented in a governance subject`);
  }
  return immutableJson({ name, hash: normalizeSha256(hashValue, `${label}.hash`) });
}

function normalizeAction(value) {
  return normalizePatternString(value, "command_subject.canonical_action", ACTION_PATTERN);
}

function normalizeCommandPath(value) {
  const path = requireNonEmptyString(value, "command_subject.command_path").toLowerCase().replace(/\s+/gu, " ");
  if (!COMMAND_PATH_PATTERN.test(path)) {
    throw new DomainValidationError("command_subject.command_path must be a canonical command path");
  }
  return path;
}

function normalizePatternString(value, label, pattern, lowercase = true) {
  const normalized = requireNonEmptyString(value, label);
  const result = lowercase ? normalized.toLowerCase() : normalized;
  if (!pattern.test(result)) {
    throw new DomainValidationError(`${label} has an unsafe or unsupported format`);
  }
  return result;
}

function normalizeSha256(value, label) {
  const normalized = requireNonEmptyString(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new DomainValidationError(`${label} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function compareRefs(left, right) {
  return compareCanonicalStrings(`${left.kind}\u0000${left.id}\u0000${left.hash ?? ""}`, `${right.kind}\u0000${right.id}\u0000${right.hash ?? ""}`);
}

function rejectUnknownKeys(value, allowed, label) {
  if (!isPlainRecord(value)) {
    return;
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new DomainValidationError(`${label} contains unsupported fields`);
  }
}
