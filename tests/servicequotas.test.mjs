import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDesiredValue, mergeQuotas } from "../src/services/servicequotas/helpers.ts";

test("Service Quotas merge applied and default values", () => {
  const rows = mergeQuotas(
    [{ QuotaCode: "L-1", QuotaName: "B quota", Value: 80, Adjustable: true, Unit: "None" }],
    [{ QuotaCode: "L-1", QuotaName: "B quota", Value: 5 }, { QuotaCode: "L-2", QuotaName: "A quota", Value: 10, Unit: "Count" }]
  );
  assert.deepEqual(rows.map((r) => [r.code, r.applied, r.defaultValue, r.adjustable, r.unit]), [
    ["L-2", null, 10, false, "Count"],
    ["L-1", 80, 5, true, null],
  ]);
  assert.equal(checkDesiredValue(81, 80), null);
  assert.match(checkDesiredValue(80, 80), /greater than the current/);
  assert.match(checkDesiredValue(Number.NaN, 1), /Enter/);
});
