import test from "node:test";
import assert from "node:assert/strict";

import { UsageError, UserError } from "../../lib/cli/user-error.mjs";
import { usageFromMetricFlags } from "../../lib/engine/assessment.mjs";
import { normalizeExecutionBudget } from "../../lib/execution-budget.mjs";

// The same limits as the saved budget in test/budget-cost-control.e2e.mjs;
// normalizing sorts the metrics, so the accepted-metrics hint names cost first.
const BUDGET = normalizeExecutionBudget({
  id: "BUDGET-ASSESS-1",
  limits: {
    tokens: { unit: "tokens", metering: "estimated", soft: 10_000 },
    cost: { unit: "money", currency: "USD", metering: "estimated", soft: "5" },
  },
});

/** Options hold the plain strings the argv parser passes through unchanged. */
function assertRefused(options, pattern) {
  assert.throws(() => usageFromMetricFlags(options, BUDGET), (error) => {
    assert.ok(error instanceof UserError, `expected a UserError, got ${error?.constructor?.name}`);
    assert.equal(error instanceof UsageError, false, "a refused value is not a usage error");
    assert.match(error.message, pattern);
    return true;
  }, JSON.stringify(options));
}

test("manual metric flags are strict whole numbers or decimals and must belong to the budget", () => {
  for (const [flag, value] of [["--input-tokens", "1e3"], ["--output-tokens", "0x10"], ["--input-tokens", "1.5"]]) {
    assertRefused(
      { [flag.slice(2)]: value },
      new RegExp(`${flag} must be a whole number such as 120 \\(got '${value.replace(".", "\\.")}'\\)`, "u"),
    );
  }
  assertRefused({ "cost-amount": "1e-3" }, /--cost-amount must be a plain decimal amount/u);
  assertRefused(
    { "input-tokens": "10", steps: "3" },
    /--steps: metric steps is not in this budget \(accepts: cost \(--cost-amount\), tokens \(--input-tokens \/ --output-tokens\)\)/u,
  );
  assertRefused({ "cost-amount": "1", currency: "EUR" }, /--currency EUR does not match the budget currency USD/u);
});
