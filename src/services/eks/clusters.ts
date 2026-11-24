/**
 * EKS clusters. The cluster screen is hand-built (src/app/eks/clusters/[cluster]) so it can
 * show the Compute, Add-ons and Access tabs with links to node groups, add-ons and access
 * entries in the console's tab order; the other tabs come from get().
 */

import {
  CreateClusterCommand,
  DeleteClusterCommand,
  DescribeClusterCommand,
  ListInsightsCommand,
  StartInsightsRefreshCommand,
  UpdateClusterConfigCommand,
  UpdateClusterVersionCommand,
  type AuthenticationMode,
  type Cluster,
  type ClusterVersionInformation,
  type LogType,
  type SupportType,
} from "@aws-sdk/client-eks";
import type { Ctx, DetailTab, FieldDef, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import { fargateActions } from "./fargate.ts";
import { AUTH_MODES, authModeLabel, csv, enabledLogTypes, endpointAccess, LOG_TYPES, loggingRows, supportPeriod, tagsToRecord } from "./helpers.ts";
import { clusterNames, clusterVersions, roleOptions, securityGroupOptions, subnetOptions, versionOptions } from "./lookups.ts";
import { manageTagsAction } from "./tagging.ts";
import { tagsTab, tolerantTab, updateTab } from "./updates.ts";

const CLUSTER_NAME = "[0-9A-Za-z][A-Za-z0-9_-]{0,99}";

export async function describeCluster(ctx: Ctx, name: string): Promise<Cluster> {
  const c = (await ctx.clients.eks.send(new DescribeClusterCommand({ name }))).cluster;
  if (!c) throw new Error(`EKS returned no cluster named ${name}.`);
  return c;
}

async function versionsOrEmpty(ctx: Ctx): Promise<{ versions: ClusterVersionInformation[]; error: string | null }> {
  try {
    return { versions: await clusterVersions(ctx), error: null };
  } catch (err: unknown) {
    return { versions: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function clusterRow(c: Cluster, versions: ClusterVersionInformation[]): Row {
  return {
    name: c.name ?? "",
    status: c.status ?? null,
    version: c.version ?? null,
    supportPeriod: supportPeriod(c.version, versions),
    upgradePolicy: c.upgradePolicy?.supportType === "EXTENDED" ? "Extended support" : c.upgradePolicy?.supportType === "STANDARD" ? "Standard support" : null,
    provider: c.connectorConfig ? c.connectorConfig.provider ?? "Other" : "EKS",
    createdAt: c.createdAt ?? null,
    arn: c.arn ?? null,
  };
}

const loggingFields: FieldDef[] = LOG_TYPES.map((t) => ({ name: `log_${t.value}`, label: t.label, kind: "checkbox" as const, default: false, section: "Control plane logs" }));

function chosenLogTypes(v: FieldValues): LogType[] {
  return LOG_TYPES.filter((t) => v[`log_${t.value}`] === true).map((t) => t.value as LogType);
}

function loggingConfig(v: FieldValues) {
  const on = chosenLogTypes(v);
  const off = LOG_TYPES.map((t) => t.value as LogType).filter((t) => !on.includes(t));
  return { clusterLogging: [...(on.length ? [{ types: on, enabled: true }] : []), ...(off.length ? [{ types: off, enabled: false }] : [])] };
}

const ENDPOINT_OPTIONS = [
  { value: "public", label: "Public: the API server endpoint is reachable from outside the VPC" },
  { value: "public-private", label: "Public and private: reachable from outside the VPC; worker node traffic stays in the VPC" },
  { value: "private", label: "Private: reachable only from inside the VPC" },
];

function endpointMode(c: Cluster): string {
  const vpc = c.resourcesVpcConfig ?? {};
  if (vpc.endpointPublicAccess && vpc.endpointPrivateAccess) return "public-private";
  return vpc.endpointPrivateAccess ? "private" : "public";
}

const NO_CHANGE = { message: "No changes to save." };

function endpointConfig(v: FieldValues) {
  const mode = v.endpointAccess;
  const cidrs = csv(v.publicAccessCidrs);
  return {
    endpointPublicAccess: mode !== "private",
    endpointPrivateAccess: mode !== "public",
    publicAccessCidrs: mode !== "private" && cidrs.length ? cidrs : undefined,
  };
}

async function updateMessage(ctx: Ctx, name: string, input: Omit<ConstructorParameters<typeof UpdateClusterConfigCommand>[0], "name">): Promise<string> {
  const r = await ctx.clients.eks.send(new UpdateClusterConfigCommand({ name, ...input }));
  return `Update ${r.update?.id ?? "(no id returned)"} (${r.update?.type ?? "update"}) is ${r.update?.status ?? "submitted"}. See the Update history tab.`;
}

function overviewTab(c: Cluster): DetailTab {
  return {
    id: "overview",
    label: "Overview",
    kind: "keyvalue",
    data: {
      "API server endpoint": c.endpoint ?? null,
      "OpenID Connect provider URL": c.identity?.oidc?.issuer ?? null,
      "Certificate authority": c.certificateAuthority?.data ?? null,
      "Cluster IAM role ARN": c.roleArn ?? null,
      "Platform version": c.platformVersion ?? null,
      "Kubernetes version": c.version ?? null,
      "Upgrade policy": c.upgradePolicy?.supportType ?? null,
      "Authentication mode": authModeLabel(c.accessConfig?.authenticationMode),
      "Bootstrap cluster creator admin permissions": c.accessConfig?.bootstrapClusterCreatorAdminPermissions ?? null,
      "Deletion protection": c.deletionProtection === undefined ? null : c.deletionProtection ? "On" : "Off",
      "Secrets encryption": c.encryptionConfig?.length ? c.encryptionConfig.map((e) => e.provider?.keyArn ?? "").join(", ") : "Off",
      "Health issues": c.health?.issues?.length ? c.health.issues.map((i) => `${i.code ?? ""}: ${i.message ?? ""}`).join("; ") : "None",
    },
  };
}

function networkingTab(c: Cluster): DetailTab {
  const vpc = c.resourcesVpcConfig ?? {};
  const net = c.kubernetesNetworkConfig ?? {};
  return {
    id: "networking",
    label: "Networking",
    kind: "keyvalue",
    data: {
      VPC: vpc.vpcId ?? null,
      Subnets: vpc.subnetIds?.join(", ") || null,
      "Cluster security group": vpc.clusterSecurityGroupId ?? null,
      "Additional security groups": vpc.securityGroupIds?.join(", ") || "None",
      "Cluster IP address family": net.ipFamily ?? null,
      "Service IPv4 range": net.serviceIpv4Cidr ?? null,
      "Service IPv6 range": net.serviceIpv6Cidr ?? null,
      "API server endpoint access": endpointAccess(vpc.endpointPublicAccess, vpc.endpointPrivateAccess),
      "Public access source allowlist": vpc.endpointPublicAccess ? vpc.publicAccessCidrs?.join(", ") || null : "Not public",
    },
  };
}

async function insightsTab(ctx: Ctx, name: string): Promise<DetailTab> {
  const rows: Row[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.eks.send(new ListInsightsCommand({ clusterName: name, nextToken: token }));
    for (const i of r.insights ?? []) {
      rows.push({
        name: i.name ?? null,
        status: i.insightStatus?.status ?? null,
        reason: i.insightStatus?.reason ?? null,
        category: i.category ?? null,
        version: i.kubernetesVersion ?? null,
        refreshed: i.lastRefreshTime ?? null,
      });
    }
    token = r.nextToken;
  } while (token);
  return {
    id: "insights",
    label: "Upgrade insights",
    kind: "table",
    description: "Checks EKS runs against the cluster before a Kubernetes version upgrade.",
    columns: [
      { key: "name", label: "Name", kind: "text" },
      { key: "status", label: "Insight status", kind: "status" },
      { key: "reason", label: "Reason", kind: "text" },
      { key: "version", label: "Kubernetes version", kind: "text" },
      { key: "category", label: "Category", kind: "text" },
      { key: "refreshed", label: "Last refresh time", kind: "date" },
    ],
    data: rows,
    emptyText: "No upgrade insights.",
  };
}

export const clusters: ResourceDef = {
  id: "clusters",
  name: "Clusters",
  singular: "cluster",
  idField: "name",
  nameField: "name",
  description: "Kubernetes control planes managed by Amazon EKS.",
  emptyText: "No clusters. Create a cluster to get started.",
  detailHref: "clusters/{id}",
  columns: [
    { key: "name", label: "Cluster name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "version", label: "Kubernetes version", kind: "text" },
    { key: "supportPeriod", label: "Support period", kind: "text" },
    { key: "upgradePolicy", label: "Upgrade policy", kind: "text" },
    { key: "provider", label: "Provider", kind: "text" },
    { key: "createdAt", label: "Created", kind: "date", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const [names, { versions }] = await Promise.all([clusterNames(ctx), versionsOrEmpty(ctx)]);
    const all = await Promise.all(names.map((n) => describeCluster(ctx, n)));
    return all.map((c) => clusterRow(c, versions));
  },

  async get(ctx, name) {
    const [c, { versions, error }] = await Promise.all([describeCluster(ctx, name), versionsOrEmpty(ctx)]);
    const row = clusterRow(c, versions);
    const [updates, insights] = await Promise.all([
      tolerantTab(() => updateTab(ctx, name), { id: "updates", label: "Update history" }),
      tolerantTab(() => insightsTab(ctx, name), { id: "insights", label: "Upgrade insights" }),
    ]);
    return {
      summary: {
        name: row.name,
        status: row.status,
        version: row.version,
        supportPeriod: error ? `Could not read: ${error}` : row.supportPeriod,
        provider: row.provider,
        arn: row.arn,
        createdAt: row.createdAt,
      },
      summaryLabels: { name: "Name", status: "Status", version: "Kubernetes version", supportPeriod: "Support period", provider: "Provider", arn: "Cluster ARN", createdAt: "Created" },
      tabs: [
        overviewTab(c),
        networkingTab(c),
        {
          id: "observability",
          label: "Observability",
          kind: "table",
          description: "Control plane logging. Turned-on log types are sent to CloudWatch Logs (/aws/eks/<cluster>/cluster).",
          columns: [
            { key: "type", label: "Log type", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
          ],
          data: loggingRows(c.logging?.clusterLogging),
        },
        updates,
        insights,
        tagsTab(c.tags, "This cluster has no tags."),
      ],
    };
  },

  create: {
    title: "Create cluster",
    description: "Custom configuration. Creates an EKS cluster in the emulator with CreateCluster. Add node groups, add-ons and access entries from the cluster page afterwards.",
    fields: [
      {
        name: "name", label: "Name", kind: "text", required: true, section: "Cluster configuration", placeholder: "my-cluster",
        help: "Up to 100 characters: letters, numbers, hyphens and underscores, starting with a letter or number. Must be unique in the Region.",
        validate: { pattern: CLUSTER_NAME, message: "Start with a letter or number; use up to 100 letters, numbers, hyphens or underscores." },
      },
      { name: "roleArn", label: "Cluster IAM role", kind: "select", required: true, options: roleOptions, section: "Cluster configuration", help: "The role the Kubernetes control plane uses to manage AWS resources (normally with AmazonEKSClusterPolicy)." },
      { name: "version", label: "Kubernetes version", kind: "select", required: true, options: versionOptions, section: "Cluster configuration" },
      {
        name: "supportType", label: "Upgrade policy", kind: "radio", default: "EXTENDED", section: "Cluster configuration",
        options: [
          { value: "EXTENDED", label: "Extended: extended support starts when standard support ends (extra cost)" },
          { value: "STANDARD", label: "Standard: the cluster is upgraded automatically when standard support ends" },
        ],
      },
      {
        name: "authenticationMode", label: "Cluster authentication mode", kind: "radio", default: "API_AND_CONFIG_MAP", section: "Cluster access",
        options: AUTH_MODES, help: "Where the cluster reads authenticated IAM principals from: EKS access entries, the aws-auth ConfigMap, or both.",
      },
      { name: "bootstrapAdmin", label: "Allow cluster administrator access for your IAM principal", kind: "checkbox", default: true, section: "Cluster access", help: "Creates an access entry with AmazonEKSClusterAdminPolicy for the identity that creates the cluster." },
      { name: "deletionProtection", label: "Deletion protection", kind: "checkbox", default: false, section: "Cluster configuration", help: "When on, the cluster can't be deleted until you turn it off." },
      { name: "subnetIds", label: "Subnets", kind: "multiselect", required: true, options: subnetOptions, section: "Networking", help: "Choose at least two subnets in different Availability Zones of one VPC (subnet | VPC | AZ | CIDR)." },
      { name: "securityGroupIds", label: "Additional security groups", kind: "multiselect", options: securityGroupOptions, section: "Networking", help: "EKS also creates a cluster security group." },
      { name: "ipFamily", label: "Cluster IP address family", kind: "radio", default: "ipv4", section: "Networking", options: [{ value: "ipv4", label: "IPv4" }, { value: "ipv6", label: "IPv6" }] },
      { name: "customServiceCidr", label: "Configure Kubernetes service IP address range", kind: "checkbox", default: false, section: "Networking" },
      {
        name: "serviceIpv4Cidr", label: "Service IPv4 range", kind: "text", required: true, section: "Networking", placeholder: "10.100.0.0/16", showIf: { field: "customServiceCidr", equals: true },
        help: "A /12 to /24 block that doesn't overlap the VPC.", validate: { pattern: "\\d{1,3}(\\.\\d{1,3}){3}/(1[2-9]|2[0-4])", message: "Enter an IPv4 CIDR block from /12 to /24." },
      },
      { name: "endpointAccess", label: "Cluster endpoint access", kind: "radio", default: "public", options: ENDPOINT_OPTIONS, section: "Networking" },
      ...loggingFields,
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const tags = tagsToRecord(v.tags);
      await ctx.clients.eks.send(
        new CreateClusterCommand({
          name,
          roleArn: String(v.roleArn),
          version: typeof v.version === "string" && v.version ? v.version : undefined,
          resourcesVpcConfig: {
            subnetIds: Array.isArray(v.subnetIds) ? (v.subnetIds as string[]) : [],
            securityGroupIds: Array.isArray(v.securityGroupIds) ? (v.securityGroupIds as string[]) : [],
            ...endpointConfig(v),
          },
          kubernetesNetworkConfig: {
            ipFamily: v.ipFamily === "ipv6" ? "ipv6" : "ipv4",
            serviceIpv4Cidr: v.customServiceCidr === true && typeof v.serviceIpv4Cidr === "string" ? v.serviceIpv4Cidr : undefined,
          },
          logging: loggingConfig(v),
          accessConfig: { authenticationMode: String(v.authenticationMode) as AuthenticationMode, bootstrapClusterCreatorAdminPermissions: v.bootstrapAdmin === true },
          upgradePolicy: { supportType: (v.supportType === "STANDARD" ? "STANDARD" : "EXTENDED") as SupportType },
          deletionProtection: v.deletionProtection === true,
          tags: Object.keys(tags).length ? tags : undefined,
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "upgrade",
      label: "Upgrade version",
      fields: [
        { name: "version", label: "Kubernetes version", kind: "select", required: true, options: versionOptions, help: "You can upgrade one minor version at a time. Upgrade node groups first if the upgrade insights say so." },
        { name: "force", label: "Force upgrade (ignore upgrade insight failures)", kind: "checkbox", default: false },
      ],
      async run(ctx, name, v) {
        const r = await ctx.clients.eks.send(new UpdateClusterVersionCommand({ name, version: String(v.version), force: v.force === true }));
        return { message: `Version update ${r.update?.id ?? ""} is ${r.update?.status ?? "submitted"}. See the Update history tab.` };
      },
    },
    {
      id: "logging",
      label: "Manage control plane logging",
      fields: loggingFields.map((f) => ({ ...f, section: undefined })),
      async initialValues(ctx, name) {
        const on = enabledLogTypes((await describeCluster(ctx, name)).logging?.clusterLogging);
        return Object.fromEntries(LOG_TYPES.map((t) => [`log_${t.value}`, on.includes(t.value)]));
      },
      async run(ctx, name, v) {
        const on = enabledLogTypes((await describeCluster(ctx, name)).logging?.clusterLogging);
        const wanted = chosenLogTypes(v);
        if (wanted.length === on.length && wanted.every((t) => on.includes(t))) return NO_CHANGE;
        return { message: await updateMessage(ctx, name, { logging: loggingConfig(v) }) };
      },
    },
    {
      id: "endpoint",
      label: "Manage endpoint access",
      fields: [
        { name: "endpointAccess", label: "Cluster endpoint access", kind: "radio", default: "public", options: ENDPOINT_OPTIONS },
        {
          name: "publicAccessCidrs", label: "Public access source allowlist", kind: "text", placeholder: "0.0.0.0/0", showIf: { field: "endpointAccess", equals: ["public", "public-private"] },
          help: "Comma-separated CIDR blocks allowed to reach the public endpoint. Empty keeps the current list.",
        },
      ],
      async initialValues(ctx, name) {
        const c = await describeCluster(ctx, name);
        return { endpointAccess: endpointMode(c), publicAccessCidrs: (c.resourcesVpcConfig?.publicAccessCidrs ?? []).join(", ") };
      },
      async run(ctx, name, v) {
        const c = await describeCluster(ctx, name);
        const cidrs = csv(v.publicAccessCidrs);
        const current = c.resourcesVpcConfig?.publicAccessCidrs ?? [];
        const sameCidrs = cidrs.length === 0 || (cidrs.length === current.length && cidrs.every((x) => current.includes(x)));
        if (v.endpointAccess === endpointMode(c) && sameCidrs) return NO_CHANGE;
        return { message: await updateMessage(ctx, name, { resourcesVpcConfig: endpointConfig(v) }) };
      },
    },
    {
      id: "access",
      label: "Manage access (authentication mode)",
      fields: [{ name: "authenticationMode", label: "Cluster authentication mode", kind: "radio", default: "API_AND_CONFIG_MAP", options: AUTH_MODES, help: "You can only move towards EKS API: ConfigMap -> EKS API and ConfigMap -> EKS API. This can't be undone." }],
      async initialValues(ctx, name) {
        return { authenticationMode: (await describeCluster(ctx, name)).accessConfig?.authenticationMode ?? "CONFIG_MAP" };
      },
      async run(ctx, name, v) {
        if ((await describeCluster(ctx, name)).accessConfig?.authenticationMode === v.authenticationMode) return NO_CHANGE;
        return { message: await updateMessage(ctx, name, { accessConfig: { authenticationMode: String(v.authenticationMode) as AuthenticationMode } }) };
      },
    },
    {
      id: "upgrade-policy",
      label: "Edit upgrade policy",
      fields: [{ name: "supportType", label: "Upgrade policy", kind: "radio", default: "EXTENDED", options: [{ value: "EXTENDED", label: "Extended support" }, { value: "STANDARD", label: "Standard support" }] }],
      async initialValues(ctx, name) {
        return { supportType: (await describeCluster(ctx, name)).upgradePolicy?.supportType === "STANDARD" ? "STANDARD" : "EXTENDED" };
      },
      async run(ctx, name, v) {
        const wanted = v.supportType === "STANDARD" ? "STANDARD" : "EXTENDED";
        if (((await describeCluster(ctx, name)).upgradePolicy?.supportType ?? "EXTENDED") === wanted) return NO_CHANGE;
        return { message: await updateMessage(ctx, name, { upgradePolicy: { supportType: wanted as SupportType } }) };
      },
    },
    {
      id: "deletion-protection",
      label: "Edit deletion protection",
      fields: [{ name: "on", label: "Deletion protection", kind: "checkbox", default: false, help: "When on, DeleteCluster is refused." }],
      async initialValues(ctx, name) {
        return { on: (await describeCluster(ctx, name)).deletionProtection === true };
      },
      async run(ctx, name, v) {
        if (((await describeCluster(ctx, name)).deletionProtection === true) === (v.on === true)) return NO_CHANGE;
        return { message: await updateMessage(ctx, name, { deletionProtection: v.on === true }) };
      },
    },
    {
      id: "refresh-insights",
      label: "Refresh upgrade insights",
      async run(ctx, name) {
        const r = await ctx.clients.eks.send(new StartInsightsRefreshCommand({ clusterName: name }));
        return { message: `Insights refresh is ${r.status ?? "started"}.` };
      },
    },
    ...fargateActions,
    manageTagsAction(async (ctx, name) => (await describeCluster(ctx, name)).arn ?? ""),
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.eks.send(new DeleteClusterCommand({ name }));
    },
  },
};
