/**
 * Amazon Cognito user pools: create (sign-in identifiers, password policy, MFA, self sign-up,
 * deletion protection, an initial app client), detail tabs (users, groups, app clients,
 * sign-in, domain, resource servers, tags) and pool-level actions to manage users, groups
 * and app clients. Users, groups and clients live inside a pool in the console, so they are
 * managed from the pool's Actions menu.
 */

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminResetUserPasswordCommand,
  AdminSetUserPasswordCommand,
  CreateGroupCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  CreateUserPoolDomainCommand,
  DeleteGroupCommand,
  DeleteUserPoolClientCommand,
  DeleteUserPoolCommand,
  DeleteUserPoolDomainCommand,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
  GetUserPoolMfaConfigCommand,
  ListGroupsCommand,
  ListResourceServersCommand,
  ListTagsForResourceCommand,
  ListUserPoolClientsCommand,
  ListUserPoolsCommand,
  ListUsersCommand,
  SetUserPoolMfaConfigCommand,
  UpdateUserPoolCommand,
  type AttributeType,
  type GroupType,
  type UpdateUserPoolCommandInput,
  type UserPoolClientDescription,
  type UserPoolType,
  type ExplicitAuthFlowsType,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import type { Ctx, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { s, strs } from "./common.ts";
import { identityPools } from "./identity-pools.ts";
import { poolSchema, updatePoolInput, type UpdatableKey } from "./pool-config.ts";

const attr = (attrs: AttributeType[] | undefined, name: string): string | null => attrs?.find((a) => a.Name === name)?.Value ?? null;

async function allPools(ctx: Ctx) {
  const out: { Id?: string; Name?: string; CreationDate?: Date; LastModifiedDate?: Date }[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken: token }));
    out.push(...(r.UserPools ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function describePool(ctx: Ctx, id: string): Promise<UserPoolType> {
  const pool = (await ctx.clients.cognito.send(new DescribeUserPoolCommand({ UserPoolId: id }))).UserPool;
  if (!pool) throw new Error(`User pool ${id} not found.`);
  return pool;
}

/**
 * UpdateUserPool with the pool's current settings and only `change` applied (see updatePoolInput).
 * UpdateUserPool only accepts MfaConfiguration ON/OPTIONAL together with an SMS configuration,
 * and leaving it out turns MFA off. So for authenticator-app-only MFA the update leaves it out
 * and then puts the pool's MFA settings back with SetUserPoolMfaConfig.
 */
async function updatePool(ctx: Ctx, id: string, change: Partial<Record<UpdatableKey, unknown>>): Promise<void> {
  const c = ctx.clients.cognito;
  const pool = await describePool(ctx, id);
  const input = updatePoolInput(id, pool as unknown as Record<string, unknown>, change) as unknown as UpdateUserPoolCommandInput;
  const restoreMfa = input.MfaConfiguration !== undefined && input.MfaConfiguration !== "OFF" && !input.SmsConfiguration;
  const mfa = restoreMfa ? await c.send(new GetUserPoolMfaConfigCommand({ UserPoolId: id })) : null;
  await c.send(new UpdateUserPoolCommand(restoreMfa ? { ...input, MfaConfiguration: undefined } : input));
  if (mfa) {
    await c.send(
      new SetUserPoolMfaConfigCommand({
        UserPoolId: id,
        MfaConfiguration: mfa.MfaConfiguration,
        SoftwareTokenMfaConfiguration: mfa.SoftwareTokenMfaConfiguration,
        SmsMfaConfiguration: mfa.SmsMfaConfiguration,
        EmailMfaConfiguration: mfa.EmailMfaConfiguration,
      })
    );
  }
}

async function allUsers(ctx: Ctx, pool: string): Promise<UserType[]> {
  const out: UserType[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.cognito.send(new ListUsersCommand({ UserPoolId: pool, PaginationToken: token, Limit: 60 }));
    out.push(...(r.Users ?? []));
    token = r.PaginationToken;
  } while (token);
  return out;
}

function userRows(users: UserType[]): Row[] {
  return users.map((u) => ({
    username: u.Username ?? "",
    email: attr(u.Attributes, "email"),
    emailVerified: attr(u.Attributes, "email_verified") === "true",
    phone: attr(u.Attributes, "phone_number"),
    status: u.UserStatus ?? null,
    enabled: u.Enabled === false ? "Disabled" : "Enabled",
    created: u.UserCreateDate ?? null,
  }));
}

const USER_COLUMNS = [
  { key: "username", label: "User name", kind: "text" as const },
  { key: "email", label: "Email address", kind: "text" as const },
  { key: "emailVerified", label: "Email verified", kind: "boolean" as const },
  { key: "status", label: "Confirmation status", kind: "status" as const },
  { key: "enabled", label: "Status", kind: "status" as const },
  { key: "created", label: "Created", kind: "date" as const },
];

async function groupRows(ctx: Ctx, pool: string): Promise<Row[]> {
  const groups: GroupType[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.cognito.send(new ListGroupsCommand({ UserPoolId: pool, Limit: 60, NextToken: token }));
    groups.push(...(r.Groups ?? []));
    token = r.NextToken;
  } while (token);
  return groups.map((g) => ({ name: g.GroupName ?? "", description: g.Description ?? null, precedence: g.Precedence ?? null, role: g.RoleArn ?? null, created: g.CreationDate ?? null }));
}

async function clientRows(ctx: Ctx, pool: string): Promise<Row[]> {
  const list: UserPoolClientDescription[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.cognito.send(new ListUserPoolClientsCommand({ UserPoolId: pool, MaxResults: 60, NextToken: token }));
    list.push(...(r.UserPoolClients ?? []));
    token = r.NextToken;
  } while (token);
  return Promise.all(
    list.map(async (c) => {
      const d = (await ctx.clients.cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: pool, ClientId: c.ClientId }))).UserPoolClient;
      return {
        id: c.ClientId ?? "",
        name: c.ClientName ?? "",
        secret: d?.ClientSecret ? "Yes" : "No",
        flows: (d?.ExplicitAuthFlows ?? []).join(", ") || "-",
        callbacks: (d?.CallbackURLs ?? []).join(", ") || "-",
        oauth: (d?.AllowedOAuthFlows ?? []).join(", ") || "-",
        created: d?.CreationDate ?? null,
      };
    })
  );
}

function selection<T extends string>(actionId: T, label: string, danger: boolean, valuesField: string) {
  return { actionId, label, danger, valuesField };
}

const userPools: ResourceDef = {
  id: "user-pools",
  name: "User pools",
  singular: "user pool",
  idField: "id",
  nameField: "User pool name",
  description: "User directories that provide sign-up and sign-in for your web and mobile app users.",
  emptyText: "No user pools. Create a user pool to add sign-up and sign-in to your app.",
  columns: [
    { key: "name", label: "User pool name", kind: "link" },
    { key: "id", label: "User pool ID", kind: "code" },
    { key: "created", label: "Created time", kind: "date" },
    { key: "updated", label: "Last updated time", kind: "date" },
  ],

  async list(ctx) {
    return (await allPools(ctx)).map((p) => ({ name: p.Name ?? "", id: p.Id ?? "", created: p.CreationDate ?? null, updated: p.LastModifiedDate ?? null }));
  },

  async get(ctx, id) {
    const c = ctx.clients.cognito;
    const pool = await describePool(ctx, id);
    // Everything after DescribeUserPool is a secondary lookup: a denied call blanks its tab, not the page.
    const [usersR, groupsR, clientsR, mfaR, serversR, tagsR] = await Promise.all([
      secondary(allUsers(ctx, id)),
      secondary(groupRows(ctx, id)),
      secondary(clientRows(ctx, id)),
      secondary(c.send(new GetUserPoolMfaConfigCommand({ UserPoolId: id }))),
      secondary(c.send(new ListResourceServersCommand({ UserPoolId: id, MaxResults: 50 }))),
      secondary<{ Tags?: Record<string, string> }>(pool.Arn ? c.send(new ListTagsForResourceCommand({ ResourceArn: pool.Arn })) : Promise.resolve({ Tags: pool.UserPoolTags })),
    ]);
    const users = usersR.ok ? usersR.value : [];
    const mfa = mfaR.ok ? mfaR.value : undefined;
    const servers = serversR.ok ? serversR.value : { ResourceServers: [] };
    const tags = tagsR.ok ? tagsR.value : { Tags: {} };
    const pw = pool.Policies?.PasswordPolicy;
    return {
      summary: {
        "User pool name": pool.Name ?? id,
        "User pool ID": pool.Id ?? id,
        ARN: pool.Arn ?? null,
        "Token signing key URL": `https://cognito-idp.${ctx.region}.amazonaws.com/${id}/.well-known/jwks.json`,
        "Estimated number of users": pool.EstimatedNumberOfUsers ?? (usersR.ok ? users.length : null),
        "Feature plan": pool.UserPoolTier ?? null,
        "Created time": pool.CreationDate ?? null,
        "Last updated time": pool.LastModifiedDate ?? null,
        "Deletion protection": pool.DeletionProtection ?? null,
        "Cognito domain": pool.Domain ?? null,
      },
      tabs: [
        { id: "users", label: "Users", kind: "table", columns: USER_COLUMNS, data: userRows(users), emptyText: unavailableText(usersR, "No users. Create a user from Actions › Create user.") },
        {
          id: "groups",
          label: "Groups",
          kind: "table",
          columns: [
            { key: "name", label: "Group name", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
            { key: "precedence", label: "Precedence", kind: "count" },
            { key: "role", label: "IAM role", kind: "arn" },
            { key: "created", label: "Created", kind: "date" },
          ],
          data: groupsR.ok ? groupsR.value : [],
          emptyText: unavailableText(groupsR, "No groups."),
        },
        {
          id: "clients",
          label: "App clients",
          kind: "table",
          columns: [
            { key: "name", label: "App client name", kind: "text" },
            { key: "id", label: "Client ID", kind: "code" },
            { key: "secret", label: "Client secret", kind: "text" },
            { key: "flows", label: "Authentication flows", kind: "text" },
            { key: "oauth", label: "OAuth grant types", kind: "text" },
            { key: "callbacks", label: "Callback URLs", kind: "text" },
          ],
          data: clientsR.ok ? clientsR.value : [],
          emptyText: unavailableText(clientsR, "No app clients."),
        },
        {
          id: "sign-in",
          label: "Sign-in",
          kind: "keyvalue",
          data: {
            "Sign-in identifiers": [...(pool.UsernameAttributes ?? []), ...(pool.AliasAttributes ?? []).map((a) => `${a} (alias)`)].join(", ") || "User name",
            "Username case sensitive": pool.UsernameConfiguration?.CaseSensitive ?? null,
            "Password minimum length": pw?.MinimumLength ?? null,
            "Require uppercase": pw?.RequireUppercase ?? null,
            "Require lowercase": pw?.RequireLowercase ?? null,
            "Require numbers": pw?.RequireNumbers ?? null,
            "Require symbols": pw?.RequireSymbols ?? null,
            "Temporary password validity (days)": pw?.TemporaryPasswordValidityDays ?? null,
            "Multi-factor authentication": mfa?.MfaConfiguration ?? pool.MfaConfiguration ?? null,
            "Authenticator apps": mfa ? mfa.SoftwareTokenMfaConfiguration?.Enabled ?? false : `Unavailable: ${mfaR.ok ? "" : mfaR.error}`,
            "SMS message": mfa ? (mfa.SmsMfaConfiguration ? "Configured" : "Not configured") : null,
          },
        },
        {
          id: "sign-up",
          label: "Sign-up",
          kind: "keyvalue",
          data: {
            "Self-registration": pool.AdminCreateUserConfig?.AllowAdminCreateUserOnly ? "Disabled" : "Enabled",
            "Attributes to verify": (pool.AutoVerifiedAttributes ?? []).join(", ") || "None",
            "Required attributes": (pool.SchemaAttributes ?? []).filter((a) => a.Required).map((a) => a.Name).join(", ") || "None",
          },
        },
        {
          id: "domain",
          label: "Domain",
          kind: "keyvalue",
          data: pool.Domain || pool.CustomDomain ? { "Cognito domain": pool.Domain ? `https://${pool.Domain}.auth.${ctx.region}.amazoncognito.com` : null, "Custom domain": pool.CustomDomain ?? null } : {},
          emptyText: "No domain. Use Actions › Create Cognito domain to host the managed login pages.",
        },
        {
          id: "resource-servers",
          label: "Resource servers",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "identifier", label: "Identifier", kind: "text" },
            { key: "scopes", label: "Custom scopes", kind: "text" },
          ],
          data: (servers.ResourceServers ?? []).map((r) => ({ name: r.Name ?? "", identifier: r.Identifier ?? "", scopes: (r.Scopes ?? []).map((x) => x.ScopeName).join(", ") })),
          emptyText: unavailableText(serversR, "No resource servers."),
        },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: Object.entries(tags.Tags ?? {}).map(([Key, Value]) => ({ Key, Value })), emptyText: unavailableText(tagsR, "No tags.") },
      ],
    };
  },

  create: {
    title: "Create user pool",
    description: "Creates the user pool with CreateUserPool and, optionally, an app client with CreateUserPoolClient.",
    fields: [
      { name: "name", label: "User pool name", kind: "text", required: true, section: "Define your application", help: "Up to 128 characters: letters, numbers, spaces and +=,.@-", validate: { pattern: "[\\w\\s+=,.@-]{1,128}", message: "Up to 128 letters, numbers, spaces and +=,.@- characters." } },
      { name: "signIn", label: "Options for sign-in identifiers", kind: "multiselect", required: true, default: ["email"], section: "Configure options", options: [{ value: "username", label: "Username" }, { value: "email", label: "Email" }, { value: "phone_number", label: "Phone number" }], help: "Without Username, users sign in with their email or phone number and Cognito generates the user name." },
      { name: "selfSignUp", label: "Enable self-registration", kind: "checkbox", default: true, section: "Configure options", help: "Lets users create their own accounts from your app." },
      { name: "required", label: "Required attributes for sign-up", kind: "multiselect", section: "Configure options", options: ["email", "phone_number", "name", "given_name", "family_name", "birthdate", "address"].map((a) => ({ value: a, label: a })) },
      { name: "minLength", label: "Password minimum length", kind: "number", default: 8, section: "Password policy", validate: { min: 6, max: 99, message: "Between 6 and 99." } },
      { name: "upper", label: "Contains at least 1 uppercase letter", kind: "checkbox", default: true, section: "Password policy" },
      { name: "lower", label: "Contains at least 1 lowercase letter", kind: "checkbox", default: true, section: "Password policy" },
      { name: "numbers", label: "Contains at least 1 number", kind: "checkbox", default: true, section: "Password policy" },
      { name: "symbols", label: "Contains at least 1 special character", kind: "checkbox", default: true, section: "Password policy" },
      { name: "tempDays", label: "Temporary passwords set by administrators expire in (days)", kind: "number", default: 7, section: "Password policy", validate: { min: 1, max: 365, message: "Between 1 and 365." } },
      { name: "mfa", label: "Multi-factor authentication", kind: "radio", default: "OFF", section: "Multi-factor authentication", options: [{ value: "ON", label: "Require MFA - Recommended" }, { value: "OPTIONAL", label: "Optional MFA" }, { value: "OFF", label: "No MFA" }], help: "MFA here uses authenticator apps (TOTP)." },
      { name: "deletionProtection", label: "Activate deletion protection", kind: "checkbox", default: false, section: "Deletion protection" },
      { name: "createClient", label: "Create an app client", kind: "checkbox", default: true, section: "App client" },
      { name: "clientName", label: "App client name", kind: "text", required: true, section: "App client", showIf: { field: "createClient", equals: true }, validate: { pattern: "[\\w\\s+=,.@-]{1,128}", message: "Up to 128 characters." } },
      { name: "clientSecret", label: "Generate a client secret (confidential client, e.g. a traditional web app)", kind: "checkbox", default: false, section: "App client", showIf: { field: "createClient", equals: true } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const c = ctx.clients.cognito;
      const signIn = strs(v.signIn);
      const tags = Array.isArray(v.tags) ? Object.fromEntries((v.tags as { Key: string; Value: string }[]).map((t) => [t.Key, t.Value])) : {};
      const cfg = poolSchema(signIn, strs(v.required));
      const r = await c.send(
        new CreateUserPoolCommand({
          PoolName: s(v.name),
          UsernameAttributes: cfg.usernameAttributes,
          AliasAttributes: cfg.aliasAttributes,
          AutoVerifiedAttributes: cfg.autoVerified,
          Schema: cfg.schema,
          Policies: {
            PasswordPolicy: {
              MinimumLength: typeof v.minLength === "number" ? v.minLength : 8,
              RequireUppercase: v.upper === true,
              RequireLowercase: v.lower === true,
              RequireNumbers: v.numbers === true,
              RequireSymbols: v.symbols === true,
              TemporaryPasswordValidityDays: typeof v.tempDays === "number" ? v.tempDays : 7,
            },
          },
          AdminCreateUserConfig: { AllowAdminCreateUserOnly: v.selfSignUp !== true },
          DeletionProtection: v.deletionProtection === true ? "ACTIVE" : "INACTIVE",
          UserPoolTags: Object.keys(tags).length ? tags : undefined,
        })
      );
      const id = r.UserPool?.Id;
      if (!id) throw new Error("CreateUserPool returned no ID.");
      if (v.mfa === "ON" || v.mfa === "OPTIONAL") {
        await c.send(new SetUserPoolMfaConfigCommand({ UserPoolId: id, MfaConfiguration: v.mfa, SoftwareTokenMfaConfiguration: { Enabled: true } }));
      }
      if (v.createClient === true) {
        await c.send(
          new CreateUserPoolClientCommand({
            UserPoolId: id,
            ClientName: s(v.clientName),
            GenerateSecret: v.clientSecret === true,
            ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
          })
        );
      }
      return id;
    },
  },

  actions: [
    {
      id: "create-user",
      label: "Create user",
      fields: [
        { name: "username", label: "User name", kind: "text", required: true, help: "For pools that sign in with email or phone, enter the email address or phone number." },
        { name: "email", label: "Email address", kind: "text" },
        { name: "emailVerified", label: "Mark email address as verified", kind: "checkbox", default: false },
        { name: "phone", label: "Phone number", kind: "text", placeholder: "+12065551234" },
        { name: "password", label: "Temporary password", kind: "password", help: "Leave empty to let Cognito generate one. Must meet the pool's password policy." },
        { name: "suppress", label: "Don't send an invitation", kind: "checkbox", default: true },
      ],
      async run(ctx, pool, v) {
        const attrs: AttributeType[] = [];
        if (s(v.email)) attrs.push({ Name: "email", Value: s(v.email) });
        if (s(v.email) && v.emailVerified === true) attrs.push({ Name: "email_verified", Value: "true" });
        if (s(v.phone)) attrs.push({ Name: "phone_number", Value: s(v.phone) });
        const r = await ctx.clients.cognito.send(
          new AdminCreateUserCommand({ UserPoolId: pool, Username: s(v.username), UserAttributes: attrs, TemporaryPassword: s(v.password) || undefined, MessageAction: v.suppress === true ? "SUPPRESS" : undefined })
        );
        return { message: `Created user ${r.User?.Username ?? s(v.username)} (${r.User?.UserStatus ?? ""}).` };
      },
    },
    ...(
      [
        ["disable-users", "Disable user access", "disable", true],
        ["enable-users", "Enable user access", "enable", false],
        ["reset-passwords", "Reset password", "reset", true],
        ["delete-users", "Delete user", "delete", true],
      ] as const
    ).map(([id, label, op, danger]) => ({
      id,
      label,
      danger,
      async run(ctx: Ctx, pool: string) {
        return {
          table: { rowKey: "username", columns: USER_COLUMNS, rows: userRows(await allUsers(ctx, pool)), emptyText: "No users.", selectionAction: selection(`${op}-selected-users`, label, danger, "users") },
        };
      },
    })),
    ...(["disable", "enable", "reset", "delete"] as const).map((op) => ({
      id: `${op}-selected-users`,
      label: `${op} users`,
      hidden: true,
      danger: op !== "enable",
      fields: [{ name: "users", label: "Users", kind: "multiselect" as const, required: true }],
      async run(ctx: Ctx, pool: string, v: Record<string, unknown>) {
        const users = strs(v.users);
        for (const u of users) {
          const input = { UserPoolId: pool, Username: u };
          if (op === "disable") await ctx.clients.cognito.send(new AdminDisableUserCommand(input));
          else if (op === "enable") await ctx.clients.cognito.send(new AdminEnableUserCommand(input));
          else if (op === "reset") await ctx.clients.cognito.send(new AdminResetUserPasswordCommand(input));
          else await ctx.clients.cognito.send(new AdminDeleteUserCommand(input));
        }
        const past = { disable: "Disabled", enable: "Enabled", reset: "Reset the password of", delete: "Deleted" }[op];
        return { message: `${past} ${users.length} user${users.length === 1 ? "" : "s"}.` };
      },
    })),
    {
      id: "set-password",
      label: "Set user password",
      fields: [
        { name: "username", label: "User name", kind: "text", required: true },
        { name: "password", label: "Password", kind: "password", required: true },
        { name: "permanent", label: "Permanent (otherwise the user must change it at next sign-in)", kind: "checkbox", default: true },
      ],
      async run(ctx, pool, v) {
        await ctx.clients.cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: pool, Username: s(v.username), Password: String(v.password ?? ""), Permanent: v.permanent === true }));
        return { message: `Password set for ${s(v.username)}.` };
      },
    },
    {
      id: "create-group",
      label: "Create group",
      fields: [
        { name: "name", label: "Group name", kind: "text", required: true, validate: { pattern: "\\S{1,128}", message: "Up to 128 characters, no spaces." } },
        { name: "description", label: "Description", kind: "text" },
        { name: "precedence", label: "Precedence", kind: "number", validate: { min: 0, max: 2147483647, message: "A non-negative number." }, help: "Lower values take precedence when a user is in several groups." },
        { name: "roleArn", label: "IAM role ARN", kind: "text", help: "Optional role for identity pool users in this group." },
      ],
      async run(ctx, pool, v) {
        await ctx.clients.cognito.send(
          new CreateGroupCommand({ UserPoolId: pool, GroupName: s(v.name), Description: s(v.description) || undefined, Precedence: typeof v.precedence === "number" ? v.precedence : undefined, RoleArn: s(v.roleArn) || undefined })
        );
        return { message: `Created group ${s(v.name)}.` };
      },
    },
    {
      id: "add-user-to-group",
      label: "Add user to group",
      fields: [
        { name: "username", label: "User name", kind: "text", required: true },
        { name: "group", label: "Group name", kind: "text", required: true },
      ],
      async run(ctx, pool, v) {
        await ctx.clients.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: pool, Username: s(v.username), GroupName: s(v.group) }));
        return { message: `Added ${s(v.username)} to ${s(v.group)}.` };
      },
    },
    {
      id: "remove-user-from-group",
      label: "Remove user from group",
      danger: true,
      fields: [
        { name: "username", label: "User name", kind: "text", required: true },
        { name: "group", label: "Group name", kind: "text", required: true },
      ],
      async run(ctx, pool, v) {
        await ctx.clients.cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: pool, Username: s(v.username), GroupName: s(v.group) }));
        return { message: `Removed ${s(v.username)} from ${s(v.group)}.` };
      },
    },
    {
      id: "delete-groups",
      label: "Delete group",
      danger: true,
      async run(ctx, pool) {
        return {
          table: {
            rowKey: "name",
            columns: [
              { key: "name", label: "Group name", kind: "text" },
              { key: "description", label: "Description", kind: "text" },
            ],
            rows: await groupRows(ctx, pool),
            emptyText: "No groups.",
            selectionAction: selection("delete-selected-groups", "Delete", true, "groups"),
          },
        };
      },
    },
    {
      id: "delete-selected-groups",
      label: "Delete groups",
      hidden: true,
      danger: true,
      fields: [{ name: "groups", label: "Groups", kind: "multiselect", required: true }],
      async run(ctx, pool, v) {
        const list = strs(v.groups);
        for (const g of list) await ctx.clients.cognito.send(new DeleteGroupCommand({ UserPoolId: pool, GroupName: g }));
        return { message: `Deleted ${list.length} group${list.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "create-app-client",
      label: "Create app client",
      fields: [
        { name: "name", label: "App client name", kind: "text", required: true },
        { name: "type", label: "Application type", kind: "radio", default: "public", options: [{ value: "public", label: "Public client (single-page or mobile app, no secret)" }, { value: "confidential", label: "Confidential client (server-side app, with a client secret)" }] },
        { name: "flows", label: "Authentication flows", kind: "multiselect", default: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"], options: ["ALLOW_USER_SRP_AUTH", "ALLOW_USER_PASSWORD_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_CUSTOM_AUTH", "ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"].map((f) => ({ value: f, label: f })) },
        { name: "callback", label: "Callback URL", kind: "text", placeholder: "https://example.com/callback", help: "Optional. Turns on the authorization code grant with the openid, email and profile scopes." },
      ],
      async run(ctx, pool, v) {
        const cb = s(v.callback);
        const r = await ctx.clients.cognito.send(
          new CreateUserPoolClientCommand({
            UserPoolId: pool,
            ClientName: s(v.name),
            GenerateSecret: v.type === "confidential",
            ExplicitAuthFlows: strs(v.flows) as ExplicitAuthFlowsType[],
            ...(cb
              ? { CallbackURLs: [cb], AllowedOAuthFlows: ["code"], AllowedOAuthScopes: ["openid", "email", "profile"], AllowedOAuthFlowsUserPoolClient: true, SupportedIdentityProviders: ["COGNITO"] }
              : {}),
          })
        );
        return { message: `Created app client ${r.UserPoolClient?.ClientName ?? ""}.`, json: { ClientId: r.UserPoolClient?.ClientId, ClientSecret: r.UserPoolClient?.ClientSecret ?? null } };
      },
    },
    {
      id: "delete-app-clients",
      label: "Delete app client",
      danger: true,
      async run(ctx, pool) {
        return {
          table: {
            rowKey: "id",
            columns: [
              { key: "name", label: "App client name", kind: "text" },
              { key: "id", label: "Client ID", kind: "code" },
            ],
            rows: await clientRows(ctx, pool),
            emptyText: "No app clients.",
            selectionAction: selection("delete-selected-clients", "Delete", true, "clients"),
          },
        };
      },
    },
    {
      id: "delete-selected-clients",
      label: "Delete app clients",
      hidden: true,
      danger: true,
      fields: [{ name: "clients", label: "App clients", kind: "multiselect", required: true }],
      async run(ctx, pool, v) {
        const list = strs(v.clients);
        for (const id of list) await ctx.clients.cognito.send(new DeleteUserPoolClientCommand({ UserPoolId: pool, ClientId: id }));
        return { message: `Deleted ${list.length} app client${list.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "create-domain",
      label: "Create Cognito domain",
      availableFor: (row) => !("Cognito domain" in row) || !row["Cognito domain"],
      fields: [{ name: "prefix", label: "Cognito domain prefix", kind: "text", required: true, help: "Lowercase letters, numbers and hyphens. The domain becomes https://<prefix>.auth.<region>.amazoncognito.com.", validate: { pattern: "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", message: "Lowercase letters, numbers and hyphens." } }],
      async run(ctx, pool, v) {
        await ctx.clients.cognito.send(new CreateUserPoolDomainCommand({ UserPoolId: pool, Domain: s(v.prefix) }));
        return { message: `Domain ${s(v.prefix)} created.` };
      },
    },
    {
      id: "delete-domain",
      label: "Delete Cognito domain",
      danger: true,
      availableFor: (row) => !("Cognito domain" in row) || Boolean(row["Cognito domain"]),
      fields: [{ name: "prefix", label: "Cognito domain prefix", kind: "text", required: true }],
      async initialValues(ctx, pool) {
        return { prefix: (await describePool(ctx, pool)).Domain ?? "" };
      },
      async run(ctx, pool, v) {
        await ctx.clients.cognito.send(new DeleteUserPoolDomainCommand({ UserPoolId: pool, Domain: s(v.prefix) }));
        return { message: `Domain ${s(v.prefix)} deleted.` };
      },
    },
    {
      id: "edit-mfa",
      label: "Edit multi-factor authentication",
      fields: [{ name: "mfa", label: "MFA enforcement", kind: "radio", required: true, default: "OFF", options: [{ value: "ON", label: "Require MFA" }, { value: "OPTIONAL", label: "Optional MFA" }, { value: "OFF", label: "No MFA" }] }],
      async initialValues(ctx, pool) {
        const r = await ctx.clients.cognito.send(new GetUserPoolMfaConfigCommand({ UserPoolId: pool }));
        return { mfa: r.MfaConfiguration ?? "OFF" };
      },
      async run(ctx, pool, v) {
        const mode = v.mfa === "ON" || v.mfa === "OPTIONAL" ? v.mfa : "OFF";
        const current = await ctx.clients.cognito.send(new GetUserPoolMfaConfigCommand({ UserPoolId: pool }));
        if ((current.MfaConfiguration ?? "OFF") === mode) return { message: `MFA is already ${mode}. Nothing changed.` };
        // Keep the SMS / email MFA settings the pool already has; turning MFA on enables authenticator apps.
        await ctx.clients.cognito.send(
          new SetUserPoolMfaConfigCommand({
            UserPoolId: pool,
            MfaConfiguration: mode,
            SmsMfaConfiguration: current.SmsMfaConfiguration,
            EmailMfaConfiguration: current.EmailMfaConfiguration,
            SoftwareTokenMfaConfiguration: mode === "OFF" ? current.SoftwareTokenMfaConfiguration : { Enabled: true },
          })
        );
        return { message: `MFA set to ${mode}.` };
      },
    },
    {
      id: "edit-password-policy",
      label: "Edit password policy",
      fields: [
        { name: "minLength", label: "Password minimum length", kind: "number", required: true, default: 8, validate: { min: 6, max: 99, message: "Between 6 and 99." } },
        { name: "upper", label: "Contains at least 1 uppercase letter", kind: "checkbox", default: true },
        { name: "lower", label: "Contains at least 1 lowercase letter", kind: "checkbox", default: true },
        { name: "numbers", label: "Contains at least 1 number", kind: "checkbox", default: true },
        { name: "symbols", label: "Contains at least 1 special character", kind: "checkbox", default: true },
        { name: "tempDays", label: "Temporary passwords set by administrators expire in (days)", kind: "number", required: true, default: 7, validate: { min: 1, max: 365, message: "Between 1 and 365." } },
      ],
      async initialValues(ctx, pool) {
        const pw = (await describePool(ctx, pool)).Policies?.PasswordPolicy;
        return {
          minLength: pw?.MinimumLength ?? 8,
          upper: pw?.RequireUppercase === true,
          lower: pw?.RequireLowercase === true,
          numbers: pw?.RequireNumbers === true,
          symbols: pw?.RequireSymbols === true,
          tempDays: pw?.TemporaryPasswordValidityDays ?? 7,
        };
      },
      async run(ctx, pool, v) {
        const current = await describePool(ctx, pool);
        await updatePool(ctx, pool, {
          Policies: {
            ...current.Policies,
            PasswordPolicy: {
              ...current.Policies?.PasswordPolicy,
              MinimumLength: typeof v.minLength === "number" ? v.minLength : current.Policies?.PasswordPolicy?.MinimumLength,
              RequireUppercase: v.upper === true,
              RequireLowercase: v.lower === true,
              RequireNumbers: v.numbers === true,
              RequireSymbols: v.symbols === true,
              TemporaryPasswordValidityDays: typeof v.tempDays === "number" ? v.tempDays : current.Policies?.PasswordPolicy?.TemporaryPasswordValidityDays,
            },
          },
        });
        return { message: "Password policy updated. Other pool settings were sent back unchanged." };
      },
    },
    {
      id: "edit-self-registration",
      label: "Edit self-service sign-up",
      fields: [{ name: "selfSignUp", label: "Enable self-registration", kind: "checkbox", default: false, help: "Lets users create their own accounts from your app. Off means only administrators create users." }],
      async initialValues(ctx, pool) {
        return { selfSignUp: (await describePool(ctx, pool)).AdminCreateUserConfig?.AllowAdminCreateUserOnly !== true };
      },
      async run(ctx, pool, v) {
        const current = await describePool(ctx, pool);
        const adminOnly = v.selfSignUp !== true;
        if ((current.AdminCreateUserConfig?.AllowAdminCreateUserOnly === true) === adminOnly) return { message: "Nothing changed." };
        await updatePool(ctx, pool, { AdminCreateUserConfig: { ...current.AdminCreateUserConfig, AllowAdminCreateUserOnly: adminOnly } });
        return { message: `Self-registration ${adminOnly ? "disabled" : "enabled"}.` };
      },
    },
    {
      id: "deletion-protection",
      label: "Edit deletion protection",
      fields: [{ name: "on", label: "Activate deletion protection", kind: "checkbox", default: false }],
      async initialValues(ctx, pool) {
        return { on: (await describePool(ctx, pool)).DeletionProtection === "ACTIVE" };
      },
      async run(ctx, pool, v) {
        const want = v.on === true ? "ACTIVE" : "INACTIVE";
        if (((await describePool(ctx, pool)).DeletionProtection ?? "INACTIVE") === want) return { message: `Deletion protection is already ${want === "ACTIVE" ? "active" : "inactive"}. Nothing changed.` };
        await updatePool(ctx, pool, { DeletionProtection: want });
        return { message: `Deletion protection ${want === "ACTIVE" ? "activated" : "deactivated"}.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, id) {
      const pool = await describePool(ctx, id);
      if (pool.Domain) await ctx.clients.cognito.send(new DeleteUserPoolDomainCommand({ UserPoolId: id, Domain: pool.Domain }));
      await ctx.clients.cognito.send(new DeleteUserPoolCommand({ UserPoolId: id }));
    },
  },
};

export const cognitoService: ServiceDef = {
  id: "cognito",
  name: "Cognito",
  category: "Security, Identity, & Compliance",
  description: "Customer identity and access management: sign-up, sign-in and access control for web and mobile apps.",
  resources: [userPools, identityPools],
};
