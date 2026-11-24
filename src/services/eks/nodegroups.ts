/** EKS managed node groups. Ids are "<cluster>/<node group>"; the cluster's Compute tab links here. */

import {
  CreateNodegroupCommand,
  DeleteNodegroupCommand,
  DescribeNodegroupCommand,
  ListNodegroupsCommand,
  UpdateNodegroupConfigCommand,
  UpdateNodegroupVersionCommand,
  type AMITypes,
  type CapacityTypes,
  type Nodegroup,
  type TaintEffect,
} from "@aws-sdk/client-eks";
import type { Ctx, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { csv, joinId, recordToRows, splitId, tagsToRecord } from "./helpers.ts";
import { clusterNames, clusterOptions, roleOptions, subnetOptions } from "./lookups.ts";
import { manageTagsAction } from "./tagging.ts";
import { tagsTab, tolerantTab, updateTab } from "./updates.ts";

const NAME = "[0-9A-Za-z][A-Za-z0-9_-]{0,62}";

const AMI_TYPES: Option[] = [
  { value: "AL2023_x86_64_STANDARD", label: "Amazon Linux 2023 (AL2023_x86_64_STANDARD)" },
  { value: "AL2023_ARM_64_STANDARD", label: "Amazon Linux 2023 Arm (AL2023_ARM_64_STANDARD)" },
  { value: "AL2023_x86_64_NVIDIA", label: "Amazon Linux 2023 NVIDIA (AL2023_x86_64_NVIDIA)" },
  { value: "BOTTLEROCKET_x86_64", label: "Bottlerocket (BOTTLEROCKET_x86_64)" },
  { value: "BOTTLEROCKET_ARM_64", label: "Bottlerocket Arm (BOTTLEROCKET_ARM_64)" },
  { value: "WINDOWS_CORE_2022_x86_64", label: "Windows Server 2022 Core (WINDOWS_CORE_2022_x86_64)" },
];

const TAINT_EFFECTS: Option[] = [
  { value: "NO_SCHEDULE", label: "NoSchedule" },
  { value: "NO_EXECUTE", label: "NoExecute" },
  { value: "PREFER_NO_SCHEDULE", label: "PreferNoSchedule" },
];

export async function nodegroupNames(ctx: Ctx, cluster: string): Promise<string[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.eks.send(new ListNodegroupsCommand({ clusterName: cluster, nextToken: token, maxResults: 100 }));
    names.push(...(r.nodegroups ?? []));
    token = r.nextToken;
  } while (token);
  return names;
}

async function describe(ctx: Ctx, cluster: string, name: string): Promise<Nodegroup> {
  const ng = (await ctx.clients.eks.send(new DescribeNodegroupCommand({ clusterName: cluster, nodegroupName: name }))).nodegroup;
  if (!ng) throw new Error(`EKS returned no node group ${name} in cluster ${cluster}.`);
  return ng;
}

function row(ng: Nodegroup): Row {
  const cluster = ng.clusterName ?? "";
  const name = ng.nodegroupName ?? "";
  return {
    id: joinId(cluster, name),
    name,
    cluster,
    status: ng.status ?? null,
    desiredSize: ng.scalingConfig?.desiredSize ?? null,
    minSize: ng.scalingConfig?.minSize ?? null,
    maxSize: ng.scalingConfig?.maxSize ?? null,
    amiType: ng.amiType ?? null,
    instanceTypes: ng.instanceTypes?.join(", ") || null,
    version: ng.version ?? null,
    capacityType: ng.capacityType ?? null,
    createdAt: ng.createdAt ?? null,
    arn: ng.nodegroupArn ?? null,
  };
}

/** Node group rows for one cluster (used by the cluster's Compute tab too). */
export async function nodegroupRows(ctx: Ctx, cluster: string): Promise<Row[]> {
  const names = await nodegroupNames(ctx, cluster);
  return Promise.all(names.map(async (n) => row(await describe(ctx, cluster, n))));
}

function labelsAndTaints(v: FieldValues) {
  const labels = tagsToRecord(v.labels);
  const taint = typeof v.taintKey === "string" && v.taintKey !== "" ? [{ key: v.taintKey, value: typeof v.taintValue === "string" && v.taintValue ? v.taintValue : undefined, effect: ((typeof v.taintEffect === "string" && v.taintEffect) || "NO_SCHEDULE") as TaintEffect }] : [];
  return { labels, taint };
}

const NODEGROUP_COLUMNS = [
  { key: "name", label: "Group name", kind: "link" as const },
  { key: "cluster", label: "Cluster", kind: "text" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "desiredSize", label: "Desired size", kind: "count" as const },
  { key: "amiType", label: "AMI type", kind: "text" as const },
  { key: "instanceTypes", label: "Instance types", kind: "text" as const },
  { key: "version", label: "Kubernetes version", kind: "text" as const },
  { key: "capacityType", label: "Capacity type", kind: "text" as const },
  { key: "createdAt", label: "Created", kind: "date" as const, hidden: true },
];

export { NODEGROUP_COLUMNS };

export const nodegroups: ResourceDef = {
  id: "node-groups",
  name: "Node groups (all clusters)",
  singular: "node group",
  idField: "id",
  nameField: "name",
  description: "Managed node groups: EC2 instances (in an Auto Scaling group) that run your pods. In the AWS console they are on each cluster's Compute tab.",
  emptyText: "No node groups. Add one to a cluster to run pods on EC2.",
  columns: NODEGROUP_COLUMNS,

  async list(ctx) {
    const clusters = await clusterNames(ctx);
    return (await Promise.all(clusters.map((c) => nodegroupRows(ctx, c)))).flat();
  },

  async get(ctx, id) {
    const { cluster, child } = splitId(id);
    const ng = await describe(ctx, cluster, child);
    const r = row(ng);
    return {
      summary: {
        name: r.name,
        cluster: r.cluster,
        status: r.status,
        version: r.version,
        releaseVersion: ng.releaseVersion ?? null,
        amiType: r.amiType,
        capacityType: r.capacityType,
        nodeRole: ng.nodeRole ?? null,
        arn: r.arn,
      },
      summaryLabels: {
        name: "Node group name", cluster: "Cluster", status: "Status", version: "Kubernetes version", releaseVersion: "AMI release version",
        amiType: "AMI type", capacityType: "Capacity type", nodeRole: "Node IAM role ARN", arn: "Node group ARN",
      },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            "Desired size": r.desiredSize,
            "Minimum size": r.minSize,
            "Maximum size": r.maxSize,
            "Maximum unavailable": ng.updateConfig?.maxUnavailable ?? (ng.updateConfig?.maxUnavailablePercentage !== undefined ? `${ng.updateConfig.maxUnavailablePercentage}%` : null),
            "Instance types": r.instanceTypes,
            "Disk size (GiB)": ng.diskSize ?? null,
            Subnets: ng.subnets?.join(", ") || null,
            "Launch template": ng.launchTemplate?.name ?? ng.launchTemplate?.id ?? "None",
            "Remote access (SSH key)": ng.remoteAccess?.ec2SshKey ?? "Off",
            "Auto Scaling groups": ng.resources?.autoScalingGroups?.map((g) => g.name ?? "").join(", ") || null,
            Created: ng.createdAt ?? null,
            Modified: ng.modifiedAt ?? null,
          },
        },
        {
          id: "health",
          label: "Health issues",
          kind: "table",
          columns: [
            { key: "code", label: "Issue type", kind: "text" },
            { key: "message", label: "Description", kind: "text" },
            { key: "resourceIds", label: "Affected resources", kind: "text" },
          ],
          data: (ng.health?.issues ?? []).map((i) => ({ code: i.code ?? null, message: i.message ?? null, resourceIds: i.resourceIds?.join(", ") ?? null })),
          emptyText: "No health issues.",
        },
        {
          id: "labels",
          label: "Kubernetes labels",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: recordToRows(ng.labels),
          emptyText: "No Kubernetes labels.",
        },
        {
          id: "taints",
          label: "Kubernetes taints",
          kind: "table",
          columns: [
            { key: "key", label: "Key", kind: "text" },
            { key: "value", label: "Value", kind: "text" },
            { key: "effect", label: "Effect", kind: "text" },
          ],
          data: (ng.taints ?? []).map((t) => ({ key: t.key ?? null, value: t.value ?? null, effect: t.effect ?? null })),
          emptyText: "No Kubernetes taints.",
        },
        await tolerantTab(() => updateTab(ctx, cluster, { nodegroupName: child }), { id: "updates", label: "Update history" }),
        tagsTab(ng.tags, "This node group has no tags."),
      ],
    };
  },

  create: {
    title: "Add node group",
    description: "Creates a managed node group with CreateNodegroup.",
    fields: [
      { name: "cluster", label: "Cluster", kind: "select", required: true, options: clusterOptions, section: "Node group configuration" },
      {
        name: "name", label: "Name", kind: "text", required: true, section: "Node group configuration", placeholder: "my-nodes",
        help: "Up to 63 letters, numbers, hyphens and underscores. Unique within the cluster.",
        validate: { pattern: NAME, message: "Start with a letter or number; up to 63 letters, numbers, hyphens or underscores." },
      },
      { name: "nodeRole", label: "Node IAM role", kind: "select", required: true, options: roleOptions, section: "Node group configuration", help: "Needs AmazonEKSWorkerNodePolicy, AmazonEC2ContainerRegistryReadOnly and AmazonEKS_CNI_Policy." },
      { name: "labels", label: "Kubernetes labels", kind: "tags", section: "Kubernetes labels" },
      { name: "taintKey", label: "Taint key", kind: "text", section: "Kubernetes taints", help: "Pods without a matching toleration won't be scheduled on these nodes." },
      { name: "taintValue", label: "Taint value", kind: "text", section: "Kubernetes taints" },
      { name: "taintEffect", label: "Taint effect", kind: "select", required: true, default: "NO_SCHEDULE", options: TAINT_EFFECTS, section: "Kubernetes taints" },
      { name: "amiType", label: "AMI type", kind: "select", default: "AL2023_x86_64_STANDARD", options: AMI_TYPES, section: "Node group compute configuration", help: "Leave empty to let EKS choose the AMI type for the cluster's version." },
      {
        name: "capacityType", label: "Capacity type", kind: "radio", default: "ON_DEMAND", section: "Node group compute configuration",
        options: [{ value: "ON_DEMAND", label: "On-Demand" }, { value: "SPOT", label: "Spot" }],
      },
      { name: "instanceTypes", label: "Instance types", kind: "text", default: "t3.medium", section: "Node group compute configuration", help: "Comma-separated, e.g. t3.medium, t3.large. Spot node groups work best with several types." },
      { name: "diskSize", label: "Disk size (GiB)", kind: "number", default: 20, section: "Node group compute configuration", validate: { min: 1, max: 16384, message: "Between 1 and 16384 GiB." } },
      { name: "desiredSize", label: "Desired size", kind: "number", default: 2, section: "Node group scaling configuration", validate: { min: 0, max: 1000, message: "Between 0 and 1000." } },
      { name: "minSize", label: "Minimum size", kind: "number", default: 2, section: "Node group scaling configuration", validate: { min: 0, max: 1000, message: "Between 0 and 1000." } },
      { name: "maxSize", label: "Maximum size", kind: "number", default: 2, section: "Node group scaling configuration", validate: { min: 1, max: 1000, message: "Between 1 and 1000." } },
      { name: "maxUnavailable", label: "Maximum unavailable (nodes)", kind: "number", default: 1, section: "Node group update configuration", help: "How many nodes can be updated at once.", validate: { min: 1, max: 100, message: "Between 1 and 100." } },
      { name: "subnets", label: "Subnets", kind: "multiselect", required: true, options: subnetOptions, section: "Node group network configuration", help: "Subnets in the cluster's VPC (subnet | VPC | AZ | CIDR)." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const cluster = String(v.cluster);
      const name = String(v.name);
      const { labels, taint } = labelsAndTaints(v);
      const tags = tagsToRecord(v.tags);
      const num = (x: unknown, d: number) => (typeof x === "number" ? x : d);
      await ctx.clients.eks.send(
        new CreateNodegroupCommand({
          clusterName: cluster,
          nodegroupName: name,
          nodeRole: String(v.nodeRole),
          subnets: Array.isArray(v.subnets) ? (v.subnets as string[]) : [],
          scalingConfig: { desiredSize: num(v.desiredSize, 2), minSize: num(v.minSize, 2), maxSize: num(v.maxSize, 2) },
          updateConfig: { maxUnavailable: num(v.maxUnavailable, 1) },
          instanceTypes: csv(v.instanceTypes).length ? csv(v.instanceTypes) : undefined,
          amiType: typeof v.amiType === "string" && v.amiType ? (v.amiType as AMITypes) : undefined,
          capacityType: String(v.capacityType) as CapacityTypes,
          diskSize: typeof v.diskSize === "number" ? v.diskSize : undefined,
          labels: Object.keys(labels).length ? labels : undefined,
          taints: taint.length ? taint : undefined,
          tags: Object.keys(tags).length ? tags : undefined,
        })
      );
      return joinId(cluster, name);
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit node group",
      fields: [
        { name: "desiredSize", label: "Desired size", kind: "number", required: true, validate: { min: 0, max: 1000, message: "Between 0 and 1000." } },
        { name: "minSize", label: "Minimum size", kind: "number", required: true, validate: { min: 0, max: 1000, message: "Between 0 and 1000." } },
        { name: "maxSize", label: "Maximum size", kind: "number", required: true, validate: { min: 1, max: 1000, message: "Between 1 and 1000." } },
        { name: "maxUnavailable", label: "Maximum unavailable (nodes)", kind: "number", validate: { min: 1, max: 100, message: "Between 1 and 100." } },
      ],
      async initialValues(ctx, id) {
        const { cluster, child } = splitId(id);
        const ng = await describe(ctx, cluster, child);
        return {
          desiredSize: ng.scalingConfig?.desiredSize ?? null,
          minSize: ng.scalingConfig?.minSize ?? null,
          maxSize: ng.scalingConfig?.maxSize ?? null,
          maxUnavailable: ng.updateConfig?.maxUnavailable ?? null,
        };
      },
      async run(ctx, id, v) {
        const { cluster, child } = splitId(id);
        const ng = await describe(ctx, cluster, child);
        const sc = ng.scalingConfig ?? {};
        const sameScaling = sc.desiredSize === Number(v.desiredSize) && sc.minSize === Number(v.minSize) && sc.maxSize === Number(v.maxSize);
        const sameUpdate = typeof v.maxUnavailable !== "number" || ng.updateConfig?.maxUnavailable === v.maxUnavailable;
        if (sameScaling && sameUpdate) return { message: "No changes to save." };
        const r = await ctx.clients.eks.send(
          new UpdateNodegroupConfigCommand({
            clusterName: cluster,
            nodegroupName: child,
            scalingConfig: sameScaling ? undefined : { desiredSize: Number(v.desiredSize), minSize: Number(v.minSize), maxSize: Number(v.maxSize) },
            updateConfig: sameUpdate ? undefined : { maxUnavailable: v.maxUnavailable as number },
          })
        );
        return { message: `Update ${r.update?.id ?? ""} (${r.update?.type ?? "ConfigUpdate"}) is ${r.update?.status ?? "submitted"}.` };
      },
    },
    {
      id: "labels",
      label: "Edit Kubernetes labels and taints",
      fields: [
        { name: "labels", label: "Add or update labels", kind: "tags" },
        { name: "removeLabels", label: "Remove labels", kind: "text", help: "Comma-separated label keys to remove." },
        { name: "taintKey", label: "Add or update taint: key", kind: "text" },
        { name: "taintValue", label: "Taint value", kind: "text" },
        { name: "taintEffect", label: "Taint effect", kind: "select", required: true, default: "NO_SCHEDULE", options: TAINT_EFFECTS },
      ],
      async run(ctx, id, v) {
        const { cluster, child } = splitId(id);
        const { labels, taint } = labelsAndTaints(v);
        const remove = csv(v.removeLabels);
        if (!Object.keys(labels).length && !remove.length && !taint.length) throw new Error("Nothing to change: add a label, a label key to remove, or a taint.");
        const r = await ctx.clients.eks.send(
          new UpdateNodegroupConfigCommand({
            clusterName: cluster,
            nodegroupName: child,
            labels: Object.keys(labels).length || remove.length ? { addOrUpdateLabels: Object.keys(labels).length ? labels : undefined, removeLabels: remove.length ? remove : undefined } : undefined,
            taints: taint.length ? { addOrUpdateTaints: taint } : undefined,
          })
        );
        return { message: `Update ${r.update?.id ?? ""} (${r.update?.type ?? "ConfigUpdate"}) is ${r.update?.status ?? "submitted"}.` };
      },
    },
    {
      id: "upgrade",
      label: "Update version",
      confirm: "Updates the node group to the cluster's Kubernetes version and the latest AMI release version.",
      async run(ctx, id) {
        const { cluster, child } = splitId(id);
        const r = await ctx.clients.eks.send(new UpdateNodegroupVersionCommand({ clusterName: cluster, nodegroupName: child }));
        return { message: `Version update ${r.update?.id ?? ""} is ${r.update?.status ?? "submitted"}.` };
      },
    },
    manageTagsAction(async (ctx, id) => {
      const { cluster, child } = splitId(id);
      return (await describe(ctx, cluster, child)).nodegroupArn ?? "";
    }),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { cluster, child } = splitId(id);
      await ctx.clients.eks.send(new DeleteNodegroupCommand({ clusterName: cluster, nodegroupName: child }));
    },
  },
};
