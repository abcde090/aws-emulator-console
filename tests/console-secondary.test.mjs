import { test } from "node:test";
import assert from "node:assert/strict";
import { optionalRead, secondary, secondaryOr, unavailableTab, unavailableText, valueOr, UNAVAILABLE } from "../src/console/secondary.ts";

test("C12: a denied secondary lookup is reported, not thrown, so the primary resource still renders", async () => {
  const ok = await secondary(Promise.resolve({ Status: "ok" }));
  assert.deepEqual(ok, { ok: true, value: { Status: "ok" } });
  const denied = await secondary(() => Promise.reject(new Error("AccessDenied (simulated by the console): user/x is not authorized to perform: ec2:DescribeInstanceStatus")));
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);
  assert.match(denied.error, /ec2:DescribeInstanceStatus/);
  const broken = await secondary(() => {
    throw new Error("socket hang up");
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.denied, false);
  assert.equal(valueOr(ok, (v) => v.Status, UNAVAILABLE), "ok");
  assert.equal(valueOr(denied, (v) => v.Status, UNAVAILABLE), UNAVAILABLE);
  assert.equal(unavailableTab("v", "Versions", ok), null);
  assert.deepEqual(unavailableTab("v", "Versions", denied)?.kind, "text");
  assert.match(unavailableTab("v", "Versions", denied).description, /permission/);
});

test("unavailableText: the normal text when the lookup worked, else the error, in that tab only", async () => {
  const ok = await secondary(Promise.resolve([]));
  const denied = await secondary(Promise.reject(new Error("AccessDenied: not authorized to perform: sns:ListTagsForResource")));
  assert.equal(unavailableText(ok, "No tags."), "No tags.");
  assert.equal(unavailableText(ok), undefined);
  assert.match(unavailableText(denied, "No tags."), /^Unavailable: AccessDenied.*sns:ListTagsForResource/);
});

test("secondaryOr keeps a fallback value next to the error", async () => {
  assert.deepEqual(await secondaryOr(Promise.resolve([1]), []), { value: [1], error: null });
  const r = await secondaryOr(() => Promise.reject(new Error("boom")), []);
  assert.deepEqual(r, { value: [], error: "boom" });
  assert.equal(unavailableText(r, "None."), "Unavailable: boom");
  assert.equal(unavailableText({ value: [], error: null }, "None."), "None.");
});

test("optionalRead: named 'not set' errors are missing, other errors are kept", async () => {
  const named = (name) => Object.assign(new Error(name), { name });
  assert.deepEqual(await optionalRead(() => Promise.resolve(1), ["X"]), { kind: "value", value: 1 });
  assert.deepEqual(await optionalRead(() => Promise.reject(named("PolicyNotFound")), ["PolicyNotFound"]), { kind: "missing" });
  assert.deepEqual(await optionalRead(() => Promise.reject(Object.assign(new Error("x"), { Code: "NoSuchBucketPolicy" })), ["NoSuchBucketPolicy"]), { kind: "missing" });
  assert.deepEqual(await optionalRead(() => Promise.reject(named("AccessDenied"))), { kind: "error", error: "AccessDenied" });
});
