/**
 * Permissions of an IAM user, group or role: managed (attached) and inline policies,
 * permissions boundaries and tags. One set of reads and actions serves all three entity kinds,
 * the way the console's Permissions tab works the same for each.
 */

import {
  AttachGroupPolicyCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  DeleteGroupPolicyCommand,
  DeleteRolePermissionsBoundaryCommand,
  DeleteRolePolicyCommand,
  DeleteUserPermissionsBoundaryCommand,
  DeleteUserPolicyCommand,
  DetachGroupPolicyCommand,
  DetachRolePolicyCommand,
  DetachUserPolicyCommand,
  GetGroupPolicyCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  GetUserCommand,
  GetUserPolicyCommand,
  ListAttachedGroupPoliciesCommand,
  ListAttachedRolePoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupPoliciesCommand,
  ListGroupsForUserCommand,
  ListRolePoliciesCommand,
  ListRoleTagsCommand,
  ListUserPoliciesCommand,
  ListUserTagsCommand,
  PutGroupPolicyCommand,
  PutRolePermissionsBoundaryCommand,
  PutRolePolicyCommand,
  PutUserPermissionsBoundaryCommand,
  PutUserPolicyCommand,
  TagRoleCommand,
  TagUserCommand,
  UntagRoleCommand,
  UntagUserCommand,
  type AttachedPolicy,
} from "@aws-sdk/client-iam";
import type { ActionDef, ColumnDef, Ctx, FieldValues, Row, Tag } from "../../console/types.ts";
import { fieldTags, tagPairs, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { policyOptions, policyType, strings, text } from "./common.ts";
import { EMPTY_IDENTITY_POLICY, decodePolicy, requirePolicy } from "./policy-json.ts";

export type EntityKind = "user" | "group" | "role";

export async function attachedPolicies(ctx: Ctx, kind: EntityKind, name: string): Promise<AttachedPolicy[]> {
  const out: AttachedPolicy[] = [];
  let marker: string | undefined;
  do {
    const r =
      kind === "user"
        ? await ctx.clients.iam.send(new ListAttachedUserPoliciesCommand({ UserName: name, Marker: marker }))
        : kind === "group"
          ? await ctx.clients.iam.send(new ListAttachedGroupPoliciesCommand({ GroupName: name, Marker: marker }))
          : await ctx.clients.iam.send(new ListAttachedRolePoliciesCommand({ RoleName: name, Marker: marker }));
    out.push(...(r.AttachedPolicies ?? []));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

export async function inlinePolicyNames(ctx: Ctx, kind: EntityKind, name: string): Promise<string[]> {
  const out: string[] = [];
  let marker: string | undefined;
  do {
    const r =
      kind === "user"
        ? await ctx.clients.iam.send(new ListUserPoliciesCommand({ UserName: name, Marker: marker }))
        : kind === "group"
          ? await ctx.clients.iam.send(new ListGroupPoliciesCommand({ GroupName: name, Marker: marker }))
          : await ctx.clients.iam.send(new ListRolePoliciesCommand({ RoleName: name, Marker: marker }));
    out.push(...(r.PolicyNames ?? []));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

/** Every tag of a user or role (paginated). */
export async function entityTags(ctx: Ctx, kind: "user" | "role", name: string): Promise<Tag[]> {
  const out: Tag[] = [];
  let marker: string | undefined;
  do {
    const r =
      kind === "user"
        ? await ctx.clients.iam.send(new ListUserTagsCommand({ UserName: name, Marker: marker }))
        : await ctx.clients.iam.send(new ListRoleTagsCommand({ RoleName: name, Marker: marker }));
    out.push(...tagPairs(r.Tags));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

/** Names of the groups a user belongs to (paginated). */
export async function groupsForUser(ctx: Ctx, user: string): Promise<string[]> {
  const out: string[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListGroupsForUserCommand({ UserName: user, Marker: marker }));
    out.push(...(r.Groups ?? []).map((g) => g.GroupName ?? "").filter(Boolean));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

async function boundaryOf(ctx: Ctx, kind: "user" | "role", name: string): Promise<string | undefined> {
  if (kind === "user") return (await ctx.clients.iam.send(new GetUserCommand({ UserName: name }))).User?.PermissionsBoundary?.PermissionsBoundaryArn;
  return (await ctx.clients.iam.send(new GetRoleCommand({ RoleName: name }))).Role?.PermissionsBoundary?.PermissionsBoundaryArn;
}

export async function inlinePolicyDocument(ctx: Ctx, kind: EntityKind, name: string, policyName: string): Promise<unknown> {
  const r =
    kind === "user"
      ? await ctx.clients.iam.send(new GetUserPolicyCommand({ UserName: name, PolicyName: policyName }))
      : kind === "group"
        ? await ctx.clients.iam.send(new GetGroupPolicyCommand({ GroupName: name, PolicyName: policyName }))
        : await ctx.clients.iam.send(new GetRolePolicyCommand({ RoleName: name, PolicyName: policyName }));
  return decodePolicy(r.PolicyDocument);
}

export async function attach(ctx: Ctx, kind: EntityKind, name: string, arn: string): Promise<void> {
  if (kind === "user") await ctx.clients.iam.send(new AttachUserPolicyCommand({ UserName: name, PolicyArn: arn }));
  else if (kind === "group") await ctx.clients.iam.send(new AttachGroupPolicyCommand({ GroupName: name, PolicyArn: arn }));
  else await ctx.clients.iam.send(new AttachRolePolicyCommand({ RoleName: name, PolicyArn: arn }));
}

export async function detach(ctx: Ctx, kind: EntityKind, name: string, arn: string): Promise<void> {
  if (kind === "user") await ctx.clients.iam.send(new DetachUserPolicyCommand({ UserName: name, PolicyArn: arn }));
  else if (kind === "group") await ctx.clients.iam.send(new DetachGroupPolicyCommand({ GroupName: name, PolicyArn: arn }));
  else await ctx.clients.iam.send(new DetachRolePolicyCommand({ RoleName: name, PolicyArn: arn }));
}

export async function putInline(ctx: Ctx, kind: EntityKind, name: string, policyName: string, doc: string): Promise<void> {
  if (kind === "user") await ctx.clients.iam.send(new PutUserPolicyCommand({ UserName: name, PolicyName: policyName, PolicyDocument: doc }));
  else if (kind === "group") await ctx.clients.iam.send(new PutGroupPolicyCommand({ GroupName: name, PolicyName: policyName, PolicyDocument: doc }));
  else await ctx.clients.iam.send(new PutRolePolicyCommand({ RoleName: name, PolicyName: policyName, PolicyDocument: doc }));
}

export async function deleteInline(ctx: Ctx, kind: EntityKind, name: string, policyName: string): Promise<void> {
  if (kind === "user") await ctx.clients.iam.send(new DeleteUserPolicyCommand({ UserName: name, PolicyName: policyName }));
  else if (kind === "group") await ctx.clients.iam.send(new DeleteGroupPolicyCommand({ GroupName: name, PolicyName: policyName }));
  else await ctx.clients.iam.send(new DeleteRolePolicyCommand({ RoleName: name, PolicyName: policyName }));
}

/** Detaches every managed policy and deletes every inline policy (the console does this on delete). */
export async function clearPermissions(ctx: Ctx, kind: EntityKind, name: string): Promise<void> {
  for (const p of await attachedPolicies(ctx, kind, name)) if (p.PolicyArn) await detach(ctx, kind, name, p.PolicyArn);
  for (const n of await inlinePolicyNames(ctx, kind, name)) await deleteInline(ctx, kind, name, n);
}

export const PERMISSION_COLUMNS: ColumnDef[] = [
  { key: "name", label: "Policy name", kind: "text" },
  { key: "type", label: "Type", kind: "text" },
  { key: "attachedVia", label: "Attached via", kind: "text" },
  { key: "arn", label: "ARN", kind: "arn" },
];

/** Rows for the Permissions tab: direct managed, inline and (for users) policies inherited from groups. */
export async function permissionRows(ctx: Ctx, kind: EntityKind, name: string): Promise<Row[]> {
  const [managed, inline] = await Promise.all([attachedPolicies(ctx, kind, name), inlinePolicyNames(ctx, kind, name)]);
  const rows: Row[] = [
    ...managed.map((p) => ({ key: `managed:${p.PolicyArn}`, name: p.PolicyName ?? "", type: policyType(p.PolicyArn), attachedVia: "Directly", arn: p.PolicyArn ?? null })),
    ...inline.map((n) => ({ key: `inline:${n}`, name: n, type: "Customer inline", attachedVia: "Directly", arn: null })),
  ];
  if (kind === "user") {
    for (const g of await groupsForUser(ctx, name)) {
      const [gm, gi] = await Promise.all([attachedPolicies(ctx, "group", g), inlinePolicyNames(ctx, "group", g)]);
      rows.push(...gm.map((p) => ({ key: `group:${g}:${p.PolicyArn}`, name: p.PolicyName ?? "", type: policyType(p.PolicyArn), attachedVia: `Group ${g}`, arn: p.PolicyArn ?? null })));
      rows.push(...gi.map((n) => ({ key: `group:${g}:inline:${n}`, name: n, type: "Customer inline", attachedVia: `Group ${g}`, arn: null })));
    }
  }
  return rows;
}

/** Inline policy documents as one JSON object, for the "Inline policies" tab. */
export async function inlineDocuments(ctx: Ctx, kind: EntityKind, name: string): Promise<Record<string, unknown> | null> {
  const names = await inlinePolicyNames(ctx, kind, name);
  if (names.length === 0) return null;
  const docs = await Promise.all(names.map(async (n) => [n, await inlinePolicyDocument(ctx, kind, name, n)] as const));
  return Object.fromEntries(docs);
}

const POLICY_NAME = "[\\w+=,.@-]{1,128}";

export function permissionActions(kind: EntityKind): ActionDef[] {
  const actions: ActionDef[] = [
    {
      id: "add-permissions",
      label: "Add permissions",
      fields: [
        {
          name: "policies", label: "Permissions policies", kind: "multiselect", required: true, options: policyOptions,
          help: kind === "group" ? "Attach managed policies to the group. Every user in the group gets these permissions." : "Attach managed policies directly. As a best practice, use groups to manage user permissions.",
        },
      ],
      async run(ctx, name, v) {
        const arns = strings(v.policies);
        for (const arn of arns) await attach(ctx, kind, name, arn);
        return { message: `Attached ${arns.length} ${arns.length === 1 ? "policy" : "policies"} to ${kind} ${name}.` };
      },
    },
    {
      id: "remove-permissions",
      label: "Remove permissions",
      async run(ctx, name) {
        const rows = (await permissionRows(ctx, kind, name)).filter((r) => r.attachedVia === "Directly");
        return {
          message: "Select the policies to remove. Managed policies are detached; inline policies are deleted.",
          table: {
            rowKey: "key",
            columns: PERMISSION_COLUMNS.filter((c) => c.key !== "attachedVia"),
            rows,
            emptyText: `No policies are attached directly to this ${kind}.`,
            selectionAction: { actionId: "remove-policies", label: "Remove", danger: true, valuesField: "keys" },
          },
        };
      },
    },
    {
      id: "remove-policies",
      label: "Remove policies",
      hidden: true,
      danger: true,
      fields: [{ name: "keys", label: "Policies", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const keys = strings(v.keys);
        for (const k of keys) {
          if (k.startsWith("managed:")) await detach(ctx, kind, name, k.slice(8));
          else if (k.startsWith("inline:")) await deleteInline(ctx, kind, name, k.slice(7));
          else throw new Error(`Unknown policy selection: ${k}`);
        }
        return { message: `Removed ${keys.length} ${keys.length === 1 ? "policy" : "policies"} from ${name}.` };
      },
    },
    {
      id: "create-inline-policy",
      label: "Create inline policy",
      fields: [
        { name: "policyName", label: "Policy name", kind: "text", required: true, help: "Maximum 128 characters: letters, numbers and +=,.@-_. Using an existing name replaces that inline policy.", validate: { pattern: POLICY_NAME, message: "Use up to 128 letters, numbers and +=,.@-_ characters." } },
        { name: "document", label: "Policy editor", kind: "json", required: true, default: EMPTY_IDENTITY_POLICY, help: "JSON policy document. Checked before it is saved." },
      ],
      async run(ctx, name, v) {
        const doc = requirePolicy(v.document, "identity");
        await putInline(ctx, kind, name, text(v.policyName), doc);
        return { message: `Saved inline policy ${text(v.policyName)} on ${kind} ${name}.` };
      },
    },
  ];
  if (kind !== "group") {
    actions.push(
      {
        id: "set-boundary",
        label: "Set permissions boundary",
        fields: [
          { name: "policy", label: "Permissions boundary policy", kind: "select", required: true, options: policyOptions, help: "A managed policy that sets the maximum permissions identity-based policies can grant." },
        ],
        async initialValues(ctx, name) {
          const arn = await boundaryOf(ctx, kind, name);
          const values: FieldValues = {};
          if (arn) values.policy = arn;
          return values;
        },
        async run(ctx, name, v) {
          const arn = text(v.policy);
          if (kind === "user") await ctx.clients.iam.send(new PutUserPermissionsBoundaryCommand({ UserName: name, PermissionsBoundary: arn }));
          else await ctx.clients.iam.send(new PutRolePermissionsBoundaryCommand({ RoleName: name, PermissionsBoundary: arn }));
          return { message: `Permissions boundary of ${name} set to ${arn}.` };
        },
      },
      {
        id: "remove-boundary",
        label: "Remove permissions boundary",
        confirm: "The permissions boundary is removed. The identity-based policies then define the maximum permissions.",
        availableFor: (row) => row["Permissions boundary"] !== "Not set",
        async run(ctx, name) {
          if (kind === "user") await ctx.clients.iam.send(new DeleteUserPermissionsBoundaryCommand({ UserName: name }));
          else await ctx.clients.iam.send(new DeleteRolePermissionsBoundaryCommand({ RoleName: name }));
          return { message: `Removed the permissions boundary of ${name}.` };
        },
      },
      {
        id: "manage-tags",
        label: "Manage tags",
        fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Add, change or remove tags. Only the differences are saved." }],
        async initialValues(ctx, name) {
          return { tags: await entityTags(ctx, kind, name) };
        },
        async run(ctx, name, v) {
          const { set, remove } = tagDiff(await entityTags(ctx, kind, name), fieldTags(v.tags));
          if (set.length) {
            if (kind === "user") await ctx.clients.iam.send(new TagUserCommand({ UserName: name, Tags: set }));
            else await ctx.clients.iam.send(new TagRoleCommand({ RoleName: name, Tags: set }));
          }
          if (remove.length) {
            if (kind === "user") await ctx.clients.iam.send(new UntagUserCommand({ UserName: name, TagKeys: remove }));
            else await ctx.clients.iam.send(new UntagRoleCommand({ RoleName: name, TagKeys: remove }));
          }
          return { message: tagDiffMessage({ set, remove }) };
        },
      }
    );
  }
  return actions;
}
