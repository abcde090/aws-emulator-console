import { test } from "node:test";
import assert from "node:assert/strict";
import { changedAttributes, editValuesFromAttributes } from "../src/services/sqs/helpers.ts";

const attrs = {
  VisibilityTimeout: "45",
  MessageRetentionPeriod: "345600",
  DelaySeconds: "0",
  MaximumMessageSize: "262144",
  ReceiveMessageWaitTimeSeconds: "0",
  RedrivePolicy: JSON.stringify({ deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:dlq", maxReceiveCount: 5 }),
};

test("SQS Edit: prefill from attributes, saving unchanged sends nothing", () => {
  const v = editValuesFromAttributes(attrs);
  assert.equal(v.visibilityTimeout, 45);
  assert.equal(v.enableDlq, true);
  assert.equal(v.dlqArn, "arn:aws:sqs:us-east-1:000000000000:dlq");
  assert.equal(v.maxReceiveCount, 5);
  assert.deepEqual(changedAttributes(attrs, v), {});
});

test("SQS Edit: only changed attributes are sent; turning the DLQ off clears it", () => {
  const v = { ...editValuesFromAttributes(attrs), visibilityTimeout: 60, enableDlq: false };
  assert.deepEqual(changedAttributes(attrs, v), { VisibilityTimeout: "60", RedrivePolicy: "" });
});

test("SQS Edit: content-based deduplication only on FIFO queues", () => {
  const v = { ...editValuesFromAttributes(attrs), contentBasedDeduplication: true };
  assert.throws(() => changedAttributes(attrs, v), /FIFO/);
  assert.deepEqual(changedAttributes({ ...attrs, FifoQueue: "true" }, v), { ContentBasedDeduplication: "true" });
});
