/**
 * Cluster access: IAM access entries (with their access policies) and EKS Pod Identity
 * associations. Ids are "<cluster>/<principal ARN>" and "<cluster>/<association id>".
 * In the AWS console both are on each cluster's Access tab, which links here.
 */

import {
  AssociateAccessPolicyCommand,
  CreateAccessEntryCommand,
  CreatePodIdentityAssociationCommand,
  DeleteAccessEntryCommand,
  DeletePodIdentityAssociationCommand,
  DescribeAccessEntryCommand,
  DescribePodIdentityAssociationCommand,
  DisassociateAccessPolicyCommand,
  ListAccessEntriesCommand,
  ListAssociatedAccessPoliciesCommand,
  ListPodIdentityAssociationsCommand,
  UpdateAccessEntryCommand,
  UpdatePodIdentityAssociationCommand,
  type AccessEntry,
  type AccessScopeType,
  type PodIdentityAssociation,
} from "@aws-sdk/client-eks";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { csv, joinId, splitId, tagsToRecord } from "./helpers.ts";
import { accessPolicyOptions, clusterNames, clusterOptions, principalOptions, roleOptions } from "./lookups.ts";
import { manageTagsAction } from "./tagging.ts";
import { tagsTab, tolerantTab } from "./updates.ts";

const ENTRY_TYPES: Option[] = [
  { value: "STANDARD", label: "Standard" },
  { value: "EC2_LINUX", label: "EC2 Linux" },
  { value: "EC2_WINDOWS", label: "EC2 Windows" },
  { value: "FARGATE_LINUX", label: "Fargate Linux" },
];

const scopeFields = (required: boolean): FieldDef[] => [
  {
    name: "scope", label: "Access scope", kind: "radio", default: "cluster",
    options: [{ value: "cluster", label: "Cluster: the whole cluster" }, { value: "namespace", label: "Kubernetes namespace: only the namespaces below" }],
    section: required ? undefined : "Access policy",
  },
  { name: "namespaces", label: "Namespaces", kind: "text", required: true, placeholder: "dev, test", showIf: { field: "scope", equals: "namespace" }, help: "Comma-separated namespaces.", section: required ? undefined : "Access policy" },
];

function scopeOf(v: FieldValues): { type: AccessScopeType; namespaces?: string[] } {
  return v.scope === "namespace" ? { type: "namespace", namespaces: csv(v.namespaces) } : { type: "cluster" };
}

async function describeEntry(ctx: Ctx, cluster: string, principal: string): Promise<AccessEntry> {
  const e = (await ctx.clients.eks.send(new DescribeAccessEntryCommand({ clusterName: cluster, principalArn: principal }))).accessEntry;
  if (!e) throw new Error(`EKS returned no access entry for ${principal} in cluster ${cluster}.`);
  return e;
}

function entryRow(e: AccessEntry): Row {
  const cluster = e.clusterName ?? "";
  const principal = e.principalArn ?? "";
  return {
    id: joinId(cluster, principal),
    principalArn: principal,
    cluster,
    type: e.type ?? null,
    username: e.username ?? null,
    groups: e.kubernetesGroups?.join(", ") || null,
    createdAt: e.createdAt ?? null,
  };
}

export async function accessEntryRows(ctx: Ctx, cluster: string): Promise<Row[]> {
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.eks.send(new ListAccessEntriesCommand({ clusterName: cluster, nextToken: token, maxResults: 100 }));
    arns.push(...(r.accessEntries ?? []));
    token = r.nextToken;
  } while (token);
  return Promise.all(arns.map(async (a) => entryRow(await describeEntry(ctx, cluster, a))));
}

export const ACCESS_ENTRY_COLUMNS = [
  { key: "principalArn", label: "IAM principal ARN", kind: "link" as const },
  { key: "cluster", label: "Cluster", kind: "text" as const },
  { key: "type", label: "Type", kind: "text" as const },
  { key: "username", label: "Username", kind: "text" as const },
  { key: "groups", label: "Group names", kind: "text" as const },
  { key: "createdAt", label: "Created", kind: "date" as const, hidden: true },
];

export const accessEntries: ResourceDef = {
  id: "access-entries",
  name: "Access entries (all clusters)",
  singular: "access entry",
  idField: "id",
  nameField: "principalArn",
  description: "IAM principals that can reach the Kubernetes API, with the EKS access policies (Kubernetes permissions) associated with them. In the AWS console they are on each cluster's Access tab.",
  emptyText: "No access entries. Create one to give an IAM principal access to a cluster.",
  columns: ACCESS_ENTRY_COLUMNS,

  async list(ctx) {
    const clusters = await clusterNames(ctx);
    return (await Promise.all(clusters.map((c) => accessEntryRows(ctx, c)))).flat();
  },

  async get(ctx, id) {
    const { cluster, child } = splitId(id);
    const e = await describeEntry(ctx, cluster, child);
    const r = entryRow(e);
    const policiesTab = await tolerantTab(async () => {
      const policies = await ctx.clients.eks.send(new ListAssociatedAccessPoliciesCommand({ clusterName: cluster, principalArn: child }));
      return {
        id: "policies",
        label: "Access policies",
        kind: "table",
        columns: [
          { key: "policyArn", label: "Policy ARN", kind: "arn" },
          { key: "scope", label: "Access scope", kind: "text" },
          { key: "associatedAt", label: "Associated at", kind: "date" },
        ],
        data: (policies.associatedAccessPolicies ?? []).map((p) => ({
          policyArn: p.policyArn ?? null,
          scope: p.accessScope?.type === "namespace" ? `Namespaces: ${p.accessScope.namespaces?.join(", ") ?? ""}` : p.accessScope?.type ?? null,
          associatedAt: p.associatedAt ?? null,
        })),
        emptyText: "No access policies are associated. Use Actions > Associate access policy.",
      };
    }, { id: "policies", label: "Access policies" });
    return {
      summary: { principalArn: r.principalArn, cluster: r.cluster, type: r.type, username: r.username, groups: r.groups, arn: e.accessEntryArn ?? null, createdAt: r.createdAt, modifiedAt: e.modifiedAt ?? null },
      summaryLabels: { principalArn: "IAM principal ARN", cluster: "Cluster", type: "Type", username: "Username", groups: "Group names", arn: "Access entry ARN", createdAt: "Created", modifiedAt: "Modified" },
      tabs: [
        policiesTab,
        tagsTab(e.tags, "This access entry has no tags."),
      ],
    };
  },

  create: {
    title: "Create access entry",
    description: "Creates an access entry with CreateAccessEntry, then optionally associates an access policy.",
    fields: [
      { name: "cluster", label: "Cluster", kind: "select", required: true, options: clusterOptions, section: "Configure IAM access entry" },
      { name: "principalArn", label: "IAM principal ARN", kind: "select", required: true, options: principalOptions, section: "Configure IAM access entry" },
      { name: "type", label: "Type", kind: "select", required: true, default: "STANDARD", options: ENTRY_TYPES, section: "Configure IAM access entry", help: "EC2 and Fargate types are for node roles; only Standard entries take access policies." },
      { name: "username", label: "Username", kind: "text", section: "Configure IAM access entry", help: "Kubernetes username. Empty: EKS generates one." },
      { name: "groups", label: "Groups", kind: "text", section: "Configure IAM access entry", help: "Comma-separated Kubernetes groups (for your own RBAC bindings)." },
      { name: "policyArn", label: "Policy name", kind: "select", default: "", options: accessPolicyOptions, section: "Access policy" },
      ...scopeFields(false),
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const cluster = String(v.cluster);
      const principal = String(v.principalArn);
      const tags = tagsToRecord(v.tags);
      const groups = csv(v.groups);
      await ctx.clients.eks.send(
        new CreateAccessEntryCommand({
          clusterName: cluster,
          principalArn: principal,
          type: typeof v.type === "string" && v.type ? v.type : undefined,
          username: typeof v.username === "string" && v.username ? v.username : undefined,
          kubernetesGroups: groups.length ? groups : undefined,
          tags: Object.keys(tags).length ? tags : undefined,
        })
      );
      if (typeof v.policyArn === "string" && v.policyArn) {
        await ctx.clients.eks.send(new AssociateAccessPolicyCommand({ clusterName: cluster, principalArn: principal, policyArn: v.policyArn, accessScope: scopeOf(v) }));
      }
      return joinId(cluster, principal);
    },
  },

  actions: [
    {
      id: "associate",
      label: "Associate access policy",
      fields: [{ name: "policyArn", label: "Policy name", kind: "select", required: true, options: accessPolicyOptions }, ...scopeFields(true)],
      async run(ctx, id, v) {
        const { cluster, child } = splitId(id);
        await ctx.clients.eks.send(new AssociateAccessPolicyCommand({ clusterName: cluster, principalArn: child, policyArn: String(v.policyArn), accessScope: scopeOf(v) }));
        return { message: `Associated ${String(v.policyArn).split("/").pop()}.` };
      },
    },
    {
      id: "disassociate",
      label: "Disassociate access policy",
      danger: true,
      fields: [{ name: "policyArn", label: "Policy name", kind: "select", required: true, options: accessPolicyOptions }],
      async run(ctx, id, v) {
        const { cluster, child } = splitId(id);
        await ctx.clients.eks.send(new DisassociateAccessPolicyCommand({ clusterName: cluster, principalArn: child, policyArn: String(v.policyArn) }));
        return { message: `Disassociated ${String(v.policyArn).split("/").pop()}.` };
      },
    },
    {
      id: "edit",
      label: "Edit",
      fields: [
        { name: "username", label: "Username", kind: "text", help: "Empty keeps the current username." },
        { name: "groups", label: "Groups", kind: "text", help: "Comma-separated Kubernetes groups. Replaces the current groups." },
      ],
      async initialValues(ctx, id) {
        const { cluster, child } = splitId(id);
        const e = await describeEntry(ctx, cluster, child);
        return { username: e.username ?? "", groups: (e.kubernetesGroups ?? []).join(", ") };
      },
      async run(ctx, id, v) {
        const { cluster, child } = splitId(id);
        const e = await describeEntry(ctx, cluster, child);
        const username = typeof v.username === "string" && v.username ? v.username : undefined;
        const groups = csv(v.groups);
        const current = e.kubernetesGroups ?? [];
        const sameGroups = groups.length === current.length && groups.every((g) => current.includes(g));
        if ((username === undefined || username === e.username) && sameGroups) return { message: "No changes to save." };
        await ctx.clients.eks.send(
          new UpdateAccessEntryCommand({ clusterName: cluster, principalArn: child, username: username === e.username ? undefined : username, kubernetesGroups: groups })
        );
        return { message: "Access entry updated." };
      },
    },
    manageTagsAction(async (ctx, id) => {
      const { cluster, child } = splitId(id);
      return (await describeEntry(ctx, cluster, child)).accessEntryArn ?? "";
    }),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { cluster, child } = splitId(id);
      await ctx.clients.eks.send(new DeleteAccessEntryCommand({ clusterName: cluster, principalArn: child }));
    },
  },
};

// ---- Pod Identity associations ----

async function describeAssociation(ctx: Ctx, cluster: string, associationId: string): Promise<PodIdentityAssociation> {
  const a = (await ctx.clients.eks.send(new DescribePodIdentityAssociationCommand({ clusterName: cluster, associationId }))).association;
  if (!a) throw new Error(`EKS returned no Pod Identity association ${associationId} in cluster ${cluster}.`);
  return a;
}

function associationRow(a: PodIdentityAssociation): Row {
  const cluster = a.clusterName ?? "";
  return {
    id: joinId(cluster, a.associationId ?? ""),
    associationId: a.associationId ?? null,
    cluster,
    namespace: a.namespace ?? null,
    serviceAccount: a.serviceAccount ?? null,
    roleArn: a.roleArn ?? null,
    ownerArn: a.ownerArn ?? null,
    createdAt: a.createdAt ?? null,
  };
}

export async function podIdentityRows(ctx: Ctx, cluster: string): Promise<Row[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.eks.send(new ListPodIdentityAssociationsCommand({ clusterName: cluster, nextToken: token, maxResults: 100 }));
    for (const a of r.associations ?? []) if (a.associationId) ids.push(a.associationId);
    token = r.nextToken;
  } while (token);
  return Promise.all(ids.map(async (id) => associationRow(await describeAssociation(ctx, cluster, id))));
}

export const POD_IDENTITY_COLUMNS = [
  { key: "associationId", label: "Association ID", kind: "link" as const },
  { key: "cluster", label: "Cluster", kind: "text" as const },
  { key: "namespace", label: "Namespace", kind: "text" as const },
  { key: "serviceAccount", label: "Service account", kind: "text" as const },
  { key: "roleArn", label: "IAM role ARN", kind: "arn" as const },
  { key: "createdAt", label: "Created", kind: "date" as const, hidden: true },
];

export const podIdentity: ResourceDef = {
  id: "pod-identity-associations",
  name: "Pod Identity associations (all clusters)",
  singular: "Pod Identity association",
  idField: "id",
  nameField: "associationId",
  description: "EKS Pod Identity maps a Kubernetes service account to an IAM role, so pods get AWS credentials without IRSA. In the AWS console they are on each cluster's Access tab.",
  emptyText: "No Pod Identity associations.",
  columns: POD_IDENTITY_COLUMNS,

  async list(ctx) {
    const clusters = await clusterNames(ctx);
    return (await Promise.all(clusters.map((c) => podIdentityRows(ctx, c)))).flat();
  },

  async get(ctx, id) {
    const { cluster, child } = splitId(id);
    const a = await describeAssociation(ctx, cluster, child);
    const r = associationRow(a);
    return {
      summary: { ...r, id: undefined, arn: a.associationArn ?? null, targetRoleArn: a.targetRoleArn ?? null, disableSessionTags: a.disableSessionTags ?? null, modifiedAt: a.modifiedAt ?? null },
      summaryLabels: {
        associationId: "Association ID", cluster: "Cluster", namespace: "Namespace", serviceAccount: "Service account", roleArn: "IAM role ARN", ownerArn: "Owner (add-on)",
        createdAt: "Created", arn: "Association ARN", targetRoleArn: "Target IAM role ARN", disableSessionTags: "Session tags disabled", modifiedAt: "Modified",
      },
      tabs: [tagsTab(a.tags, "This association has no tags.")],
    };
  },

  create: {
    title: "Create Pod Identity association",
    description: "Creates an association with CreatePodIdentityAssociation. The cluster needs the eks-pod-identity-agent add-on for pods to use it.",
    fields: [
      { name: "cluster", label: "Cluster", kind: "select", required: true, options: clusterOptions, section: "Configure Pod Identity association" },
      { name: "roleArn", label: "IAM role", kind: "select", required: true, options: roleOptions, section: "Configure Pod Identity association", help: "Its trust policy must allow pods.eks.amazonaws.com to sts:AssumeRole and sts:TagSession." },
      { name: "namespace", label: "Kubernetes namespace", kind: "text", required: true, placeholder: "default", section: "Configure Pod Identity association" },
      { name: "serviceAccount", label: "Kubernetes service account", kind: "text", required: true, placeholder: "my-app", section: "Configure Pod Identity association" },
      { name: "disableSessionTags", label: "Disable session tags", kind: "checkbox", default: false, section: "Configure Pod Identity association" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const cluster = String(v.cluster);
      const tags = tagsToRecord(v.tags);
      const r = await ctx.clients.eks.send(
        new CreatePodIdentityAssociationCommand({
          clusterName: cluster,
          roleArn: String(v.roleArn),
          namespace: String(v.namespace),
          serviceAccount: String(v.serviceAccount),
          disableSessionTags: v.disableSessionTags === true,
          tags: Object.keys(tags).length ? tags : undefined,
        })
      );
      const id = r.association?.associationId;
      if (!id) throw new Error("EKS returned no association ID.");
      return joinId(cluster, id);
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit",
      fields: [
        { name: "roleArn", label: "IAM role", kind: "select", required: true, options: roleOptions },
        { name: "disableSessionTags", label: "Disable session tags", kind: "checkbox", default: false },
      ],
      async initialValues(ctx, id) {
        const { cluster, child } = splitId(id);
        const a = await describeAssociation(ctx, cluster, child);
        return { roleArn: a.roleArn ?? "", disableSessionTags: a.disableSessionTags === true };
      },
      async run(ctx, id, v) {
        const { cluster, child } = splitId(id);
        await ctx.clients.eks.send(new UpdatePodIdentityAssociationCommand({ clusterName: cluster, associationId: child, roleArn: String(v.roleArn), disableSessionTags: v.disableSessionTags === true }));
        return { message: "Pod Identity association updated." };
      },
    },
    manageTagsAction(async (ctx, id) => {
      const { cluster, child } = splitId(id);
      return (await describeAssociation(ctx, cluster, child)).associationArn ?? "";
    }),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { cluster, child } = splitId(id);
      await ctx.clients.eks.send(new DeletePodIdentityAssociationCommand({ clusterName: cluster, associationId: child }));
    },
  },
};
