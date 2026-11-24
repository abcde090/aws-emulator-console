import { test } from "node:test";
import assert from "node:assert/strict";
import { checkName, checkSql, formatRunTime, optionalName, shapeResults } from "../src/services/athena/helpers.ts";

const meta = (...names) => ({ ColumnInfo: names.map((n) => ({ Name: n, Label: n, Type: "varchar" })) });
const rows = (...rs) => rs.map((r) => ({ Data: r.map((v) => (v === null ? {} : { VarCharValue: v })) }));

test("Athena results drop the header row only on the first page of a SELECT", () => {
  const rs = { ResultSetMetadata: meta("a", "b"), Rows: rows(["a", "b"], ["1", null]) };
  assert.deepEqual(shapeResults(rs, true), { columns: [{ name: "a", type: "varchar" }, { name: "b", type: "varchar" }], rows: [["1", null]] });
  assert.equal(shapeResults(rs, false).rows.length, 2);
  // SHOW TABLES has no header row.
  const show = { ResultSetMetadata: meta("tab_name"), Rows: rows(["people"], ["t2"]) };
  assert.deepEqual(shapeResults(show, true).rows, [["people"], ["t2"]]);
  assert.deepEqual(shapeResults(undefined, true), { columns: [], rows: [] });
  assert.deepEqual(shapeResults({ Rows: rows(["x", "y"]) }, true).columns.map((c) => c.name), ["_col0", "_col1"]);
});

test("Athena editor input checks", () => {
  assert.equal(formatRunTime(950), "950 ms");
  assert.equal(formatRunTime(3000), "3.00 sec");
  assert.equal(formatRunTime(null), "-");
  assert.throws(() => checkSql("  "), /Enter a query/);
  assert.equal(checkSql("SELECT 1"), "SELECT 1");
  assert.equal(checkName("primary", "Workgroup"), "primary");
  assert.throws(() => checkName("../x", "Workgroup"), /not valid/);
  assert.equal(optionalName("", "Database"), undefined);
  assert.equal(optionalName("probe_db", "Database"), "probe_db");
});
