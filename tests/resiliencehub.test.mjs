import { test } from "node:test";
import assert from "node:assert/strict";
import { arnId, policyRows, secondsLabel } from "../src/services/resiliencehub/helpers.ts";

test("Resilience Hub helpers", () => {
  assert.equal(arnId("arn:aws:resiliencehub:us-east-1:0:app/abc-123"), "abc-123");
  assert.equal(secondsLabel(90), "1m 30s");
  assert.equal(secondsLabel(86400), "1d");
  assert.equal(secondsLabel(0), "0s");
  assert.equal(secondsLabel(undefined), "-");
  assert.deepEqual(policyRows({ AZ: { rtoInSecs: 1, rpoInSecs: 2 }, Software: { rtoInSecs: 3, rpoInSecs: 4 } }).map((r) => r.disruption), ["Customer application", "Cloud infrastructure Availability Zone"]);
});
