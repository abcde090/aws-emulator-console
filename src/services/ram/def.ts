/**
 * AWS RAM: resource shares you own (create with resources, principals and managed permissions;
 * add/remove resources and principals; tags; delete), resource shares shared with you, and the
 * managed permissions library. Shared resources and principals are read with
 * GetResourceShareAssociations because the emulator doesn't implement ListResources /
 * ListPrincipals.
 */

import {
  AssociateResourceShareCommand,
  CreateResourceShareCommand,
  DeleteResourceShareCommand,
  DisassociateResourceShareCommand,
  GetPermissionCommand,
  GetResourceShareAssociationsCommand,
  GetResourceSharesCommand,
  ListPermissionsCommand,
  ListResourceSharePermissionsCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateResourceShareCommand,
  type ResourceShare,
  type ResourceShareAssociation,
} from "@aws-sdk/client-ram";
import { DescribeManagedPrefixListsCommand, DescribeSubnetsCommand, DescribeTransitGatewaysCommand } from "@aws-sdk/client-ec2";
import type { Ctx, Detail, Option, ResourceDef, Row, ServiceDef, Tag } from "../../console/types.ts";
import { secondary, unavailableText, type Secondary } from "../../console/secondary.ts";
import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { parsePrincipals, parseResourceArns } from "./principals.ts";

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
const shareArn = (ctx: Ctx, id: string) => (id.startsWith("arn:") ? id : `arn:aws:ram:${ctx.region}:${ctx.accountId}:resource-share/${id}`);
const shareId = (arn: string) => arn.replace(/^.*:resource-share\//, "");

async function shares(ctx: Ctx, owner: "SELF" | "OTHER-ACCOUNTS", arns?: string[]): Promise<ResourceShare[]> {
  const out: ResourceShare[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ram.send(new GetResourceSharesCommand({ resourceOwner: owner, resourceShareArns: arns, nextToken: token }));
    out.push(...(r.resourceShares ?? []));
    token = r.nextToken;
  } while (token);
  return out;
}

async function associations(ctx: Ctx, arn: string, type: "RESOURCE" | "PRINCIPAL"): Promise<ResourceShareAssociation[]> {
  const out: ResourceShareAssociation[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ram.send(new GetResourceShareAssociationsCommand({ associationType: type, resourceShareArns: [arn], nextToken: token }));
    out.push(...(r.resourceShareAssociations ?? []));
    token = r.nextToken;
  } while (token);
  // Disassociated entries stay listed for a while; the console shows the live ones.
  return out.filter((a) => a.status !== "DISASSOCIATED");
}

/** Follows NextToken until the last page. */
async function paged<T>(fetch: (token: string | undefined) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await fetch(token);
    out.push(...page.items);
    token = page.next;
    if (!token) break;
  }
  return out;
}

/** Shareable resources this console can find (subnets, transit gateways, customer-managed prefix lists). */
async function shareableResources(ctx: Ctx): Promise<Option[]> {
  const ec2 = ctx.clients.ec2;
  const [subnetList, tgwList, plList] = await Promise.all([
    paged(async (t) => {
      const r = await ec2.send(new DescribeSubnetsCommand({ NextToken: t }));
      return { items: r.Subnets ?? [], next: r.NextToken };
    }),
    paged(async (t) => {
      const r = await ec2.send(new DescribeTransitGatewaysCommand({ NextToken: t }));
      return { items: r.TransitGateways ?? [], next: r.NextToken };
    }),
    paged(async (t) => {
      const r = await ec2.send(new DescribeManagedPrefixListsCommand({ NextToken: t }));
      return { items: r.PrefixLists ?? [], next: r.NextToken };
    }),
  ]);
  return [
    ...subnetList.filter((x) => x.SubnetArn).map((x) => ({ value: x.SubnetArn as string, label: `Subnet ${x.SubnetId} (${x.CidrBlock ?? ""}, ${x.AvailabilityZone ?? ""})` })),
    ...tgwList.filter((x) => x.TransitGatewayArn).map((x) => ({ value: x.TransitGatewayArn as string, label: `Transit gateway ${x.TransitGatewayId}` })),
    ...plList.filter((x) => x.PrefixListArn && x.OwnerId !== "AWS").map((x) => ({ value: x.PrefixListArn as string, label: `Prefix list ${x.PrefixListName ?? x.PrefixListId}` })),
  ];
}

function shareRow(x: ResourceShare): Row {
  return {
    name: x.name ?? "",
    id: shareId(x.resourceShareArn ?? ""),
    status: x.status ?? null,
    owner: x.owningAccountId ?? null,
    external: x.allowExternalPrincipals ?? null,
    created: x.creationTime ?? null,
    arn: x.resourceShareArn ?? null,
  };
}

async function shareDetail(ctx: Ctx, id: string, owner: "SELF" | "OTHER-ACCOUNTS"): Promise<Detail> {
  const arn = shareArn(ctx, id);
  const [found, resR, princR, permsR] = await Promise.all([
    shares(ctx, owner, [arn]),
    secondary(associations(ctx, arn, "RESOURCE")),
    owner === "SELF" ? secondary(associations(ctx, arn, "PRINCIPAL")) : Promise.resolve<Secondary<ResourceShareAssociation[]>>({ ok: true, value: [] }),
    secondary(sharePermissions(ctx, arn)),
  ]);
  const x = found[0];
  if (!x) throw new Error(`Resource share ${id} not found.`);
  const res = resR.ok ? resR.value : [];
  const princ = princR.ok ? princR.value : [];
  const perms = permsR.ok ? permsR.value : [];
  return {
    summary: {
      Name: x.name ?? id,
      ARN: x.resourceShareArn ?? arn,
      Status: x.status ?? null,
      Owner: x.owningAccountId ?? null,
      "Allow external principals": x.allowExternalPrincipals ? "Yes" : "No",
      "Status message": x.statusMessage ?? null,
      "Created on": x.creationTime ?? null,
      "Last updated": x.lastUpdatedTime ?? null,
    },
    tabs: [
      {
        id: "resources",
        label: "Shared resources",
        kind: "table",
        columns: [
          { key: "arn", label: "Resource", kind: "arn" },
          { key: "status", label: "Status", kind: "status" },
          { key: "updated", label: "Last updated", kind: "date" },
        ],
        data: res.map((a) => ({ arn: a.associatedEntity ?? "", status: a.status ?? null, updated: a.lastUpdatedTime ?? null })),
        emptyText: unavailableText(resR, "No resources are shared."),
      },
      ...(owner === "SELF"
        ? [
            {
              id: "principals",
              label: "Shared principals",
              kind: "table" as const,
              columns: [
                { key: "principal", label: "Principal", kind: "text" as const },
                { key: "external", label: "External", kind: "boolean" as const },
                { key: "status", label: "Status", kind: "status" as const },
              ],
              data: princ.map((a) => ({ principal: a.associatedEntity ?? "", external: a.external ?? false, status: a.status ?? null })),
              emptyText: unavailableText(princR, "No principals."),
            },
          ]
        : []),
      {
        id: "permissions",
        label: "Managed permissions",
        kind: "table",
        columns: [
          { key: "name", label: "Name", kind: "text" },
          { key: "type", label: "Resource type", kind: "text" },
          { key: "version", label: "Version", kind: "text" },
          { key: "status", label: "Status", kind: "status" },
        ],
        data: perms.map((p) => ({ name: p.name ?? "", type: p.resourceType ?? null, version: p.version ?? null, status: p.status ?? null })),
        emptyText: unavailableText(permsR, "No managed permissions."),
      },
      { id: "tags", label: "Tags", kind: "table", columns: [{ key: "key", label: "Key", kind: "text" }, { key: "value", label: "Value", kind: "text" }], data: (x.tags ?? []).map((t) => ({ key: t.key ?? "", value: t.value ?? "" })), emptyText: "No tags." },
    ],
  };
}

async function sharePermissions(ctx: Ctx, arn: string) {
  return paged(async (t) => {
    const r = await ctx.clients.ram.send(new ListResourceSharePermissionsCommand({ resourceShareArn: arn, nextToken: t }));
    return { items: r.permissions ?? [], next: r.nextToken };
  });
}

async function ownShare(ctx: Ctx, id: string): Promise<ResourceShare> {
  const x = (await shares(ctx, "SELF", [shareArn(ctx, id)]))[0];
  if (!x) throw new Error(`Resource share ${id} not found.`);
  return x;
}

const currentTags = (x: ResourceShare): Tag[] => (x.tags ?? []).map((t) => ({ Key: t.key ?? "", Value: t.value ?? "" }));
const isActive = (row: Row): boolean => {
  const status = row.status ?? row.Status;
  return status === undefined || status === null || status === "ACTIVE" || status === "PENDING";
};

const SHARE_COLUMNS = [
  { key: "name", label: "Name", kind: "link" as const },
  { key: "id", label: "ID", kind: "code" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "owner", label: "Owner", kind: "text" as const },
  { key: "external", label: "Allow external principals", kind: "boolean" as const },
  { key: "created", label: "Created on", kind: "date" as const },
  { key: "arn", label: "ARN", kind: "arn" as const, hidden: true },
];

const sharedByMe: ResourceDef = {
  id: "resource-shares",
  name: "Shared by me: Resource shares",
  singular: "resource share",
  idField: "id",
  nameField: "Name",
  description: "Resource shares you own. Deleted shares are not listed.",
  emptyText: "No resource shares. Create a resource share to share resources with other accounts.",
  columns: SHARE_COLUMNS,
  async list(ctx) {
    return (await shares(ctx, "SELF")).filter((x) => x.status !== "DELETED").map(shareRow);
  },
  get: (ctx, id) => shareDetail(ctx, id, "SELF"),
  create: {
    title: "Create resource share",
    description: "Creates the share with CreateResourceShare. Each resource type uses its default AWS managed permission.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Resource share name", validate: { max: 255, message: "At most 255 characters." } },
      { name: "resources", label: "Resources", kind: "multiselect", options: shareableResources, section: "Resources - optional", help: "Subnets, transit gateways and prefix lists in this account." },
      { name: "resourceArns", label: "Other resource ARNs", kind: "textarea", section: "Resources - optional", help: "One ARN per line, for any other shareable resource type." },
      { name: "allowExternal", label: "Allow sharing with anyone (principals outside your organization)", kind: "checkbox", default: true, section: "Grant access to principals" },
      { name: "principals", label: "Principals", kind: "textarea", section: "Grant access to principals", help: "One per line: 12-digit AWS account ID, organization / OU ARN, IAM role or user ARN, or service principal." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const tags = Array.isArray(v.tags) ? (v.tags as { Key: string; Value: string }[]).map((t) => ({ key: t.Key, value: t.Value })) : [];
      const resources = [...strs(v.resources), ...parseResourceArns(v.resourceArns)];
      const principals = parsePrincipals(v.principals);
      const r = await ctx.clients.ram.send(
        new CreateResourceShareCommand({
          name: s(v.name),
          resourceArns: resources.length ? [...new Set(resources)] : undefined,
          principals: principals.length ? principals : undefined,
          allowExternalPrincipals: v.allowExternal === true,
          tags: tags.length ? tags : undefined,
        })
      );
      const arn = r.resourceShare?.resourceShareArn;
      if (!arn) throw new Error("CreateResourceShare returned no ARN.");
      return shareId(arn);
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit name and external sharing",
      availableFor: isActive,
      fields: [
        { name: "name", label: "Name", kind: "text", required: true, validate: { max: 255, message: "At most 255 characters." } },
        { name: "allowExternal", label: "Allow sharing with anyone (principals outside your organization)", kind: "checkbox", default: false },
      ],
      async initialValues(ctx, id) {
        const x = await ownShare(ctx, id);
        return { name: x.name ?? "", allowExternal: x.allowExternalPrincipals === true };
      },
      async run(ctx, id, v) {
        const x = await ownShare(ctx, id);
        const name = s(v.name);
        const allow = v.allowExternal === true;
        const nameChanged = name !== "" && name !== (x.name ?? "");
        const allowChanged = allow !== (x.allowExternalPrincipals === true);
        if (!nameChanged && !allowChanged) return { message: "Nothing changed." };
        await ctx.clients.ram.send(
          new UpdateResourceShareCommand({ resourceShareArn: shareArn(ctx, id), name: nameChanged ? name : undefined, allowExternalPrincipals: allowChanged ? allow : undefined })
        );
        return { message: "Resource share updated." };
      },
    },
    {
      id: "add-resources",
      label: "Add resources",
      fields: [
        { name: "resources", label: "Resources", kind: "multiselect", options: shareableResources },
        { name: "resourceArns", label: "Other resource ARNs", kind: "textarea", help: "One per line." },
      ],
      async run(ctx, id, v) {
        const resources = [...new Set([...strs(v.resources), ...parseResourceArns(v.resourceArns)])];
        if (!resources.length) throw new Error("Choose at least one resource.");
        await ctx.clients.ram.send(new AssociateResourceShareCommand({ resourceShareArn: shareArn(ctx, id), resourceArns: resources }));
        return { message: `Added ${resources.length} resource${resources.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "add-principals",
      label: "Add principals",
      fields: [{ name: "principals", label: "Principals", kind: "textarea", required: true, help: "One per line: account ID, organization / OU ARN, IAM role or user ARN, or service principal." }],
      async run(ctx, id, v) {
        const principals = parsePrincipals(v.principals);
        if (!principals.length) throw new Error("Enter at least one principal.");
        await ctx.clients.ram.send(new AssociateResourceShareCommand({ resourceShareArn: shareArn(ctx, id), principals }));
        return { message: `Added ${principals.length} principal${principals.length === 1 ? "" : "s"}.` };
      },
    },
    ...(["RESOURCE", "PRINCIPAL"] as const).map((type) => ({
      id: type === "RESOURCE" ? "remove-resources" : "remove-principals",
      label: type === "RESOURCE" ? "Remove resources" : "Remove principals",
      danger: true,
      async run(ctx: Ctx, id: string) {
        const list = await associations(ctx, shareArn(ctx, id), type);
        return {
          table: {
            rowKey: "entity",
            columns: [
              { key: "entity", label: type === "RESOURCE" ? "Resource" : "Principal", kind: "text" as const },
              { key: "status", label: "Status", kind: "status" as const },
            ],
            rows: list.map((a) => ({ entity: a.associatedEntity ?? "", status: a.status ?? null })),
            emptyText: type === "RESOURCE" ? "No resources." : "No principals.",
            selectionAction: { actionId: type === "RESOURCE" ? "disassociate-resources" : "disassociate-principals", label: "Remove", danger: true, valuesField: "entities" },
          },
        };
      },
    })),
    ...(["RESOURCE", "PRINCIPAL"] as const).map((type) => ({
      id: type === "RESOURCE" ? "disassociate-resources" : "disassociate-principals",
      label: "Remove",
      hidden: true,
      danger: true,
      fields: [{ name: "entities", label: "Entities", kind: "multiselect" as const, required: true }],
      async run(ctx: Ctx, id: string, v: Record<string, unknown>) {
        const list = strs(v.entities);
        await ctx.clients.ram.send(
          new DisassociateResourceShareCommand({ resourceShareArn: shareArn(ctx, id), ...(type === "RESOURCE" ? { resourceArns: list } : { principals: list }) })
        );
        return { message: `Removed ${list.length} ${type === "RESOURCE" ? "resource" : "principal"}${list.length === 1 ? "" : "s"}.` };
      },
    })),
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Add, change or remove tags. Only the changes are saved." }],
      async initialValues(ctx, id) {
        return { tags: currentTags(await ownShare(ctx, id)) };
      },
      async run(ctx, id, v) {
        const diff = tagDiff(currentTags(await ownShare(ctx, id)), fieldTags(v.tags));
        if (diff.remove.length) await ctx.clients.ram.send(new UntagResourceCommand({ resourceShareArn: shareArn(ctx, id), tagKeys: diff.remove }));
        if (diff.set.length) await ctx.clients.ram.send(new TagResourceCommand({ resourceShareArn: shareArn(ctx, id), tags: diff.set.map((t) => ({ key: t.Key, value: t.Value })) }));
        return { message: tagDiffMessage(diff) };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ram.send(new DeleteResourceShareCommand({ resourceShareArn: shareArn(ctx, id) }));
    },
  },
};

const sharedWithMe: ResourceDef = {
  id: "shared-with-me",
  name: "Shared with me: Resource shares",
  singular: "resource share",
  idField: "id",
  nameField: "Name",
  description: "Resource shares that other accounts shared with you.",
  emptyText: "No resource shares are shared with this account.",
  columns: SHARE_COLUMNS,
  async list(ctx) {
    return (await shares(ctx, "OTHER-ACCOUNTS")).filter((x) => x.status !== "DELETED").map(shareRow);
  },
  get: (ctx, id) => shareDetail(ctx, id, "OTHER-ACCOUNTS"),
};

const permissions: ResourceDef = {
  id: "permissions",
  name: "Managed permissions library",
  singular: "managed permission",
  idField: "arn",
  nameField: "Name",
  description: "Managed permissions define the actions principals can perform on each type of shared resource.",
  emptyText: "No managed permissions.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "resourceType", label: "Resource type", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "version", label: "Version", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    const out: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ram.send(new ListPermissionsCommand({ nextToken: token }));
      out.push(...(r.permissions ?? []).map((p) => ({ name: p.name ?? "", resourceType: p.resourceType ?? null, type: p.permissionType === "CUSTOMER_MANAGED" ? "Customer managed" : "AWS managed", version: p.version ?? null, status: p.status ?? null, arn: p.arn ?? "" })));
      token = r.nextToken;
    } while (token);
    return out;
  },
  async get(ctx, arn) {
    const p = (await ctx.clients.ram.send(new GetPermissionCommand({ permissionArn: arn }))).permission;
    if (!p) throw new Error(`Permission ${arn} not found.`);
    let doc: unknown = p.permission ?? null;
    try {
      doc = p.permission ? (JSON.parse(p.permission) as unknown) : null;
    } catch {
      // keep the raw text
    }
    return {
      summary: { Name: p.name ?? arn, ARN: p.arn ?? arn, "Resource type": p.resourceType ?? null, Version: p.version ?? null, "Default version": p.defaultVersion ?? null, Status: p.status ?? null, Created: p.creationTime ?? null },
      tabs: [{ id: "policy", label: "Permission", kind: "json", data: doc, description: "The actions this managed permission grants on the shared resource." }],
    };
  },
};

export const ramService: ServiceDef = {
  id: "ram",
  name: "Resource Access Manager",
  category: "Security, Identity, & Compliance",
  description: "Share AWS resources with other accounts, organizational units and IAM principals.",
  resources: [sharedByMe, sharedWithMe, permissions],
  notSupported: [
    "Accepting or rejecting resource share invitations (AcceptResourceShareInvitation)",
    "Enabling sharing with AWS Organizations (EnableSharingWithAwsOrganization)",
    "ListResources / ListPrincipals (this console reads associations instead)",
  ],
};
