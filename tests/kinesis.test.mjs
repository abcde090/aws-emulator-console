import { test } from "node:test";
import assert from "node:assert/strict";
import { lines, metricChanges, retentionChange } from "../src/services/kinesis/helpers.ts";

test("Kinesis retention and metric changes", () => {
  assert.equal(retentionChange(24, 48), "increase");
  assert.equal(retentionChange(48, 24), "decrease");
  assert.equal(retentionChange(24, 24), "none");
  assert.equal(retentionChange(undefined, 24), "increase");
  assert.deepEqual(metricChanges(["IncomingBytes", "OutgoingBytes"], ["IncomingBytes", "IncomingRecords"]), { enable: ["IncomingRecords"], disable: ["OutgoingBytes"] });
  assert.deepEqual(metricChanges(["ALL"], []), { enable: [], disable: [] });
  assert.deepEqual(lines("a\n\n b \r\nc"), ["a", " b ", "c"]);
});
