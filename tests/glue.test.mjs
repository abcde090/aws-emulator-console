import { test } from "node:test";
import assert from "node:assert/strict";
import { glueSchedule, parseColumns, storageFormat } from "../src/services/glue/helpers.ts";

test("Glue schema text becomes columns", () => {
  assert.deepEqual(parseColumns("id int\n\n# note\nname string customer name\namount decimal(10,2)\ntags array<string>"), [
    { Name: "id", Type: "int" },
    { Name: "name", Type: "string", Comment: "customer name" },
    { Name: "amount", Type: "decimal(10,2)" },
    { Name: "tags", Type: "array<string>" },
  ]);
  assert.deepEqual(parseColumns(undefined), []);
  assert.throws(() => parseColumns("justname"), /line 1/);
  assert.throws(() => parseColumns("1bad int"), /not a valid column name/);
  assert.throws(() => parseColumns("a int\nA string"), /appears twice/);
});

test("Glue formats and schedules", () => {
  assert.equal(storageFormat("csv", "|").SerdeInfo.Parameters?.["field.delim"], "|");
  assert.match(storageFormat("parquet").InputFormat, /Parquet/);
  assert.throws(() => storageFormat("xml"), /Unknown/);
  assert.equal(glueSchedule("on-demand"), undefined);
  assert.equal(glueSchedule("daily"), "cron(0 0 * * ? *)");
  assert.throws(() => glueSchedule("custom", "every day"), /cron/);
});


test("Glue crawler schedules map back to the Edit schedule form", async () => {
  const { scheduleChoice, glueSchedule } = await import("../src/services/glue/helpers.ts");
  assert.deepEqual(scheduleChoice(undefined), { frequency: "on-demand", cron: "" });
  assert.deepEqual(scheduleChoice(glueSchedule("daily")), { frequency: "daily", cron: "" });
  assert.deepEqual(scheduleChoice("cron(15 12 * * ? *)"), { frequency: "custom", cron: "cron(15 12 * * ? *)" });
});
