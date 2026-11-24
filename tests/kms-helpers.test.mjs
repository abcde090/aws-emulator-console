import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultKeyPolicy, keyTypeOf, usageActions } from "../src/services/kms/key-policy.ts";

test("default key policy matches the console's statements", () => {
  const p = defaultKeyPolicy({ accountId: "000000000000", admins: ["arn:aws:iam::000000000000:user/a"], allowAdminsDelete: true, users: ["arn:aws:iam::000000000000:role/r"], otherAccounts: ["111122223333"], usage: "ENCRYPT_DECRYPT", symmetric: true });
  const sids = p.Statement.map((s) => s.Sid);
  assert.deepEqual(sids, ["Enable IAM User Permissions", "Allow access for Key Administrators", "Allow use of the key", "Allow attachment of persistent resources"]);
  assert.ok(p.Statement[1].Action.includes("kms:ScheduleKeyDeletion"));
  assert.deepEqual(p.Statement[2].Principal.AWS, ["arn:aws:iam::000000000000:role/r", "arn:aws:iam::111122223333:root"]);
});

test("key policy without admins or users has only the root statement", () => {
  const p = defaultKeyPolicy({ accountId: "000000000000", admins: [], allowAdminsDelete: false, users: [], otherAccounts: [], usage: "SIGN_VERIFY", symmetric: false });
  assert.equal(p.Statement.length, 1);
  assert.throws(() => defaultKeyPolicy({ accountId: "0", admins: [], allowAdminsDelete: false, users: [], otherAccounts: ["12"], usage: "SIGN_VERIFY", symmetric: false }));
  const noDelete = defaultKeyPolicy({ accountId: "000000000000", admins: ["x"], allowAdminsDelete: false, users: [], otherAccounts: [], usage: "SIGN_VERIFY", symmetric: false });
  assert.equal(noDelete.Statement[1].Action.includes("kms:ScheduleKeyDeletion"), false);
});

test("usage actions and key types", () => {
  assert.ok(usageActions("SIGN_VERIFY", false).includes("kms:Sign"));
  assert.ok(usageActions("GENERATE_VERIFY_MAC", true).includes("kms:GenerateMac"));
  assert.ok(usageActions("KEY_AGREEMENT", false).includes("kms:DeriveSharedSecret"));
  assert.ok(usageActions("ENCRYPT_DECRYPT", false).includes("kms:GetPublicKey"));
  assert.equal(keyTypeOf("SYMMETRIC_DEFAULT"), "Symmetric");
  assert.equal(keyTypeOf("HMAC_256"), "HMAC");
  assert.equal(keyTypeOf("RSA_2048"), "Asymmetric");
  assert.equal(keyTypeOf(undefined), "-");
});

import { keyActionAvailable } from "../src/services/kms/edit-helpers.ts";

test("KMS key actions apply only to matching keys", () => {
  const sym = { status: "Enabled", keySpec: "SYMMETRIC_DEFAULT", keyUsage: "ENCRYPT_DECRYPT", origin: "AWS_KMS", regionality: "Single-Region" };
  assert.equal(keyActionAvailable("sign", sym), false);
  assert.equal(keyActionAvailable("generate-mac", sym), false);
  assert.equal(keyActionAvailable("encrypt", sym), true);
  assert.equal(keyActionAvailable("cancel-deletion", sym), false);
  assert.equal(keyActionAvailable("enable", sym), false);
  assert.equal(keyActionAvailable("replicate", sym), false);
  assert.equal(keyActionAvailable("enable-rotation", sym), true);
  const signDetail = { Status: "Enabled", "Key spec": "RSA_2048", "Key usage": "SIGN_VERIFY", Origin: "AWS_KMS", Regionality: "Multi-Region primary" };
  assert.equal(keyActionAvailable("sign", signDetail), true);
  assert.equal(keyActionAvailable("encrypt", signDetail), false);
  assert.equal(keyActionAvailable("enable-rotation", signDetail), false);
  assert.equal(keyActionAvailable("replicate", signDetail), true);
  assert.equal(keyActionAvailable("cancel-deletion", { ...sym, status: "PendingDeletion" }), true);
  assert.equal(keyActionAvailable("edit-description", {}), true);
});
