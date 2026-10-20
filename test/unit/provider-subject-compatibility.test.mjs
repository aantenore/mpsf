import assert from "node:assert/strict";
import test from "node:test";

import { deliveryProviderOperationSubjectsMatch } from "../../lib/delivery/provider-subject-compatibility.mjs";

const portablePushSubject = Object.freeze({
  repository: "github.com/acme/shopfront",
  remote: "origin",
  destination_ref: "refs/heads/codex/portable",
  base_ref: "refs/heads/main",
  source_sha: "a".repeat(40),
});

test("legacy git.push cwd is the only portable provider-subject difference", () => {
  assert.equal(deliveryProviderOperationSubjectsMatch(
    "git.push",
    { cwd: "/private/tmp/source-checkout", ...portablePushSubject },
    portablePushSubject,
  ), true);
  assert.equal(deliveryProviderOperationSubjectsMatch(
    "git.push",
    { cwd: "C:\\Users\\runner\\source-checkout", ...portablePushSubject },
    portablePushSubject,
  ), true);
  assert.equal(deliveryProviderOperationSubjectsMatch(
    "git.push",
    portablePushSubject,
    portablePushSubject,
  ), true);

  for (const [field, value] of [
    ["repository", "github.com/acme/other"],
    ["remote", "upstream"],
    ["destination_ref", "refs/heads/codex/other"],
    ["base_ref", "refs/heads/release"],
    ["source_sha", "b".repeat(40)],
  ]) {
    assert.equal(deliveryProviderOperationSubjectsMatch(
      "git.push",
      { cwd: "/private/tmp/source-checkout", ...portablePushSubject, [field]: value },
      portablePushSubject,
    ), false, `${field} must remain exact`);
  }
  assert.equal(deliveryProviderOperationSubjectsMatch(
    "git.push",
    { cwd: "relative/source-checkout", ...portablePushSubject },
    portablePushSubject,
  ), false);
  assert.equal(deliveryProviderOperationSubjectsMatch(
    "git.push",
    { cwd: "/private/tmp/source-checkout", ...portablePushSubject, unexpected: true },
    portablePushSubject,
  ), false);
});

test("non-git provider subjects remain byte-for-byte canonical and cwd is not projected", () => {
  const pullRequestSubject = {
    repository: "github.com/acme/shopfront",
    head_branch: "codex/portable",
    base_branch: "main",
    source_sha: "a".repeat(40),
    authorized_at: "2026-07-19T00:00:00.000Z",
  };
  assert.equal(deliveryProviderOperationSubjectsMatch(
    "pull_request.create",
    pullRequestSubject,
    { ...pullRequestSubject },
  ), true);
  assert.equal(deliveryProviderOperationSubjectsMatch(
    "pull_request.create",
    { cwd: "/private/tmp/source-checkout", ...pullRequestSubject },
    pullRequestSubject,
  ), false);
  assert.equal(deliveryProviderOperationSubjectsMatch(
    "pull_request.create",
    { ...pullRequestSubject, source_sha: "b".repeat(40) },
    pullRequestSubject,
  ), false);
});
