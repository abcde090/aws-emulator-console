import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToText, joinId, jsonObject, parseJsonText, parseS3Uri, prettyJson, sameJson, splitId, stringMap } from "../src/console/values.ts";

test("form value helpers: ids, JSON and S3 URIs", () => {
  assert.equal(joinId("db", "t"), "db~t");
  assert.deepEqual(splitId("vault~arn:aws:backup:us-east-1:0:recovery-point:x", "recovery point"), ["vault", "arn:aws:backup:us-east-1:0:recovery-point:x"]);
  assert.throws(() => splitId("nosep", "table"), /not a valid table id/);
  assert.throws(() => splitId("~x", "table"));
  assert.deepEqual(stringMap('{"--a":"b"}', "Args"), { "--a": "b" });
  assert.throws(() => stringMap('{"a":1}', "Args"), /must be a string/);
  assert.throws(() => jsonObject("[1]", "X"), /JSON object/);
  assert.equal(jsonObject("", "X"), undefined);
  assert.deepEqual(parseS3Uri("s3://my-bucket/a/b/"), { bucket: "my-bucket", key: "a/b/" });
  assert.deepEqual(parseS3Uri("s3://my-bucket"), { bucket: "my-bucket", key: "" });
  assert.equal(parseS3Uri("https://x"), null);
  assert.deepEqual(bytesToText(new TextEncoder().encode("héllo")), { text: "héllo", base64: Buffer.from("héllo").toString("base64") });
  assert.equal(bytesToText(new Uint8Array([0, 1, 2])).text, "(binary, 3 bytes)");
});

test("JSON text helpers", () => {
  assert.equal(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyJson(undefined), "");
  assert.equal(prettyJson("not json"), "not json");
  assert.equal(parseJsonText(""), null);
  assert.deepEqual(parseJsonText('{"a":1}'), { a: 1 });
  assert.equal(parseJsonText("plain"), "plain");
  assert.equal(sameJson('{"a":1,"b":[1,2]}', '{ "b": [1, 2], "a": 1 }'), true);
  assert.equal(sameJson('{"a":1}', '{"a":2}'), false);
  assert.equal(sameJson("", undefined), true);
  assert.equal(sameJson("", "{}"), false);
});
