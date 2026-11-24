import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEditableFile, isEmulatorLocation } from "../src/lib/lambda-code.ts";

test("a single-file package is editable", () => {
  assert.deepEqual(pickEditableFile(["index.js"], "index.handler"), { file: "index.js", editable: true });
});

test("finds the handler module by name, ignoring directories", () => {
  assert.deepEqual(pickEditableFile(["lib/", "lambda_function.py"], "lambda_function.lambda_handler"), {
    file: "lambda_function.py",
    editable: true,
  });
});

test("a multi-file package is shown read-only, so a deploy cannot drop the other files", () => {
  assert.deepEqual(pickEditableFile(["index.mjs", "util.mjs"], "index.handler"), { file: "index.mjs", editable: false });
});

test("no matching handler file gives nothing to show", () => {
  assert.deepEqual(pickEditableFile(["a.js", "b.js"], "index.handler"), { file: null, editable: false });
  assert.deepEqual(pickEditableFile([], "index.handler"), { file: null, editable: false });
});

test("only downloads code from the emulator endpoint", () => {
  assert.equal(isEmulatorLocation("https://127.0.0.1:9297/awslambda/x?sig=1", "https://127.0.0.1:9297"), true);
  assert.equal(isEmulatorLocation("https://127.0.0.1:9297.evil.example/x", "https://127.0.0.1:9297"), false);
  assert.equal(isEmulatorLocation("https://prod-04.s3.amazonaws.com/x", "https://127.0.0.1:9297"), false);
  assert.equal(isEmulatorLocation(undefined, "https://127.0.0.1:9297"), false);
  assert.equal(isEmulatorLocation("not a url", "https://127.0.0.1:9297"), false);
});
