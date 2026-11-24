import { test } from "node:test";
import assert from "node:assert/strict";
import { complianceLabel, MANAGED_RULES, managedRule, parseJsonObject, queryRows, resourceKey, splitResourceKey } from "../src/services/config/helpers.ts";

test("Config: resource keys survive ids with slashes and colons", () => {
  const key = resourceKey("AWS::SQS::Queue", "https://sqs.us-east-1.amazonaws.com/0/jobs");
  assert.deepEqual(splitResourceKey(key), { type: "AWS::SQS::Queue", id: "https://sqs.us-east-1.amazonaws.com/0/jobs" });
  assert.throws(() => splitResourceKey("nobar"));
});

test("Config: query rows, compliance labels, managed rules", () => {
  const r = queryRows(['{"resourceId":"a","configuration":{"name":"x"}}', '{"resourceId":"b","tags":[1]}', "not json"]);
  assert.deepEqual(r.columns, ["resourceId", "configuration.name", "tags", "value"]);
  assert.equal(r.rows[1].tags, "[1]");
  assert.equal(r.rows[2].value, "not json");
  assert.deepEqual(queryRows(undefined), { columns: [], rows: [] });
  assert.equal(complianceLabel("NON_COMPLIANT", 3), "3 Noncompliant resource(s)");
  assert.equal(complianceLabel("COMPLIANT", undefined), "Compliant");
  assert.equal(complianceLabel(undefined, undefined), "No results reported");
  assert.equal(managedRule("S3_BUCKET_VERSIONING_ENABLED").scope[0], "AWS::S3::Bucket");
  assert.equal(new Set(MANAGED_RULES.map((m) => m.id)).size, MANAGED_RULES.length);
  for (const m of MANAGED_RULES) if (m.parameters) assert.equal(typeof JSON.parse(m.parameters), "object");
  assert.equal(parseJsonObject("", "x"), undefined);
  assert.throws(() => parseJsonObject("[]", "x"));
});
