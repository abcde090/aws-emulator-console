import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyHistory, moveHistory, pushHistory } from "../src/components/shell/history.ts";
import { filterServices, groupByCategory } from "../src/components/shell/service-search.ts";

test("CloudShell history: up and down walk through earlier commands", () => {
  let h = emptyHistory;
  for (const c of ["aws s3 ls", "aws sqs list-queues", "aws sqs list-queues", "  "]) h = pushHistory(h, c);
  assert.deepEqual(h.entries, ["aws s3 ls", "aws sqs list-queues"]);
  let m = moveHistory(h, "up");
  assert.equal(m.line, "aws sqs list-queues");
  m = moveHistory(m.history, "up");
  assert.equal(m.line, "aws s3 ls");
  m = moveHistory(m.history, "up");
  assert.equal(m.line, "aws s3 ls");
  m = moveHistory(m.history, "down");
  m = moveHistory(m.history, "down");
  assert.equal(m.line, "");
});

test("service search matches every word and groups by category", () => {
  const services = [
    { id: "sqs", name: "Amazon SQS", category: "Application Integration", description: "Message queues" },
    { id: "s3", name: "Amazon S3", category: "Storage", description: "Object storage" },
  ];
  assert.deepEqual(filterServices(services, "queue").map((s) => s.id), ["sqs"]);
  assert.deepEqual(filterServices(services, "amazon s3").map((s) => s.id), ["s3"]);
  assert.deepEqual(filterServices(services, ""), []);
  assert.deepEqual(groupByCategory(services).map((g) => g.category), ["Application Integration", "Storage"]);
});

test("OG-11: arrow keys move through search results and wrap", async () => {
  const { moveActive } = await import("../src/components/shell/service-search.ts");
  assert.equal(moveActive(0, 1, 3), 1);
  assert.equal(moveActive(2, 1, 3), 0);
  assert.equal(moveActive(0, -1, 3), 2);
  assert.equal(moveActive(5, 1, 0), 0);
});
