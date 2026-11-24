import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePermissions } from "../src/lib/permissions.ts";

const user = (policies, extra = {}) => ({ type: "user", name: "alice", accountId: "000000000000", policies, ...extra });
const doc = (...Statement) => ({ name: "p", document: { Version: "2012-10-17", Statement } });

test("an Allow grants and an explicit Deny wins", () => {
  const id = user([doc({ Effect: "Allow", Action: "s3:*", Resource: "*" }, { Effect: "Deny", Action: "s3:DeleteBucket", Resource: "*" })]);
  assert.equal(evaluatePermissions(id, "s3:ListAllMyBuckets").allowed, true);
  assert.equal(evaluatePermissions(id, "s3:DeleteBucket", "arn:aws:s3:::b").allowed, false);
});

test("no matching Allow is an implicit deny", () => {
  assert.equal(evaluatePermissions(user([doc({ Effect: "Allow", Action: "sqs:*", Resource: "*" })]), "s3:ListBucket").allowed, false);
  assert.equal(evaluatePermissions(user([]), "s3:ListBucket").allowed, false);
});

test("resource patterns must match", () => {
  const id = user([doc({ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::public/*" })]);
  assert.equal(evaluatePermissions(id, "s3:GetObject", "arn:aws:s3:::public/a.txt").allowed, true);
  assert.equal(evaluatePermissions(id, "s3:GetObject", "arn:aws:s3:::private/a.txt").allowed, false);
});

test("an Allow with a Condition is not counted, because the simulator cannot evaluate conditions", () => {
  const id = user([doc({ Effect: "Allow", Action: "s3:*", Resource: "*", Condition: { Bool: { "aws:MultiFactorAuthPresent": "true" } } })]);
  const r = evaluatePermissions(id, "s3:ListAllMyBuckets");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Condition/);
});

test("a Deny with a Condition still applies, so the simulator never grants more than AWS would", () => {
  const id = user([doc({ Effect: "Allow", Action: "*", Resource: "*" }, { Effect: "Deny", Action: "s3:*", Resource: "*", Condition: { Bool: { "aws:SecureTransport": "false" } } })]);
  assert.equal(evaluatePermissions(id, "s3:ListAllMyBuckets").allowed, false);
});

test("NotAction allows everything except the listed actions", () => {
  const id = user([doc({ Effect: "Allow", NotAction: "iam:*", Resource: "*" })]);
  assert.equal(evaluatePermissions(id, "s3:ListAllMyBuckets").allowed, true);
  assert.equal(evaluatePermissions(id, "iam:CreateUser").allowed, false);
});

test("a policy that failed to load denies everything (fail closed)", () => {
  const id = user([doc({ Effect: "Allow", Action: "*", Resource: "*" })], { loadErrors: ["DenyAll: AccessDenied"] });
  const r = evaluatePermissions(id, "s3:ListAllMyBuckets");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /could not be loaded/);
});

test("only the admin type is admin; a user named emulator is still a user", () => {
  assert.equal(evaluatePermissions({ type: "admin", name: "x", accountId: "000000000000" }, "iam:CreateUser").allowed, true);
  assert.equal(evaluatePermissions(user([], { name: "emulator" }), "iam:CreateUser").allowed, false);
});

test("an unknown resource: any matching Deny applies, and only an Allow on * counts", async () => {
  const { evaluatePermissions, UNKNOWN_RESOURCE } = await import("../src/lib/permissions.ts");
  const id = (statements) => ({ type: "user", name: "u", accountId: "000000000000", policies: [{ name: "p", document: { Statement: statements } }] });
  const allowAll = { Effect: "Allow", Action: "kms:*", Resource: "*" };
  const denyOne = { Effect: "Deny", Action: "kms:ScheduleKeyDeletion", Resource: "arn:aws:kms:us-east-1:000000000000:key/abc" };
  assert.equal(evaluatePermissions(id([allowAll, denyOne]), "kms:ScheduleKeyDeletion", UNKNOWN_RESOURCE).allowed, false);
  assert.equal(evaluatePermissions(id([allowAll]), "kms:ScheduleKeyDeletion", UNKNOWN_RESOURCE).allowed, true);
  const allowOneKey = { Effect: "Allow", Action: "kms:*", Resource: "arn:aws:kms:us-east-1:000000000000:key/abc" };
  assert.equal(evaluatePermissions(id([allowOneKey]), "kms:ScheduleKeyDeletion", UNKNOWN_RESOURCE).allowed, false);
  const notResource = { Effect: "Allow", Action: "kms:*", NotResource: "arn:aws:kms:us-east-1:000000000000:key/secret" };
  assert.equal(evaluatePermissions(id([notResource]), "kms:ScheduleKeyDeletion", UNKNOWN_RESOURCE).allowed, false);
});
