/** VPC flow logs: to CloudWatch Logs or S3, for a VPC, subnet or network interface. */

import { CreateFlowLogsCommand, DeleteFlowLogsCommand, DescribeFlowLogsCommand, type FlowLog, type FlowLogsResourceType, type TrafficType } from "@aws-sdk/client-ec2";
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { ListRolesCommand } from "@aws-sdk/client-iam";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef } from "../../console/types.ts";
import { collect, eniOptions, numOrUndef, one, subnetOptions, tagActions, tagsTab, tagSpec, text, vpcOptions } from "./ec2.ts";
import { nameOf, withName } from "./helpers.ts";

async function logGroupOptions(ctx: Ctx): Promise<Option[]> {
  const groups = await collect(async (t) => {
    const r = await ctx.clients.logs.send(new DescribeLogGroupsCommand({ nextToken: t }));
    return { items: r.logGroups, next: r.nextToken };
  });
  return groups.filter((g) => g.logGroupName).map((g) => ({ value: g.logGroupName as string, label: g.logGroupName as string }));
}

async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const roles = await collect(async (t) => {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: t }));
    return { items: r.Roles, next: r.IsTruncated ? r.Marker : undefined };
  });
  return roles.filter((r) => r.Arn).map((r) => ({ value: r.Arn as string, label: r.RoleName ?? (r.Arn as string) }));
}

async function bucketOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.s3.send(new ListBucketsCommand({}));
  return (r.Buckets ?? []).filter((b) => b.Name).map((b) => ({ value: `arn:aws:s3:::${b.Name}`, label: b.Name as string }));
}

/** Fields for creating a flow log; `withResource` adds the resource type and resource pickers. */
export function flowLogFields(withResource: boolean): FieldDef[] {
  const resource: FieldDef[] = withResource
    ? [
        { name: "resourceType", label: "Resource type", kind: "radio", default: "VPC", section: "Flow log settings", options: [{ value: "VPC", label: "VPC" }, { value: "Subnet", label: "Subnet" }, { value: "NetworkInterface", label: "Network interface" }] },
        { name: "vpcId", label: "VPC", kind: "select", required: true, section: "Flow log settings", options: vpcOptions, showIf: { field: "resourceType", equals: "VPC" } },
        { name: "subnetId", label: "Subnet", kind: "select", required: true, section: "Flow log settings", options: subnetOptions, showIf: { field: "resourceType", equals: "Subnet" } },
        { name: "eniId", label: "Network interface", kind: "select", required: true, section: "Flow log settings", options: eniOptions, showIf: { field: "resourceType", equals: "NetworkInterface" } },
      ]
    : [];
  return [
    { name: "name", label: "Name", kind: "text", section: "Flow log settings" },
    ...resource,
    { name: "filter", label: "Filter", kind: "radio", default: "ALL", section: "Flow log settings", options: [{ value: "ACCEPT", label: "Accept" }, { value: "REJECT", label: "Reject" }, { value: "ALL", label: "All" }], help: "The type of traffic to log." },
    { name: "interval", label: "Maximum aggregation interval", kind: "radio", default: "600", section: "Flow log settings", options: [{ value: "600", label: "10 minutes" }, { value: "60", label: "1 minute" }] },
    { name: "destination", label: "Destination", kind: "radio", default: "cloud-watch-logs", section: "Destination", options: [{ value: "cloud-watch-logs", label: "Send to CloudWatch Logs" }, { value: "s3", label: "Send to an Amazon S3 bucket" }] },
    { name: "logGroup", label: "Destination log group", kind: "select", required: true, section: "Destination", options: logGroupOptions, showIf: { field: "destination", equals: "cloud-watch-logs" }, help: "Create the log group in CloudWatch Logs first." },
    { name: "role", label: "IAM role", kind: "select", required: true, section: "Destination", options: roleOptions, showIf: { field: "destination", equals: "cloud-watch-logs" }, help: "A role that lets the flow logs service publish to CloudWatch Logs." },
    { name: "bucket", label: "S3 bucket", kind: "select", required: true, section: "Destination", options: bucketOptions, showIf: { field: "destination", equals: "s3" } },
    { name: "format", label: "Log record format", kind: "radio", default: "default", section: "Log record format", options: [{ value: "default", label: "AWS default format" }, { value: "custom", label: "Custom format" }] },
    { name: "customFormat", label: "Custom format", kind: "text", section: "Log record format", showIf: { field: "format", equals: "custom" }, placeholder: "${version} ${srcaddr} ${dstaddr} ${action}" },
    { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
  ];
}

export async function createFlowLog(ctx: Ctx, v: FieldValues): Promise<string> {
  const type = (v.resourceType === "Subnet" ? "Subnet" : v.resourceType === "NetworkInterface" ? "NetworkInterface" : "VPC") as FlowLogsResourceType;
  const resourceId = text(type === "Subnet" ? v.subnetId : type === "NetworkInterface" ? v.eniId : v.vpcId);
  if (!resourceId) throw new Error("Choose the resource to log.");
  const toS3 = v.destination === "s3";
  const r = await ctx.clients.ec2.send(
    new CreateFlowLogsCommand({
      ResourceType: type,
      ResourceIds: [resourceId],
      TrafficType: (typeof v.filter === "string" ? v.filter : "ALL") as TrafficType,
      MaxAggregationInterval: numOrUndef(Number(v.interval)) ?? 600,
      LogDestinationType: toS3 ? "s3" : "cloud-watch-logs",
      LogGroupName: toS3 ? undefined : text(v.logGroup),
      DeliverLogsPermissionArn: toS3 ? undefined : text(v.role),
      LogDestination: toS3 ? text(v.bucket) : undefined,
      LogFormat: v.format === "custom" && text(v.customFormat) ? text(v.customFormat) : undefined,
      TagSpecifications: tagSpec("vpc-flow-log", withName(v.name, v.tags)),
    })
  );
  const failed = r.Unsuccessful?.[0];
  if (failed) throw new Error(`${failed.Error?.Code ?? "Error"}: ${failed.Error?.Message ?? "the flow log was not created"}`);
  const id = r.FlowLogIds?.[0];
  if (!id) throw new Error("CreateFlowLogs returned no flow log ID.");
  return id;
}

async function describeFlowLogs(ctx: Ctx, ids?: string[]): Promise<FlowLog[]> {
  return collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeFlowLogsCommand({ FlowLogIds: ids, NextToken: t }));
    return { items: r.FlowLogs, next: r.NextToken };
  });
}

function flowRow(l: FlowLog) {
  return {
    name: nameOf(l.Tags),
    id: l.FlowLogId ?? "",
    resourceId: l.ResourceId ?? null,
    filter: l.TrafficType ?? null,
    destinationType: l.LogDestinationType ?? null,
    destination: l.LogGroupName ?? l.LogDestination ?? null,
    status: l.FlowLogStatus ?? null,
    deliveryStatus: l.DeliverLogsStatus ?? null,
    role: l.DeliverLogsPermissionArn ?? null,
    interval: l.MaxAggregationInterval ?? null,
    format: l.LogFormat ?? null,
    created: l.CreationTime ?? null,
  };
}

export const flowLogs: ResourceDef = {
  id: "flow-logs",
  name: "Flow logs",
  singular: "flow log",
  idField: "id",
  description: "Flow logs capture information about the IP traffic going to and from network interfaces in your VPC.",
  emptyText: "No flow logs.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Flow log ID", kind: "link" },
    { key: "resourceId", label: "Resource ID", kind: "text" },
    { key: "filter", label: "Filter", kind: "text" },
    { key: "destinationType", label: "Destination type", kind: "text" },
    { key: "destination", label: "Destination name", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "interval", label: "Maximum aggregation interval (s)", kind: "count" },
    { key: "created", label: "Creation time", kind: "date" },
  ],
  async list(ctx) {
    return (await describeFlowLogs(ctx)).map(flowRow);
  },
  async get(ctx, id) {
    const l = one(await describeFlowLogs(ctx, [id]), "Flow log", id);
    const r = flowRow(l);
    return {
      summary: {
        "Flow log ID": r.id,
        Name: r.name,
        "Resource ID": r.resourceId,
        Filter: r.filter,
        "Destination type": r.destinationType,
        "Destination name": r.destination,
        Status: r.status,
        "Delivery status": r.deliveryStatus,
        "IAM role": r.role,
        "Maximum aggregation interval (seconds)": r.interval,
        "Log line format": r.format,
        "Creation time": r.created,
      },
      tabs: [tagsTab(l.Tags)],
    };
  },
  create: {
    title: "Create flow log",
    description: "Creates a flow log with CreateFlowLogs.",
    fields: flowLogFields(true),
    run: createFlowLog,
  },
  actions: tagActions,
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const r = await ctx.clients.ec2.send(new DeleteFlowLogsCommand({ FlowLogIds: [id] }));
      const failed = r.Unsuccessful?.[0];
      if (failed) throw new Error(`${failed.Error?.Code ?? "Error"}: ${failed.Error?.Message ?? ""}`);
    },
  },
};
