import { GATE_REQUIREMENTS, missingGuarantees, recordAssuranceLevel } from "../capabilities.mjs";
import { openRecordStore } from "./registry.mjs";

/**
 * Errors a gate adds when the project's record store cannot give the
 * guarantees its certification level needs. Fails closed: a store that
 * cannot be opened (unknown provider, invalid options) is an error too.
 * The default git-backed store gives every guarantee, so it adds nothing.
 */
export function recordStoreGuaranteeErrors(context, level) {
  let store;
  try {
    store = openRecordStore(context, context?.config && typeof context.config === "object" ? { config: context.config } : {});
  } catch (error) {
    return [`record store: ${error.message}`];
  }
  const missing = missingGuarantees(store.guarantees, GATE_REQUIREMENTS[level] ?? []);
  if (missing.length === 0) return [];
  return [
    `record store '${store.id}' (assurance ${recordAssuranceLevel(store.guarantees)}) cannot back a ${level} gate: it does not guarantee ${missing.join(", ")}. `
    + "Use a store that does (host_policy.adapters.records), or run a standard check.",
  ];
}
