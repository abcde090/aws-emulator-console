import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCriterion, criterionRows, featureLabel, severityLabel } from "../src/services/guardduty/helpers.ts";

test("GuardDuty: severity bands", () => {
  assert.equal(severityLabel(2), "Low");
  assert.equal(severityLabel(4), "Medium");
  assert.equal(severityLabel(8.9), "High");
  assert.equal(severityLabel(9), "Critical");
  assert.equal(severityLabel("x"), null);
});

test("GuardDuty: suppression rule criteria", () => {
  const c = buildCriterion({ findingType: "Recon:EC2/PortProbeUnprotectedPort, UnauthorizedAccess:EC2/SSHBruteForce", minSeverity: "High", resourceType: "Instance" });
  assert.deepEqual(c.type.Eq, ["Recon:EC2/PortProbeUnprotectedPort", "UnauthorizedAccess:EC2/SSHBruteForce"]);
  assert.equal(c.severity.GreaterThanOrEqual, 7);
  assert.deepEqual(c["resource.resourceType"], { Eq: ["Instance"] });
  const adv = buildCriterion({ advanced: '{"service.archived":{"Eq":["false"]}}' });
  assert.deepEqual(adv["service.archived"], { Eq: ["false"] });
  assert.throws(() => buildCriterion({}));
  assert.throws(() => buildCriterion({ advanced: "[1]" }));
  assert.deepEqual(criterionRows({ severity: { Lt: 4, LessThan: 4 } }), [{ attribute: "severity", condition: "< 4" }]);
  assert.equal(featureLabel("S3_DATA_EVENTS"), "S3 Protection");
  assert.equal(featureLabel("NEW_THING"), "NEW_THING");
});
