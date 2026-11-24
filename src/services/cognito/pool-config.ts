/**
 * Pure helper: turns the Create user pool form's sign-in identifiers and required attributes
 * into CreateUserPool's UsernameAttributes / AliasAttributes / AutoVerifiedAttributes / Schema.
 */

export interface PoolSchema {
  usernameAttributes?: ("email" | "phone_number")[];
  aliasAttributes?: ("email" | "phone_number" | "preferred_username")[];
  autoVerified?: ("email" | "phone_number")[];
  schema?: { Name: string; AttributeDataType: "String"; Required: true; Mutable: true }[];
}

export function poolSchema(signIn: string[], required: string[]): PoolSchema {
  const want = signIn.filter((x) => x === "email" || x === "phone_number") as ("email" | "phone_number")[];
  if (signIn.length === 0) throw new Error("Choose at least one sign-in identifier.");
  const out: PoolSchema = {};
  if (signIn.includes("username")) {
    // Username sign-in, with email / phone as aliases users can also sign in with.
    if (want.length) out.aliasAttributes = want;
  } else {
    out.usernameAttributes = want;
  }
  const verify = [...new Set([...want, ...required.filter((r) => r === "email" || r === "phone_number")])] as ("email" | "phone_number")[];
  if (verify.length) out.autoVerified = verify.includes("email") ? ["email"] : ["phone_number"];
  const req = [...new Set(required)];
  if (req.length) out.schema = req.map((Name) => ({ Name, AttributeDataType: "String", Required: true, Mutable: true }));
  return out;
}

/** Settings UpdateUserPool takes that DescribeUserPool also returns, under the same name. */
const UPDATABLE_KEYS = [
  "Policies",
  "DeletionProtection",
  "LambdaConfig",
  "AutoVerifiedAttributes",
  "SmsVerificationMessage",
  "EmailVerificationMessage",
  "EmailVerificationSubject",
  "VerificationMessageTemplate",
  "SmsAuthenticationMessage",
  "UserAttributeUpdateSettings",
  "MfaConfiguration",
  "DeviceConfiguration",
  "EmailConfiguration",
  "SmsConfiguration",
  "AdminCreateUserConfig",
  "UserPoolAddOns",
  "AccountRecoverySetting",
  "PoolName",
  "UserPoolTier",
] as const;

export type UpdatableKey = (typeof UPDATABLE_KEYS)[number];

/**
 * UpdateUserPool resets every setting it isn't given to its default (AWS docs). So an edit
 * sends the pool's current settings, from DescribeUserPool, with only `change` applied.
 * Empty values are left out, and AdminCreateUserConfig drops the deprecated
 * UnusedAccountValidityDays when the password policy already sets TemporaryPasswordValidityDays
 * (AWS rejects both together).
 */
export function updatePoolInput(poolId: string, pool: Record<string, unknown>, change: Partial<Record<UpdatableKey, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { UserPoolId: poolId };
  for (const key of UPDATABLE_KEYS) {
    const value = key in change ? change[key] : pool[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0 && !(key in change)) continue;
    out[key] = value;
  }
  const policies = out.Policies as { PasswordPolicy?: { TemporaryPasswordValidityDays?: number } } | undefined;
  const admin = out.AdminCreateUserConfig as Record<string, unknown> | undefined;
  if (admin && "UnusedAccountValidityDays" in admin && policies?.PasswordPolicy?.TemporaryPasswordValidityDays !== undefined) {
    const { UnusedAccountValidityDays: _dropped, ...rest } = admin;
    void _dropped;
    out.AdminCreateUserConfig = rest;
  }
  return out;
}
