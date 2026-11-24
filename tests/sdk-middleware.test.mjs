import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Agent } from "node:https";
import { hasLongEpochFraction, isTimestampKey, trimEpochFractions } from "../src/lib/epoch-trim.ts";
import { adjustedHeaders, emulatorRequestHandler, EPOCH_MIDDLEWARE_NAME, IAM_MIDDLEWARE_NAME, installEmulatorMiddleware, shouldTrimResponse } from "../src/lib/sdk-middleware.ts";
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { ECSClient, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { KinesisClient } from "@aws-sdk/client-kinesis";
import { NodeHttpHandler } from "@smithy/node-http-handler";

test("ECS-style epoch fractions are trimmed to milliseconds", () => {
  const raw = '{"createdAt":1795421453.604998128,"x":{"updatedAt": 1795421453.6049 },"events":[{"createdAt":1.5}],"msg":"v1.23456","n":12}';
  const fixed = trimEpochFractions(raw);
  assert.equal(fixed, '{"createdAt":1795421453.604,"x":{"updatedAt": 1795421453.604 },"events":[{"createdAt":1.5}],"msg":"v1.23456","n":12}');
  assert.equal(JSON.parse(fixed).createdAt, 1795421453.604);
});

test("Glue-style epoch fractions are trimmed, including in arrays; strings never change", () => {
  assert.equal(trimEpochFractions('{"CreateTime":1795422532.263886213,"N":12.5}'), '{"CreateTime":1795422532.263,"N":12.5}');
  assert.equal(trimEpochFractions('{"Timestamps":[1795422532.1234567,1795422533.7654321]}'), '{"Timestamps":[1795422532.123,1795422533.765]}');
  assert.equal(trimEpochFractions('{"Name":"1795422532.263886213"}'), '{"Name":"1795422532.263886213"}');
  assert.equal(trimEpochFractions('{"t":1795422532.26}'), '{"t":1795422532.26}');
});

test("Identity Store-style fractions are trimmed; non-epoch numbers untouched", () => {
  assert.equal(trimEpochFractions('{"CreatedAt":1795422357.89387938,"UpdatedAt":1795422357.1}'), '{"CreatedAt":1795422357.893,"UpdatedAt":1795422357.1}');
  assert.equal(trimEpochFractions('{"Revision":"1","N":3.14159265}'), '{"Revision":"1","N":3.14159265}');
  assert.equal(trimEpochFractions('{"x": {"lastModified": 1795422357.12345}}'), '{"x": {"lastModified": 1795422357.123}}');
});

test("SEC-6: numbers that are not timestamps are never changed", () => {
  // The reviewer's case: metric values and sums in the epoch range.
  const metrics = '{"Values":[1234567890.123456,12.34567],"Sum":987654321.9876543}';
  assert.equal(trimEpochFractions(metrics), metrics);
  // Epoch-range numbers under non-timestamp names (costs, quotas, sizes, "Format", "Stat").
  for (const raw of [
    '{"Amount":1795422357.123456}',
    '{"Value":1795422357.1234}',
    '{"Quota":{"Value":2000000000.55555}}',
    '{"Format":1795422357.123456,"Stat":1795422357.123456}',
    '{"Datapoints":[{"Average":1795422357.123456}]}',
    '{"TotalBytes":3000000000.123456}',
  ]) assert.equal(trimEpochFractions(raw), raw, raw);
  // Timestamp names with values outside 2001-2100 stay as they are.
  for (const raw of ['{"createdAt":12.3456789}', '{"createdAt":9999999999.123456}', '{"createdAt":-1795422357.123456}', '{"createdAt":1795422357123.4567}']) {
    assert.equal(trimEpochFractions(raw), raw, raw);
  }
  // A key in an earlier object does not leak into a sibling array element.
  assert.equal(trimEpochFractions('[{"createdAt":1},1795422357.123456]'), '[{"createdAt":1},1795422357.123456]');
});

test("timestamp member names are recognised", () => {
  for (const k of ["createdAt", "updatedAt", "CreationTime", "CreationDate", "LastModified", "lastModified", "Timestamp", "Timestamps", "Expiration", "NotAfter", "StartTime", "LastUpdatedDate"]) {
    assert.equal(isTimestampKey(k), true, k);
  }
  for (const k of ["Format", "Stat", "Value", "Sum", "Amount", "Heartbeat", "Values", null, ""]) assert.equal(isTimestampKey(k), false, String(k));
});

test("numbers inside strings with escapes are left alone", () => {
  const raw = '{"msg":"say \\"1795422357.123456\\", ok","StartTime":1795422357.123456}';
  assert.equal(trimEpochFractions(raw), '{"msg":"say \\"1795422357.123456\\", ok","StartTime":1795422357.123}');
  assert.equal(hasLongEpochFraction('{"t":1795422357.1234}'), true);
  assert.equal(hasLongEpochFraction('{"t":1795422357.123}'), false);
});

test("payload bodies (S3, Lambda Invoke) and non-JSON bodies are never rewritten", () => {
  assert.equal(shouldTrimResponse({ clientName: "ECSClient", commandName: "DescribeServicesCommand" }, "application/x-amz-json-1.1"), true);
  assert.equal(shouldTrimResponse({ clientName: "ECSClient", commandName: "DescribeServicesCommand" }, ""), true);
  assert.equal(shouldTrimResponse({ clientName: "EC2Client", commandName: "DescribeVpcsCommand" }, "text/xml"), false);
  assert.equal(shouldTrimResponse({ clientName: "S3Client", commandName: "GetObjectCommand" }, "application/json"), false);
  assert.equal(shouldTrimResponse({ clientName: "LambdaClient", commandName: "InvokeCommand" }, "application/json"), false);
});

function fakeHandler(body, headers = { "content-type": "application/x-amz-json-1.0" }) {
  return {
    handle: async () => ({ response: { statusCode: 200, headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, body: Readable.from([Buffer.from(body)]) } }),
  };
}

const baseConfig = { region: "us-east-1", endpoint: "https://127.0.0.1:1", credentials: { accessKeyId: "a", secretAccessKey: "b" }, maxAttempts: 1 };

test("a client with the middleware parses nanosecond epoch timestamps", async () => {
  const body = '{"services":[{"serviceName":"s","createdAt":1795421453.604998128}]}';
  const plain = new ECSClient({ ...baseConfig, requestHandler: fakeHandler(body) });
  await assert.rejects(plain.send(new DescribeServicesCommand({ services: ["s"] })), /Epoch timestamps/);
  const fixed = new ECSClient({ ...baseConfig, requestHandler: fakeHandler(body) });
  installEmulatorMiddleware(fixed, null);
  const out = await fixed.send(new DescribeServicesCommand({ services: ["s"] }));
  assert.equal(out.services[0].createdAt.getTime(), 1795421453604);
});

test("the IAM check runs first and can stop the call before it is sent", async () => {
  const calls = [];
  const client = new DynamoDBClient({ ...baseConfig, requestHandler: { handle: async () => { calls.push("sent"); throw new Error("should not send"); } } });
  installEmulatorMiddleware(client, async (clientName, commandName, input) => {
    calls.push(`${clientName}.${commandName}:${input.TableName}`);
    throw new Error("AccessDenied: test");
  });
  await assert.rejects(client.send(new DescribeTableCommand({ TableName: "T" })), /AccessDenied/);
  assert.deepEqual(calls, ["DynamoDBClient.DescribeTableCommand:T"]);
  const order = client.middlewareStack.identify();
  assert.ok(order.findIndex((n) => n.startsWith(IAM_MIDDLEWARE_NAME)) === 0, order.join(", "));
  assert.ok(order.some((n) => n.startsWith(EPOCH_MIDDLEWARE_NAME)));
});

test("every client, Kinesis included, gets an HTTP/1.1 handler", () => {
  const agent = new Agent();
  const handler = emulatorRequestHandler(agent);
  assert.ok(handler instanceof NodeHttpHandler);
  const kinesis = new KinesisClient({ ...baseConfig, requestHandler: handler });
  assert.ok(kinesis.config.requestHandler instanceof NodeHttpHandler);
  agent.destroy();
});

test("a rewritten body gets its new length and loses the old checksum", () => {
  assert.deepEqual(adjustedHeaders({ "Content-Length": "40", "x-amz-crc32": "123", "content-type": "application/json" }, 37), { "Content-Length": "37", "content-type": "application/json" });
});
