import { test } from "node:test";
import assert from "node:assert/strict";
import { arnTail, buildAsff, buildRuleCriteria, criteriaRows, defaultProductArn, isSeverity, isWorkflowStatus } from "../src/services/securityhub/helpers.ts";

test("Security Hub: ASFF import document", () => {
  const doc = buildAsff({ id: "f-1", title: "t", description: "d", severity: "HIGH", type: "TTPs/Initial Access", resourceType: "", resourceId: "arn:aws:s3:::b", generatorId: "", region: "us-east-1", account: "000000000000", now: "2026-01-01T00:00:00Z" });
  assert.equal(doc.ProductArn, "arn:aws:securityhub:us-east-1:000000000000:product/000000000000/default");
  assert.equal(doc.SchemaVersion, "2018-10-08");
  assert.deepEqual(doc.Resources, [{ Type: "Other", Id: "arn:aws:s3:::b", Region: "us-east-1" }]);
  assert.equal(doc.GeneratorId, "custom");
  assert.throws(() => buildAsff({ id: " ", title: "t", description: "d", severity: "LOW", type: "x", resourceType: "", resourceId: "r", generatorId: "", region: "r", account: "a", now: "n" }));
  assert.equal(defaultProductArn("eu-west-1", "1"), "arn:aws:securityhub:eu-west-1:1:product/1/default");
});

test("Security Hub: automation rule criteria and labels", () => {
  const c = buildRuleCriteria({ severities: ["LOW", "BOGUS"], productName: "Security Hub", resourceType: "", titlePrefix: "[SAMPLE]", complianceStatus: "" });
  assert.deepEqual(c.SeverityLabel, [{ Value: "LOW", Comparison: "EQUALS" }]);
  assert.deepEqual(c.Title, [{ Value: "[SAMPLE]", Comparison: "PREFIX" }]);
  assert.throws(() => buildRuleCriteria({ severities: [], productName: "", resourceType: "", titlePrefix: "", complianceStatus: "" }));
  assert.deepEqual(criteriaRows({ SeverityLabel: [{ Value: "LOW", Comparison: "EQUALS" }, { Value: "HIGH", Comparison: "EQUALS" }] }), [{ field: "SeverityLabel", condition: "EQUALS LOW OR EQUALS HIGH" }]);
  assert.equal(arnTail("arn:aws:securityhub:us-east-1:0:automation-rule/abc"), "abc");
  assert.equal(arnTail(undefined), "");
  assert.equal(isSeverity("CRITICAL"), true);
  assert.equal(isWorkflowStatus("DONE"), false);
});
