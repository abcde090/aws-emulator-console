import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInputPaths, parseRuleArn, parseScheduleId, patternFromForm, scheduleExpression, scheduleId, targetType } from "../src/services/eventbridge/helpers.ts";

test("EventBridge rule ARNs give bus and name", () => {
  assert.deepEqual(parseRuleArn("arn:aws:events:us-east-1:000000000000:rule/r1"), { bus: "default", name: "r1" });
  assert.deepEqual(parseRuleArn("arn:aws:events:us-east-1:000000000000:rule/orders/r1"), { bus: "orders", name: "r1" });
  assert.deepEqual(parseRuleArn("arn:aws:events:us-east-1:000000000000:rule/aws.partner/x/y/r1"), { bus: "aws.partner/x/y", name: "r1" });
  assert.equal(parseRuleArn("arn:aws:events:us-east-1:000000000000:event-bus/x"), null);
  assert.equal(parseRuleArn("r1"), null);
});

test("EventBridge target types and patterns", () => {
  assert.equal(targetType("arn:aws:sqs:us-east-1:000000000000:q"), "SQS queue");
  assert.equal(targetType("arn:aws:states:us-east-1:000000000000:stateMachine:s"), "Step Functions state machine");
  assert.equal(patternFromForm("a, b", "X"), '{"source":["a","b"],"detail-type":["X"]}');
  assert.throws(() => patternFromForm(" ", ""), /event source/);
  assert.deepEqual(parseInputPaths('{"s":"$.source"}'), { s: "$.source" });
  assert.throws(() => parseInputPaths('{"s":1}'), /JSONPath/);
});

test("Scheduler expressions and ids", () => {
  assert.equal(scheduleExpression("at", { at: "2026-12-31T09:00" }), "at(2026-12-31T09:00:00)");
  assert.equal(scheduleExpression("at", { at: "2026-12-31T09:00:00Z" }), "at(2026-12-31T09:00:00)");
  assert.throws(() => scheduleExpression("at", { at: "tomorrow" }), /yyyy-mm-dd/);
  assert.equal(scheduleExpression("rate", { rateValue: 1, rateUnit: "hours" }), "rate(1 hour)");
  assert.equal(scheduleExpression("rate", { rateValue: 5, rateUnit: "minutes" }), "rate(5 minutes)");
  assert.throws(() => scheduleExpression("rate", { rateValue: 0 }), /whole number/);
  assert.equal(scheduleExpression("cron", { cron: "0 12 * * ? *" }), "cron(0 12 * * ? *)");
  assert.throws(() => scheduleExpression("cron", { cron: "0 12 * *" }), /six fields/);
  assert.deepEqual(parseScheduleId(scheduleId("g", "n")), { group: "g", name: "n" });
  assert.deepEqual(parseScheduleId("n"), { group: "default", name: "n" });
});

test("EventBridge Scheduler: schedule expressions round-trip through the edit form", async () => {
  const { parseScheduleExpression, scheduleExpression } = await import("../src/services/eventbridge/helpers.ts");
  for (const expr of ["rate(1 minute)", "rate(10 minutes)", "rate(2 hours)", "rate(1 day)", "cron(0 12 * * ? *)", "at(2026-12-31T09:00:00)"]) {
    const p = parseScheduleExpression(expr);
    assert.equal(scheduleExpression(p.kind, p), expr, expr);
  }
  assert.deepEqual(parseScheduleExpression("rate(1 hour)"), { kind: "rate", at: "", rateValue: 1, rateUnit: "hours", cron: "" });
  assert.throws(() => parseScheduleExpression("every day"), /Unrecognised/);
});

test("EventBridge: Enable and Disable are offered by state", async () => {
  const { canDisable, canEnable } = await import("../src/services/eventbridge/helpers.ts");
  assert.equal(canEnable({ state: "ENABLED" }), false);
  assert.equal(canEnable({ Status: "DISABLED" }), true);
  assert.equal(canEnable({ state: "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS" }), false);
  assert.equal(canDisable({ Status: "DISABLED" }), false);
  assert.equal(canDisable({ state: "ENABLED" }), true);
  assert.equal(canEnable({}), true);
  assert.equal(canDisable({}), true);
});
