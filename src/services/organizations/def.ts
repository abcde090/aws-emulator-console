/**
 * AWS Organizations: the organization, its root and organizational units, and the
 * policy types enabled on the root. AWS Emulator implements only part of the API
 * (verified by calling each operation), so account, policy, trusted-access and
 * delegated-administrator screens are listed under notSupported instead of offered.
 * The "AWS accounts" list is a hand-built tree (src/app/organizations/accounts).
 */

import {
  CreateOrganizationalUnitCommand,
  CreateOrganizationCommand,
  DeleteOrganizationalUnitCommand,
  DescribeOrganizationalUnitCommand,
  DescribeOrganizationCommand,
  ListOrganizationalUnitsForParentCommand,
  ListRootsCommand,
  type Organization,
  type Root,
} from "@aws-sdk/client-organizations";
import type { Ctx, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { depthFirst, isOuId, isRootId, parentFromPath, unitNodes, type OrgNode, type RawUnit } from "./tree.ts";

const NOT_IN_USE = "AWSOrganizationsNotInUseException";
const NO_ORG_TEXT = "This account isn't a member of an organization. Create an organization on the Settings page first.";
const MAX_OUS = 1000;

export const POLICY_TYPES: { type: string; name: string; description: string }[] = [
  { type: "SERVICE_CONTROL_POLICY", name: "Service control policies", description: "Set the maximum permissions available to IAM users and roles in member accounts." },
  { type: "RESOURCE_CONTROL_POLICY", name: "Resource control policies", description: "Set the maximum permissions available on resources in member accounts." },
  { type: "DECLARATIVE_POLICY_EC2", name: "Declarative policies", description: "Declare and enforce the configuration of AWS services across the organization." },
  { type: "TAG_POLICY", name: "Tag policies", description: "Standardize the tags attached to resources in member accounts." },
  { type: "BACKUP_POLICY", name: "Backup policies", description: "Deploy AWS Backup plans to member accounts." },
  { type: "AISERVICES_OPT_OUT_POLICY", name: "AI services opt-out policies", description: "Control whether AWS AI services can store and use content from member accounts." },
  { type: "CHATBOT_POLICY", name: "Chat applications policies", description: "Control access to accounts from chat applications such as Slack and Microsoft Teams." },
];

function isNotInUse(err: unknown): boolean {
  return err instanceof Error && err.name === NOT_IN_USE;
}

async function describeOrganization(ctx: Ctx): Promise<Organization | null> {
  try {
    const r = await ctx.clients.organizations.send(new DescribeOrganizationCommand({}));
    return r.Organization ?? null;
  } catch (err: unknown) {
    if (isNotInUse(err)) return null;
    throw err;
  }
}

async function listRoots(ctx: Ctx): Promise<Root[]> {
  const roots: Root[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.organizations.send(new ListRootsCommand({ NextToken: token }));
    roots.push(...(r.Roots ?? []));
    token = r.NextToken;
  } while (token);
  return roots;
}

async function listUnits(ctx: Ctx, parentId: string): Promise<RawUnit[]> {
  const units: RawUnit[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.organizations.send(new ListOrganizationalUnitsForParentCommand({ ParentId: parentId, NextToken: token }));
    units.push(...(r.OrganizationalUnits ?? []));
    token = r.NextToken;
  } while (token);
  return units;
}

/** The root and every OU under it, depth-first. Throws a plain message when there is no organization. */
export async function loadHierarchy(ctx: Ctx): Promise<{ organization: Organization; roots: Root[]; nodes: OrgNode[] }> {
  const organization = await describeOrganization(ctx);
  if (!organization) throw new Error(NO_ORG_TEXT);
  const roots = await listRoots(ctx);
  const nodes: OrgNode[] = [];
  const queue: OrgNode[] = roots
    .filter((r): r is Root & { Id: string } => typeof r.Id === "string")
    .map((r) => ({ id: r.Id, name: r.Name ?? "Root", arn: r.Arn ?? null, type: "Root", parentId: null, depth: 0, hierarchy: r.Name ?? "Root" }));
  while (queue.length > 0) {
    const node = queue.shift() as OrgNode;
    nodes.push(node);
    if (nodes.length > MAX_OUS) throw new Error(`More than ${MAX_OUS} organizational units; the console stops listing here.`);
    queue.push(...unitNodes(node, await listUnits(ctx, node.id)));
  }
  return { organization, roots, nodes: depthFirst(nodes) };
}

function nodeRow(n: OrgNode): Row {
  return { id: n.id, name: n.name, type: n.type, hierarchy: n.hierarchy, depth: n.depth, parentId: n.parentId, arn: n.arn };
}

async function parentOptions(ctx: Ctx): Promise<Option[]> {
  const { nodes } = await loadHierarchy(ctx);
  return nodes.map((n) => ({ value: n.id, label: `${n.hierarchy} (${n.id})` }));
}

const childColumns = [
  { key: "name", label: "Name", kind: "text" as const },
  { key: "id", label: "ID", kind: "text" as const },
  { key: "arn", label: "ARN", kind: "arn" as const },
];

const accounts: ResourceDef = {
  id: "accounts",
  name: "AWS accounts",
  singular: "organizational unit",
  idField: "id",
  nameField: "Name",
  description: "The organization's structure: the root and the organizational units (OUs) that group accounts.",
  emptyText: "No organization. Create an organization on the Settings page.",
  columns: [
    { key: "hierarchy", label: "Organizational structure", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "id", label: "ID", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const org = await describeOrganization(ctx);
    if (!org) return [];
    return (await loadHierarchy(ctx)).nodes.map(nodeRow);
  },

  async get(ctx, id) {
    const org = ctx.clients.organizations;
    if (isRootId(id)) {
      const root = (await listRoots(ctx)).find((r) => r.Id === id);
      if (!root) throw new Error(`Root ${id} was not found in this organization.`);
      const children = await listUnits(ctx, id);
      const enabled = root.PolicyTypes ?? [];
      return {
        summary: { Name: root.Name ?? "Root", Type: "Root", ID: id, ARN: root.Arn ?? null },
        tabs: [
          { id: "children", label: "Organizational units", kind: "table", columns: childColumns, data: children.map((u) => ({ name: u.Name, id: u.Id, arn: u.Arn })), emptyText: "No organizational units directly under the root." },
          {
            id: "policies",
            label: "Policy types",
            kind: "table",
            description: "Policy types enabled on the root, as ListRoots reports them.",
            columns: [
              { key: "name", label: "Policy type", kind: "text" },
              { key: "status", label: "Status", kind: "status" },
            ],
            data: POLICY_TYPES.map((p) => ({ name: p.name, status: enabled.find((e) => e.Type === p.type)?.Status ?? "DISABLED" })),
          },
        ],
      };
    }
    if (!isOuId(id)) throw new Error(`"${id}" is not a root or organizational unit ID.`);
    const r = await org.send(new DescribeOrganizationalUnitCommand({ OrganizationalUnitId: id }));
    const ou = r.OrganizationalUnit;
    const path = ou?.Path;
    const children = await listUnits(ctx, id);
    return {
      summary: { Name: ou?.Name ?? id, Type: "Organizational unit", ID: ou?.Id ?? id, "Parent ID": parentFromPath(path, id), ARN: ou?.Arn ?? null, Path: path ?? null },
      tabs: [
        { id: "children", label: "Organizational units", kind: "table", columns: childColumns, data: children.map((u) => ({ name: u.Name, id: u.Id, arn: u.Arn })), emptyText: "No organizational units in this OU." },
        {
          id: "accounts",
          label: "Accounts",
          kind: "text",
          data: "AWS Emulator doesn't support listing the accounts in an OU yet (ListAccountsForParent).",
        },
      ],
    };
  },

  create: {
    title: "Create organizational unit",
    description: "An organizational unit (OU) groups accounts so you can manage them as a single unit.",
    fields: [
      {
        name: "parentId",
        label: "Parent",
        kind: "select",
        required: true,
        options: parentOptions,
        help: "The root or OU that the new OU is created in.",
        section: "Organizational unit details",
      },
      {
        name: "name",
        label: "Organizational unit name",
        kind: "text",
        required: true,
        placeholder: "e.g. Workloads",
        help: "Up to 128 characters.",
        validate: { pattern: "[\\s\\S]{1,128}", message: "Use 1 to 128 characters." },
        section: "Organizational unit details",
      },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.organizations.send(new CreateOrganizationalUnitCommand({ ParentId: String(v.parentId), Name: String(v.name) }));
      const id = r.OrganizationalUnit?.Id;
      if (!id) throw new Error("Organizations returned no ID for the new OU.");
      return id;
    },
  },

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      if (!isOuId(id)) throw new Error("Only organizational units can be deleted. The root is deleted with the organization.");
      await ctx.clients.organizations.send(new DeleteOrganizationalUnitCommand({ OrganizationalUnitId: id }));
    },
  },
};

const policies: ResourceDef = {
  id: "policies",
  name: "Policies",
  singular: "policy type",
  idField: "type",
  nameField: "Policy type",
  description: "Authorization and management policy types, and whether each is enabled on the root.",
  emptyText: "No organization. Create an organization on the Settings page.",
  columns: [
    { key: "name", label: "Policy type", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "description", label: "Description", kind: "text" },
    { key: "type", label: "API name", kind: "code", hidden: true },
  ],
  async list(ctx) {
    const org = await describeOrganization(ctx);
    if (!org) return [];
    const enabled = (await listRoots(ctx)).flatMap((r) => r.PolicyTypes ?? []);
    return POLICY_TYPES.map((p) => ({ type: p.type, name: p.name, description: p.description, status: enabled.find((e) => e.Type === p.type)?.Status ?? "DISABLED" }));
  },
  async get(ctx, type) {
    const p = POLICY_TYPES.find((x) => x.type === type);
    if (!p) throw new Error(`Unknown policy type ${type}.`);
    const roots = await listRoots(ctx);
    const enabled = roots.flatMap((r) => (r.PolicyTypes ?? []).filter((e) => e.Type === type).map((e) => ({ root: r.Id, status: e.Status })));
    return {
      summary: { "Policy type": p.name, "API name": p.type, Status: enabled[0]?.status ?? "DISABLED", Description: p.description },
      tabs: [
        {
          id: "policies",
          label: "Policies",
          kind: "text",
          data: "AWS Emulator doesn't support listing, creating, attaching or detaching policies yet (ListPolicies, CreatePolicy, AttachPolicy, DetachPolicy), nor enabling or disabling policy types (EnablePolicyType, DisablePolicyType). The status above is what ListRoots reports.",
        },
      ],
    };
  },
};

const settings: ResourceDef = {
  id: "settings",
  name: "Settings",
  singular: "organization",
  idField: "id",
  nameField: "Organization ID",
  description: "Organization details and the management account.",
  emptyText: "This account isn't a member of an organization. Create an organization to manage accounts centrally.",
  columns: [
    { key: "id", label: "Organization ID", kind: "link" },
    { key: "featureSet", label: "Feature set", kind: "text" },
    { key: "managementAccountId", label: "Management account ID", kind: "text" },
    { key: "managementAccountEmail", label: "Management account email", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn" },
  ],
  async list(ctx) {
    const o = await describeOrganization(ctx);
    if (!o?.Id) return [];
    return [{ id: o.Id, featureSet: o.FeatureSet === "ALL" ? "All features" : o.FeatureSet ?? null, managementAccountId: o.MasterAccountId ?? null, managementAccountEmail: o.MasterAccountEmail ?? null, arn: o.Arn ?? null }];
  },
  async get(ctx, id) {
    const o = await describeOrganization(ctx);
    if (!o || o.Id !== id) throw new Error(`Organization ${id} was not found. ${o ? `This account is in ${o.Id}.` : NO_ORG_TEXT}`);
    return {
      summary: {
        "Organization ID": o.Id,
        ARN: o.Arn ?? null,
        "Feature set": o.FeatureSet === "ALL" ? "All features" : o.FeatureSet ?? null,
        "Management account ID": o.MasterAccountId ?? null,
        "Management account email": o.MasterAccountEmail ?? null,
        "Management account ARN": o.MasterAccountArn ?? null,
      },
      tabs: [
        {
          id: "policy-types",
          label: "Available policy types",
          kind: "table",
          columns: [
            { key: "type", label: "Policy type", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
          ],
          data: (o.AvailablePolicyTypes ?? []).map((t) => ({ type: POLICY_TYPES.find((p) => p.type === t.Type)?.name ?? t.Type, status: t.Status })),
          emptyText: "No policy types are enabled.",
        },
      ],
    };
  },
  create: {
    title: "Create an organization",
    description: "Your account becomes the management account of a new organization.",
    fields: [
      {
        name: "featureSet",
        label: "Feature set",
        kind: "radio",
        required: true,
        default: "ALL",
        options: [
          { value: "ALL", label: "All features - consolidated billing plus policies and integration with other AWS services" },
          { value: "CONSOLIDATED_BILLING", label: "Consolidated billing only" },
        ],
      },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.organizations.send(new CreateOrganizationCommand({ FeatureSet: v.featureSet === "CONSOLIDATED_BILLING" ? "CONSOLIDATED_BILLING" : "ALL" }));
      const id = r.Organization?.Id;
      if (!id) throw new Error("Organizations returned no organization ID.");
      return id;
    },
  },
};

export const organizationsService: ServiceDef = {
  id: "organizations",
  name: "AWS Organizations",
  category: "Management & Governance",
  description: "Centrally manage and govern multiple AWS accounts.",
  resources: [accounts, policies, settings],
  notSupported: [
    "Listing and describing accounts (ListAccounts, ListAccountsForParent, ListChildren, DescribeAccount)",
    "Creating, inviting and moving accounts (CreateAccount, InviteAccountToOrganization, MoveAccount)",
    "Renaming organizational units (UpdateOrganizationalUnit)",
    "Policies of every type - SCP, RCP, declarative, tag, backup, AI services opt-out, chat applications: list, create, edit, delete, attach, detach (ListPolicies, CreatePolicy, AttachPolicy …)",
    "Enabling or disabling policy types (EnablePolicyType, DisablePolicyType) and effective policies",
    "Services / trusted access (ListAWSServiceAccessForOrganization, EnableAWSServiceAccess)",
    "Delegated administrators (ListDelegatedAdministrators, RegisterDelegatedAdministrator)",
    "Invitations (handshakes), enabling all features, the resource-based delegation policy",
    "Tags on organization resources (ListTagsForResource, TagResource)",
  ],
};
