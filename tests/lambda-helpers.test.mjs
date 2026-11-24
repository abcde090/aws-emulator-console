import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeLogTail, envFromPairs, formatPayload, initDurationFromLog, lambdaDate, parseTestEvent, policyStatements, requestIdFromLog, RUNTIMES, starterCode } from "../src/services/lambda/helpers.ts";

test("starter code matches each offered runtime", () => {
  for (const r of RUNTIMES) {
    const s = starterCode(r.id);
    assert.ok(s.code.includes("Hello from Lambda!"), r.id);
    assert.equal(s.handler.split(".")[0], s.fileName.replace(/\.[^.]+$/, ""));
  }
  assert.equal(starterCode("python3.13").handler, "lambda_function.lambda_handler");
  assert.equal(starterCode("nodejs22.x").fileName, "index.mjs");
  assert.throws(() => starterCode("ruby3.3"), /Node.js or Python/);
});

test("environment variables are checked like Lambda does", () => {
  assert.deepEqual(envFromPairs([{ Key: "TABLE", Value: "t" }, { Key: " ", Value: "x" }]), { TABLE: "t" });
  assert.throws(() => envFromPairs([{ Key: "1BAD", Value: "" }]), /start with a letter/);
  assert.throws(() => envFromPairs([{ Key: "AWS_REGION", Value: "x" }]), /reserved/);
  assert.throws(() => envFromPairs([{ Key: "BIG", Value: "x".repeat(5000) }]), /4 KB/);
});

test("log tails, request IDs and init duration", () => {
  const log = "START RequestId: 1b35188b-67b5-4214-b169-47c8268261b6 Version: $LATEST\nREPORT RequestId: 1b35188b-67b5-4214-b169-47c8268261b6\tDuration: 3.41 ms\tInit Duration: 3.16 ms\t\n";
  assert.equal(decodeLogTail(Buffer.from(log).toString("base64")), log);
  assert.equal(decodeLogTail(undefined), "");
  assert.equal(requestIdFromLog(log), "1b35188b-67b5-4214-b169-47c8268261b6");
  assert.equal(initDurationFromLog(log), 3.16);
  assert.equal(requestIdFromLog("nothing"), null);
});

test("payloads and test events", () => {
  assert.equal(formatPayload(new TextEncoder().encode('{"a":1}')), '{\n  "a": 1\n}');
  assert.equal(formatPayload(new TextEncoder().encode("plain")), "plain");
  assert.equal(formatPayload(undefined), "");
  assert.deepEqual(parseTestEvent(""), { ok: true, value: "{}" });
  assert.equal(parseTestEvent("{bad").ok, false);
});

test("dates and resource policies", () => {
  assert.equal(lambdaDate("2026-11-23T06:50:38.050+0000"), "2026-11-23T06:50:38.050Z");
  assert.equal(lambdaDate(undefined), null);
  const policy = JSON.stringify({ Statement: [{ Sid: "s3", Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "lambda:InvokeFunction", Condition: { ArnLike: { "AWS:SourceArn": "arn:aws:s3:::b" } } }] });
  assert.deepEqual(policyStatements(policy), [{ sid: "s3", effect: "Allow", principal: "s3.amazonaws.com", action: "lambda:InvokeFunction", conditions: '{"ArnLike":{"AWS:SourceArn":"arn:aws:s3:::b"}}' }]);
  assert.deepEqual(policyStatements("not json"), []);
  assert.deepEqual(policyStatements(undefined), []);
});

test("general configuration patch sends only what changed", async () => {
  const { generalPatch, sameRecord, pairsFrom } = await import("../src/services/lambda/helpers.ts");
  const current = { Description: "d", MemorySize: 256, EphemeralStorage: { Size: 512 }, Timeout: 30, Role: "arn:r" };
  assert.deepEqual(generalPatch(current, { description: "d", memory: 256, ephemeral: 512, timeout: 30, role: "arn:r" }), {});
  assert.deepEqual(generalPatch(current, { description: "new", memory: 256, ephemeral: 512, timeout: 30 }), { Description: "new" });
  assert.deepEqual(generalPatch({}, { description: "", memory: 128, ephemeral: 1024, timeout: 3, role: "arn:x" }), { MemorySize: 128, EphemeralStorage: { Size: 1024 }, Timeout: 3, Role: "arn:x" });
  assert.ok(sameRecord({ a: "1" }, { a: "1" }));
  assert.ok(!sameRecord({ a: "1" }, { a: "1", b: "" }));
  assert.deepEqual(pairsFrom({ k: "v" }), [{ Key: "k", Value: "v" }]);
});
