import { test } from "node:test";
import assert from "node:assert/strict";
import { objectHref, parseS3Uri, s3Uri } from "../src/services/s3/object-paths.ts";

test("S3 copy destinations: folder URIs keep the object's name", () => {
  assert.deepEqual(parseS3Uri("s3://dest-bucket/", "a/b/file.txt"), { bucket: "dest-bucket", key: "file.txt" });
  assert.deepEqual(parseS3Uri("s3://dest-bucket", "file.txt"), { bucket: "dest-bucket", key: "file.txt" });
  assert.deepEqual(parseS3Uri("s3://dest-bucket/x/y/", "a/file.txt"), { bucket: "dest-bucket", key: "x/y/file.txt" });
  assert.deepEqual(parseS3Uri(" s3://dest-bucket/new.txt ", "a/file.txt"), { bucket: "dest-bucket", key: "new.txt" });
  assert.equal(parseS3Uri("https://dest-bucket/x", "f"), null);
  assert.equal(parseS3Uri("s3://Bad_Bucket/x", "f"), null);
  assert.equal(parseS3Uri(42, "f"), null);
});

test("S3 object links and URIs encode the key", () => {
  assert.equal(s3Uri("b1b", "a/b c.txt"), "s3://b1b/a/b c.txt");
  assert.equal(objectHref("b1b", "a/b c.txt"), "/s3/buckets/b1b/object?key=a%2Fb%20c.txt");
  assert.equal(objectHref("b1b", "k", "v&1"), "/s3/buckets/b1b/object?key=k&versionId=v%261");
});

