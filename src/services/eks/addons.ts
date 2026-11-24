/** EKS add-ons. Ids are "<cluster>/<add-on name>"; the cluster's Add-ons tab links here. */

import {
  CreateAddonCommand,
  DeleteAddonCommand,
  DescribeAddonCommand,
  DescribeAddonVersionsCommand,
  ListAddonsCommand,
  UpdateAddonCommand,
  type Addon,
  type ResolveConflicts,
} from "@aws-sdk/client-eks";
import type { Ctx, Option, ResourceDef, Row } from "../../console/types.ts";
import { joinId, splitId, tagsToRecord } from "./helpers.ts";
import { addonNameOptions, clusterNames, clusterOptions, roleOptions } from "./lookups.ts";
import { manageTagsAction } from "./tagging.ts";
import { tagsTab, tolerantTab, updateTab } from "./updates.ts";

const CONFLICTS: Option[] = [
  { value: "NONE", label: "None: fail if a field the add-on manages was changed on the cluster" },
  { value: "OVERWRITE", label: "Override: replace changed fields with Amazon EKS defaults" },
  { value: "PRESERVE", label: "Preserve: keep the values on the cluster (updates only)" },
];

async function describe(ctx: Ctx, cluster: string, name: string): Promise<Addon> {
  const a = (await ctx.clients.eks.send(new DescribeAddonCommand({ clusterName: cluster, addonName: name }))).addon;
  if (!a) throw new Error(`EKS returned no add-on ${name} in cluster ${cluster}.`);
  return a;
}

function row(a: Addon): Row {
  const cluster = a.clusterName ?? "";
  const name = a.addonName ?? "";
  return {
    id: joinId(cluster, name),
    name,
    cluster,
    status: a.status ?? null,
    version: a.addonVersion ?? null,
    roleArn: a.serviceAccountRoleArn ?? null,
    createdAt: a.createdAt ?? null,
    arn: a.addonArn ?? null,
  };
}

export async function addonRows(ctx: Ctx, cluster: string): Promise<Row[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.eks.send(new ListAddonsCommand({ clusterName: cluster, nextToken: token, maxResults: 100 }));
    names.push(...(r.addons ?? []));
    token = r.nextToken;
  } while (token);
  return Promise.all(names.map(async (n) => row(await describe(ctx, cluster, n))));
}

export const ADDON_COLUMNS = [
  { key: "name", label: "Add-on name", kind: "link" as const },
  { key: "cluster", label: "Cluster", kind: "text" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "version", label: "Version", kind: "text" as const },
  { key: "roleArn", label: "IAM role for service account (IRSA)", kind: "arn" as const },
  { key: "createdAt", label: "Created", kind: "date" as const, hidden: true },
];

/** Versions of one add-on, newest first, for the edit dialog's help text. */
async function versionsOf(ctx: Ctx, name: string, k8sVersion: string | undefined): Promise<string[]> {
  const r = await ctx.clients.eks.send(new DescribeAddonVersionsCommand({ addonName: name, kubernetesVersion: k8sVersion }));
  return (r.addons?.[0]?.addonVersions ?? []).map((v) => v.addonVersion ?? "").filter(Boolean);
}

export const addons: ResourceDef = {
  id: "add-ons",
  name: "Add-ons (all clusters)",
  singular: "add-on",
  idField: "id",
  nameField: "name",
  description: "Operational software for clusters (networking, DNS, storage drivers, observability agents) that Amazon EKS installs and updates. In the AWS console they are on each cluster's Add-ons tab.",
  emptyText: "No add-ons. Get more add-ons for a cluster to install them.",
  columns: ADDON_COLUMNS,

  async list(ctx) {
    const clusters = await clusterNames(ctx);
    return (await Promise.all(clusters.map((c) => addonRows(ctx, c)))).flat();
  },

  async get(ctx, id) {
    const { cluster, child } = splitId(id);
    const a = await describe(ctx, cluster, child);
    const r = row(a);
    let config: unknown = null;
    if (a.configurationValues) {
      try {
        config = JSON.parse(a.configurationValues);
      } catch {
        config = a.configurationValues;
      }
    }
    let available: string[] = [];
    let availableError: string | null = null;
    try {
      available = await versionsOf(ctx, child, undefined);
    } catch (err: unknown) {
      availableError = err instanceof Error ? err.message : String(err);
    }
    return {
      summary: { name: r.name, cluster: r.cluster, status: r.status, version: r.version, roleArn: r.roleArn, arn: r.arn, createdAt: r.createdAt, modifiedAt: a.modifiedAt ?? null },
      summaryLabels: { name: "Add-on name", cluster: "Cluster", status: "Status", version: "Version", roleArn: "IAM role for service account (IRSA)", arn: "Add-on ARN", createdAt: "Created", modifiedAt: "Modified" },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            Namespace: a.namespaceConfig?.namespace ?? null,
            Publisher: a.publisher ?? null,
            Owner: a.owner ?? null,
            "Pod Identity associations": a.podIdentityAssociations?.join(", ") || "None",
            "Available versions": availableError ? `Could not read: ${availableError}` : available.join(", ") || null,
          },
        },
        {
          id: "configuration",
          label: "Advanced configuration",
          kind: "json",
          data: config,
          emptyText: "No configuration values: the add-on uses its defaults.",
        },
        {
          id: "health",
          label: "Health issues",
          kind: "table",
          columns: [
            { key: "code", label: "Issue type", kind: "text" },
            { key: "message", label: "Description", kind: "text" },
          ],
          data: (a.health?.issues ?? []).map((i) => ({ code: i.code ?? null, message: i.message ?? null })),
          emptyText: "No health issues.",
        },
        await tolerantTab(() => updateTab(ctx, cluster, { addonName: child }), { id: "updates", label: "Update history" }),
        tagsTab(a.tags, "This add-on has no tags."),
      ],
    };
  },

  create: {
    title: "Get more add-ons",
    description: "Installs an add-on on a cluster with CreateAddon.",
    fields: [
      { name: "cluster", label: "Cluster", kind: "select", required: true, options: clusterOptions, section: "Select add-on" },
      { name: "addonName", label: "Add-on", kind: "select", required: true, options: addonNameOptions, section: "Select add-on", help: "Amazon EKS add-ons and AWS Marketplace add-ons (name - category (publisher))." },
      { name: "version", label: "Version", kind: "text", section: "Configure selected add-on settings", placeholder: "v1.25.0-eksbuild.1", help: "Leave empty for the default version for the cluster's Kubernetes version." },
      { name: "roleArn", label: "IAM role (IRSA)", kind: "select", default: "", options: roleOptions, section: "Configure selected add-on settings", help: "A role for the add-on's Kubernetes service account. Empty: the add-on uses the node IAM role." },
      { name: "resolveConflicts", label: "Conflict resolution method", kind: "radio", default: "NONE", options: CONFLICTS.slice(0, 2), section: "Optional configuration settings" },
      { name: "configurationValues", label: "Configuration values", kind: "json", section: "Optional configuration settings", help: "JSON matching the add-on's configuration schema." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const cluster = String(v.cluster);
      const name = String(v.addonName);
      const tags = tagsToRecord(v.tags);
      await ctx.clients.eks.send(
        new CreateAddonCommand({
          clusterName: cluster,
          addonName: name,
          addonVersion: typeof v.version === "string" && v.version ? v.version : undefined,
          serviceAccountRoleArn: typeof v.roleArn === "string" && v.roleArn ? v.roleArn : undefined,
          resolveConflicts: String(v.resolveConflicts) as ResolveConflicts,
          configurationValues: typeof v.configurationValues === "string" && v.configurationValues.trim() ? v.configurationValues : undefined,
          tags: Object.keys(tags).length ? tags : undefined,
        })
      );
      return joinId(cluster, name);
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit add-on",
      fields: [
        { name: "version", label: "Version", kind: "text", help: "Leave empty to keep the current version. See Details > Available versions." },
        { name: "roleArn", label: "IAM role (IRSA)", kind: "select", default: "", options: roleOptions, help: "Empty keeps the current role." },
        { name: "resolveConflicts", label: "Conflict resolution method", kind: "radio", default: "PRESERVE", options: CONFLICTS },
        { name: "configurationValues", label: "Configuration values", kind: "json", help: "Leave empty to keep the current values." },
      ],
      async initialValues(ctx, id) {
        const { cluster, child } = splitId(id);
        const a = await describe(ctx, cluster, child);
        return { version: a.addonVersion ?? "", roleArn: a.serviceAccountRoleArn ?? "", configurationValues: a.configurationValues ?? "" };
      },
      async run(ctx, id, v) {
        const { cluster, child } = splitId(id);
        const a = await describe(ctx, cluster, child);
        const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : undefined);
        const changed = (x: string | undefined, cur: string | undefined) => (x !== undefined && x !== (cur ?? "") ? x : undefined);
        const version = changed(str(v.version), a.addonVersion);
        const role = changed(str(v.roleArn), a.serviceAccountRoleArn);
        const config = changed(str(v.configurationValues), a.configurationValues);
        if (!version && !role && !config) return { message: "No changes to save." };
        const r = await ctx.clients.eks.send(
          new UpdateAddonCommand({
            clusterName: cluster,
            addonName: child,
            addonVersion: version,
            serviceAccountRoleArn: role,
            resolveConflicts: ((typeof v.resolveConflicts === "string" && v.resolveConflicts) || "PRESERVE") as ResolveConflicts,
            configurationValues: config,
          })
        );
        return { message: `Update ${r.update?.id ?? ""} (${r.update?.type ?? "AddonUpdate"}) is ${r.update?.status ?? "submitted"}.` };
      },
    },
    {
      id: "remove-preserve",
      label: "Remove, keep software on cluster",
      danger: true,
      confirm: "Removes the add-on from Amazon EKS management (DeleteAddon with preserve) but leaves its Kubernetes resources on the cluster.",
      async run(ctx, id) {
        const { cluster, child } = splitId(id);
        const r = await ctx.clients.eks.send(new DeleteAddonCommand({ clusterName: cluster, addonName: child, preserve: true }));
        return { message: `Add-on ${child} is ${r.addon?.status ?? "being removed"}; its resources stay on the cluster.` };
      },
    },
    manageTagsAction(async (ctx, id) => {
      const { cluster, child } = splitId(id);
      return (await describe(ctx, cluster, child)).addonArn ?? "";
    }),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { cluster, child } = splitId(id);
      await ctx.clients.eks.send(new DeleteAddonCommand({ clusterName: cluster, addonName: child }));
    },
  },
};
