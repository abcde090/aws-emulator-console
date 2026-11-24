import { test } from "node:test";
import assert from "node:assert/strict";
import { actionParameters, selectionMode, targetSpec } from "../src/services/fis/helpers.ts";

test("FIS template form helpers", () => {
  assert.deepEqual(actionParameters('{"duration": "PT5M", "n": 2}'), { duration: "PT5M", n: "2" });
  assert.equal(actionParameters(""), undefined);
  assert.throws(() => actionParameters('{"a": [1]}'), /string/);
  assert.equal(selectionMode("count(2)"), "COUNT(2)");
  assert.equal(selectionMode(""), "ALL");
  assert.throws(() => selectionMode("PERCENT(200)"), /100/);
  assert.throws(() => selectionMode("SOME"), /ALL/);
  assert.deepEqual(targetSpec("tags", "chaos=ready, env = dev", ""), { resourceTags: { chaos: "ready", env: "dev" } });
  assert.deepEqual(targetSpec("arns", "", "arn:aws:ec2:x\narn:aws:ec2:y"), { resourceArns: ["arn:aws:ec2:x", "arn:aws:ec2:y"] });
  assert.throws(() => targetSpec("arns", "", "i-123"), /arn:/);
  assert.throws(() => targetSpec("tags", "", ""), /Key=Value/);
});
