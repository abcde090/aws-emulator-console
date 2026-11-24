import { test } from "node:test";
import assert from "node:assert/strict";
import { poolSchema } from "../src/services/cognito/pool-config.ts";

test("sign-in identifiers map to username or alias attributes", () => {
  assert.deepEqual(poolSchema(["email"], []), { usernameAttributes: ["email"], autoVerified: ["email"] });
  assert.deepEqual(poolSchema(["username", "email"], ["name"]), { aliasAttributes: ["email"], autoVerified: ["email"], schema: [{ Name: "name", AttributeDataType: "String", Required: true, Mutable: true }] });
  assert.deepEqual(poolSchema(["username"], []), {});
  assert.deepEqual(poolSchema(["phone_number"], []), { usernameAttributes: ["phone_number"], autoVerified: ["phone_number"] });
  assert.throws(() => poolSchema([], []));
});

test("updatePoolInput sends the current settings back with only the change applied", async () => {
  const { updatePoolInput } = await import("../src/services/cognito/pool-config.ts");
  const pool = {
    Id: "us-east-1_x", Arn: "arn", Name: "p", CreationDate: new Date(0),
    Policies: { PasswordPolicy: { MinimumLength: 12, TemporaryPasswordValidityDays: 3 } },
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true, UnusedAccountValidityDays: 7 },
    AutoVerifiedAttributes: ["email"], MfaConfiguration: "OFF", DeletionProtection: "INACTIVE", AliasAttributes: [], LambdaConfig: null,
  };
  const out = updatePoolInput("us-east-1_x", pool, { DeletionProtection: "ACTIVE" });
  assert.deepEqual(out, {
    UserPoolId: "us-east-1_x",
    Policies: { PasswordPolicy: { MinimumLength: 12, TemporaryPasswordValidityDays: 3 } },
    DeletionProtection: "ACTIVE",
    AutoVerifiedAttributes: ["email"],
    MfaConfiguration: "OFF",
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
  });
  // Read-only fields (Id, Arn, Name, CreationDate, AliasAttributes) are never sent; an explicit change wins.
  assert.deepEqual(updatePoolInput("p", { AutoVerifiedAttributes: ["email"] }, { AutoVerifiedAttributes: [] }).AutoVerifiedAttributes, []);
});

