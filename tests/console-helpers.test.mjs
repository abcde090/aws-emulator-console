import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMessage, toPlain } from "../src/console/serialize.ts";
import { compareValues, formatBytes, formatDate, formatValue, rowMatches, statusTone } from "../src/console/format.ts";
import { groupBySection, initialValues, isFieldVisible, visibleValues } from "../src/console/form-state.ts";
import { detailPath, resolveFields, toServiceMeta } from "../src/console/meta.ts";
import { addRecent, parseRecent } from "../src/console/recent.ts";

test("toPlain makes SDK output serialisable", () => {
  const out = toPlain({ $metadata: { httpStatusCode: 200 }, when: new Date("2026-01-02T03:04:05Z"), n: 1n, bin: new Uint8Array(3), skip: undefined, nested: [{ d: new Date(0) }] });
  assert.deepEqual(out, { when: "2026-01-02T03:04:05.000Z", n: "1", bin: "(3 bytes of binary data)", nested: [{ d: "1970-01-01T00:00:00.000Z" }] });
});

test("errorMessage keeps the AWS error name and the simulator's text", () => {
  const e = new Error("The specified queue does not exist.");
  e.name = "QueueDoesNotExist";
  assert.equal(errorMessage(e), "QueueDoesNotExist: The specified queue does not exist.");
  const denied = new Error("AccessDenied (simulated by the console): x");
  denied.name = "AccessDeniedError";
  assert.equal(errorMessage(denied), "AccessDenied (simulated by the console): x");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage({}), "Unexpected error");
});

test("formatting", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(null), "-");
  assert.equal(formatDate("2026-11-23T14:05:09Z"), "November 23, 2026, 14:05:09 (UTC)");
  assert.equal(formatValue("count", 1234), "1,234");
  assert.equal(formatValue("text", null), "-");
  assert.equal(formatValue("tags", [{ Key: "a", Value: "b" }]), "a=b");
  assert.equal(statusTone("available"), "success");
  assert.equal(statusTone("CREATE_FAILED"), "error");
  assert.equal(statusTone("creating"), "pending");
  assert.equal(statusTone("stopped"), "warning");
  assert.equal(rowMatches({ name: "Orders", n: 3 }, ["name", "n"], "ord"), true);
  assert.equal(rowMatches({ name: "Orders" }, ["name"], "x"), false);
  assert.ok(compareValues("q2", "q10") < 0);
  assert.ok(compareValues(null, "a") > 0);
});

test("form state: defaults, visibility and sections", () => {
  const fields = [
    { name: "t", label: "T", kind: "radio", options: [{ value: "s", label: "S" }], section: "A" },
    { name: "n", label: "N", kind: "number", default: 5, section: "A" },
    { name: "c", label: "C", kind: "checkbox", section: "B" },
    { name: "x", label: "X", kind: "text", showIf: { field: "c", equals: true }, section: "B" },
  ];
  const v = initialValues(fields);
  assert.deepEqual(v, { t: "s", n: 5, c: false, x: "" });
  assert.equal(isFieldVisible(fields[3], v), false);
  assert.deepEqual(visibleValues(fields, v), { t: "s", n: 5, c: false });
  assert.deepEqual(groupBySection(fields).map((g) => [g.section, g.fields.length]), [["A", 2], ["B", 2]]);
});

test("meta strips functions and resolves live options without throwing", async () => {
  const def = {
    id: "svc", name: "Svc", category: "Cat", description: "d",
    resources: [{ id: "things", name: "Things", singular: "thing", idField: "id", columns: [], list: async () => [], get: async () => ({ summary: {} }), actions: [{ id: "go", label: "Go", fields: [{ name: "a", label: "A", kind: "text" }], run: async () => {} }], delete: { run: async () => {} } }],
  };
  const meta = toServiceMeta(def);
  assert.equal(JSON.stringify(meta).includes("function"), false);
  assert.deepEqual(meta.resources[0].actions, [{ id: "go", label: "Go", danger: undefined, confirm: undefined, hasFields: true, hidden: undefined }]);
  assert.equal(meta.resources[0].canGet, true);
  assert.equal(meta.resources[0].canCreate, false);
  const fields = await resolveFields({}, [
    { name: "ok", label: "OK", kind: "select", options: async () => [{ value: "1", label: "one" }] },
    { name: "bad", label: "Bad", kind: "select", options: async () => { throw new Error("nope"); } },
  ]);
  assert.deepEqual(fields[0].options, [{ value: "1", label: "one" }]);
  assert.match(fields[1].optionsError, /nope/);
  assert.equal(detailPath("sqs", { id: "queues" }, "a b"), "/sqs/queues/a%20b");
  assert.equal(detailPath("s3", { id: "buckets", detailHref: "buckets/{id}" }, "b"), "/s3/buckets/b");
});

test("recently visited keeps a short, unique, newest-first list", () => {
  let list = [];
  for (const id of ["a", "b", "a", "c"]) list = addRecent(list, { id, name: id.toUpperCase() }, 2);
  assert.deepEqual(list.map((e) => e.id), ["c", "a"]);
  assert.deepEqual(parseRecent('[{"id":"s3","name":"S3"},{"id":1},"x"]'), [{ id: "s3", name: "S3" }]);
  assert.deepEqual(parseRecent("{"), []);
});
