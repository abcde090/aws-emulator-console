import { test } from "node:test";
import assert from "node:assert/strict";
import { canStartTask, defaultPort, defaultStartType, endpointTypeLabel, migrationTypeLabel, prettyJson, selectionRules, tableMappingProblem, taskSettings } from "../src/services/dms/helpers.ts";

test("DMS table mappings", () => {
  const rules = JSON.parse(selectionRules("shop", " ", "exclude"));
  assert.deepEqual(rules.rules[0]["object-locator"], { "schema-name": "shop", "table-name": "%" });
  assert.equal(rules.rules[0]["rule-action"], "exclude");
  assert.equal(tableMappingProblem(selectionRules("%", "%", "include")), null);
  assert.match(tableMappingProblem("{"), /valid JSON/);
  assert.match(tableMappingProblem('{"rules":[]}'), /at least one rule/);
  assert.match(tableMappingProblem('{"rules":[{"rule-type":"transformation"}]}'), /selection rule/);
});

test("DMS task settings and labels", () => {
  const s = JSON.parse(taskSettings("TRUNCATE_BEFORE_LOAD", "none", true));
  assert.equal(s.FullLoadSettings.TargetTablePrepMode, "TRUNCATE_BEFORE_LOAD");
  assert.equal(s.TargetMetadata.SupportLobs, false);
  assert.equal(s.ValidationSettings.EnableValidation, true);
  assert.equal(JSON.parse(taskSettings("DO_NOTHING", "full", false)).TargetMetadata.FullLobMode, true);
  assert.equal(migrationTypeLabel("cdc"), "Replicate data changes only");
  assert.equal(endpointTypeLabel("SOURCE"), "Source");
  assert.deepEqual(prettyJson('{"a":1}'), { a: 1 });
  assert.equal(prettyJson("x"), "x");
  assert.equal(prettyJson(undefined), null);
});

test("endpoint ports default per engine", () => {
  assert.equal(defaultPort("postgres"), 5432);
  assert.equal(defaultPort("aurora-postgresql"), 5432);
  assert.equal(defaultPort("mysql"), 3306);
  assert.equal(defaultPort("oracle"), 1521);
  assert.equal(defaultPort("sqlserver"), 1433);
  assert.equal(defaultPort("nope"), undefined);
});

test("tasks can be started only when ready, stopped or failed", () => {
  for (const s of ["ready", "stopped", "failed", "Stopped", undefined, ""]) assert.equal(canStartTask(s), true, String(s));
  for (const s of ["running", "starting", "stopping", "creating", "deleting"]) assert.equal(canStartTask(s), false, s);
  assert.equal(defaultStartType("stopped"), "resume-processing");
  assert.equal(defaultStartType("failed"), "resume-processing");
  assert.equal(defaultStartType("ready"), "start-replication");
});
