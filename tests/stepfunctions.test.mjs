import { test } from "node:test";
import assert from "node:assert/strict";
import { HELLO_WORLD, historyRows, stateMachineArnOfExecution, statesOf } from "../src/services/stepfunctions/helpers.ts";

test("Step Functions execution ARN -> state machine ARN", () => {
  assert.equal(stateMachineArnOfExecution("arn:aws:states:us-east-1:000000000000:execution:sm:ex1"), "arn:aws:states:us-east-1:000000000000:stateMachine:sm");
  assert.equal(stateMachineArnOfExecution("arn:aws:states:us-east-1:000000000000:express:sm:a:b"), "arn:aws:states:us-east-1:000000000000:stateMachine:sm");
  assert.equal(stateMachineArnOfExecution("nope"), null);
});

test("Step Functions states table from a definition", () => {
  const rows = statesOf(HELLO_WORLD);
  assert.deepEqual(rows.map((r) => [r.name, r.type, r.next]), [
    ["Pass", "Pass", "Wait 3 sec"],
    ["Wait 3 sec", "Wait", "Is Hello World Example?"],
    ["Is Hello World Example?", "Choice", "Hello World, Fail"],
    ["Hello World", "Succeed", "End"],
    ["Fail", "Fail", "End"],
  ]);
  assert.deepEqual(statesOf("not json"), []);
  assert.deepEqual(statesOf(undefined), []);
});

test("Step Functions history rows carry the step and elapsed time", () => {
  const t = (ms) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));
  const rows = historyRows([
    { id: 1, type: "ExecutionStarted", timestamp: t(0), executionStartedEventDetails: { input: "{}" } },
    { id: 2, type: "PassStateEntered", timestamp: t(5), stateEnteredEventDetails: { name: "P", input: "{}" } },
    { id: 3, type: "PassStateExited", timestamp: t(9), stateExitedEventDetails: { name: "P", output: '{"x":1}' } },
    { id: 4, type: "ExecutionFailed", timestamp: t(20), executionFailedEventDetails: { error: "E", cause: "c" } },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.step, r.elapsedMs]), [[1, null, 0], [2, "P", 5], [3, "P", 9], [4, null, 20]]);
  assert.equal(rows[3].details, "error: E\ncause: c");
  assert.equal(rows[0].timestamp, "2026-01-01T00:00:00.000Z");
});

test("Step Functions: Stop and Redrive are offered only where they apply", async () => {
  const { canRedrive, canStop } = await import("../src/services/stepfunctions/helpers.ts");
  assert.equal(canStop({ status: "RUNNING" }), true);
  assert.equal(canStop({ status: "SUCCEEDED" }), false);
  assert.equal(canStop({ "Execution status": "FAILED" }), false);
  assert.equal(canStop({}), true);
  assert.equal(canRedrive({ status: "SUCCEEDED" }), false);
  assert.equal(canRedrive({ status: "RUNNING" }), false);
  assert.equal(canRedrive({ status: "FAILED" }), true);
  assert.equal(canRedrive({ "Execution status": "TIMED_OUT", "Redrive status": "REDRIVABLE" }), true);
  assert.equal(canRedrive({ "Execution status": "FAILED", "Redrive status": "NOT_REDRIVABLE" }), false);
});
