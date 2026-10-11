import "../helpers/test-isolation.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_VERSION,
  buildRequirementRecord,
  comparePluginVersions,
  configKeyFeature,
  evaluateRequirements,
  pluginUpdateCommand,
  requiresNewerPlugin,
  unknownConfigKeyLine,
} from "../../lib/plugin-compatibility.mjs";
import { validateSdlcConfig } from "../../lib/engine/project.mjs";
import {
  buildSharedClaimPayload,
  buildSharedReleasePayload,
  interpretSharedClaimRecords,
  sharedClaimRef,
} from "../../lib/story-claim-shared-state.mjs";
import { sealSharedPayload } from "../../lib/shared-ref-records.mjs";

// In-process checks moved from test/plugin-compatibility.e2e.mjs; the CLI and hook
// scenario stays there.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("versions compare numerically and a malformed minimum counts as newer", () => {
  assert.equal(comparePluginVersions("0.10.0", "0.9.9"), 1);
  assert.equal(comparePluginVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(comparePluginVersions("x", "1.0.0"), null);
  assert.equal(requiresNewerPlugin(undefined), false);
  assert.equal(requiresNewerPlugin(PLUGIN_VERSION), false);
  assert.equal(requiresNewerPlugin("999.0.0"), true);
  assert.equal(requiresNewerPlugin("not-a-version"), true);
});

test("requirement files decide whether this plugin can work on the project", () => {
  const known = { path: "a.json", record: buildRequirementRecord("shared-claim-completed") };
  assert.equal(evaluateRequirements([known]).satisfied, true);
  const future = { path: "b.json", record: { ...known.record, feature: "future", minimum_plugin_version: "999.0.0" } };
  const verdict = evaluateRequirements([known, future]);
  assert.equal(verdict.satisfied, false);
  assert.equal(verdict.required_plugin_version, "999.0.0");
  assert.deepEqual(verdict.newer_features.map((item) => item.feature), ["future"]);
  const unreadable = evaluateRequirements([{ path: "c.json", record: { schema_version: "plugin-compatibility-requirement:v9" } }]);
  assert.equal(unreadable.satisfied, false);
  assert.deepEqual(unreadable.unreadable, ["c.json"]);
  assert.match(pluginUpdateCommand(), /^claude plugin marketplace update \S+ && claude plugin update mpsf@\S+$/u);
});

test("a shared record that declares a newer plugin is not interpreted and asks for the update", () => {
  const release = buildSharedReleasePayload({
    storyId: "ST-1", epoch: 1, claimantId: "c1", status: "completed", releasedAt: "2026-10-09T00:00:00Z",
  });
  assert.equal(release.minimum_plugin_version, "0.32.0");
  const { payload_hash: _hash, ...plain } = buildSharedClaimPayload({
    storyId: "ST-1", epoch: 1, claimantId: "c1", agent: "a", branch: "b", actor: null, claimedAt: "2026-10-09T00:00:00Z",
  });
  const claim = sealSharedPayload({ ...plain, minimum_plugin_version: "999.0.0" });
  const interpreted = interpretSharedClaimRecords([
    { ref: sharedClaimRef("ST-1", 1), message: JSON.stringify(claim) },
  ]);
  const problems = [...interpreted.stories.values()].flatMap((state) => state.problems);
  assert.ok(problems.some((text) => /newer plugin version \(999\.0\.0 or later\); update the plugin: claude plugin/u.test(text)), problems.join("\n"));
});

test("configuration keys declare the plugin version that introduced them", () => {
  assert.equal(configKeyFeature("orchestration_policy.story_records.in_branch").since, "0.35.0");
  assert.equal(configKeyFeature("orchestration_policy.merge_drift.open_state").since, "0.35.0");
  assert.equal(configKeyFeature("orchestration_policy.merge_drift.base_branch"), null);
  assert.match(unknownConfigKeyLine(["a.b"]), /does not know: a\.b\. If a newer plugin added them, update the plugin: claude plugin/u);
});

test("an unknown configuration key names the plugin update", () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates", "sdlc-config.json"), "utf8"));
  config.orchestration_policy = { ...(config.orchestration_policy || {}), future_option: true };
  assert.throws(() => validateSdlcConfig(config), /orchestration_policy\.future_option.*update the plugin: claude plugin/su);
});
