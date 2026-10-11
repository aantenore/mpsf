import "../helpers/test-isolation.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordLineEndingsCheck } from "../../lib/engine/record-line-endings.mjs";

test("the record line-ending check is not applicable outside a git checkout", (t) => {
  // Outside the repository checkout, so git cannot find a parent repository.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-line-endings-plain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const check = recordLineEndingsCheck({ root, sdlcRoot: path.join(root, ".sdlc") });
  assert.equal(check.status, "not_applicable");
  assert.equal(check.warning, false);
  assert.match(check.details, /Not a git checkout/u);
});
