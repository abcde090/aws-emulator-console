import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutGraph, timelineRows } from "../src/services/xray/helpers.ts";

test("X-Ray segments become a nested timeline", () => {
  const seg = JSON.stringify({ id: "a", name: "api", start_time: 10, end_time: 11, http: { request: { method: "GET", url: "/x" }, response: { status: 502 } }, subsegments: [{ id: "s1", name: "DynamoDB", namespace: "aws", start_time: 10.1, end_time: 10.5 }] });
  const inferred = JSON.stringify({ id: "b", name: "DynamoDB", parent_id: "s1", inferred: true, start_time: 10.1, end_time: 10.5, throttle: true });
  const rows = timelineRows([inferred, seg, "not json"]);
  assert.deepEqual(rows.map((r) => [r.name, r.depth, r.kind, r.status]), [
    ["api", 0, "segment", "Fault"],
    ["DynamoDB", 1, "subsegment", "OK"],
    ["DynamoDB", 1, "segment", "Throttle"],
  ]);
  assert.equal(rows[0].method, "GET");
});

test("X-Ray service graph layout puts callers left of callees", () => {
  const nodes = layoutGraph([{ id: 1, name: "client", type: null, edges: [2], root: true }, { id: 2, name: "api", type: null, edges: [3], root: false }, { id: 3, name: "db", type: "AWS::DynamoDB", edges: [], root: false }], 900, 90);
  const x = (n) => nodes.find((v) => v.name === n).x;
  assert.ok(x("client") < x("api") && x("api") < x("db"));
});

test("X-Ray: Delete is not offered for the Default sampling rule or the Default group (OG-9)", async () => {
  const { getResource } = await import("../src/console/registry.ts");
  const { unavailableActions } = await import("../src/console/meta.ts");
  for (const [resourceId, detailKey] of [["sampling-rules", "Name"], ["groups", "Group name"]]) {
    const r = getResource("xray", resourceId);
    assert.ok(r?.delete?.availableFor, resourceId);
    assert.equal(r.delete.availableFor({ name: "Default" }), false);
    assert.equal(r.delete.availableFor({ [detailKey]: "Default" }), false);
    assert.equal(r.delete.availableFor({ name: "dedup-rule" }), true);
    assert.ok(unavailableActions(r.actions, { name: "Default" }, r.delete).includes("$delete"));
  }
});
