import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePolicyDocument } from "../src/lib/policy-document.ts";

const doc = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "arn:aws:s3:::a+b/*" }] };

test("reads URL-encoded and plain policy documents", () => {
  assert.deepEqual(parsePolicyDocument(encodeURIComponent(JSON.stringify(doc))), { ok: true, document: doc });
  assert.deepEqual(parsePolicyDocument(JSON.stringify(doc)), { ok: true, document: doc });
});

test("empty, non-JSON and odd documents are errors (so the identity is denied)", () => {
  for (const raw of [undefined, "", "not json", "[1,2]", JSON.stringify({ Statement: "x" })]) {
    assert.equal(parsePolicyDocument(raw).ok, false, String(raw));
  }
});
