import { test } from "node:test";
import assert from "node:assert/strict";
import { lastArnSegment, normaliseJsonObject, parseMessageAttributes, parsePendingId, subscriptionRowId, topicArnOfSubscription } from "../src/services/sns/helpers.ts";

test("SNS ARN helpers", () => {
  assert.equal(lastArnSegment("arn:aws:sns:us-east-1:000000000000:orders.fifo"), "orders.fifo");
  assert.equal(topicArnOfSubscription("arn:aws:sns:us-east-1:000000000000:orders:abc-123"), "arn:aws:sns:us-east-1:000000000000:orders");
  assert.equal(topicArnOfSubscription("arn:aws:sns:us-east-1:000000000000:orders"), null);
});

test("SNS pending subscriptions get a stable row id", () => {
  const arn = "arn:aws:sns:us-east-1:000000000000:t:1";
  assert.equal(subscriptionRowId({ SubscriptionArn: arn }), arn);
  const id = subscriptionRowId({ SubscriptionArn: "PendingConfirmation", TopicArn: "arn:aws:sns:us-east-1:000000000000:t", Protocol: "email", Endpoint: "a|b@example.com" });
  assert.deepEqual(parsePendingId(id), { topicArn: "arn:aws:sns:us-east-1:000000000000:t", protocol: "email", endpoint: "a|b@example.com" });
  assert.equal(parsePendingId(arn), null);
});

test("SNS message attributes from the simple and API forms", () => {
  assert.deepEqual(parseMessageAttributes(""), {});
  assert.deepEqual(parseMessageAttributes('{"a":"x","n":2,"l":["r","b"],"raw":{"DataType":"String","StringValue":"v"}}'), {
    a: { DataType: "String", StringValue: "x" },
    n: { DataType: "Number", StringValue: "2" },
    l: { DataType: "String.Array", StringValue: '["r","b"]' },
    raw: { DataType: "String", StringValue: "v" },
  });
  assert.throws(() => parseMessageAttributes("[1]"), /JSON object/);
  assert.throws(() => parseMessageAttributes("{bad"), /not valid JSON/);
  assert.throws(() => parseMessageAttributes('{"a":true}'), /"a"/);
});

test("SNS JSON policies are objects, compacted", () => {
  assert.equal(normaliseJsonObject("P", ""), undefined);
  assert.equal(normaliseJsonObject("P", '{ "k": ["v"] }'), '{"k":["v"]}');
  assert.throws(() => normaliseJsonObject("P", "[]"), /P: must be a JSON object/);
});

