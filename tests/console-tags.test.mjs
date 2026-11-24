import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fieldTags,
  manageTagsAction,
  nameTag,
  noTagChanges,
  recordTagDiff,
  recordToTags,
  tagDiff,
  tagDiffMessage,
  tagPairs,
  tagRecord,
  tagsToRecord,
} from "../src/console/tags.ts";

const CURRENT = [
  { Key: "env", Value: "prod" },
  { Key: "team", Value: "a" },
  { Key: "old", Value: "x" },
];

test("tagDiff: unchanged list sends nothing", () => {
  const d = tagDiff(CURRENT, CURRENT);
  assert.deepEqual(d, { set: [], remove: [] });
  assert.equal(noTagChanges(d), true);
  assert.equal(tagDiffMessage(d), "No tag changes.");
});

test("tagDiff: only added and changed tags are set, missing keys removed", () => {
  const d = tagDiff(CURRENT, [
    { Key: "env", Value: "prod" },
    { Key: "team", Value: "b" },
    { Key: "new", Value: "" },
  ]);
  assert.deepEqual(d, { set: [{ Key: "team", Value: "b" }, { Key: "new", Value: "" }], remove: ["old"] });
  assert.equal(noTagChanges(d), false);
  assert.equal(tagDiffMessage(d), "Added or changed 2 tags, removed 1.");
  assert.deepEqual(tagDiff(CURRENT, []), { set: [], remove: ["env", "team", "old"] });
  assert.deepEqual(tagDiff(undefined, [{ Key: "a", Value: "1" }]), { set: [{ Key: "a", Value: "1" }], remove: [] });
});

test("tagDiff: wanted keys are trimmed, blank keys ignored, missing values become empty", () => {
  const d = tagDiff([{ Key: "a", Value: "1" }], [{ Key: " a ", Value: "1" }, { Key: "  ", Value: "ignored" }, { Key: "b" }]);
  assert.deepEqual(d, { set: [{ Key: "b", Value: "" }], remove: [] });
});

test("tagDiff: a repeated key is rejected, not silently merged", () => {
  assert.throws(() => tagDiff([], [{ Key: "a", Value: "1" }, { Key: "a ", Value: "2" }]), /"a" appears more than once/);
});

test("tagDiff: API tags with missing keys or values are tolerated", () => {
  assert.deepEqual(tagDiff([{ Key: undefined, Value: "x" }, { Key: "k" }], [{ Key: "k", Value: "" }]), { set: [], remove: [] });
});

test("recordTagDiff: key/value maps", () => {
  assert.deepEqual(recordTagDiff({ a: "1", b: "2" }, { a: "1", c: "3" }), { set: { c: "3" }, remove: ["b"] });
  assert.deepEqual(recordTagDiff({ a: "1" }, { a: "9" }), { set: { a: "9" }, remove: [] });
  const same = recordTagDiff({ a: "1" }, { a: "1" });
  assert.deepEqual(same, { set: {}, remove: [] });
  assert.equal(tagDiffMessage(same), "No tag changes.");
  assert.deepEqual(recordTagDiff(undefined, { x: "" }), { set: { x: "" }, remove: [] });
  assert.equal(tagDiffMessage(recordTagDiff({ a: "1", b: "2" }, { c: "3" })), "Added or changed 1 tag, removed 2.");
});

test("tagDiffMessage wording", () => {
  assert.equal(tagDiffMessage({ set: [], remove: [] }), "No tag changes.");
  assert.equal(tagDiffMessage({ set: [], remove: ["a"] }), "Added or changed 0 tags, removed 1.");
  assert.equal(tagDiffMessage({ set: [{ Key: "a", Value: "" }], remove: [] }), "Added or changed 1 tag, removed 0.");
  assert.equal(tagDiffMessage({ set: { a: "1", b: "2" }, remove: [] }), "Added or changed 2 tags, removed 0.");
});

test("adapters: fieldTags, tagPairs, recordToTags, tagsToRecord, tagRecord, nameTag", () => {
  assert.deepEqual(fieldTags([{ Key: " k ", Value: "v" }, { Key: "" }, null, "x", { Key: "n" }]), [{ Key: "k", Value: "v" }, { Key: "n", Value: "" }]);
  assert.deepEqual(fieldTags("nope"), []);
  assert.deepEqual(tagPairs([{ Key: "a" }, { Value: "x" }, { Key: "b", Value: "2" }]), [{ Key: "a", Value: "" }, { Key: "b", Value: "2" }]);
  assert.deepEqual(tagPairs(undefined), []);
  assert.deepEqual(recordToTags({ x: "1" }), [{ Key: "x", Value: "1" }]);
  assert.deepEqual(recordToTags(undefined), []);
  assert.deepEqual(tagsToRecord([{ Key: "a", Value: "1" }, { Key: "", Value: "x" }]), { a: "1" });
  assert.throws(() => tagsToRecord([{ Key: "a", Value: "1" }, { Key: "a", Value: "2" }]));
  assert.deepEqual(tagRecord([{ Key: "a", Value: "1" }]), { a: "1" });
  assert.equal(tagRecord([]), undefined);
  assert.equal(nameTag([{ Key: "Name", Value: "web" }]), "web");
  assert.equal(nameTag([{ Key: "x", Value: "y" }]), null);
});

test("manageTagsAction: opens with current tags and applies only the difference", async () => {
  const calls = [];
  let tags = [{ Key: "a", Value: "1" }, { Key: "b", Value: "2" }];
  const action = manageTagsAction({
    read: async () => tags,
    tag: async (_ctx, _id, t) => void calls.push(["tag", t]),
    untag: async (_ctx, _id, k) => void calls.push(["untag", k]),
  });
  assert.deepEqual(await action.initialValues({}, "id"), { tags });
  assert.deepEqual(await action.run({}, "id", { tags }), { message: "No tag changes." });
  assert.deepEqual(calls, []);
  const r = await action.run({}, "id", { tags: [{ Key: "a", Value: "9" }] });
  assert.equal(r.message, "Added or changed 1 tag, removed 1.");
  assert.deepEqual(calls, [["untag", ["b"]], ["tag", [{ Key: "a", Value: "9" }]]]);
  tags = [];
});
