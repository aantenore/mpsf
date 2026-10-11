import { createOperationalRedactionPolicy, redactText } from "../observability/redaction.mjs";
import { scanFiles } from "../secret-scan.mjs";

/**
 * Nothing secret leaves the context module. Two independent layers:
 * the operational redaction policy (credentials, tokens, personal data)
 * on every line, then the delivery secret scan rules (the same ones the
 * gate uses, plus the project's gate_policy.secret_scan.rules) as a last
 * check that blanks any line still matching.
 */
const POLICY = createOperationalRedactionPolicy();
export const SECRET_PLACEHOLDER = "[REDACTED]";

let projectRules = [];

/** Project secret scan rules (gate_policy.secret_scan.rules) used by the final check. */
export function setContextSecretRules(config) {
  const rules = config?.gate_policy?.secret_scan?.rules;
  projectRules = Array.isArray(rules) ? rules : [];
}

export function redactPackText(text) {
  const value = String(text ?? "");
  let redacted;
  try {
    redacted = redactText(value, POLICY);
  } catch {
    redacted = SECRET_PLACEHOLDER;
  }
  return scrubWithSecretRules(redacted);
}

/** Replaces each line that still matches a secret scan rule. */
export function scrubWithSecretRules(text) {
  let scan;
  try {
    scan = scanFiles([{ path: "context", content: text }], { rules: projectRules });
  } catch {
    scan = scanFiles([{ path: "context", content: text }]);
  }
  if (scan.findings.length === 0) return text;
  const lines = text.split("\n");
  for (const finding of scan.findings) lines[finding.line - 1] = SECRET_PLACEHOLDER;
  return lines.join("\n");
}
