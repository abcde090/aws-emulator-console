import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDateRange, decodeNotification, encodeNotification, flattenCostResults, invalidEmails, money, percentOf, splitList } from "../src/services/cost/helpers.ts";
import { parseRules } from "../src/services/cost/explorer.ts";

test("money and percentOf", () => {
  assert.equal(money({ Amount: "1234.5", Unit: "USD" }), "$1,234.50");
  assert.equal(money({ Amount: "10", Unit: "Hrs" }), "10.00 Hrs");
  assert.equal(money(undefined), null);
  assert.equal(percentOf({ Amount: "25" }, { Amount: "100" }), "25.00%");
  assert.equal(percentOf({ Amount: "25" }, { Amount: "0" }), null);
  assert.equal(percentOf(undefined, { Amount: "1" }), null);
});

test("splitList and invalidEmails", () => {
  assert.deepEqual(splitList(" a@x.com, b@y.com;a@x.com\n"), ["a@x.com", "b@y.com"]);
  assert.deepEqual(splitList(5), []);
  assert.deepEqual(invalidEmails(["a@x.com", "nope"]), ["nope"]);
});

test("notification keys round-trip and reject junk", () => {
  const n = { NotificationType: "ACTUAL", ComparisonOperator: "GREATER_THAN", Threshold: 80, ThresholdType: "PERCENTAGE" };
  assert.deepEqual(decodeNotification(encodeNotification(n)), n);
  assert.equal(decodeNotification("ACTUAL|GREATER_THAN|x|PERCENTAGE"), null);
  assert.equal(decodeNotification("NOPE|GREATER_THAN|1|PERCENTAGE"), null);
  assert.equal(decodeNotification("a|b"), null);
});

test("checkDateRange", () => {
  assert.equal(checkDateRange("2026-01-01", "2026-02-01"), null);
  assert.match(checkDateRange("2026-02-01", "2026-01-01"), /before/);
  assert.match(checkDateRange("x", "2026-01-01"), /Start/);
});

test("flattenCostResults handles groups and totals", () => {
  const rows = flattenCostResults(
    [
      { TimePeriod: { Start: "2026-01-01", End: "2026-02-01" }, Groups: [{ Keys: ["Amazon S3"], Metrics: { UnblendedCost: { Amount: "1.5", Unit: "USD" } } }] },
      { TimePeriod: { Start: "2026-02-01", End: "2026-03-01" }, Total: { UnblendedCost: { Amount: "0", Unit: "USD" } }, Estimated: true },
    ],
    "UnblendedCost"
  );
  assert.deepEqual(rows, [
    { period: "2026-01-01 – 2026-02-01", group: "Amazon S3", amount: "1.5", unit: "USD", estimated: false },
    { period: "2026-02-01 – 2026-03-01", group: "Total", amount: "0", unit: "USD", estimated: true },
  ]);
});

test("parseRules", () => {
  assert.equal(parseRules('[{"Value":"A","Rule":{}}]').length, 1);
  assert.throws(() => parseRules("[]"), /non-empty/);
  assert.throws(() => parseRules("{"), /valid JSON/);
  assert.throws(() => parseRules("[1]"), /object/);
});
