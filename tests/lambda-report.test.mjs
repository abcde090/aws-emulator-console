import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLambdaReport } from "../src/lib/lambda-code.ts";

test("reads the figures from Lambda's REPORT line", () => {
  const logs = "START RequestId: a\nEND RequestId: a\nREPORT RequestId: a\tDuration: 12.34 ms\tBilled Duration: 13 ms\tMemory Size: 256 MB\tMax Memory Used: 71 MB\t\n";
  assert.deepEqual(parseLambdaReport(logs), { durationMs: 12.34, billedDurationMs: 13, memorySizeMb: 256, maxMemoryUsedMb: 71 });
});

test("a missing figure is null, never a made-up number", () => {
  assert.deepEqual(parseLambdaReport("REPORT RequestId: a\tDuration: 5 ms"), {
    durationMs: 5, billedDurationMs: null, memorySizeMb: null, maxMemoryUsedMb: null,
  });
  assert.deepEqual(parseLambdaReport(""), { durationMs: null, billedDurationMs: null, memorySizeMb: null, maxMemoryUsedMb: null });
});
