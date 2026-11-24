import { test } from "node:test";
import assert from "node:assert/strict";
import { backupVaultArn, buildPlanInput, countByState, resourceNameFromArn, scheduleExpression } from "../src/services/backup/helpers.ts";

test("Backup schedules", () => {
  assert.equal(scheduleExpression("daily"), "cron(0 5 ? * * *)");
  assert.equal(scheduleExpression("hourly"), "cron(0 * ? * * *)");
  assert.equal(scheduleExpression("custom", " cron(0 1 * * ? *) "), "cron(0 1 * * ? *)");
  assert.throws(() => scheduleExpression("custom", "rate(1 day)"), /cron expression/);
  assert.throws(() => scheduleExpression("yearly"), /Unknown/);
});

test("Backup plan input, with lifecycle and a cross-Region copy", () => {
  const plan = buildPlanInput({ planName: "p", ruleName: "r", vaultName: "v", schedule: "cron(0 5 ? * * *)", deleteAfterDays: 35, copyToVaultArn: backupVaultArn("us-west-2", "000000000000", "dr"), copyDeleteAfterDays: 7 });
  assert.equal(plan.Rules[0].CopyActions?.[0].DestinationBackupVaultArn, "arn:aws:backup:us-west-2:000000000000:backup-vault:dr");
  assert.deepEqual(plan.Rules[0].Lifecycle, { MoveToColdStorageAfterDays: undefined, DeleteAfterDays: 35 });
  assert.equal(buildPlanInput({ planName: "p", ruleName: "r", vaultName: "v", schedule: "x" }).Rules[0].Lifecycle, undefined);
  assert.throws(() => buildPlanInput({ planName: "p", ruleName: "r", vaultName: "v", schedule: "x", coldAfterDays: 30, deleteAfterDays: 60 }), /90 days/);
});

test("Backup display helpers", () => {
  assert.equal(resourceNameFromArn("arn:aws:dynamodb:us-east-1:0:table/orders"), "orders");
  assert.equal(resourceNameFromArn("arn:aws:s3:::bucket"), "bucket");
  assert.equal(resourceNameFromArn(undefined), null);
  assert.deepEqual(countByState([{ status: "COMPLETED" }, { status: "FAILED" }, { status: "COMPLETED" }, {}], "status"), [
    { state: "COMPLETED", count: 2 },
    { state: "FAILED", count: 1 },
    { state: "UNKNOWN", count: 1 },
  ]);
});
