/**
 * EC2 Instances: list, detail tabs (details, security, networking, storage, status checks,
 * monitoring, tags) and the Instance state / Actions menu. Launching uses the hand-built
 * wizard at /ec2/instances/create (src/app/ec2/instances/create).
 */

import {
  AssociateIamInstanceProfileCommand,
  DescribeAddressesCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  DescribeImagesCommand,
  DescribeInstanceAttributeCommand,
  DescribeInstanceStatusCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeVolumesCommand,
  DisassociateIamInstanceProfileCommand,
  GetConsoleOutputCommand,
  ModifyInstanceAttributeCommand,
  ModifyInstanceMetadataOptionsCommand,
  MonitorInstancesCommand,
  RebootInstancesCommand,
  ReplaceIamInstanceProfileAssociationCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  UnmonitorInstancesCommand,
  type Instance,
  type InstanceStatus,
  type SecurityGroupRule,
} from "@aws-sdk/client-ec2";
import { GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import type { ActionDef, Ctx, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import { decodeUserData, defaultLoginUser, errorText, nameTag, ruleRow, sshHint, stateIn, statusCheckSummary, strList, tagRows } from "./helpers.ts";
import { ec2TagAction } from "./tag-action.ts";
import { launchInstances, VOLUME_TYPES } from "./launch.ts";
import { allInstances, instanceProfileOptions, instanceTypeOptions, keyPairOptions, oneInstance, securityGroupOptions, subnetOptions } from "./options.ts";

const RULE_COLUMNS = [
  { key: "direction", label: "Direction", kind: "text" as const },
  { key: "groupId", label: "Security group ID", kind: "text" as const },
  { key: "ruleId", label: "Security group rule ID", kind: "text" as const },
  { key: "type", label: "Type", kind: "text" as const },
  { key: "protocol", label: "Protocol", kind: "text" as const },
  { key: "portRange", label: "Port range", kind: "text" as const },
  { key: "source", label: "Source / destination", kind: "text" as const },
  { key: "description", label: "Description", kind: "text" as const },
];

async function statusMap(ctx: Ctx, ids?: string[]): Promise<Map<string, InstanceStatus>> {
  const map = new Map<string, InstanceStatus>();
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeInstanceStatusCommand({ IncludeAllInstances: true, InstanceIds: ids, NextToken: token }));
    for (const s of r.InstanceStatuses ?? []) if (s.InstanceId) map.set(s.InstanceId, s);
    token = r.NextToken;
  } while (token);
  return map;
}

function checkText(s: InstanceStatus | undefined, state: string | undefined): string | null {
  if (state !== "running") return null;
  return statusCheckSummary(s?.InstanceStatus?.Status, s?.SystemStatus?.Status, s?.AttachedEbsStatus?.Status);
}

/** A secondary lookup's result, or the error that made it unavailable. */
type Lookup<T> = { ok: true; value: T } | { ok: false; error: string };

async function tolerant<T>(p: Promise<T>): Promise<Lookup<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err: unknown) {
    return { ok: false, error: errorText(err) };
  }
}

const unavailable = (error: string) => `Unavailable: ${error.split("\n")[0].slice(0, 160)}`;

function instanceRow(i: Instance, statuses: Lookup<Map<string, InstanceStatus>>, eips: Lookup<Map<string, string>>): Row {
  const id = i.InstanceId ?? "";
  return {
    name: nameTag(i.Tags),
    instanceId: id,
    state: i.State?.Name ?? null,
    instanceType: i.InstanceType ?? null,
    statusCheck: statuses.ok ? checkText(statuses.value.get(id), i.State?.Name) : unavailable(statuses.error),
    az: i.Placement?.AvailabilityZone ?? null,
    publicDns: i.PublicDnsName || null,
    publicIp: i.PublicIpAddress ?? null,
    elasticIp: eips.ok ? eips.value.get(id) ?? null : unavailable(eips.error),
    monitoring: i.Monitoring?.State ?? null,
    securityGroups: (i.SecurityGroups ?? []).map((g) => g.GroupName).filter(Boolean).join(", ") || null,
    keyName: i.KeyName ?? null,
    launchTime: i.LaunchTime ?? null,
    platform: i.PlatformDetails ?? null,
    privateIp: i.PrivateIpAddress ?? null,
    vpcId: i.VpcId ?? null,
    subnetId: i.SubnetId ?? null,
  };
}

async function elasticIpsByInstance(ctx: Ctx): Promise<Map<string, string>> {
  const r = await ctx.clients.ec2.send(new DescribeAddressesCommand({}));
  return new Map((r.Addresses ?? []).filter((a) => a.InstanceId && a.PublicIp).map((a) => [a.InstanceId as string, a.PublicIp as string]));
}

async function attribute(ctx: Ctx, id: string, name: "userData" | "disableApiTermination" | "disableApiStop") {
  try {
    return await ctx.clients.ec2.send(new DescribeInstanceAttributeCommand({ InstanceId: id, Attribute: name }));
  } catch {
    return null;
  }
}

const METRICS: { name: string; label: string; stat: "Average" | "Sum" }[] = [
  { name: "CPUUtilization", label: "CPU utilization (%)", stat: "Average" },
  { name: "NetworkIn", label: "Network in (bytes)", stat: "Sum" },
  { name: "NetworkOut", label: "Network out (bytes)", stat: "Sum" },
  { name: "StatusCheckFailed", label: "Status check failed (any)", stat: "Sum" },
  { name: "EBSReadBytes", label: "EBS read bytes", stat: "Sum" },
  { name: "EBSWriteBytes", label: "EBS write bytes", stat: "Sum" },
];

/** The last 3 hours of AWS/EC2 metrics, one row per 5-minute period CloudWatch returned. */
async function monitoringRows(ctx: Ctx, id: string): Promise<{ rows: Row[]; error: string | null }> {
  const end = new Date();
  const start = new Date(end.getTime() - 3 * 3600 * 1000);
  const byTime = new Map<string, Row>();
  try {
    const results = await Promise.all(
      METRICS.map((m) =>
        ctx.clients.cloudwatch.send(
          new GetMetricStatisticsCommand({ Namespace: "AWS/EC2", MetricName: m.name, Dimensions: [{ Name: "InstanceId", Value: id }], StartTime: start, EndTime: end, Period: 300, Statistics: [m.stat] })
        )
      )
    );
    results.forEach((r, idx) => {
      const m = METRICS[idx];
      for (const d of r.Datapoints ?? []) {
        if (!d.Timestamp) continue;
        const key = d.Timestamp.toISOString();
        const row = byTime.get(key) ?? { time: key };
        const v = m.stat === "Average" ? d.Average : d.Sum;
        byTime.set(key, { ...row, [m.name]: typeof v === "number" ? Math.round(v * 100) / 100 : null });
      }
    });
  } catch (err: unknown) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
  return { rows: [...byTime.values()].sort((a, b) => String(b.time).localeCompare(String(a.time))), error: null };
}

async function getInstance(ctx: Ctx, id: string) {
  const ec2 = ctx.clients.ec2;
  const i = await oneInstance(ctx, id);
  const groupIds = (i.SecurityGroups ?? []).map((g) => g.GroupId).filter((g): g is string => Boolean(g));
  const volumeIds = (i.BlockDeviceMappings ?? []).map((b) => b.Ebs?.VolumeId).filter((v): v is string => Boolean(v));
  const [statuses, rules, volumes, userData, protection, image, monitoring] = await Promise.all([
    tolerant(statusMap(ctx, [id])),
    tolerant<{ SecurityGroupRules?: SecurityGroupRule[] }>(groupIds.length ? ec2.send(new DescribeSecurityGroupRulesCommand({ Filters: [{ Name: "group-id", Values: groupIds }] })) : Promise.resolve({ SecurityGroupRules: [] })),
    volumeIds.length ? ec2.send(new DescribeVolumesCommand({ VolumeIds: volumeIds })).catch(() => ({ Volumes: [] })) : Promise.resolve({ Volumes: [] }),
    attribute(ctx, id, "userData"),
    attribute(ctx, id, "disableApiTermination"),
    i.ImageId ? ec2.send(new DescribeImagesCommand({ ImageIds: [i.ImageId] })).then((r) => r.Images?.[0] ?? null).catch(() => null) : Promise.resolve(null),
    monitoringRows(ctx, id),
  ]);
  return {
    i,
    status: statuses.ok ? statuses.value.get(id) : undefined,
    statusError: statuses.ok ? null : statuses.error,
    rules: rules.ok ? rules.value.SecurityGroupRules ?? [] : [],
    rulesError: rules.ok ? null : rules.error,
    volumes: volumes.Volumes ?? [], userData, protection, image, monitoring };
}

const STOPPED = ["stopped"];
const NOT_GONE = ["pending", "running", "stopping", "stopped"];

function stateMessage(verb: string, changes: { InstanceId?: string; PreviousState?: { Name?: string }; CurrentState?: { Name?: string } }[] | undefined): string {
  const c = changes?.[0];
  return c ? `${verb} ${c.InstanceId}: ${c.PreviousState?.Name ?? "?"} → ${c.CurrentState?.Name ?? "?"}.` : `${verb} request sent.`;
}

/** Security groups in the instance's VPC (the only ones ModifyInstanceAttribute accepts). */
async function instanceVpcGroupOptions(ctx: Ctx, id?: string) {
  const all = await securityGroupOptions(ctx);
  if (!id) return all;
  const vpc = (await oneInstance(ctx, id)).VpcId;
  return vpc ? all.filter((o) => o.label.endsWith(` - ${vpc}`)) : all;
}

const actions: ActionDef[] = [
  {
    id: "start",
    label: "Start instance",
    availableFor: (row) => stateIn(row, STOPPED),
    async run(ctx, id) {
      const r = await ctx.clients.ec2.send(new StartInstancesCommand({ InstanceIds: [id] }));
      return { message: stateMessage("Starting", r.StartingInstances) };
    },
  },
  {
    id: "stop",
    label: "Stop instance",
    availableFor: (row) => stateIn(row, ["pending", "running"]),
    confirm: "Stopping the instance shuts it down. Data on instance store volumes is lost; EBS volumes are kept. A public IPv4 address that is not an Elastic IP is released.",
    fields: [{ name: "force", label: "Force stop", kind: "checkbox", default: false, help: "Skips the graceful OS shutdown. Use only if a normal stop is stuck." }],
    async run(ctx, id, v) {
      const r = await ctx.clients.ec2.send(new StopInstancesCommand({ InstanceIds: [id], Force: v.force === true }));
      return { message: stateMessage("Stopping", r.StoppingInstances) };
    },
  },
  {
    id: "reboot",
    label: "Reboot instance",
    availableFor: (row) => stateIn(row, ["running"]),
    confirm: "Rebooting restarts the operating system. The instance keeps its public DNS name and IP addresses.",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new RebootInstancesCommand({ InstanceIds: [id] }));
      return { message: `Reboot requested for ${id}.` };
    },
  },
  {
    id: "terminate",
    label: "Terminate (delete) instance",
    danger: true,
    availableFor: (row) => stateIn(row, NOT_GONE),
    confirm: "Terminating deletes the instance. EBS volumes with Delete on termination set are deleted with it. This can't be undone.",
    async run(ctx, id) {
      const r = await ctx.clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: [id] }));
      return { message: stateMessage("Terminating", r.TerminatingInstances) };
    },
  },
  {
    id: "connect",
    label: "Connect",
    runOnOpen: true,
    availableFor: (row) => stateIn(row, NOT_GONE),
    async run(ctx, id) {
      const i = await oneInstance(ctx, id);
      const img = i.ImageId ? (await ctx.clients.ec2.send(new DescribeImagesCommand({ ImageIds: [i.ImageId] })).catch(() => null))?.Images?.[0] : undefined;
      const user = img ? defaultLoginUser(img) : null;
      const host = i.PublicDnsName || i.PublicIpAddress;
      const rows: Row[] = [
        { item: "Instance state", value: i.State?.Name ?? "-" },
        { item: "Public DNS", value: i.PublicDnsName || "-" },
        { item: "Public IPv4 address", value: i.PublicIpAddress ?? "-" },
        { item: "Private IPv4 address", value: i.PrivateIpAddress ?? "-" },
        { item: "Key pair", value: i.KeyName ?? "None (you will need another way to sign in)" },
        { item: "AMI", value: img?.Name ?? i.ImageId ?? "-" },
      ];
      if (i.PlatformDetails?.toLowerCase().startsWith("windows")) rows.push({ item: "RDP client", value: `Connect to ${host ?? "the instance"} on port 3389 and use Get Windows password with key pair ${i.KeyName ?? "(none)"}.` });
      else rows.push({ item: "SSH client", value: sshHint(host, i.KeyName, user) });
      return {
        message: "Connect using an SSH client: open a terminal, make sure your private key is readable only by you (chmod 400), then run the command below. These values come from DescribeInstances; AWS Emulator does not run a real guest OS to sign in to.",
        table: { rowKey: "item", columns: [{ key: "item", label: "", kind: "text" }, { key: "value", label: "Value", kind: "code" }], rows },
      };
    },
  },
  {
    id: "change-type",
    label: "Change instance type",
    fields: [{ name: "instanceType", label: "New instance type", kind: "select", required: true, options: instanceTypeOptions, help: "The instance must be stopped to change its type." }],
    availableFor: (row) => stateIn(row, STOPPED),
    async initialValues(ctx, id) {
      return { instanceType: (await oneInstance(ctx, id)).InstanceType ?? "" };
    },
    async run(ctx, id, v) {
      if ((await oneInstance(ctx, id)).InstanceType === v.instanceType) return { message: `The instance type is already ${v.instanceType}; nothing changed.` };
      await ctx.clients.ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: id, InstanceType: { Value: String(v.instanceType) } }));
      return { message: `Instance type changed to ${v.instanceType}.` };
    },
  },
  {
    id: "security-groups",
    label: "Change security groups",
    fields: [{ name: "groups", label: "Associated security groups", kind: "multiselect", required: true, options: instanceVpcGroupOptions, help: "Replaces all security groups on the primary network interface. Only groups in the instance's VPC are listed." }],
    availableFor: (row) => stateIn(row, NOT_GONE),
    async initialValues(ctx, id) {
      return { groups: ((await oneInstance(ctx, id)).SecurityGroups ?? []).map((g) => g.GroupId).filter((g): g is string => Boolean(g)) };
    },
    async run(ctx, id, v) {
      const groups = strList(v.groups);
      await ctx.clients.ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: id, Groups: groups }));
      return { message: `Security groups set to ${groups.join(", ")}.` };
    },
  },
  {
    id: "iam-role",
    label: "Modify IAM role",
    fields: [{ name: "profile", label: "IAM role (instance profile)", kind: "select", default: "", options: instanceProfileOptions, help: "Choose No IAM role (-) to detach the current role." }],
    availableFor: (row) => stateIn(row, NOT_GONE),
    async initialValues(ctx, id) {
      return { profile: (await oneInstance(ctx, id)).IamInstanceProfile?.Arn?.split("/").pop() ?? "" };
    },
    async run(ctx, id, v) {
      const ec2 = ctx.clients.ec2;
      const assoc = (await ec2.send(new DescribeIamInstanceProfileAssociationsCommand({ Filters: [{ Name: "instance-id", Values: [id] }] }))).IamInstanceProfileAssociations?.find((a) => a.State === "associated" || a.State === "associating");
      const profile = typeof v.profile === "string" && v.profile ? v.profile : null;
      if (!profile) {
        if (!assoc?.AssociationId) return { message: "The instance has no IAM role; nothing to detach." };
        await ec2.send(new DisassociateIamInstanceProfileCommand({ AssociationId: assoc.AssociationId }));
        return { message: "IAM role detached." };
      }
      const currentName = assoc?.IamInstanceProfile?.Arn?.split("/").pop();
      if (currentName === profile) return { message: `IAM role ${profile} is already attached; nothing changed.` };
      if (assoc?.AssociationId) await ec2.send(new ReplaceIamInstanceProfileAssociationCommand({ AssociationId: assoc.AssociationId, IamInstanceProfile: { Name: profile } }));
      else await ec2.send(new AssociateIamInstanceProfileCommand({ InstanceId: id, IamInstanceProfile: { Name: profile } }));
      return { message: `IAM role ${profile} attached.` };
    },
  },
  {
    id: "console-output",
    label: "Get system log",
    async run(ctx, id) {
      const r = await ctx.clients.ec2.send(new GetConsoleOutputCommand({ InstanceId: id, Latest: true }));
      const text = decodeUserData(r.Output) ?? "";
      const lines = text.split("\n").map((line, n) => ({ n: n + 1, line }));
      return {
        message: `System log for ${id}${r.Timestamp ? ` as of ${r.Timestamp.toISOString()}` : ""}.`,
        table: { rowKey: "n", columns: [{ key: "line", label: "Output", kind: "code" }], rows: lines.filter((l) => l.line !== "" || l.n < lines.length), emptyText: "The instance has no console output yet." },
      };
    },
  },
  ec2TagAction("instance", async (ctx, id) => (await oneInstance(ctx, id)).Tags),
  {
    id: "termination-protection",
    label: "Change termination protection",
    fields: [{ name: "enabled", label: "Termination protection: Enable", kind: "checkbox", default: false, help: "Prevents the instance from being terminated through the console, CLI or API." }],
    availableFor: (row) => stateIn(row, NOT_GONE),
    async initialValues(ctx, id) {
      const r = await ctx.clients.ec2.send(new DescribeInstanceAttributeCommand({ InstanceId: id, Attribute: "disableApiTermination" }));
      return { enabled: r.DisableApiTermination?.Value === true };
    },
    async run(ctx, id, v) {
      await ctx.clients.ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: id, DisableApiTermination: { Value: v.enabled === true } }));
      return { message: `Termination protection ${v.enabled === true ? "enabled" : "disabled"}.` };
    },
  },
  {
    id: "metadata",
    label: "Modify instance metadata options",
    fields: [
      { name: "endpoint", label: "Instance metadata service", kind: "radio", default: "enabled", options: [{ value: "enabled", label: "Enable" }, { value: "disabled", label: "Disable" }] },
      { name: "tokens", label: "IMDSv2", kind: "radio", default: "required", options: [{ value: "optional", label: "Optional" }, { value: "required", label: "Required" }], help: "Required means only session tokens (IMDSv2) are accepted." },
      { name: "hopLimit", label: "Metadata response hop limit", kind: "number", default: 2, validate: { min: 1, max: 64, message: "Between 1 and 64." } },
      { name: "tagsAccess", label: "Allow tags in instance metadata", kind: "checkbox", default: false },
    ],
    availableFor: (row) => stateIn(row, NOT_GONE),
    async initialValues(ctx, id) {
      const m = (await oneInstance(ctx, id)).MetadataOptions;
      return {
        endpoint: m?.HttpEndpoint === "disabled" ? "disabled" : "enabled",
        tokens: m?.HttpTokens === "optional" ? "optional" : "required",
        hopLimit: typeof m?.HttpPutResponseHopLimit === "number" ? m.HttpPutResponseHopLimit : null,
        tagsAccess: m?.InstanceMetadataTags === "enabled",
      };
    },
    async run(ctx, id, v) {
      const r = await ctx.clients.ec2.send(
        new ModifyInstanceMetadataOptionsCommand({
          InstanceId: id,
          HttpEndpoint: v.endpoint === "disabled" ? "disabled" : "enabled",
          HttpTokens: v.tokens === "optional" ? "optional" : "required",
          HttpPutResponseHopLimit: typeof v.hopLimit === "number" ? v.hopLimit : undefined,
          InstanceMetadataTags: v.tagsAccess === true ? "enabled" : "disabled",
        })
      );
      return { message: "Instance metadata options saved.", json: r.InstanceMetadataOptions };
    },
  },
  {
    id: "monitoring",
    label: "Manage detailed monitoring",
    fields: [{ name: "enabled", label: "Detailed monitoring: Enable", kind: "checkbox", default: false, help: "Sends metrics to CloudWatch every minute instead of every 5 minutes." }],
    availableFor: (row) => stateIn(row, NOT_GONE),
    async initialValues(ctx, id) {
      const state = (await oneInstance(ctx, id)).Monitoring?.State;
      return { enabled: state === "enabled" || state === "pending" };
    },
    async run(ctx, id, v) {
      const r = v.enabled === true ? await ctx.clients.ec2.send(new MonitorInstancesCommand({ InstanceIds: [id] })) : await ctx.clients.ec2.send(new UnmonitorInstancesCommand({ InstanceIds: [id] }));
      return { message: `Detailed monitoring: ${r.InstanceMonitorings?.[0]?.Monitoring?.State ?? "requested"}.` };
    },
  },
  {
    id: "user-data",
    label: "Edit user data",
    fields: [{ name: "userData", label: "User data", kind: "textarea", help: "The instance must be stopped. Enter the script as text; it is base64-encoded for you." }],
    availableFor: (row) => stateIn(row, STOPPED),
    async initialValues(ctx, id) {
      const r = await ctx.clients.ec2.send(new DescribeInstanceAttributeCommand({ InstanceId: id, Attribute: "userData" }));
      return { userData: decodeUserData(r.UserData?.Value) ?? "" };
    },
    async run(ctx, id, v) {
      const text = typeof v.userData === "string" ? v.userData : "";
      const current = await ctx.clients.ec2.send(new DescribeInstanceAttributeCommand({ InstanceId: id, Attribute: "userData" }));
      if ((decodeUserData(current.UserData?.Value) ?? "") === text) return { message: "User data unchanged; nothing saved." };
      await ctx.clients.ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: id, UserData: { Value: new TextEncoder().encode(text) } }));
      return { message: text ? "User data saved." : "User data cleared." };
    },
  },
];

export const instances: ResourceDef = {
  id: "instances",
  name: "Instances",
  singular: "instance",
  idField: "instanceId",
  nameField: "Name",
  description: "Virtual servers in the cloud. Terminated instances stay visible for a while, as in the console.",
  emptyText: "You do not have any instances in this region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "instanceId", label: "Instance ID", kind: "link" },
    { key: "state", label: "Instance state", kind: "status" },
    { key: "instanceType", label: "Instance type", kind: "text" },
    { key: "statusCheck", label: "Status check", kind: "text" },
    { key: "az", label: "Availability Zone", kind: "text" },
    { key: "publicDns", label: "Public IPv4 DNS", kind: "text" },
    { key: "publicIp", label: "Public IPv4 address", kind: "text" },
    { key: "elasticIp", label: "Elastic IP", kind: "text" },
    { key: "monitoring", label: "Monitoring", kind: "text" },
    { key: "securityGroups", label: "Security group name", kind: "text" },
    { key: "keyName", label: "Key name", kind: "text" },
    { key: "launchTime", label: "Launch time", kind: "date" },
    { key: "platform", label: "Platform details", kind: "text", hidden: true },
    { key: "privateIp", label: "Private IP address", kind: "text", hidden: true },
    { key: "vpcId", label: "VPC ID", kind: "text", hidden: true },
  ],

  async list(ctx) {
    // Only DescribeInstances is essential; a denied status or Elastic IP lookup marks those cells.
    const [list, statuses, eips] = await Promise.all([allInstances(ctx), tolerant(statusMap(ctx)), tolerant(elasticIpsByInstance(ctx))]);
    return list.map((i) => instanceRow(i, statuses, eips)).sort((a, b) => String(b.launchTime ?? "").localeCompare(String(a.launchTime ?? "")));
  },

  async get(ctx, id) {
    const d = await getInstance(ctx, id);
    const i = d.i;
    const nic = i.NetworkInterfaces ?? [];
    return {
      summary: {
        Name: nameTag(i.Tags) ?? id,
        "Instance ID": id,
        "Instance state": i.State?.Name ?? null,
        "Instance type": i.InstanceType ?? null,
        "Public IPv4 address": i.PublicIpAddress ?? null,
        "Private IPv4 addresses": i.PrivateIpAddress ?? null,
        "Public IPv4 DNS": i.PublicDnsName || null,
        "Private IP DNS name (IPv4 only)": i.PrivateDnsName || null,
        "VPC ID": i.VpcId ?? null,
        "Subnet ID": i.SubnetId ?? null,
        "Status check": d.statusError ? unavailable(d.statusError) : checkText(d.status, i.State?.Name),
        "IAM Role": i.IamInstanceProfile?.Arn?.split("/").pop() ?? null,
      },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            "AMI ID": i.ImageId ?? null,
            "AMI name": d.image?.Name ?? null,
            "Platform details": i.PlatformDetails ?? null,
            Architecture: i.Architecture ?? null,
            "Launch time": i.LaunchTime ?? null,
            "Key pair assigned at launch": i.KeyName ?? null,
            "Availability Zone": i.Placement?.AvailabilityZone ?? null,
            Tenancy: i.Placement?.Tenancy ?? null,
            "Placement group": i.Placement?.GroupName || null,
            "Virtualization type": i.VirtualizationType ?? null,
            "Root device name": i.RootDeviceName ?? null,
            "Root device type": i.RootDeviceType ?? null,
            "Number of vCPUs": i.CpuOptions?.CoreCount !== undefined ? (i.CpuOptions.CoreCount ?? 0) * (i.CpuOptions.ThreadsPerCore ?? 1) : null,
            "Termination protection": d.protection?.DisableApiTermination?.Value ?? null,
            Monitoring: i.Monitoring?.State ?? null,
            "IMDSv2": i.MetadataOptions?.HttpTokens === "required" ? "Required" : i.MetadataOptions?.HttpTokens === "optional" ? "Optional" : null,
            "Instance metadata service": i.MetadataOptions?.HttpEndpoint ?? null,
            "Hibernation": i.HibernationOptions?.Configured ?? null,
            "Owner": i.NetworkInterfaces?.[0]?.OwnerId ?? null,
          },
        },
        {
          id: "security",
          label: "Security",
          kind: "table",
          columns: RULE_COLUMNS,
          description: `IAM Role: ${i.IamInstanceProfile?.Arn ?? "-"}. Security groups: ${(i.SecurityGroups ?? []).map((g) => `${g.GroupId} (${g.GroupName})`).join(", ") || "-"}.${d.rulesError ? ` Rules could not be read: ${d.rulesError}` : ""}`,
          data: d.rules.map((r) => ({ direction: r.IsEgress ? "Outbound" : "Inbound", groupId: r.GroupId ?? null, ...ruleRow(r) })).sort((a, b) => String(a.direction).localeCompare(String(b.direction))),
          emptyText: "The instance's security groups have no rules.",
        },
        {
          id: "networking",
          label: "Networking",
          kind: "table",
          description: `Public IPv4 DNS ${i.PublicDnsName || "-"} · Private DNS ${i.PrivateDnsName || "-"} · VPC ${i.VpcId ?? "-"} · Subnet ${i.SubnetId ?? "-"}`,
          columns: [
            { key: "eni", label: "Interface ID", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
            { key: "deviceIndex", label: "Device index", kind: "count" },
            { key: "privateIp", label: "Private IPv4 address", kind: "text" },
            { key: "publicIp", label: "Public IPv4 address", kind: "text" },
            { key: "subnet", label: "Subnet ID", kind: "text" },
            { key: "mac", label: "MAC address", kind: "text" },
            { key: "sourceDest", label: "Source/dest. check", kind: "boolean" },
            { key: "status", label: "Status", kind: "status" },
          ],
          data: nic.map((n) => ({
            eni: n.NetworkInterfaceId ?? null,
            description: n.Description || null,
            deviceIndex: n.Attachment?.DeviceIndex ?? null,
            privateIp: n.PrivateIpAddress ?? null,
            publicIp: n.Association?.PublicIp ?? null,
            subnet: n.SubnetId ?? null,
            mac: n.MacAddress ?? null,
            sourceDest: n.SourceDestCheck ?? null,
            status: n.Status ?? null,
          })),
          emptyText: "No network interfaces.",
        },
        {
          id: "storage",
          label: "Storage",
          kind: "table",
          description: `Root device name ${i.RootDeviceName ?? "-"} · Root device type ${i.RootDeviceType ?? "-"} · EBS optimization ${i.EbsOptimized ? "enabled" : "disabled"}`,
          columns: [
            { key: "volumeId", label: "Volume ID", kind: "text" },
            { key: "device", label: "Device name", kind: "text" },
            { key: "size", label: "Volume size (GiB)", kind: "count" },
            { key: "type", label: "Volume type", kind: "text" },
            { key: "iops", label: "IOPS", kind: "count" },
            { key: "status", label: "Attachment status", kind: "status" },
            { key: "attached", label: "Attachment time", kind: "date" },
            { key: "encrypted", label: "Encrypted", kind: "boolean" },
            { key: "deleteOnTermination", label: "Delete on termination", kind: "boolean" },
          ],
          data: (i.BlockDeviceMappings ?? []).map((b) => {
            const vol = d.volumes.find((v) => v.VolumeId === b.Ebs?.VolumeId);
            return {
              volumeId: b.Ebs?.VolumeId ?? null,
              device: b.DeviceName ?? null,
              size: vol?.Size ?? null,
              type: vol?.VolumeType ?? null,
              iops: vol?.Iops ?? null,
              status: b.Ebs?.Status ?? null,
              attached: b.Ebs?.AttachTime ?? null,
              encrypted: vol?.Encrypted ?? null,
              deleteOnTermination: b.Ebs?.DeleteOnTermination ?? null,
            };
          }),
          emptyText: "No block devices.",
        },
        {
          id: "status",
          label: "Status and alarms",
          kind: "keyvalue",
          data: d.status
            ? {
                "System status checks": d.status.SystemStatus?.Status ?? null,
                "Instance status checks": d.status.InstanceStatus?.Status ?? null,
                "Attached EBS status checks": d.status.AttachedEbsStatus?.Status ?? null,
                "System reachability": d.status.SystemStatus?.Details?.map((x) => `${x.Name}: ${x.Status}`).join(", ") ?? null,
                "Instance reachability": d.status.InstanceStatus?.Details?.map((x) => `${x.Name}: ${x.Status}`).join(", ") ?? null,
                "Scheduled events": d.status.Events?.length ? d.status.Events.map((e) => `${e.Code}: ${e.Description}`).join("; ") : "No scheduled events",
              }
            : {},
          emptyText: d.statusError ? `Status checks could not be read: ${d.statusError}` : "DescribeInstanceStatus returned no status for this instance.",
        },
        {
          id: "monitoring",
          label: "Monitoring",
          kind: "table",
          description: d.monitoring.error ? `CloudWatch could not be read: ${d.monitoring.error}` : "AWS/EC2 metrics from CloudWatch GetMetricStatistics for the last 3 hours, 5-minute periods (CPU is an average, the rest are sums).",
          columns: [{ key: "time", label: "Time", kind: "date" }, ...METRICS.map((m) => ({ key: m.name, label: m.label, kind: "text" as const }))],
          data: d.monitoring.rows,
          emptyText: "CloudWatch has no datapoints for this instance in the last 3 hours.",
        },
        {
          id: "userdata",
          label: "User data",
          kind: "text",
          data: decodeUserData(d.userData?.UserData?.Value) ?? "",
          emptyText: "No user data.",
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tagRows(i.Tags),
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Launch instances",
    description: "Launches instances with RunInstances.",
    fields: [
      { name: "name", label: "Name", kind: "text", section: "Name and tags", placeholder: "e.g. My Web Server" },
      { name: "imageId", label: "Amazon Machine Image (AMI)", kind: "text", required: true, section: "Application and OS Images (Amazon Machine Image)", validate: { pattern: "ami-[0-9a-f]+", message: "An AMI ID such as ami-0123456789abcdef0." } },
      { name: "instanceType", label: "Instance type", kind: "select", required: true, options: instanceTypeOptions, default: "t3.micro", section: "Instance type" },
      { name: "keyName", label: "Key pair name", kind: "select", default: "", options: keyPairOptions, section: "Key pair (login)" },
      { name: "subnetId", label: "Subnet", kind: "select", default: "", options: subnetOptions, section: "Network settings" },
      { name: "securityGroups", label: "Security groups", kind: "multiselect", required: true, options: securityGroupOptions, section: "Network settings" },
      { name: "volumeSize", label: "Root volume size (GiB)", kind: "number", section: "Configure storage", validate: { min: 1, max: 16384, message: "Between 1 and 16384 GiB." } },
      { name: "volumeType", label: "Root volume type", kind: "select", default: "", options: VOLUME_TYPES.map((t) => ({ value: t, label: t })), section: "Configure storage" },
      { name: "userData", label: "User data", kind: "textarea", section: "Advanced details" },
      { name: "count", label: "Number of instances", kind: "number", default: 1, required: true, section: "Summary", validate: { min: 1, max: 20, message: "Between 1 and 20." } },
    ],
    async run(ctx, v: FieldValues) {
      const o = await launchInstances(ctx, {
        name: typeof v.name === "string" ? v.name : "",
        tags: [],
        imageId: String(v.imageId),
        instanceType: String(v.instanceType),
        keyName: typeof v.keyName === "string" && v.keyName ? v.keyName : null,
        vpcId: null,
        subnetId: typeof v.subnetId === "string" && v.subnetId ? v.subnetId : null,
        autoAssignPublicIp: "default",
        securityGroupIds: strList(v.securityGroups),
        newSecurityGroup: null,
        volumeSize: typeof v.volumeSize === "number" ? v.volumeSize : null,
        volumeType: typeof v.volumeType === "string" && v.volumeType ? v.volumeType : null,
        userData: typeof v.userData === "string" ? v.userData : "",
        count: typeof v.count === "number" ? v.count : 1,
        iamInstanceProfile: null,
        terminationProtection: false,
        detailedMonitoring: false,
      });
      return o.instanceIds[0];
    },
  },

  actions,
};
