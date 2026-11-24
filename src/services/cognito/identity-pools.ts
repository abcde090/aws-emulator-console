/**
 * Amazon Cognito identity pools (federated identities): give users from a user pool (or
 * guests) temporary AWS credentials through an authenticated / unauthenticated IAM role.
 * Every value comes from the cognito-identity API.
 */

import {
  CreateIdentityPoolCommand,
  DeleteIdentityPoolCommand,
  DescribeIdentityPoolCommand,
  GetIdentityPoolRolesCommand,
  ListIdentitiesCommand,
  ListIdentityPoolsCommand,
  ListTagsForResourceCommand,
  SetIdentityPoolRolesCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateIdentityPoolCommand,
  type CognitoIdentityProvider,
  type IdentityPool,
  type IdentityPoolShortDescription,
} from "@aws-sdk/client-cognito-identity";
import { ListUserPoolClientsCommand, ListUserPoolsCommand } from "@aws-sdk/client-cognito-identity-provider";
import { ListRolesCommand, type Role } from "@aws-sdk/client-iam";
import type { Ctx, FieldValues, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { fieldTags, recordTagDiff, recordToTags, tagDiffMessage, tagsToRecord } from "../../console/tags.ts";
import { s, strs } from "./common.ts";

const NAME = { pattern: "[\\w ]{1,128}", message: "Up to 128 letters, numbers, underscores and spaces." };

const poolArn = (ctx: Ctx, id: string) => `arn:aws:cognito-identity:${ctx.region}:${ctx.accountId}:identitypool/${id}`;
const providerName = (ctx: Ctx, userPoolId: string) => `cognito-idp.${ctx.region}.amazonaws.com/${userPoolId}`;

/** "userPoolId|clientId" <-> a Cognito user pool identity provider. */
function toProvider(ctx: Ctx, value: string): CognitoIdentityProvider {
  const [pool, client] = value.split("|");
  if (!pool || !client) throw new Error(`"${value}" is not a user pool app client choice.`);
  return { ProviderName: providerName(ctx, pool), ClientId: client, ServerSideTokenCheck: false };
}

function providerValue(p: CognitoIdentityProvider): string {
  return `${(p.ProviderName ?? "").replace(/^.*\//, "")}|${p.ClientId ?? ""}`;
}

async function allIdentityPools(ctx: Ctx): Promise<IdentityPoolShortDescription[]> {
  const out: IdentityPoolShortDescription[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.cognitoidentity.send(new ListIdentityPoolsCommand({ MaxResults: 60, NextToken: token }));
    out.push(...(r.IdentityPools ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function describe(ctx: Ctx, id: string): Promise<IdentityPool> {
  return ctx.clients.cognitoidentity.send(new DescribeIdentityPoolCommand({ IdentityPoolId: id }));
}

/** Every app client of every user pool, as "userPoolId|clientId" choices. */
async function appClientOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken: token }));
    for (const p of r.UserPools ?? []) {
      if (!p.Id) continue;
      let ct: string | undefined;
      do {
        const c = await ctx.clients.cognito.send(new ListUserPoolClientsCommand({ UserPoolId: p.Id, MaxResults: 60, NextToken: ct }));
        for (const x of c.UserPoolClients ?? []) if (x.ClientId) out.push({ value: `${p.Id}|${x.ClientId}`, label: `${p.Name ?? p.Id} - app client ${x.ClientName ?? x.ClientId}` });
        ct = c.NextToken;
      } while (ct);
    }
    token = r.NextToken;
  } while (token);
  return out;
}

async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const roles: Role[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 1000 }));
    roles.push(...(r.Roles ?? []));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return roles.filter((r) => r.Arn).map((r) => ({ value: r.Arn as string, label: r.RoleName ?? (r.Arn as string) }));
}

async function tagMap(ctx: Ctx, id: string): Promise<Record<string, string>> {
  return (await ctx.clients.cognitoidentity.send(new ListTagsForResourceCommand({ ResourceArn: poolArn(ctx, id) }))).Tags ?? {};
}

async function setRoles(ctx: Ctx, id: string, v: FieldValues): Promise<void> {
  const current = await ctx.clients.cognitoidentity.send(new GetIdentityPoolRolesCommand({ IdentityPoolId: id }));
  const roles: Record<string, string> = {};
  if (s(v.authRole)) roles.authenticated = s(v.authRole);
  if (s(v.unauthRole)) roles.unauthenticated = s(v.unauthRole);
  await ctx.clients.cognitoidentity.send(new SetIdentityPoolRolesCommand({ IdentityPoolId: id, Roles: roles, RoleMappings: current.RoleMappings }));
}

/** UpdateIdentityPool replaces the whole pool, so send the current one with only `change` applied. */
async function updatePool(ctx: Ctx, id: string, change: Partial<IdentityPool>): Promise<void> {
  const cur = await describe(ctx, id);
  await ctx.clients.cognitoidentity.send(
    new UpdateIdentityPoolCommand({
      IdentityPoolId: id,
      IdentityPoolName: cur.IdentityPoolName,
      AllowUnauthenticatedIdentities: cur.AllowUnauthenticatedIdentities ?? false,
      AllowClassicFlow: cur.AllowClassicFlow,
      SupportedLoginProviders: cur.SupportedLoginProviders,
      DeveloperProviderName: cur.DeveloperProviderName,
      OpenIdConnectProviderARNs: cur.OpenIdConnectProviderARNs,
      CognitoIdentityProviders: cur.CognitoIdentityProviders,
      SamlProviderARNs: cur.SamlProviderARNs,
      ...change,
    })
  );
}

const ROLE_FIELDS = [
  { name: "authRole", label: "Authenticated role", kind: "select" as const, options: roleOptions, help: "The IAM role signed-in users get. Its trust policy must allow cognito-identity.amazonaws.com." },
  { name: "unauthRole", label: "Guest (unauthenticated) role", kind: "select" as const, options: roleOptions, help: "Only used when guest access is on." },
];

export const identityPools: ResourceDef = {
  id: "identity-pools",
  name: "Identity pools",
  singular: "identity pool",
  idField: "id",
  nameField: "Identity pool name",
  description: "Identity pools exchange user pool (or guest) sign-ins for temporary AWS credentials through IAM roles.",
  emptyText: "No identity pools. Create an identity pool to give your app's users AWS credentials.",
  columns: [
    { key: "name", label: "Identity pool name", kind: "link" },
    { key: "id", label: "Identity pool ID", kind: "code" },
  ],
  async list(ctx) {
    return (await allIdentityPools(ctx)).map((p): Row => ({ name: p.IdentityPoolName ?? "", id: p.IdentityPoolId ?? "" }));
  },
  async get(ctx, id) {
    const p = await describe(ctx, id);
    const c = ctx.clients.cognitoidentity;
    const [rolesR, identitiesR, tagsR] = await Promise.all([
      secondary(c.send(new GetIdentityPoolRolesCommand({ IdentityPoolId: id }))),
      secondary(c.send(new ListIdentitiesCommand({ IdentityPoolId: id, MaxResults: 60 }))),
      secondary(tagMap(ctx, id)),
    ]);
    const roles = rolesR.ok ? rolesR.value.Roles ?? {} : {};
    return {
      summary: {
        "Identity pool name": p.IdentityPoolName ?? id,
        "Identity pool ID": p.IdentityPoolId ?? id,
        ARN: poolArn(ctx, id),
        "Guest access": p.AllowUnauthenticatedIdentities ? "Activated" : "Inactive",
        "Basic (classic) authentication": p.AllowClassicFlow ? "Activated" : "Inactive",
      },
      tabs: [
        {
          id: "providers",
          label: "Identity providers",
          kind: "table",
          columns: [
            { key: "provider", label: "Amazon Cognito user pool", kind: "text" },
            { key: "client", label: "App client ID", kind: "code" },
            { key: "check", label: "Server-side token check", kind: "boolean" },
          ],
          data: (p.CognitoIdentityProviders ?? []).map((x) => ({ provider: x.ProviderName ?? "", client: x.ClientId ?? "", check: x.ServerSideTokenCheck ?? false })),
          emptyText: "No user pool identity providers.",
        },
        {
          id: "roles",
          label: "User access",
          kind: "keyvalue",
          description: rolesR.ok ? undefined : `IAM roles unavailable: ${rolesR.error}`,
          data: { "Authenticated role": roles.authenticated ?? null, "Guest role": roles.unauthenticated ?? null },
        },
        {
          id: "identities",
          label: "Identities",
          kind: "table",
          columns: [
            { key: "id", label: "Identity ID", kind: "code" },
            { key: "logins", label: "Linked logins", kind: "text" },
            { key: "created", label: "Created", kind: "date" },
          ],
          data: identitiesR.ok ? (identitiesR.value.Identities ?? []).map((x) => ({ id: x.IdentityId ?? "", logins: (x.Logins ?? []).join(", ") || "Guest", created: x.CreationDate ?? null })) : [],
          emptyText: unavailableText(identitiesR, "No identities yet. Identities appear when users get credentials (GetId)."),
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }],
          data: Object.entries(tagsR.ok ? tagsR.value : {}).map(([Key, Value]) => ({ Key, Value })),
          emptyText: unavailableText(tagsR, "No tags."),
        },
      ],
    };
  },
  create: {
    title: "Create identity pool",
    description: "Creates the pool with CreateIdentityPool, then sets its IAM roles with SetIdentityPoolRoles.",
    fields: [
      { name: "name", label: "Identity pool name", kind: "text", required: true, section: "Identity pool", validate: NAME },
      { name: "allowUnauth", label: "Guest access (unauthenticated identities)", kind: "checkbox", default: false, section: "User access", help: "Lets users get limited credentials without signing in." },
      { name: "clients", label: "Amazon Cognito user pool app clients", kind: "multiselect", options: appClientOptions, section: "Identity sources", help: "Users who sign in through these app clients get the authenticated role." },
      { name: "allowClassic", label: "Activate basic (classic) authentication", kind: "checkbox", default: false, section: "Identity sources", help: "Allows the basic flow (GetOpenIdToken + STS AssumeRoleWithWebIdentity). The enhanced flow is recommended." },
      { ...ROLE_FIELDS[0], section: "IAM roles" },
      { ...ROLE_FIELDS[1], section: "IAM roles", showIf: { field: "allowUnauth", equals: true } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const tags = Array.isArray(v.tags) ? Object.fromEntries((v.tags as Tag[]).map((t) => [t.Key, t.Value])) : {};
      const clients = strs(v.clients);
      const r = await ctx.clients.cognitoidentity.send(
        new CreateIdentityPoolCommand({
          IdentityPoolName: s(v.name),
          AllowUnauthenticatedIdentities: v.allowUnauth === true,
          AllowClassicFlow: v.allowClassic === true,
          CognitoIdentityProviders: clients.length ? clients.map((x) => toProvider(ctx, x)) : undefined,
          IdentityPoolTags: Object.keys(tags).length ? tags : undefined,
        })
      );
      if (!r.IdentityPoolId) throw new Error("CreateIdentityPool returned no ID.");
      if (s(v.authRole) || (v.allowUnauth === true && s(v.unauthRole))) {
        await setRoles(ctx, r.IdentityPoolId, { authRole: s(v.authRole), unauthRole: v.allowUnauth === true ? s(v.unauthRole) : "" });
      }
      return r.IdentityPoolId;
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit identity pool",
      fields: [
        { name: "name", label: "Identity pool name", kind: "text", required: true, validate: NAME },
        { name: "allowUnauth", label: "Guest access (unauthenticated identities)", kind: "checkbox", default: false },
        { name: "allowClassic", label: "Activate basic (classic) authentication", kind: "checkbox", default: false },
      ],
      async initialValues(ctx, id) {
        const p = await describe(ctx, id);
        return { name: p.IdentityPoolName ?? "", allowUnauth: p.AllowUnauthenticatedIdentities === true, allowClassic: p.AllowClassicFlow === true };
      },
      async run(ctx, id, v) {
        const p = await describe(ctx, id);
        const change: Partial<IdentityPool> = {};
        if (s(v.name) && s(v.name) !== p.IdentityPoolName) change.IdentityPoolName = s(v.name);
        if ((v.allowUnauth === true) !== (p.AllowUnauthenticatedIdentities === true)) change.AllowUnauthenticatedIdentities = v.allowUnauth === true;
        if ((v.allowClassic === true) !== (p.AllowClassicFlow === true)) change.AllowClassicFlow = v.allowClassic === true;
        if (!Object.keys(change).length) return { message: "Nothing changed." };
        await updatePool(ctx, id, change);
        return { message: "Identity pool updated." };
      },
    },
    {
      id: "edit-providers",
      label: "Edit user pool identity providers",
      fields: [{ name: "clients", label: "Amazon Cognito user pool app clients", kind: "multiselect", options: appClientOptions }],
      async initialValues(ctx, id) {
        return { clients: ((await describe(ctx, id)).CognitoIdentityProviders ?? []).map(providerValue) };
      },
      async run(ctx, id, v) {
        const p = await describe(ctx, id);
        const before = (p.CognitoIdentityProviders ?? []).map(providerValue).sort().join(",");
        const want = strs(v.clients);
        if ([...want].sort().join(",") === before) return { message: "Nothing changed." };
        // Keep the existing provider entries (and their token-check setting) that are still chosen.
        const kept = (p.CognitoIdentityProviders ?? []).filter((x) => want.includes(providerValue(x)));
        const added = want.filter((w) => !kept.some((x) => providerValue(x) === w)).map((w) => toProvider(ctx, w));
        await updatePool(ctx, id, { CognitoIdentityProviders: [...kept, ...added] });
        return { message: `The identity pool now trusts ${want.length} app client${want.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "edit-roles",
      label: "Edit IAM roles",
      fields: ROLE_FIELDS,
      async initialValues(ctx, id) {
        const r = await ctx.clients.cognitoidentity.send(new GetIdentityPoolRolesCommand({ IdentityPoolId: id }));
        return { authRole: r.Roles?.authenticated ?? "", unauthRole: r.Roles?.unauthenticated ?? "" };
      },
      async run(ctx, id, v) {
        const r = await ctx.clients.cognitoidentity.send(new GetIdentityPoolRolesCommand({ IdentityPoolId: id }));
        if (s(v.authRole) === (r.Roles?.authenticated ?? "") && s(v.unauthRole) === (r.Roles?.unauthenticated ?? "")) return { message: "Nothing changed." };
        await setRoles(ctx, id, v);
        return { message: "IAM roles updated." };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Add, change or remove tags. Only the changes are saved." }],
      async initialValues(ctx, id) {
        return { tags: recordToTags(await tagMap(ctx, id)) };
      },
      async run(ctx, id, v) {
        const diff = recordTagDiff(await tagMap(ctx, id), tagsToRecord(fieldTags(v.tags)));
        const arn = poolArn(ctx, id);
        if (diff.remove.length) await ctx.clients.cognitoidentity.send(new UntagResourceCommand({ ResourceArn: arn, TagKeys: diff.remove }));
        const n = Object.keys(diff.set).length;
        if (n) await ctx.clients.cognitoidentity.send(new TagResourceCommand({ ResourceArn: arn, Tags: diff.set }));
        return { message: tagDiffMessage(diff) };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, id) {
      await ctx.clients.cognitoidentity.send(new DeleteIdentityPoolCommand({ IdentityPoolId: id }));
    },
  },
};
