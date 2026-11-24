/**
 * The default key policy the KMS console writes from "Define key administrative permissions"
 * and "Define key usage permissions". Pure, so it is unit tested.
 */

export type KeyUsageChoice = "ENCRYPT_DECRYPT" | "SIGN_VERIFY" | "GENERATE_VERIFY_MAC" | "KEY_AGREEMENT";

export interface KeyPolicyInput {
  accountId: string;
  admins: string[];
  allowAdminsDelete: boolean;
  users: string[];
  otherAccounts: string[];
  usage: KeyUsageChoice;
  symmetric: boolean;
}

const ADMIN_ACTIONS = [
  "kms:Create*",
  "kms:Describe*",
  "kms:Enable*",
  "kms:List*",
  "kms:Put*",
  "kms:Update*",
  "kms:Revoke*",
  "kms:Disable*",
  "kms:Get*",
  "kms:Delete*",
  "kms:TagResource",
  "kms:UntagResource",
  "kms:RotateKeyOnDemand",
];

export function usageActions(usage: KeyUsageChoice, symmetric: boolean): string[] {
  switch (usage) {
    case "ENCRYPT_DECRYPT":
      return symmetric
        ? ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
        : ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:DescribeKey", "kms:GetPublicKey"];
    case "SIGN_VERIFY":
      return ["kms:DescribeKey", "kms:GetPublicKey", "kms:Sign", "kms:Verify"];
    case "GENERATE_VERIFY_MAC":
      return ["kms:DescribeKey", "kms:GenerateMac", "kms:VerifyMac"];
    case "KEY_AGREEMENT":
      return ["kms:DescribeKey", "kms:GetPublicKey", "kms:DeriveSharedSecret"];
  }
}

export function defaultKeyPolicy(input: KeyPolicyInput): Record<string, unknown> {
  for (const a of input.otherAccounts) if (!/^\d{12}$/.test(a)) throw new Error(`"${a}" is not a 12-digit AWS account ID.`);
  const statements: Record<string, unknown>[] = [
    { Sid: "Enable IAM User Permissions", Effect: "Allow", Principal: { AWS: `arn:aws:iam::${input.accountId}:root` }, Action: "kms:*", Resource: "*" },
  ];
  if (input.admins.length) {
    statements.push({
      Sid: "Allow access for Key Administrators",
      Effect: "Allow",
      Principal: { AWS: input.admins },
      Action: input.allowAdminsDelete ? [...ADMIN_ACTIONS, "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"] : ADMIN_ACTIONS,
      Resource: "*",
    });
  }
  const users = [...input.users, ...input.otherAccounts.map((a) => `arn:aws:iam::${a}:root`)];
  if (users.length) {
    statements.push({ Sid: "Allow use of the key", Effect: "Allow", Principal: { AWS: users }, Action: usageActions(input.usage, input.symmetric), Resource: "*" });
    if (input.usage === "ENCRYPT_DECRYPT" && input.symmetric) {
      statements.push({
        Sid: "Allow attachment of persistent resources",
        Effect: "Allow",
        Principal: { AWS: users },
        Action: ["kms:CreateGrant", "kms:ListGrants", "kms:RevokeGrant"],
        Resource: "*",
        Condition: { Bool: { "kms:GrantIsForAWSResource": "true" } },
      });
    }
  }
  return { Version: "2012-10-17", Id: "key-consolepolicy-3", Statement: statements };
}

/** "Symmetric" / "Asymmetric" / "HMAC", from a KeySpec. */
export function keyTypeOf(spec: string | undefined): string {
  if (!spec) return "-";
  if (spec === "SYMMETRIC_DEFAULT") return "Symmetric";
  if (spec.startsWith("HMAC_")) return "HMAC";
  return "Asymmetric";
}
