import { test } from "node:test";
import assert from "node:assert/strict";
import { validateValues } from "../src/console/validate.ts";

const fields = [
  { name: "type", label: "Type", kind: "radio", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
  { name: "name", label: "Name", kind: "text", required: true, validate: { pattern: "[a-z]{3,5}", message: "3-5 letters" } },
  { name: "count", label: "Count", kind: "number", validate: { min: 1, max: 10, message: "1-10" } },
  { name: "onlyB", label: "Only B", kind: "text", required: true, showIf: { field: "type", equals: "b" } },
  { name: "flag", label: "Flag", kind: "checkbox" },
  { name: "doc", label: "Doc", kind: "json" },
  { name: "tags", label: "Tags", kind: "tags" },
  { name: "many", label: "Many", kind: "multiselect", options: [{ value: "x", label: "X" }] },
];

test("valid values are coerced and unknown keys dropped", () => {
  const r = validateValues(fields, { type: "a", name: " abc ", count: "4", flag: true, doc: '{"a":1}', tags: [{ Key: "k", Value: "v" }, { Key: " ", Value: "" }], many: ["x"], extra: "dropped" });
  assert.deepEqual(r, { ok: true, data: { type: "a", name: "abc", count: 4, flag: true, doc: '{"a":1}', tags: [{ Key: "k", Value: "v" }], many: ["x"] } });
});

test("hidden fields are skipped, visible required fields are enforced", () => {
  assert.equal(validateValues(fields, { type: "a", name: "abc" }).ok, true);
  const r = validateValues(fields, { type: "b", name: "abc" });
  assert.deepEqual(r, { ok: false, error: "Only B is required." });
});

test("patterns, ranges, choices and JSON are checked on the server", () => {
  assert.match(validateValues(fields, { type: "a", name: "ab" }).error, /3-5 letters/);
  assert.match(validateValues(fields, { type: "a", name: "abcdefg" }).error, /3-5 letters/, "the pattern is anchored");
  assert.match(validateValues(fields, { type: "a", name: "abc", count: 11 }).error, /1-10/);
  assert.match(validateValues(fields, { type: "z", name: "abc" }).error, /not one of the choices/);
  assert.match(validateValues(fields, { type: "a", name: "abc", many: ["y"] }).error, /not one of the choices/);
  assert.match(validateValues(fields, { type: "a", name: "abc", doc: "{" }).error, /not valid JSON/);
  assert.match(validateValues(fields, { type: "a", name: "abc", count: "4x" }).error, /must be a number/);
  assert.match(validateValues(fields, { type: "a", name: ["abc"] }).error, /must be text/);
  assert.equal(validateValues(fields, null).ok, false);
});

test("a field whose options failed to load is refused", () => {
  const r = validateValues([{ name: "dlq", label: "DLQ", kind: "select", options: [], optionsError: "choices could not be loaded: boom" }], { dlq: "x" });
  assert.deepEqual(r, { ok: false, error: "DLQ: choices could not be loaded: boom" });
});

test("SI-2/SI-6: optional selects with a default or a None option don't offer '-', and '' means the default", async () => {
  const { selectOffersEmpty, initialValues } = await import("../src/console/form-state.ts");
  const opts = [{ value: "LATEST", label: "Latest" }, { value: "TRIM_HORIZON", label: "Trim horizon" }];
  const withDefault = { name: "iteratorType", label: "Starting position", kind: "select", options: opts, default: "LATEST" };
  const plain = { name: "x", label: "X", kind: "select", options: opts };
  const withNone = { name: "dlq", label: "DLQ", kind: "select", options: [{ value: "", label: "None" }, ...opts] };
  assert.equal(selectOffersEmpty(withDefault), false);
  assert.equal(selectOffersEmpty(plain), true);
  assert.equal(selectOffersEmpty(withNone), false);
  assert.equal(selectOffersEmpty({ ...plain, required: true }), false);
  assert.equal(selectOffersEmpty({ ...plain, default: "" }), true);
  assert.deepEqual(initialValues([withDefault, plain, withNone]), { iteratorType: "LATEST", x: "", dlq: "" });
  // A stale or scripted "" for a defaulted select becomes the default on the server.
  assert.deepEqual(validateValues([withDefault], { iteratorType: "" }), { ok: true, data: { iteratorType: "LATEST" } });
  assert.deepEqual(validateValues([plain], { x: "" }), { ok: true, data: { x: "" } });
  assert.deepEqual(validateValues([withNone], { dlq: "" }), { ok: true, data: { dlq: "" } });
});

test("an optional select prefilled from the resource keeps '-' so it can be cleared", async () => {
  const { selectOffersEmpty } = await import("../src/console/form-state.ts");
  const { applyInitialValues } = await import("../src/console/meta.ts");
  const opts = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
  const [plain, defaulted, required] = applyInitialValues(
    [
      { name: "x", label: "X", kind: "select", options: opts },
      { name: "y", label: "Y", kind: "select", options: opts, default: "a" },
      { name: "z", label: "Z", kind: "select", options: opts, required: true },
    ],
    { x: "b", y: "b", z: "b" }
  );
  assert.equal(plain.default, "b");
  assert.equal(selectOffersEmpty(plain), true);
  assert.deepEqual(validateValues([plain], { x: "" }), { ok: true, data: { x: "" } });
  assert.equal(selectOffersEmpty(defaulted), false);
  assert.equal(selectOffersEmpty(required), false);
});
