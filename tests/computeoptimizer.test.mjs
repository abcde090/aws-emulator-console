import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findingLabel,
  formatPercent,
  formatSavings,
  idFromArn,
  lambdaId,
  metricText,
  optInMessage,
  parsePreferenceId,
  preferenceId,
  preferenceRow,
  setPreferenceNames,
  splitList,
  summarizeFindings,
} from "../src/services/computeoptimizer/helpers.ts";

test("Compute Optimizer: savings and findings formatting", () => {
  assert.equal(formatSavings({ estimatedMonthlySavings: { currency: "USD", value: 140.16 } }), "$140.16/month");
  assert.equal(formatSavings({ estimatedMonthlySavings: { currency: "EUR", value: 1 } }), "1.00 EUR/month");
  assert.equal(formatSavings(undefined), null);
  assert.equal(formatPercent({ savingsOpportunityPercentage: 28.57 }), "28.57%");
  assert.equal(formatPercent({}), null);
  assert.equal(findingLabel("OVER_PROVISIONED"), "Over-provisioned");
  assert.equal(findingLabel("Overprovisioned"), "Over-provisioned");
  assert.equal(findingLabel("NotOptimized"), "Not optimized");
  assert.equal(findingLabel("NOT_OPTIMIZED"), "Not optimized");
  assert.equal(findingLabel("SomethingNew"), "Something new");
  assert.equal(findingLabel(""), null);
  assert.equal(summarizeFindings([{ name: "OPTIMIZED", value: 2 }, { name: "Unused" }]), "Optimized: 2, Unused: 0");
  assert.equal(summarizeFindings([]), null);
});

test("Compute Optimizer: ids from ARNs", () => {
  assert.equal(idFromArn("arn:aws:ec2:us-east-1:000000000000:instance/i-1"), "i-1");
  assert.equal(idFromArn("arn:aws:lambda:us-east-1:000000000000:function:fn"), "fn");
  assert.equal(idFromArn(undefined), null);
  assert.equal(lambdaId("arn:aws:lambda:us-east-1:000000000000:function:fn", "$LATEST"), "fn:$LATEST");
  assert.equal(lambdaId("arn:aws:lambda:us-east-1:000000000000:function:fn", undefined), "fn");
  assert.equal(lambdaId("nope", "1"), null);
  assert.equal(metricText([{ name: "Cpu", statistic: "Maximum", value: 45 }], "Cpu"), "45");
  assert.equal(metricText([{ name: "Duration", statistic: "Expected", value: 4 }], "Duration", "Expected"), "4");
  assert.equal(metricText([], "Cpu"), null);
});

test("Compute Optimizer: preference ids and rows", () => {
  const id = preferenceId("AutoScalingGroup", "ResourceArn", "arn:aws:autoscaling:us-east-1:000000000000:autoScalingGroup:x:autoScalingGroupName/a|b");
  assert.deepEqual(parsePreferenceId(id), { resourceType: "AutoScalingGroup", scopeName: "ResourceArn", scopeValue: "arn:aws:autoscaling:us-east-1:000000000000:autoScalingGroup:x:autoScalingGroupName/a|b" });
  assert.equal(parsePreferenceId("Ec2Instance"), null);
  assert.equal(parsePreferenceId("Ec2Instance||x"), null);
  assert.equal(parsePreferenceId("Ec2Instance|AccountId|"), null);
  const p = {
    resourceType: "Ec2Instance",
    scope: { name: "AccountId", value: "000000000000" },
    enhancedInfrastructureMetrics: "Active",
    lookBackPeriod: "DAYS_32",
    utilizationPreferences: [{ metricName: "CpuUtilization", metricParameters: { threshold: "P95", headroom: "PERCENT_30" } }],
    preferredResources: [{ name: "Ec2InstanceTypes", includeList: ["m5.*"] }],
    savingsEstimationMode: "AfterDiscounts",
  };
  const row = preferenceRow(p);
  assert.equal(row.id, "Ec2Instance|AccountId|000000000000");
  assert.equal(row.scope, "Account 000000000000");
  assert.equal(row.lookBackPeriod, "32 days");
  assert.equal(row.utilization, "CpuUtilization (threshold P95, headroom PERCENT_30)");
  assert.equal(row.preferredResources, "Ec2InstanceTypes: include m5.*");
  assert.deepEqual(setPreferenceNames(p), ["EnhancedInfrastructureMetrics", "LookBackPeriodPreference", "PreferredResources", "UtilizationPreferences"]);
  assert.deepEqual(setPreferenceNames({ savingsEstimationMode: "AfterDiscounts" }), []);
  assert.equal(preferenceRow({ resourceType: "Ec2Instance", scope: { name: "Organization", value: "ALL_ACCOUNTS" } }).scope, "Organization (all accounts)");
  assert.deepEqual(splitList(" m5.*, c6g.large  r5 "), ["m5.*", "c6g.large", "r5"]);
  assert.deepEqual(splitList(null), []);
});

test("Compute Optimizer: opt-in error message", () => {
  const e = new Error("The account is not opted in");
  e.name = "OptInRequiredException";
  assert.match(optInMessage(e)?.message ?? "", /^OptInRequiredException: .*Account page/);
  assert.equal(optInMessage(new Error("other")), null);
});
