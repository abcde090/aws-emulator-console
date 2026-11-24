import { test } from "node:test";
import assert from "node:assert/strict";
import { isRateValue, maskValue, parseDocParameters, shortBaselineId, tagTarget } from "../src/services/ssm/helpers.ts";

test("SSM document parameters and targets", () => {
  assert.deepEqual(parseDocParameters('{"commands": ["echo a", "echo b"], "workingDirectory": "/tmp", "n": 3}'), { commands: ["echo a", "echo b"], workingDirectory: ["/tmp"], n: ["3"] });
  assert.deepEqual(parseDocParameters(""), {});
  assert.throws(() => parseDocParameters("[1]"), /JSON object/);
  assert.throws(() => parseDocParameters('{"a": {"b": 1}}'), /string/);
  assert.deepEqual(tagTarget("Env=prod, dev"), { Key: "tag:Env", Values: ["prod", "dev"] });
  assert.throws(() => tagTarget("Env"), /Key=Value/);
  assert.equal(isRateValue("10"), true);
  assert.equal(isRateValue("25%"), true);
  assert.equal(isRateValue("101%"), false);
  assert.equal(isRateValue("x"), false);
  assert.equal(shortBaselineId("arn:aws:ssm:us-east-1:1:patchbaseline/pb-123"), "pb-123");
  assert.equal(shortBaselineId("pb-9"), "pb-9");
  assert.equal(maskValue("SecureString", "s", false), "****");
  assert.equal(maskValue("SecureString", "s", true), "s");
});
