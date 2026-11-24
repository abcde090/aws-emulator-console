import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutDefinition, stateRuns } from "../src/services/stepfunctions/graph.ts";

const definition = JSON.stringify({
  StartAt: "Init",
  States: {
    Init: { Type: "Pass", Next: "Check" },
    Check: { Type: "Choice", Choices: [{ Variable: "$.x", NumericEquals: 1, Next: "Fan" }], Default: "Bad" },
    Fan: { Type: "Parallel", Branches: [{ StartAt: "A", States: { A: { Type: "Pass", End: true } } }, { StartAt: "B", States: { B: { Type: "Wait", Seconds: 1, End: true } } }], Next: "Each" },
    Each: { Type: "Map", ItemProcessor: { StartAt: "Item", States: { Item: { Type: "Pass", End: true } } }, Next: "Call" },
    Call: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Catch: [{ ErrorEquals: ["States.ALL"], Next: "Recovered" }], Next: "Done" },
    Recovered: { Type: "Pass", Next: "Boom" },
    Boom: { Type: "Fail", Error: "Probe" },
    Bad: { Type: "Fail" },
    Done: { Type: "Succeed" },
    Loop: { Type: "Pass", Next: "Init" },
  },
});

const entered = (id, prev, type, name, input = "{}") => ({ id, previousEventId: prev, type, stateEnteredEventDetails: { name, input } });
const exited = (id, prev, type, name, output = "{}") => ({ id, previousEventId: prev, type, stateExitedEventDetails: { name, output } });

// The shape AWS Emulator returned for this definition (ids and previousEventIds kept).
const events = [
  { id: 1, previousEventId: 0, type: "ExecutionStarted", executionStartedEventDetails: { input: "{}" } },
  entered(2, 0, "PassStateEntered", "Init"),
  exited(3, 2, "PassStateExited", "Init", '{"x":1}'),
  entered(4, 3, "ChoiceStateEntered", "Check", '{"x":1}'),
  exited(5, 4, "ChoiceStateExited", "Check", '{"x":1}'),
  entered(6, 5, "ParallelStateEntered", "Fan"),
  entered(8, 6, "PassStateEntered", "A"),
  exited(9, 8, "PassStateExited", "A"),
  entered(10, 9, "WaitStateEntered", "B"),
  exited(11, 10, "WaitStateExited", "B"),
  exited(13, 11, "ParallelStateExited", "Fan"),
  entered(14, 13, "MapStateEntered", "Each"),
  entered(17, 14, "PassStateEntered", "Item", "1"),
  exited(18, 17, "PassStateExited", "Item", "1"),
  entered(21, 18, "PassStateEntered", "Item", "2"),
  exited(22, 21, "PassStateExited", "Item", "2"),
  exited(25, 22, "MapStateExited", "Each"),
  entered(26, 25, "TaskStateEntered", "Call"),
  { id: 27, previousEventId: 26, type: "TaskScheduled" },
  { id: 28, previousEventId: 27, type: "TaskStarted" },
  { id: 29, previousEventId: 28, type: "TaskFailed", taskFailedEventDetails: { error: "Lambda.AWSLambdaException", cause: "no such function" } },
  exited(33, 29, "TaskStateExited", "Call", '{"err":1}'),
  entered(34, 33, "PassStateEntered", "Recovered"),
  exited(35, 34, "PassStateExited", "Recovered"),
  entered(36, 35, "FailStateEntered", "Boom"),
  { id: 37, previousEventId: 36, type: "ExecutionFailed", executionFailedEventDetails: { error: "Probe", cause: "expected" } },
];

test("Step Functions graph: each state's outcome comes from the event history", () => {
  const runs = stateRuns(events, "FAILED");
  assert.equal(runs.Init.outcome, "succeeded");
  assert.equal(runs.Init.output, '{"x":1}');
  assert.equal(runs.Fan.outcome, "succeeded");
  assert.equal(runs.B.outcome, "succeeded");
  assert.equal(runs.Item.entered, 2);
  assert.equal(runs.Call.outcome, "caught");
  assert.equal(runs.Call.error, "Lambda.AWSLambdaException");
  assert.equal(runs.Call.failures, 1);
  assert.equal(runs.Boom.outcome, "failed");
  assert.equal(runs.Boom.error, "Probe");
  assert.equal(runs.Boom.cause, "expected");
  assert.equal(runs.Bad, undefined);
  assert.equal(runs.Done, undefined);
});

test("Step Functions graph: an open state is in progress while running, failed otherwise", () => {
  const partial = events.slice(0, 20);
  assert.equal(stateRuns(partial, "RUNNING").Call.outcome, "inProgress");
  assert.equal(stateRuns(partial, "ABORTED").Call.outcome, "failed");
  assert.equal(stateRuns(partial, "RUNNING").Each.outcome, "succeeded");
});

test("Step Functions graph: layout places every state, nests branches and draws every transition", () => {
  const layout = layoutDefinition(definition);
  assert.ok(layout);
  const names = layout.nodes.map((n) => n.name).sort();
  assert.deepEqual(names, ["A", "B", "Bad", "Boom", "Call", "Check", "Done", "Each", "End", "Fan", "Init", "Item", "Loop", "Recovered", "Start"].sort());
  const node = (n) => layout.nodes.find((x) => x.name === n);
  // Branches sit inside their Parallel / Map frame.
  for (const [inner, outer] of [["A", "Fan"], ["B", "Fan"], ["Item", "Each"]]) {
    const i = node(inner);
    const o = node(outer);
    assert.ok(o.container);
    assert.ok(i.x >= o.x && i.x + i.w <= o.x + o.w && i.y >= o.y && i.y + i.h <= o.y + o.h, `${inner} inside ${outer}`);
  }
  // A and B are side by side, Init above Check, End at the bottom.
  assert.equal(node("A").y, node("B").y);
  assert.ok(node("Init").y < node("Check").y);
  assert.ok(layout.nodes.every((n) => n.name === "End" || n.y < node("End").y));
  const edge = (from, to) => layout.edges.find((e) => e.from === from && e.to === to);
  assert.equal(edge("Check", "Bad")?.label, "Default");
  assert.equal(edge("Check", "Fan")?.label, "Rule #1");
  assert.equal(edge("Call", "Recovered")?.kind, "catch");
  assert.ok(edge("Start", "Init"));
  assert.ok(edge("Done", "End"));
  assert.ok(edge("Loop", "Init"), "a loop back to an earlier state is still drawn");
  assert.ok(layout.width > 0 && layout.height > 0);
  assert.equal(layoutDefinition("not json"), null);
  assert.equal(layoutDefinition(null), null);
});
