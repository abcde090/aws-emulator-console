/**
 * IAM users: list, create (console access, permissions via groups / copy / direct policies,
 * permissions boundary, tags), detail tabs and the Security credentials actions
 * (console password, access keys, virtual MFA devices).
 */

import {
  AddUserToGroupCommand,
  CreateAccessKeyCommand,
  CreateLoginProfileCommand,
  CreateUserCommand,
  CreateVirtualMFADeviceCommand,
  DeactivateMFADeviceCommand,
  DeleteAccessKeyCommand,
  DeleteLoginProfileCommand,
  DeleteSigningCertificateCommand,
  DeleteSSHPublicKeyCommand,
  DeleteServiceSpecificCredentialCommand,
  DeleteUserCommand,
  DeleteVirtualMFADeviceCommand,
  EnableMFADeviceCommand,
  GetAccessKeyLastUsedCommand,
  GetLoginProfileCommand,
  GetUserCommand,
  ListAccessKeysCommand,
  ListMFADevicesCommand,
  ListServiceSpecificCredentialsCommand,
  ListSigningCertificatesCommand,
  ListSSHPublicKeysCommand,
  PutUserPermissionsBoundaryCommand,
  RemoveUserFromGroupCommand,
  UpdateAccessKeyCommand,
  UpdateLoginProfileCommand,
  type AccessKeyMetadata,
} from "@aws-sdk/client-iam";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { fieldTags } from "../../console/tags.ts";
import { secondary } from "../../console/secondary.ts";
import { allUsers, orDenied, groupOptions, maybe, PATH_PATTERN, plural, policyOptions, strings, TAG_COLUMNS, tagRows, text, userOptions } from "./common.ts";
import { attach, attachedPolicies, clearPermissions, entityTags, groupsForUser, inlineDocuments, inlinePolicyDocument, inlinePolicyNames, PERMISSION_COLUMNS, permissionActions, permissionRows, putInline } from "./permissions.ts";

const USER_NAME = "[\\w+=,.@-]{1,64}";

async function listKeys(ctx: Ctx, user: string): Promise<AccessKeyMetadata[]> {
  return (await ctx.clients.iam.send(new ListAccessKeysCommand({ UserName: user }))).AccessKeyMetadata ?? [];
}

const groupsOf = groupsForUser;
const UNAVAILABLE = "Unavailable";

function ageDays(d: Date | undefined): number | null {
  return d ? Math.floor((Date.now() - d.getTime()) / 86_400_000) : null;
}

async function keyRows(ctx: Ctx, user: string): Promise<Row[]> {
  const keys = await listKeys(ctx, user);
  return Promise.all(
    keys.map(async (k) => {
      const used = k.AccessKeyId ? await ctx.clients.iam.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: k.AccessKeyId })) : null;
      return {
        id: k.AccessKeyId ?? "",
        status: k.Status ?? null,
        created: k.CreateDate ?? null,
        lastUsed: used?.AccessKeyLastUsed?.LastUsedDate ?? null,
        lastService: used?.AccessKeyLastUsed?.ServiceName ?? null,
        lastRegion: used?.AccessKeyLastUsed?.Region ?? null,
      };
    })
  );
}

async function mfaRows(ctx: Ctx, user: string): Promise<Row[]> {
  const r = await ctx.clients.iam.send(new ListMFADevicesCommand({ UserName: user }));
  return (r.MFADevices ?? []).map((d) => ({ serial: d.SerialNumber ?? "", type: d.SerialNumber?.includes(":mfa/") ? "Virtual" : "Hardware / passkey", enabled: d.EnableDate ?? null }));
}

/** Everything the console deletes along with the user. */
async function deleteUserCascade(ctx: Ctx, user: string): Promise<void> {
  const iam = ctx.clients.iam;
  await maybe(() => iam.send(new DeleteLoginProfileCommand({ UserName: user })));
  for (const k of await listKeys(ctx, user)) if (k.AccessKeyId) await iam.send(new DeleteAccessKeyCommand({ UserName: user, AccessKeyId: k.AccessKeyId }));
  for (const d of (await iam.send(new ListMFADevicesCommand({ UserName: user }))).MFADevices ?? []) {
    if (!d.SerialNumber) continue;
    await iam.send(new DeactivateMFADeviceCommand({ UserName: user, SerialNumber: d.SerialNumber }));
    if (d.SerialNumber.includes(":mfa/")) await maybe(() => iam.send(new DeleteVirtualMFADeviceCommand({ SerialNumber: d.SerialNumber })));
  }
  for (const k of (await iam.send(new ListSSHPublicKeysCommand({ UserName: user }))).SSHPublicKeys ?? []) {
    if (k.SSHPublicKeyId) await iam.send(new DeleteSSHPublicKeyCommand({ UserName: user, SSHPublicKeyId: k.SSHPublicKeyId }));
  }
  for (const c of (await iam.send(new ListSigningCertificatesCommand({ UserName: user }))).Certificates ?? []) {
    if (c.CertificateId) await iam.send(new DeleteSigningCertificateCommand({ UserName: user, CertificateId: c.CertificateId }));
  }
  for (const c of (await iam.send(new ListServiceSpecificCredentialsCommand({ UserName: user }))).ServiceSpecificCredentials ?? []) {
    if (c.ServiceSpecificCredentialId) await iam.send(new DeleteServiceSpecificCredentialCommand({ UserName: user, ServiceSpecificCredentialId: c.ServiceSpecificCredentialId }));
  }
  for (const g of await groupsOf(ctx, user)) await iam.send(new RemoveUserFromGroupCommand({ UserName: user, GroupName: g }));
  await clearPermissions(ctx, "user", user);
  await iam.send(new DeleteUserCommand({ UserName: user }));
}

/** "Copy permissions": groups, managed and inline policies and the boundary of another user. */
async function copyPermissions(ctx: Ctx, from: string, to: string): Promise<void> {
  const iam = ctx.clients.iam;
  for (const g of await groupsOf(ctx, from)) await iam.send(new AddUserToGroupCommand({ UserName: to, GroupName: g }));
  for (const p of await attachedPolicies(ctx, "user", from)) if (p.PolicyArn) await attach(ctx, "user", to, p.PolicyArn);
  for (const n of await inlinePolicyNames(ctx, "user", from)) await putInline(ctx, "user", to, n, JSON.stringify(await inlinePolicyDocument(ctx, "user", from, n)));
  const boundary = (await iam.send(new GetUserCommand({ UserName: from }))).User?.PermissionsBoundary?.PermissionsBoundaryArn;
  if (boundary) await iam.send(new PutUserPermissionsBoundaryCommand({ UserName: to, PermissionsBoundary: boundary }));
}

/** Console access from a list row ("consoleAccess") or the detail summary ("Console access"). */
function consoleState(row: Row): "enabled" | "disabled" | "unknown" {
  const v = String(row.consoleAccess ?? row["Console access"] ?? "");
  if (v === "Disabled") return "disabled";
  return v.startsWith("Enabled") ? "enabled" : "unknown";
}

export const users: ResourceDef = {
  id: "users",
  name: "Users",
  singular: "user",
  idField: "name",
  nameField: "User name",
  description: "An IAM user is an identity with long-term credentials that is used to interact with AWS in an account.",
  emptyText: "No users to display.",
  columns: [
    { key: "name", label: "User name", kind: "link" },
    { key: "path", label: "Path", kind: "text" },
    { key: "groups", label: "Groups", kind: "count" },
    { key: "mfa", label: "MFA", kind: "text" },
    { key: "consoleAccess", label: "Console access", kind: "status" },
    { key: "passwordLastUsed", label: "Console last sign-in", kind: "date" },
    { key: "accessKey", label: "Access key ID", kind: "code" },
    { key: "keyAge", label: "Active key age (days)", kind: "count" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const list = await allUsers(ctx);
    return Promise.all(
      list.map(async (u) => {
        const name = u.UserName ?? "";
        // Secondary reads: a denied one marks its cell unavailable instead of failing the list.
        const [groups, mfa, login, keys] = await Promise.all([
          orDenied(() => groupsOf(ctx, name), null),
          orDenied(async () => (await ctx.clients.iam.send(new ListMFADevicesCommand({ UserName: name }))).MFADevices ?? [], null),
          orDenied(async () => ((await maybe(() => ctx.clients.iam.send(new GetLoginProfileCommand({ UserName: name })))) ? "Enabled" : "Disabled"), UNAVAILABLE),
          orDenied(() => listKeys(ctx, name), null),
        ]);
        const active = (keys ?? []).filter((k) => k.Status === "Active");
        return {
          name,
          path: u.Path ?? "/",
          groups: groups ? groups.length : null,
          mfa: mfa === null ? UNAVAILABLE : mfa.length ? mfa.map((d) => (d.SerialNumber?.includes(":mfa/") ? "Virtual" : "Hardware")).join(", ") : "-",
          consoleAccess: login,
          passwordLastUsed: u.PasswordLastUsed ?? null,
          accessKey: keys === null ? UNAVAILABLE : keys.length ? keys.map((k) => `${k.AccessKeyId} (${k.Status})`).join(", ") : null,
          keyAge: active.length ? ageDays(active.map((k) => k.CreateDate).filter((d): d is Date => d instanceof Date).sort((a, b) => a.getTime() - b.getTime())[0]) : null,
          created: u.CreateDate ?? null,
          arn: u.Arn ?? null,
        };
      })
    );
  },

  async get(ctx, name) {
    const iam = ctx.clients.iam;
    const [userR, loginR, groupsR, permsR, inlineR, tagsR, keysR, mfaR, sshR, certsR, svcR] = await Promise.all([
      iam.send(new GetUserCommand({ UserName: name })),
      secondary(() => maybe(() => iam.send(new GetLoginProfileCommand({ UserName: name })))),
      secondary(() => groupsOf(ctx, name)),
      secondary(() => permissionRows(ctx, "user", name)),
      secondary(() => inlineDocuments(ctx, "user", name)),
      secondary(() => entityTags(ctx, "user", name)),
      secondary(() => keyRows(ctx, name)),
      secondary(() => mfaRows(ctx, name)),
      secondary(() => iam.send(new ListSSHPublicKeysCommand({ UserName: name }))),
      secondary(() => iam.send(new ListSigningCertificatesCommand({ UserName: name }))),
      secondary(() => iam.send(new ListServiceSpecificCredentialsCommand({ UserName: name }))),
    ]);
    const u = userR.User;
    const val = <T,>(r: { ok: true; value: T } | { ok: false; error: string }, fallback: T): T => (r.ok ? r.value : fallback);
    const empty = (r: { ok: boolean; error?: string }, text: string) => (r.ok ? text : `Unavailable: ${r.error}`);
    const login = val(loginR, null);
    const groups = val(groupsR, []);
    const keys = val(keysR, []);
    const mfa = val(mfaR, []);
    const ssh = sshR.ok ? (sshR.value.SSHPublicKeys ?? []) : [];
    const certs = certsR.ok ? (certsR.value.Certificates ?? []) : [];
    const svc = svcR.ok ? (svcR.value.ServiceSpecificCredentials ?? []) : [];
    const consoleAccess = !loginR.ok ? UNAVAILABLE : login?.LoginProfile ? (mfa.length ? "Enabled with MFA" : "Enabled without MFA") : "Disabled";
    return {
      summary: {
        "User name": u?.UserName ?? name,
        ARN: u?.Arn ?? null,
        "Console access": consoleAccess,
        "Created": u?.CreateDate ?? null,
        "Last console sign-in": u?.PasswordLastUsed ?? "Never",
        "Access key 1": !keysR.ok ? UNAVAILABLE : keys[0] ? `${keys[0].id} - ${keys[0].status}` : "Not enabled",
        "Access key 2": !keysR.ok ? UNAVAILABLE : keys[1] ? `${keys[1].id} - ${keys[1].status}` : "Not enabled",
        "Permissions boundary": u?.PermissionsBoundary?.PermissionsBoundaryArn ?? "Not set",
        Path: u?.Path ?? "/",
      },
      tabs: [
        { id: "permissions", label: "Permissions", kind: "table", columns: PERMISSION_COLUMNS, data: val(permsR, []), description: "Permissions are defined by policies attached to the user directly or through groups.", emptyText: empty(permsR, "No permissions policies. This user can't do anything.") },
        { id: "inline", label: "Inline policies", kind: "json", data: val(inlineR, null), emptyText: empty(inlineR, "No inline policies.") },
        {
          id: "boundary",
          label: "Permissions boundary",
          kind: "keyvalue",
          data: u?.PermissionsBoundary ? { "Boundary policy": u.PermissionsBoundary.PermissionsBoundaryArn ?? null, Type: u.PermissionsBoundary.PermissionsBoundaryType ?? null } : {},
          emptyText: "Permissions boundary (not set). Use Actions › Set permissions boundary.",
        },
        { id: "groups", label: "Groups", kind: "table", columns: [{ key: "group", label: "Group name", kind: "text", href: "/iam/groups/{group}" }], data: groups.map((group) => ({ group })), emptyText: empty(groupsR, "This user is not a member of any groups.") },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(val(tagsR, [])), emptyText: empty(tagsR, "No tags associated with the resource.") },
        {
          id: "console",
          label: "Console sign-in",
          kind: "keyvalue",
          data: {
            "Console access": consoleAccess,
            "Console password created": login?.LoginProfile?.CreateDate ?? null,
            "Password reset required": login?.LoginProfile ? login.LoginProfile.PasswordResetRequired === true : null,
            "Console sign-in link": `https://${ctx.accountId}.signin.aws.amazon.com/console`,
          },
        },
        {
          id: "mfa",
          label: "Multi-factor authentication (MFA)",
          kind: "table",
          columns: [
            { key: "serial", label: "Identifier", kind: "arn" },
            { key: "type", label: "Type", kind: "text" },
            { key: "enabled", label: "Created on", kind: "date" },
          ],
          data: mfa,
          emptyText: empty(mfaR, "No MFA devices. Assign an MFA device to improve the security of your AWS environment."),
        },
        {
          id: "keys",
          label: "Access keys",
          kind: "table",
          columns: [
            { key: "id", label: "Access key ID", kind: "code" },
            { key: "status", label: "Status", kind: "status" },
            { key: "created", label: "Created", kind: "date" },
            { key: "lastUsed", label: "Last used", kind: "date" },
            { key: "lastService", label: "Last used service", kind: "text" },
            { key: "lastRegion", label: "Last used Region", kind: "text" },
          ],
          data: keys,
          description: "Use access keys to send programmatic calls to AWS from the AWS CLI, SDKs or direct API calls. You can have a maximum of two access keys (active or inactive) at a time.",
          emptyText: empty(keysR, "No access keys. As a best practice, avoid using long-term credentials like access keys."),
        },
        {
          id: "other-credentials",
          label: "Other credentials",
          kind: "table",
          columns: [
            { key: "type", label: "Credential type", kind: "text" },
            { key: "id", label: "ID", kind: "code" },
            { key: "status", label: "Status", kind: "status" },
          ],
          data: [
            ...ssh.map((k) => ({ type: "SSH public key for AWS CodeCommit", id: k.SSHPublicKeyId ?? "", status: k.Status ?? null })),
            ...certs.map((c) => ({ type: "X.509 signing certificate", id: c.CertificateId ?? "", status: c.Status ?? null })),
            ...svc.map((c) => ({ type: `Service-specific credential (${c.ServiceName ?? ""})`, id: c.ServiceSpecificCredentialId ?? "", status: c.Status ?? null })),
          ],
          emptyText: sshR.ok && certsR.ok && svcR.ok ? "No SSH public keys, X.509 signing certificates or service-specific credentials." : "Some credential types are unavailable (access denied).",
        },
      ],
    };
  },

  create: {
    title: "Create user",
    description: "Creates an IAM user with CreateUser, then sets console access, permissions and tags.",
    fields: [
      { name: "userName", label: "User name", kind: "text", required: true, section: "User details", help: "Up to 64 characters. Valid characters: A-Z, a-z, 0-9, and + = , . @ _ - (hyphen).", validate: { pattern: USER_NAME, message: "Use up to 64 letters, numbers and + = , . @ _ - characters." } },
      { name: "path", label: "Path", kind: "text", section: "User details", default: "/", help: "Optional organizational path, for example /division/team/. Starts and ends with /.", validate: { pattern: PATH_PATTERN, message: "A path starts and ends with /." } },
      { name: "consoleAccess", label: "Provide user access to the AWS Management Console", kind: "checkbox", default: false, section: "User details", help: "If you're providing console access to a person, it's a best practice to manage their access in IAM Identity Center." },
      { name: "password", label: "Custom password", kind: "password", required: true, section: "User details", showIf: { field: "consoleAccess", equals: true }, help: "Must meet the account password policy. You give this password to the user; it is not shown again.", validate: { min: 8, max: 128, message: "Between 8 and 128 characters." } },
      { name: "resetRequired", label: "Users must create a new password at next sign-in - Recommended", kind: "checkbox", default: true, section: "User details", showIf: { field: "consoleAccess", equals: true } },
      {
        name: "permissionsOption", label: "Permissions options", kind: "radio", default: "group", section: "Set permissions",
        options: [
          { value: "group", label: "Add user to group: add the user to an existing group (recommended)" },
          { value: "copy", label: "Copy permissions: copy all group memberships, attached managed policies and inline policies from an existing user" },
          { value: "direct", label: "Attach policies directly: attach a managed policy directly to the user" },
        ],
      },
      { name: "groups", label: "User groups", kind: "multiselect", options: groupOptions, section: "Set permissions", showIf: { field: "permissionsOption", equals: "group" } },
      { name: "copyFrom", label: "Copy permissions from user", kind: "select", options: userOptions, section: "Set permissions", showIf: { field: "permissionsOption", equals: "copy" } },
      { name: "policies", label: "Permissions policies", kind: "multiselect", options: policyOptions, section: "Set permissions", showIf: { field: "permissionsOption", equals: "direct" } },
      { name: "useBoundary", label: "Use a permissions boundary to control the maximum user permissions", kind: "checkbox", default: false, section: "Permissions boundary" },
      { name: "boundary", label: "Permissions boundary policy", kind: "select", required: true, options: policyOptions, section: "Permissions boundary", showIf: { field: "useBoundary", equals: true } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const iam = ctx.clients.iam;
      const name = text(v.userName);
      const tags = fieldTags(v.tags);
      await iam.send(
        new CreateUserCommand({
          UserName: name,
          Path: text(v.path) || "/",
          Tags: tags.length ? tags : undefined,
          PermissionsBoundary: v.useBoundary === true ? text(v.boundary) : undefined,
        })
      );
      if (v.consoleAccess === true) {
        await iam.send(new CreateLoginProfileCommand({ UserName: name, Password: String(v.password ?? ""), PasswordResetRequired: v.resetRequired === true }));
      }
      if (v.permissionsOption === "group") for (const g of strings(v.groups)) await iam.send(new AddUserToGroupCommand({ UserName: name, GroupName: g }));
      if (v.permissionsOption === "direct") for (const p of strings(v.policies)) await attach(ctx, "user", name, p);
      if (v.permissionsOption === "copy" && text(v.copyFrom)) await copyPermissions(ctx, text(v.copyFrom), name);
      return name;
    },
  },

  actions: [
    ...permissionActions("user"),
    {
      id: "add-to-groups",
      label: "Add user to groups",
      fields: [{ name: "groups", label: "User groups", kind: "multiselect", required: true, options: groupOptions }],
      async run(ctx, name, v) {
        const groups = strings(v.groups);
        for (const g of groups) await ctx.clients.iam.send(new AddUserToGroupCommand({ UserName: name, GroupName: g }));
        return { message: `Added ${name} to ${plural(groups.length, "group")}.` };
      },
    },
    {
      id: "remove-from-groups",
      label: "Remove user from groups",
      async run(ctx, name) {
        const groups = await groupsOf(ctx, name);
        return {
          table: {
            rowKey: "group",
            columns: [{ key: "group", label: "Group name", kind: "text" }],
            rows: groups.map((group) => ({ group })),
            emptyText: "This user is not a member of any groups.",
            selectionAction: { actionId: "leave-groups", label: "Remove", danger: true, valuesField: "groups" },
          },
        };
      },
    },
    {
      id: "leave-groups",
      label: "Remove from groups",
      hidden: true,
      danger: true,
      fields: [{ name: "groups", label: "Groups", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const groups = strings(v.groups);
        for (const g of groups) await ctx.clients.iam.send(new RemoveUserFromGroupCommand({ UserName: name, GroupName: g }));
        return { message: `Removed ${name} from ${plural(groups.length, "group")}.` };
      },
    },
    {
      id: "enable-console",
      label: "Enable console access",
      availableFor: (row) => consoleState(row) !== "enabled",
      fields: [
        { name: "password", label: "Custom password", kind: "password", required: true, validate: { min: 8, max: 128, message: "Between 8 and 128 characters." } },
        { name: "resetRequired", label: "User must create a new password at next sign-in", kind: "checkbox", default: true },
      ],
      async run(ctx, name, v) {
        await ctx.clients.iam.send(new CreateLoginProfileCommand({ UserName: name, Password: String(v.password ?? ""), PasswordResetRequired: v.resetRequired === true }));
        return { message: `Console access enabled for ${name}. Sign-in URL: https://${ctx.accountId}.signin.aws.amazon.com/console` };
      },
    },
    {
      id: "reset-password",
      label: "Reset console password",
      availableFor: (row) => consoleState(row) !== "disabled",
      fields: [
        { name: "password", label: "New custom password", kind: "password", required: true, validate: { min: 8, max: 128, message: "Between 8 and 128 characters." } },
        { name: "resetRequired", label: "User must create a new password at next sign-in", kind: "checkbox", default: true },
      ],
      async run(ctx, name, v) {
        await ctx.clients.iam.send(new UpdateLoginProfileCommand({ UserName: name, Password: String(v.password ?? ""), PasswordResetRequired: v.resetRequired === true }));
        return { message: `Console password for ${name} was reset.` };
      },
    },
    {
      id: "disable-console",
      label: "Disable console access",
      availableFor: (row) => consoleState(row) !== "disabled",
      danger: true,
      confirm: "The user's console password is deleted. The user can no longer sign in to the AWS Management Console.",
      async run(ctx, name) {
        await ctx.clients.iam.send(new DeleteLoginProfileCommand({ UserName: name }));
        return { message: `Console access disabled for ${name}.` };
      },
    },
    {
      id: "create-access-key",
      label: "Create access key",
      // At most two access keys per user.
      availableFor: (row) => row["Access key 2"] === undefined || row["Access key 2"] === "Not enabled",
      confirm: "Creates a new access key. This is the only time the secret access key can be viewed or downloaded; you can't recover it later.",
      async run(ctx, name) {
        const r = await ctx.clients.iam.send(new CreateAccessKeyCommand({ UserName: name }));
        const k = r.AccessKey;
        return {
          message: `Access key created. Copy the secret access key now; it is not shown again.`,
          json: { AccessKeyId: k?.AccessKeyId, SecretAccessKey: k?.SecretAccessKey, Status: k?.Status, CreateDate: k?.CreateDate },
        };
      },
    },
    ...(["Activate", "Deactivate", "Delete"] as const).map((verb) => ({
      id: `${verb.toLowerCase()}-access-keys`,
      label: `${verb} access key`,
      danger: verb !== "Activate",
      async run(ctx: Ctx, name: string) {
        const rows = await keyRows(ctx, name);
        return {
          message: verb === "Delete" ? "Deactivate an access key before you delete it, so you can check nothing still uses it." : undefined,
          table: {
            rowKey: "id",
            columns: [
              { key: "id", label: "Access key ID", kind: "code" as const },
              { key: "status", label: "Status", kind: "status" as const },
              { key: "created", label: "Created", kind: "date" as const },
              { key: "lastUsed", label: "Last used", kind: "date" as const },
            ],
            rows,
            emptyText: "No access keys.",
            selectionAction: { actionId: `${verb.toLowerCase()}-keys`, label: verb, danger: verb !== "Activate", valuesField: "keys" },
          },
        };
      },
    })),
    ...(["Activate", "Deactivate", "Delete"] as const).map((verb) => ({
      id: `${verb.toLowerCase()}-keys`,
      label: `${verb} keys`,
      hidden: true,
      danger: verb !== "Activate",
      fields: [{ name: "keys", label: "Access keys", kind: "multiselect" as const, required: true }],
      async run(ctx: Ctx, name: string, v: Record<string, unknown>) {
        const keys = Array.isArray(v.keys) ? (v.keys as string[]) : [];
        for (const id of keys) {
          if (verb === "Delete") await ctx.clients.iam.send(new DeleteAccessKeyCommand({ UserName: name, AccessKeyId: id }));
          else await ctx.clients.iam.send(new UpdateAccessKeyCommand({ UserName: name, AccessKeyId: id, Status: verb === "Activate" ? "Active" : "Inactive" }));
        }
        return { message: `${verb === "Delete" ? "Deleted" : verb === "Activate" ? "Activated" : "Deactivated"} ${plural(keys.length, "access key")}.` };
      },
    })),
    {
      id: "assign-mfa",
      label: "Assign MFA device",
      fields: [
        { name: "deviceName", label: "Device name", kind: "text", required: true, help: "Up to 128 characters: letters, numbers and +=,.@-_. Step 1 of 2: creates a virtual MFA device.", validate: { pattern: "[\\w+=,.@-]{1,128}", message: "Use up to 128 letters, numbers and +=,.@-_." } },
      ],
      async run(ctx, name, v) {
        const r = await ctx.clients.iam.send(new CreateVirtualMFADeviceCommand({ VirtualMFADeviceName: text(v.deviceName) }));
        const seed = r.VirtualMFADevice?.Base32StringSeed;
        return {
          message: `Virtual MFA device created for ${name}. Add the secret key to your authenticator app, then use Actions › Activate MFA device with two consecutive codes.`,
          json: { SerialNumber: r.VirtualMFADevice?.SerialNumber, SecretKey: seed ? Buffer.from(seed).toString("utf8") : null },
        };
      },
    },
    {
      id: "activate-mfa",
      label: "Activate MFA device",
      fields: [
        { name: "serial", label: "MFA device identifier (ARN)", kind: "text", required: true, placeholder: "arn:aws:iam::000000000000:mfa/my-device" },
        { name: "code1", label: "MFA code 1", kind: "text", required: true, validate: { pattern: "\\d{6}", message: "Six digits." } },
        { name: "code2", label: "MFA code 2", kind: "text", required: true, help: "Wait 30 seconds and enter the next code.", validate: { pattern: "\\d{6}", message: "Six digits." } },
      ],
      async run(ctx, name, v) {
        await ctx.clients.iam.send(new EnableMFADeviceCommand({ UserName: name, SerialNumber: text(v.serial), AuthenticationCode1: text(v.code1), AuthenticationCode2: text(v.code2) }));
        return { message: `MFA device ${text(v.serial)} is now active for ${name}.` };
      },
    },
    {
      id: "remove-mfa",
      label: "Remove MFA device",
      availableFor: (row) => row.mfa !== "-",
      danger: true,
      async run(ctx, name) {
        return {
          table: {
            rowKey: "serial",
            columns: [
              { key: "serial", label: "Identifier", kind: "arn" },
              { key: "type", label: "Type", kind: "text" },
              { key: "enabled", label: "Created on", kind: "date" },
            ],
            rows: await mfaRows(ctx, name),
            emptyText: "No MFA devices.",
            selectionAction: { actionId: "deactivate-mfa", label: "Remove", danger: true, valuesField: "serials" },
          },
        };
      },
    },
    {
      id: "deactivate-mfa",
      label: "Remove MFA devices",
      hidden: true,
      danger: true,
      fields: [{ name: "serials", label: "Devices", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const serials = strings(v.serials);
        for (const s of serials) {
          await ctx.clients.iam.send(new DeactivateMFADeviceCommand({ UserName: name, SerialNumber: s }));
          if (s.includes(":mfa/")) await ctx.clients.iam.send(new DeleteVirtualMFADeviceCommand({ SerialNumber: s }));
        }
        return { message: `Removed ${plural(serials.length, "MFA device")}.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await deleteUserCascade(ctx, name);
    },
  },
};

