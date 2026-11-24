/**
 * IAM account-level screens: Dashboard (GetAccountSummary, account alias), Account settings
 * (password policy) and the Policy simulator's principal list. The Dashboard and the Policy
 * simulator have hand-built pages under src/app/iam/.
 */

import {
  DeleteAccountPasswordPolicyCommand,
  GetAccountPasswordPolicyCommand,
  GetAccountSummaryCommand,
  UpdateAccountPasswordPolicyCommand,
  type PasswordPolicy,
} from "@aws-sdk/client-iam";
import type { Ctx, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import { allGroups, allRoles, allUsers, maybe } from "./common.ts";

/** Labels for the GetAccountSummary keys the console's Dashboard shows first. */
export const SUMMARY_LABELS: Record<string, string> = {
  Users: "Users",
  Groups: "User groups",
  Roles: "Roles",
  Policies: "Customer managed policies",
  Providers: "Identity providers",
  InstanceProfiles: "Instance profiles",
  MFADevices: "MFA devices",
  MFADevicesInUse: "MFA devices in use",
  AccountMFAEnabled: "Root user MFA enabled",
  AccountAccessKeysPresent: "Root user access keys present",
  ServerCertificates: "Server certificates",
};

export async function accountSummary(ctx: Ctx): Promise<Record<string, number>> {
  const r = await ctx.clients.iam.send(new GetAccountSummaryCommand({}));
  return (r.SummaryMap ?? {}) as Record<string, number>;
}

export const dashboard: ResourceDef = {
  id: "dashboard",
  name: "Dashboard",
  singular: "summary item",
  idField: "key",
  description: "IAM resources in this AWS account.",
  columns: [
    { key: "label", label: "IAM resource", kind: "link" },
    { key: "value", label: "Count", kind: "count" },
  ],
  async list(ctx) {
    const map = await accountSummary(ctx);
    return Object.entries(map).map(([key, value]) => ({ key, label: SUMMARY_LABELS[key] ?? key, value }));
  },
};

const PASSWORD_FIELDS = [
  ["MinimumPasswordLength", "Password minimum length"],
  ["RequireUppercaseCharacters", "Require at least one uppercase letter from the Latin alphabet (A-Z)"],
  ["RequireLowercaseCharacters", "Require at least one lowercase letter from the Latin alphabet (a-z)"],
  ["RequireNumbers", "Require at least one number"],
  ["RequireSymbols", "Require at least one non-alphanumeric character (! @ # $ % ^ & * ( ) _ + - = [ ] { } | ')"],
  ["AllowUsersToChangePassword", "Allow users to change their own password"],
  ["ExpirePasswords", "Turn on password expiration"],
  ["MaxPasswordAge", "Expire passwords in (days)"],
  ["PasswordReusePrevention", "Prevent password reuse (number of previous passwords)"],
  ["HardExpiry", "Password expiration requires administrator reset"],
] as const;

function policyRow(p: PasswordPolicy): Row {
  return Object.fromEntries(PASSWORD_FIELDS.map(([k, label]) => [label, p[k] ?? null]));
}

export const accountSettings: ResourceDef = {
  id: "account-settings",
  name: "Account settings",
  singular: "account setting",
  idField: "setting",
  nameField: "Setting",
  description: "Settings that apply to every IAM user in this account.",
  columns: [
    { key: "setting", label: "Setting", kind: "link" },
    { key: "status", label: "Status", kind: "text" },
  ],
  async list(ctx) {
    const p = await maybe(() => ctx.clients.iam.send(new GetAccountPasswordPolicyCommand({})));
    return [{ setting: "Password policy", status: p?.PasswordPolicy ? "Custom" : "IAM default" }];
  },
  async get(ctx, id) {
    if (id !== "Password policy") throw new Error(`Unknown account setting ${id}.`);
    const p = await maybe(() => ctx.clients.iam.send(new GetAccountPasswordPolicyCommand({})));
    return {
      summary: {
        Setting: "Password policy",
        Status: p?.PasswordPolicy ? "Custom password policy" : "IAM default",
      },
      tabs: [
        {
          id: "policy",
          label: "Password policy",
          kind: "keyvalue",
          data: p?.PasswordPolicy ? policyRow(p.PasswordPolicy) : {},
          description: "Use Actions › Edit password policy to change it.",
          emptyText:
            "This AWS account uses the IAM default password policy: minimum 8 characters, at least three of uppercase letters, lowercase letters, numbers and non-alphanumeric characters, and the password can't be the account name or email address.",
        },
      ],
    };
  },
  actions: [
    {
      id: "edit-password-policy",
      label: "Edit password policy",
      fields: [
        { name: "MinimumPasswordLength", label: "Password minimum length", kind: "number", default: 8, validate: { min: 6, max: 128, message: "Between 6 and 128." } },
        { name: "RequireUppercaseCharacters", label: "Require at least one uppercase letter from the Latin alphabet (A-Z)", kind: "checkbox", default: false },
        { name: "RequireLowercaseCharacters", label: "Require at least one lowercase letter from the Latin alphabet (a-z)", kind: "checkbox", default: false },
        { name: "RequireNumbers", label: "Require at least one number", kind: "checkbox", default: false },
        { name: "RequireSymbols", label: "Require at least one non-alphanumeric character", kind: "checkbox", default: false },
        { name: "AllowUsersToChangePassword", label: "Allow users to change their own password", kind: "checkbox", default: true },
        { name: "ExpirePasswords", label: "Turn on password expiration", kind: "checkbox", default: false },
        { name: "MaxPasswordAge", label: "Expire passwords in (days)", kind: "number", default: 90, showIf: { field: "ExpirePasswords", equals: true }, validate: { min: 1, max: 1095, message: "Between 1 and 1095 days." } },
        { name: "HardExpiry", label: "Password expiration requires administrator reset", kind: "checkbox", default: false, showIf: { field: "ExpirePasswords", equals: true } },
        { name: "PreventReuse", label: "Prevent password reuse", kind: "checkbox", default: false },
        { name: "PasswordReusePrevention", label: "Remember previous passwords", kind: "number", default: 5, showIf: { field: "PreventReuse", equals: true }, validate: { min: 1, max: 24, message: "Between 1 and 24." } },
      ],
      async initialValues(ctx) {
        const p = (await maybe(() => ctx.clients.iam.send(new GetAccountPasswordPolicyCommand({}))))?.PasswordPolicy;
        if (!p) return {}; // IAM default: the field defaults describe it.
        const values: FieldValues = {
          MinimumPasswordLength: p.MinimumPasswordLength ?? 8,
          RequireUppercaseCharacters: p.RequireUppercaseCharacters === true,
          RequireLowercaseCharacters: p.RequireLowercaseCharacters === true,
          RequireNumbers: p.RequireNumbers === true,
          RequireSymbols: p.RequireSymbols === true,
          AllowUsersToChangePassword: p.AllowUsersToChangePassword === true,
          ExpirePasswords: (p.MaxPasswordAge ?? 0) > 0,
          HardExpiry: p.HardExpiry === true,
          PreventReuse: (p.PasswordReusePrevention ?? 0) > 0,
        };
        if (p.MaxPasswordAge) values.MaxPasswordAge = p.MaxPasswordAge;
        if (p.PasswordReusePrevention) values.PasswordReusePrevention = p.PasswordReusePrevention;
        return values;
      },
      async run(ctx, _id, v) {
        const bool = (k: string) => v[k] === true;
        await ctx.clients.iam.send(
          new UpdateAccountPasswordPolicyCommand({
            MinimumPasswordLength: typeof v.MinimumPasswordLength === "number" ? v.MinimumPasswordLength : 8,
            RequireUppercaseCharacters: bool("RequireUppercaseCharacters"),
            RequireLowercaseCharacters: bool("RequireLowercaseCharacters"),
            RequireNumbers: bool("RequireNumbers"),
            RequireSymbols: bool("RequireSymbols"),
            AllowUsersToChangePassword: bool("AllowUsersToChangePassword"),
            MaxPasswordAge: bool("ExpirePasswords") && typeof v.MaxPasswordAge === "number" ? v.MaxPasswordAge : undefined,
            HardExpiry: bool("ExpirePasswords") ? bool("HardExpiry") : undefined,
            PasswordReusePrevention: bool("PreventReuse") && typeof v.PasswordReusePrevention === "number" ? v.PasswordReusePrevention : undefined,
          })
        );
        return { message: "Password policy updated." };
      },
    },
    {
      id: "reset-password-policy",
      label: "Reset to IAM default",
      danger: true,
      confirm: "Deletes the custom password policy (DeleteAccountPasswordPolicy). The IAM default applies again.",
      availableFor: (row) => row.status !== "IAM default" && row.Status !== "IAM default",
      async run(ctx) {
        await ctx.clients.iam.send(new DeleteAccountPasswordPolicyCommand({}));
        return { message: "The account now uses the IAM default password policy." };
      },
    },
  ],
};

/** Principals the simulator can test; the screen itself is hand-built. */
export const simulator: ResourceDef = {
  id: "policy-simulator",
  name: "Policy simulator",
  singular: "principal",
  idField: "arn",
  detailHref: "policy-simulator?principal={id}",
  description: "Test the effect of IAM policies attached to users, groups and roles (SimulatePrincipalPolicy).",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn" },
  ],
  async list(ctx) {
    return principalRows(ctx);
  },
};

export async function principalRows(ctx: Ctx): Promise<Row[]> {
  const [u, g, r] = await Promise.all([allUsers(ctx), allGroups(ctx), allRoles(ctx)]);
  return [
    ...u.map((x) => ({ name: x.UserName ?? "", type: "User", arn: x.Arn ?? "" })),
    ...g.map((x) => ({ name: x.GroupName ?? "", type: "User group", arn: x.Arn ?? "" })),
    ...r.map((x) => ({ name: x.RoleName ?? "", type: "Role", arn: x.Arn ?? "" })),
  ].filter((x) => x.arn);
}
