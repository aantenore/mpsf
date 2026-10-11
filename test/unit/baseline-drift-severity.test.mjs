import assert from "node:assert/strict";
import test from "node:test";

import { staleBaselineSeverity, taskStartBaselineDriftVerdict } from "../../lib/engine/story.mjs";

const base = { scope: "story", strict: true, active: true, status: "approved", declaredByStory: false };

// Each row keeps the scenario name of the case it covers: [scenario, input, expected].

test("staleBaselineSeverity: story drift warns, project drift and a declared baseline block", () => {
  const cases = [
    ["story scope: baseline drift is a warning, also in strict mode", base, "warnings"],
    ["project scope: baseline drift stays a blocker in strict mode", { ...base, scope: "project" }, "errors"],
    ["project scope: without strict mode drift is a warning", { ...base, scope: "project", strict: false }, "warnings"],
    ["story that declares the baseline as context source keeps the blocker", { ...base, declaredByStory: true }, "errors"],
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(staleBaselineSeverity(input), expected, label);
  }
});

test("taskStartBaselineDriftVerdict: explained drift warns, unattributed changes or a declared baseline block", () => {
  const cases = [
    [
      "drift fully explained by delivered stories is a warning",
      { rawIssues: ["baseline B source a.js is missing or changed"], unexplainedIssues: [] },
      "warning",
    ],
    ["no drift is ready", { rawIssues: [], unexplainedIssues: [] }, "ready"],
    ["unattributed changes keep the blocker", { rawIssues: ["a", "b"], unexplainedIssues: ["b"] }, "blocked"],
    [
      "a declared baseline keeps the blocker",
      { rawIssues: ["a", "b"], unexplainedIssues: [], declaredByStory: true },
      "blocked",
    ],
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(taskStartBaselineDriftVerdict(input), expected, label);
  }
});
