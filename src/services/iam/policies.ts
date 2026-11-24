/**
 * IAM managed policies (customer and AWS managed): list, create with the JSON editor,
 * permissions, versions, entities attached, tags and delete. Editing (a new version) is on
 * the hand-built policy page (src/app/iam/policies/[arn]).
 */

import {
  AttachGroupPolicyCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreatePolicyCommand,
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  ListEntitiesForPolicyCommand,
  ListPolicyTagsCommand,
  ListPolicyVersionsCommand,
  SetDefaultPolicyVersionCommand,
  TagPolicyCommand,
  UntagPolicyCommand,
  type ListEntitiesForPolicyCommandOutput,
} from "@aws-sdk/client-iam";
import type { Ctx, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { fieldTags, tagPairs, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { allGroups, allPolicies, allRoles, allUsers, PATH_PATTERN, plural, policyType, strings, TAG_COLUMNS, tagRows, text } from "./common.ts";
import { detach } from "./permissions.ts";
import { decodePolicy, EMPTY_IDENTITY_POLICY, requirePolicy } from "./policy-json.ts";

const POLICY_NAME = "[\\w+=,.@-]{1,128}";

/** Every user, group and role the policy is attached to (paginated). */
async function entities(ctx: Ctx, arn: string): Promise<ListEntitiesForPolicyCommandOutput> {
  const first = await ctx.clients.iam.send(new ListEntitiesForPolicyCommand({ PolicyArn: arn }));
  const out = { ...first, PolicyUsers: [...(first.PolicyUsers ?? [])], PolicyGroups: [...(first.PolicyGroups ?? [])], PolicyRoles: [...(first.PolicyRoles ?? [])] };
  for (let marker = first.IsTruncated ? first.Marker : undefined; marker; ) {
    const r = await ctx.clients.iam.send(new ListEntitiesForPolicyCommand({ PolicyArn: arn, Marker: marker }));
    out.PolicyUsers.push(...(r.PolicyUsers ?? []));
    out.PolicyGroups.push(...(r.PolicyGroups ?? []));
    out.PolicyRoles.push(...(r.PolicyRoles ?? []));
    marker = r.IsTruncated ? r.Marker : undefined;
  }
  return out;
}

function entityRows(e: ListEntitiesForPolicyCommandOutput): Row[] {
  return [
    ...(e.PolicyUsers ?? []).map((u) => ({ key: `user:${u.UserName}`, name: u.UserName ?? "", type: "IAM user" })),
    ...(e.PolicyGroups ?? []).map((g) => ({ key: `group:${g.GroupName}`, name: g.GroupName ?? "", type: "IAM user group" })),
    ...(e.PolicyRoles ?? []).map((r) => ({ key: `role:${r.RoleName}`, name: r.RoleName ?? "", type: "IAM role" })),
  ];
}

async function entityOptions(ctx: Ctx): Promise<Option[]> {
  const [u, g, r] = await Promise.all([allUsers(ctx), allGroups(ctx), allRoles(ctx)]);
  return [
    ...u.map((x) => ({ value: `user:${x.UserName}`, label: `${x.UserName} (IAM user)` })),
    ...g.map((x) => ({ value: `group:${x.GroupName}`, label: `${x.GroupName} (IAM user group)` })),
    ...r.map((x) => ({ value: `role:${x.RoleName}`, label: `${x.RoleName} (IAM role)` })),
  ];
}

function splitEntity(key: string): { kind: "user" | "group" | "role"; name: string } {
  const i = key.indexOf(":");
  const kind = key.slice(0, i);
  if (kind !== "user" && kind !== "group" && kind !== "role") throw new Error(`Unknown entity ${key}`);
  return { kind, name: key.slice(i + 1) };
}

const isCustomer = (arn: string) => !arn.startsWith("arn:aws:iam::aws:policy/");
/** Customer managed, from a list row ("type") or the detail summary ("Type"). */
const customerRow = (row: Row) => String(row.type ?? row.Type ?? "Customer managed") === "Customer managed";

async function policyTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const out: Tag[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListPolicyTagsCommand({ PolicyArn: arn, Marker: marker }));
    out.push(...tagPairs(r.Tags));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

export async function policyDocument(ctx: Ctx, arn: string, versionId?: string): Promise<unknown> {
  const p = versionId ? null : (await ctx.clients.iam.send(new GetPolicyCommand({ PolicyArn: arn }))).Policy;
  const v = await ctx.clients.iam.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: versionId ?? p?.DefaultVersionId ?? "v1" }));
  return decodePolicy(v.PolicyVersion?.Document);
}

export const policies: ResourceDef = {
  id: "policies",
  name: "Policies",
  singular: "policy",
  idField: "arn",
  nameField: "Policy name",
  detailHref: "policies/{id}",
  description: "A policy is an object in AWS that defines permissions.",
  emptyText: "No policies to display.",
  columns: [
    { key: "name", label: "Policy name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "usedAs", label: "Used as", kind: "text" },
    { key: "updated", label: "Last edited", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await allPolicies(ctx)).map((p) => {
      const uses = [p.AttachmentCount ? `Permissions policy (${p.AttachmentCount})` : "", p.PermissionsBoundaryUsageCount ? `Boundary (${p.PermissionsBoundaryUsageCount})` : ""].filter(Boolean);
      return { name: p.PolicyName ?? "", type: policyType(p.Arn), usedAs: uses.join(", ") || "-", updated: p.UpdateDate ?? p.CreateDate ?? null, arn: p.Arn ?? "" };
    });
  },

  async get(ctx, arn) {
    const iam = ctx.clients.iam;
    const p = (await iam.send(new GetPolicyCommand({ PolicyArn: arn }))).Policy;
    const [doc, versions, ents, tags] = await Promise.all([
      policyDocument(ctx, arn),
      iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn })),
      entities(ctx, arn),
      isCustomer(arn) ? iam.send(new ListPolicyTagsCommand({ PolicyArn: arn })) : Promise.resolve(null),
    ]);
    return {
      summary: {
        "Policy name": p?.PolicyName ?? arn,
        Type: policyType(arn),
        ARN: p?.Arn ?? arn,
        Description: p?.Description ?? null,
        "Creation time": p?.CreateDate ?? null,
        "Edited time": p?.UpdateDate ?? null,
        "Default version": p?.DefaultVersionId ?? null,
        "Attachment count": p?.AttachmentCount ?? 0,
      },
      tabs: [
        { id: "permissions", label: "Permissions", kind: "json", data: doc, description: `Policy document of the default version (${p?.DefaultVersionId ?? "-"}).` },
        {
          id: "entities",
          label: "Entities attached",
          kind: "table",
          columns: [
            { key: "name", label: "Entity name", kind: "text" },
            { key: "type", label: "Entity type", kind: "text" },
          ],
          data: entityRows(ents),
          emptyText: "No entities attached. Use Actions › Attach to attach this policy.",
        },
        {
          id: "versions",
          label: "Policy versions",
          kind: "table",
          columns: [
            { key: "version", label: "Version", kind: "text" },
            { key: "isDefault", label: "Default", kind: "boolean" },
            { key: "created", label: "Creation time", kind: "date" },
          ],
          data: (versions.Versions ?? []).map((v) => ({ version: v.VersionId ?? "", isDefault: v.IsDefaultVersion === true, created: v.CreateDate ?? null })),
          description: "A managed policy can have up to five versions.",
        },
        ...(tags ? [{ id: "tags", label: "Tags", kind: "table" as const, columns: TAG_COLUMNS, data: tagRows(tags.Tags), emptyText: "No tags associated with the resource." }] : []),
      ],
    };
  },

  create: {
    title: "Create policy",
    description: "Write the policy in JSON. It is checked, then created with CreatePolicy.",
    fields: [
      { name: "document", label: "Policy editor", kind: "json", required: true, default: EMPTY_IDENTITY_POLICY, section: "Specify permissions", help: "Add statements with Effect, Action and Resource. Managed policies are limited to 6,144 characters." },
      { name: "name", label: "Policy name", kind: "text", required: true, section: "Policy details", help: "Maximum 128 characters. Use alphanumeric and '+=,.@-_' characters.", validate: { pattern: POLICY_NAME, message: "Use up to 128 letters, numbers and +=,.@-_ characters." } },
      { name: "description", label: "Description", kind: "textarea", section: "Policy details", help: "Maximum 1,000 characters. You can't edit the description after you create the policy.", validate: { max: 1000, message: "At most 1000 characters." } },
      { name: "path", label: "Path", kind: "text", default: "/", section: "Policy details", validate: { pattern: PATH_PATTERN, message: "A path starts and ends with /." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Add tags - optional" },
    ],
    async run(ctx, v) {
      const doc = requirePolicy(v.document, "identity", true);
      const tags = fieldTags(v.tags);
      const r = await ctx.clients.iam.send(
        new CreatePolicyCommand({ PolicyName: text(v.name), PolicyDocument: doc, Description: text(v.description) || undefined, Path: text(v.path) || "/", Tags: tags.length ? tags : undefined })
      );
      if (!r.Policy?.Arn) throw new Error("CreatePolicy returned no ARN.");
      return r.Policy.Arn;
    },
  },

  actions: [
    {
      id: "attach",
      label: "Attach",
      fields: [{ name: "entities", label: "IAM entities", kind: "multiselect", required: true, options: entityOptions, help: "Users, user groups and roles to attach this policy to." }],
      async run(ctx, arn, v) {
        const list = strings(v.entities).map(splitEntity);
        for (const e of list) {
          if (e.kind === "user") await ctx.clients.iam.send(new AttachUserPolicyCommand({ UserName: e.name, PolicyArn: arn }));
          else if (e.kind === "group") await ctx.clients.iam.send(new AttachGroupPolicyCommand({ GroupName: e.name, PolicyArn: arn }));
          else await ctx.clients.iam.send(new AttachRolePolicyCommand({ RoleName: e.name, PolicyArn: arn }));
        }
        return { message: `Attached the policy to ${list.length} ${list.length === 1 ? "entity" : "entities"}.` };
      },
    },
    {
      id: "detach",
      label: "Detach",
      availableFor: (row) => row.usedAs !== "-" && row["Attachment count"] !== 0,
      async run(ctx, arn) {
        return {
          table: {
            rowKey: "key",
            columns: [
              { key: "name", label: "Entity name", kind: "text" },
              { key: "type", label: "Entity type", kind: "text" },
            ],
            rows: entityRows(await entities(ctx, arn)),
            emptyText: "This policy isn't attached to any entities.",
            selectionAction: { actionId: "detach-entities", label: "Detach", danger: true, valuesField: "entities" },
          },
        };
      },
    },
    {
      id: "detach-entities",
      label: "Detach entities",
      hidden: true,
      danger: true,
      fields: [{ name: "entities", label: "Entities", kind: "multiselect", required: true }],
      async run(ctx, arn, v) {
        const list = strings(v.entities).map(splitEntity);
        for (const e of list) await detach(ctx, e.kind, e.name, arn);
        return { message: `Detached the policy from ${list.length} ${list.length === 1 ? "entity" : "entities"}.` };
      },
    },
    {
      id: "manage-versions",
      label: "Manage versions",
      availableFor: customerRow,
      async run(ctx, arn) {
        const r = await ctx.clients.iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn }));
        return {
          message: "Select one version to set as default.",
          table: {
            rowKey: "version",
            columns: [
              { key: "version", label: "Version", kind: "text" },
              { key: "isDefault", label: "Default", kind: "boolean" },
              { key: "created", label: "Creation time", kind: "date" },
            ],
            rows: (r.Versions ?? []).map((x) => ({ version: x.VersionId ?? "", isDefault: x.IsDefaultVersion === true, created: x.CreateDate ?? null })),
            selectionAction: { actionId: "set-default-version", label: "Set as default", valuesField: "versions" },
          },
        };
      },
    },
    {
      id: "set-default-version",
      label: "Set default version",
      hidden: true,
      fields: [{ name: "versions", label: "Version", kind: "multiselect", required: true }],
      async run(ctx, arn, v) {
        const list = strings(v.versions);
        if (list.length !== 1) throw new Error("Select exactly one version.");
        await ctx.clients.iam.send(new SetDefaultPolicyVersionCommand({ PolicyArn: arn, VersionId: list[0] }));
        return { message: `Version ${list[0]} is now the default.` };
      },
    },
    {
      id: "delete-versions",
      label: "Delete versions",
      availableFor: customerRow,
      danger: true,
      async run(ctx, arn) {
        const r = await ctx.clients.iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn }));
        return {
          message: "The default version can't be deleted.",
          table: {
            rowKey: "version",
            columns: [
              { key: "version", label: "Version", kind: "text" },
              { key: "created", label: "Creation time", kind: "date" },
            ],
            rows: (r.Versions ?? []).filter((x) => !x.IsDefaultVersion).map((x) => ({ version: x.VersionId ?? "", created: x.CreateDate ?? null })),
            emptyText: "Only the default version exists.",
            selectionAction: { actionId: "remove-versions", label: "Delete", danger: true, valuesField: "versions" },
          },
        };
      },
    },
    {
      id: "remove-versions",
      label: "Remove versions",
      hidden: true,
      danger: true,
      fields: [{ name: "versions", label: "Versions", kind: "multiselect", required: true }],
      async run(ctx, arn, v) {
        const list = strings(v.versions);
        for (const ver of list) await ctx.clients.iam.send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: ver }));
        return { message: `Deleted ${plural(list.length, "version")}.` };
      },
    },
    {
      id: "manage-tags",
      label: "Manage tags",
      availableFor: (row) => customerRow(row),
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Add, change or remove tags. Only the differences are saved." }],
      async initialValues(ctx, arn) {
        return { tags: await policyTags(ctx, arn) };
      },
      async run(ctx, arn, v) {
        if (!isCustomer(arn)) throw new Error("AWS managed policies can't be tagged.");
        const { set, remove } = tagDiff(await policyTags(ctx, arn), fieldTags(v.tags));
        if (set.length) await ctx.clients.iam.send(new TagPolicyCommand({ PolicyArn: arn, Tags: set }));
        if (remove.length) await ctx.clients.iam.send(new UntagPolicyCommand({ PolicyArn: arn, TagKeys: remove }));
        return { message: tagDiffMessage({ set, remove }) };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, arn) {
      if (!isCustomer(arn)) throw new Error("AWS managed policies can't be deleted.");
      // As in the console: detach from every entity and delete non-default versions first.
      const e = await entities(ctx, arn);
      for (const u of e.PolicyUsers ?? []) if (u.UserName) await detach(ctx, "user", u.UserName, arn);
      for (const g of e.PolicyGroups ?? []) if (g.GroupName) await detach(ctx, "group", g.GroupName, arn);
      for (const r of e.PolicyRoles ?? []) if (r.RoleName) await detach(ctx, "role", r.RoleName, arn);
      for (const v of (await ctx.clients.iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn }))).Versions ?? []) {
        if (!v.IsDefaultVersion && v.VersionId) await ctx.clients.iam.send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: v.VersionId }));
      }
      await ctx.clients.iam.send(new DeletePolicyCommand({ PolicyArn: arn }));
    },
  },
};
