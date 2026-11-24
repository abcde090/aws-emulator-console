import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessDeniedError, assertAllPermissions, assertPermission, evaluatePermissions, principalArn, wildcardMatch } from "../src/lib/permissions.ts";

const user = (Statement, extra = {}) => ({ type: "user", name: "bob", accountId: "000000000000", policies: [{ name: "p", document: { Statement } }], ...extra });

test("wildcards: * is any run, ? is one character; resources are case-sensitive, actions are not", () => {
  assert.equal(wildcardMatch("arn:aws:s3:::b/*", "arn:aws:s3:::b/x/y"), true);
  assert.equal(wildcardMatch("arn:aws:s3:::b/?.txt", "arn:aws:s3:::b/a.txt"), true);
  assert.equal(wildcardMatch("arn:aws:s3:::b/?.txt", "arn:aws:s3:::b/ab.txt"), false);
  assert.equal(wildcardMatch("arn:aws:s3:::B", "arn:aws:s3:::b"), false);
  assert.equal(wildcardMatch("*a*b*", "xxaxxbxx"), true);
  const id = user([{ Effect: "Allow", Action: "S3:list*", Resource: "arn:aws:s3:::Data" }]);
  assert.equal(evaluatePermissions(id, "s3:ListBucket", "arn:aws:s3:::Data").allowed, true);
  assert.equal(evaluatePermissions(id, "s3:ListBucket", "arn:aws:s3:::data").allowed, false);
});

test("a single Statement object (not a list) and NotResource on an Allow", () => {
  const id = { ...user([]), policies: [{ name: "one", document: { Statement: { Effect: "Allow", Action: "s3:GetObject", NotResource: "arn:aws:s3:::secret/*" } } }] };
  assert.equal(evaluatePermissions(id, "s3:GetObject", "arn:aws:s3:::open/k").allowed, true);
  assert.equal(evaluatePermissions(id, "s3:GetObject", "arn:aws:s3:::secret/k").allowed, false);
});

test("an invalid identity is denied everything", () => {
  const r = evaluatePermissions({ type: "invalid", name: "x", accountId: "000000000000", policies: [], loadErrors: ["bad cookie"] }, "s3:ListAllMyBuckets");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /bad cookie/);
});

test("AccessDeniedError names the principal, action and resource", () => {
  const id = user([]);
  assert.throws(
    () => assertPermission(id, "s3:DeleteBucket", "arn:aws:s3:::b"),
    (err) => err instanceof AccessDeniedError && err.message.startsWith("AccessDenied (simulated by the console): arn:aws:iam::000000000000:user/bob") && /s3:DeleteBucket on resource: arn:aws:s3:::b/.test(err.message)
  );
  assert.throws(() => assertAllPermissions(user([{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }]), [["s3:GetObject", "*"], ["s3:PutObject", "*"]]), /s3:PutObject/);
});

test("principal ARNs for each identity type", () => {
  assert.equal(principalArn({ type: "role", name: "app", accountId: "000000000000", policies: [] }), "arn:aws:sts::000000000000:assumed-role/app/console");
  assert.equal(principalArn({ type: "admin", name: "emulator", accountId: "000000000000" }), "arn:aws:iam::000000000000:user/emulator");
});

test("a statement without a known Effect is ignored", () => {
  assert.equal(evaluatePermissions(user([{ Effect: "allow", Action: "*", Resource: "*" }]), "s3:ListAllMyBuckets").allowed, false);
});
