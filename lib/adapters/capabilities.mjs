/**
 * Guarantees an adapter declares, and the ones each check needs.
 *
 * Gates never trust an adapter by name: they ask for guarantees. An adapter
 * that cannot give one a check needs makes that check fail closed, with the
 * missing guarantee named, instead of passing on weaker evidence.
 */

/** What a record store may guarantee. */
export const RECORD_GUARANTEES = Object.freeze({
  // A written record cannot be changed or removed without leaving a visible trace (git history, WORM storage).
  immutable_history: "immutable_history",
  // Append-only traces carry a hash chain and a checkpoint, so a rewrite or truncation is detected.
  hash_chain: "hash_chain",
  // A publication lands entirely or not at all (one commit, one transaction).
  atomic_publish: "atomic_publish",
  // Records travel with the code on the base branch, so a merged change and its evidence share one history.
  base_branch_coupling: "base_branch_coupling",
  // Coordination state (claims, waits, reviews, standing approvals) is shared between computers with create-only writes.
  shared_state: "shared_state",
});

/** What a messaging provider may guarantee. Messaging is notification only: no gate ever needs one of these. */
export const MESSAGING_GUARANTEES = Object.freeze({
  // Messages reach the other computers (false for an offline or disabled channel).
  cross_host_delivery: "cross_host_delivery",
  // Message ids only grow, so a read position never skips or repeats a message.
  ordered_ids: "ordered_ids",
  // The sender is authenticated by the transport (an account), not only by the text.
  authenticated_sender: "authenticated_sender",
});

/**
 * Assurance level of a record store, from its guarantees. Reported in gate
 * results so a reader sees on what the verdict rests.
 *   full      every record guarantee
 *   standard  hash chain and atomic publication, without base-branch coupling or immutable history
 *   local     anything less: good for a single computer, never for certification
 */
export function recordAssuranceLevel(guarantees) {
  const have = new Set(guarantees ?? []);
  if (Object.values(RECORD_GUARANTEES).every((name) => have.has(name))) return "full";
  if (have.has(RECORD_GUARANTEES.hash_chain) && have.has(RECORD_GUARANTEES.atomic_publish)) return "standard";
  return "local";
}

/**
 * Record guarantees each kind of gate result needs. A standard check reads
 * records only; a strict story check seals a receipt, so it needs the hash
 * chain; the final lifecycle certification also needs the records to be
 * immutable, published atomically and tied to the merged code.
 */
export const GATE_REQUIREMENTS = Object.freeze({
  standard: Object.freeze([]),
  strict_intermediate: Object.freeze([RECORD_GUARANTEES.hash_chain]),
  lifecycle_complete: Object.freeze([
    RECORD_GUARANTEES.hash_chain,
    RECORD_GUARANTEES.immutable_history,
    RECORD_GUARANTEES.atomic_publish,
    RECORD_GUARANTEES.base_branch_coupling,
  ]),
});

/** The guarantees in `required` that `guarantees` lacks (empty when all are there). */
export function missingGuarantees(guarantees, required) {
  const have = new Set(guarantees ?? []);
  return (required ?? []).filter((name) => !have.has(name));
}
