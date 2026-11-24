/**
 * Route 53 hosted zones. The zone detail screen is hand-built
 * (src/app/route53/hosted-zones/[zone]) because it holds the records table and record
 * editor; its other tabs and the actions come from this definition.
 */

import { noTagChanges, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { secondaryOr, unavailableText } from "../../console/secondary.ts";
import {
  AssociateVPCWithHostedZoneCommand,
  ChangeTagsForResourceCommand,
  CreateHostedZoneCommand,
  CreateQueryLoggingConfigCommand,
  DeleteHostedZoneCommand,
  DeleteQueryLoggingConfigCommand,
  DisassociateVPCFromHostedZoneCommand,
  GetDNSSECCommand,
  GetHostedZoneCommand,
  ListHostedZonesCommand,
  ListQueryLoggingConfigsCommand,
  ListTagsForResourceCommand,
  TestDNSAnswerCommand,
  UpdateHostedZoneCommentCommand,
  type HostedZone,
  type RRType,
} from "@aws-sdk/client-route-53";
import { DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, FieldValues, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { fullName, RECORD_TYPES } from "./records.ts";
import { bareZoneId } from "./zone-id.ts";

const DOMAIN = "(?=.{1,253}\\.?$)([A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\\.)+[A-Za-z0-9_-]{1,63}\\.?";

async function listZones(ctx: Ctx): Promise<HostedZone[]> {
  const out: HostedZone[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.route53.send(new ListHostedZonesCommand({ Marker: marker, MaxItems: 100 }));
    out.push(...(r.HostedZones ?? []));
    marker = r.IsTruncated ? r.NextMarker : undefined;
  } while (marker);
  return out;
}

export async function zoneOptions(ctx: Ctx): Promise<Option[]> {
  return (await listZones(ctx)).map((z) => ({ value: bareZoneId(z.Id ?? ""), label: `${z.Name ?? ""} (${bareZoneId(z.Id ?? "")})` }));
}

async function vpcOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeVpcsCommand({ NextToken: token, MaxResults: 1000 }));
    for (const v of r.Vpcs ?? []) {
      if (!v.VpcId) continue;
      const name = v.Tags?.find((t) => t.Key === "Name")?.Value;
      out.push({ value: v.VpcId, label: `${v.VpcId}${name ? ` | ${name}` : ""} (${v.CidrBlock ?? ""})${v.IsDefault ? " - default" : ""}` });
    }
    token = r.NextToken;
  } while (token);
  return out;
}

/** VPCs associated with the hosted zone. */
async function zoneVpcOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  if (!id) return vpcOptions(ctx);
  const vpcs = (await ctx.clients.route53.send(new GetHostedZoneCommand({ Id: id }))).VPCs ?? [];
  const all = await vpcOptions(ctx);
  return vpcs.filter((v) => v.VPCId).map((v) => all.find((o) => o.value === v.VPCId) ?? { value: v.VPCId as string, label: `${v.VPCId} (${v.VPCRegion ?? ""})` });
}

/** VPCs in this Region not yet associated with the hosted zone. */
async function unassociatedVpcOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  const all = await vpcOptions(ctx);
  if (!id) return all;
  const taken = new Set(((await ctx.clients.route53.send(new GetHostedZoneCommand({ Id: id }))).VPCs ?? []).map((v) => v.VPCId));
  return all.filter((o) => !taken.has(o.value));
}

async function logGroupOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.logs.send(new DescribeLogGroupsCommand({ nextToken: token }));
    for (const g of r.logGroups ?? []) {
      if (g.logGroupName && g.arn) out.push({ value: g.arn.replace(/:\*$/, ""), label: g.logGroupName });
    }
    token = r.nextToken;
  } while (token);
  return out;
}

function zoneRow(z: HostedZone): Row {
  return {
    name: z.Name ?? "",
    id: bareZoneId(z.Id ?? ""),
    type: z.Config?.PrivateZone ? "Private" : "Public",
    recordCount: z.ResourceRecordSetCount ?? null,
    description: z.Config?.Comment ?? null,
    linkedService: z.LinkedService?.ServicePrincipal ?? null,
  };
}

export async function tagsOf(ctx: Ctx, type: "hostedzone" | "healthcheck", id: string): Promise<Tag[]> {
  const r = await ctx.clients.route53.send(new ListTagsForResourceCommand({ ResourceType: type, ResourceId: id }));
  return (r.ResourceTagSet?.Tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

/**
 * Makes the resource's tags exactly `tags`: removes keys not listed, adds new keys and
 * overwrites changed values. Unchanged tags are not sent, so an unedited form changes nothing.
 */
export async function replaceTags(ctx: Ctx, type: "hostedzone" | "healthcheck", id: string, tags: Tag[]): Promise<string> {
  const diff = tagDiff(await tagsOf(ctx, type, id), tags);
  if (noTagChanges(diff)) return tagDiffMessage(diff);
  await ctx.clients.route53.send(
    new ChangeTagsForResourceCommand({ ResourceType: type, ResourceId: id, AddTags: diff.set.length ? diff.set : undefined, RemoveTagKeys: diff.remove.length ? diff.remove : undefined })
  );
  return tagDiffMessage(diff);
}

const asTags = (v: FieldValues[string]): Tag[] => (Array.isArray(v) ? (v as Tag[]) : []);
const text = (v: FieldValues[string]): string => (typeof v === "string" ? v.trim() : "");

async function queryLogging(ctx: Ctx, id: string) {
  const r = await ctx.clients.route53.send(new ListQueryLoggingConfigsCommand({ HostedZoneId: id }));
  return r.QueryLoggingConfigs ?? [];
}

async function dnssecRow(ctx: Ctx, id: string): Promise<Row> {
  try {
    const r = await ctx.clients.route53.send(new GetDNSSECCommand({ HostedZoneId: id }));
    return {
      "DNSSEC signing": r.Status?.ServeSignature ?? null,
      "Status message": r.Status?.StatusMessage ?? null,
      "Key-signing keys": (r.KeySigningKeys ?? []).map((k) => `${k.Name ?? ""} (${k.Status ?? ""})`).join(", ") || "None",
    };
  } catch (err: unknown) {
    return { "DNSSEC signing": `Could not read: ${errorMessage(err)}` };
  }
}

export const hostedZones: ResourceDef = {
  id: "hosted-zones",
  name: "Hosted zones",
  singular: "hosted zone",
  idField: "id",
  nameField: "name",
  description: "A hosted zone is a container for records that say how to route traffic for a domain and its subdomains.",
  emptyText: "No hosted zones to display. Create a hosted zone to route traffic for a domain.",
  detailHref: "hosted-zones/{id}",
  columns: [
    { key: "name", label: "Hosted zone name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "recordCount", label: "Record count", kind: "count" },
    { key: "description", label: "Description", kind: "text" },
    { key: "id", label: "Hosted zone ID", kind: "code" },
    { key: "linkedService", label: "Created by service", kind: "text", hidden: true },
  ],

  async list(ctx) {
    return (await listZones(ctx)).map(zoneRow);
  },

  async get(ctx, id) {
    const r = await ctx.clients.route53.send(new GetHostedZoneCommand({ Id: id }));
    const z = r.HostedZone;
    if (!z) throw new Error(`Route 53 returned no hosted zone for ${id}.`);
    const row = zoneRow(z);
    const [tagsR, loggingR, dnssec] = await Promise.all([secondaryOr(tagsOf(ctx, "hostedzone", id), []), secondaryOr(queryLogging(ctx, id), []), dnssecRow(ctx, id)]);
    const [tags, logging] = [tagsR.value, loggingR.value];
    const nameServers = r.DelegationSet?.NameServers ?? [];
    return {
      summary: { name: row.name, id: row.id, type: row.type, recordCount: row.recordCount, description: row.description, nameServers: nameServers.join("\n") || null },
      summaryLabels: { name: "Hosted zone name", id: "Hosted zone ID", type: "Type", recordCount: "Record count", description: "Description", nameServers: "Name servers" },
      tabs: [
        {
          id: "details",
          label: "Hosted zone details",
          kind: "keyvalue",
          data: {
            "Hosted zone name": row.name,
            "Hosted zone ID": row.id,
            Type: row.type === "Private" ? "Private hosted zone" : "Public hosted zone",
            Description: row.description,
            "Record count": row.recordCount,
            "Caller reference": z.CallerReference ?? null,
            "Created by service": row.linkedService,
            "Query logging": loggingR.error ? `Unavailable: ${loggingR.error}` : logging.length ? logging.map((l) => l.CloudWatchLogsLogGroupArn ?? "").join(", ") : "Not configured",
            "Name servers": nameServers.join("\n") || null,
          },
        },
        {
          id: "vpcs",
          label: "VPCs",
          kind: "table",
          columns: [
            { key: "VPCId", label: "VPC ID", kind: "code" },
            { key: "VPCRegion", label: "Region", kind: "text" },
          ],
          data: r.VPCs ?? [],
          description: "VPCs whose DNS queries this private hosted zone answers.",
          emptyText: row.type === "Private" ? "No VPCs are associated with this hosted zone." : "Public hosted zones aren't associated with VPCs.",
        },
        {
          id: "query-logging",
          label: "Query logging",
          kind: "table",
          columns: [
            { key: "Id", label: "Configuration ID", kind: "code" },
            { key: "CloudWatchLogsLogGroupArn", label: "CloudWatch Logs log group", kind: "arn" },
          ],
          data: logging,
          emptyText: unavailableText(loggingR, "Query logging is not configured. Use Actions > Configure query logging."),
        },
        { id: "dnssec", label: "DNSSEC signing", kind: "keyvalue", data: dnssec },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tags,
          emptyText: unavailableText(tagsR, "No tags are associated with this hosted zone."),
        },
      ],
    };
  },

  create: {
    title: "Create hosted zone",
    description: "Creates a hosted zone with CreateHostedZone. Route 53 adds an NS and an SOA record to it automatically.",
    fields: [
      {
        name: "name", label: "Domain name", kind: "text", required: true, section: "Hosted zone configuration", placeholder: "example.com",
        help: "This is the name of the domain that you want to route traffic for.",
        validate: { pattern: DOMAIN, message: "Enter a valid domain name, such as example.com." },
      },
      { name: "comment", label: "Description", kind: "textarea", section: "Hosted zone configuration", help: "This value lets you distinguish hosted zones that have the same name.", validate: { max: 256, message: "At most 256 characters." } },
      {
        name: "type", label: "Type", kind: "radio", default: "public", section: "Hosted zone configuration",
        help: "The type indicates whether you want to route traffic on the internet or in an Amazon VPC.",
        options: [
          { value: "public", label: "Public hosted zone: determines how traffic is routed on the internet." },
          { value: "private", label: "Private hosted zone: determines how traffic is routed within an Amazon VPC." },
        ],
      },
      { name: "vpcId", label: "VPC ID", kind: "select", required: true, options: vpcOptions, section: "VPCs to associate with the hosted zone", showIf: { field: "type", equals: "private" }, help: "VPCs in US East (N. Virginia) us-east-1, the Region the console uses for global Route 53. To use private hosted zones, enableDnsHostnames and enableDnsSupport must be true for the VPC." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const priv = v.type === "private";
      const vpcId = text(v.vpcId);
      if (priv && !vpcId) throw new Error("Choose a VPC for the private hosted zone.");
      const comment = text(v.comment);
      const r = await ctx.clients.route53.send(
        new CreateHostedZoneCommand({
          Name: String(v.name),
          CallerReference: `console-${Date.now()}-${String(v.name)}`,
          HostedZoneConfig: { Comment: comment || undefined, PrivateZone: priv },
          VPC: priv ? { VPCId: vpcId, VPCRegion: ctx.region as "us-east-1" } : undefined,
        })
      );
      const id = bareZoneId(r.HostedZone?.Id ?? "");
      if (!id) throw new Error("Route 53 returned no hosted zone ID.");
      const tags = asTags(v.tags);
      if (tags.length) await replaceTags(ctx, "hostedzone", id, tags);
      return id;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit hosted zone",
      fields: [{ name: "comment", label: "Description", kind: "textarea", help: "Clear the box to remove the description.", validate: { max: 256, message: "At most 256 characters." } }],
      initialValues: async (ctx, id) => ({ comment: (await ctx.clients.route53.send(new GetHostedZoneCommand({ Id: id }))).HostedZone?.Config?.Comment ?? "" }),
      async run(ctx, id, v) {
        const current = (await ctx.clients.route53.send(new GetHostedZoneCommand({ Id: id }))).HostedZone?.Config?.Comment ?? "";
        const comment = text(v.comment);
        if (comment === current.trim()) return { message: "No changes to the hosted zone." };
        await ctx.clients.route53.send(new UpdateHostedZoneCommentCommand({ Id: id, Comment: comment }));
        return { message: comment ? "Hosted zone description saved." : "Hosted zone description removed." };
      },
    },
    {
      id: "associate-vpc",
      label: "Associate VPC",
      availableFor: (row) => row.type !== "Public",
      fields: [{ name: "vpcId", label: "VPC ID", kind: "select", required: true, options: unassociatedVpcOptions, help: "VPCs not yet associated with this private hosted zone." }],
      async run(ctx, id, v) {
        const r = await ctx.clients.route53.send(new AssociateVPCWithHostedZoneCommand({ HostedZoneId: id, VPC: { VPCId: text(v.vpcId), VPCRegion: ctx.region as "us-east-1" } }));
        return { message: `Associated ${text(v.vpcId)}. Change status: ${r.ChangeInfo?.Status ?? "unknown"}.` };
      },
    },
    {
      id: "disassociate-vpc",
      label: "Disassociate VPC",
      availableFor: (row) => row.type !== "Public",
      fields: [{ name: "vpcId", label: "VPC ID", kind: "select", required: true, options: zoneVpcOptions, help: "A private hosted zone must keep at least one VPC." }],
      async run(ctx, id, v) {
        const r = await ctx.clients.route53.send(new DisassociateVPCFromHostedZoneCommand({ HostedZoneId: id, VPC: { VPCId: text(v.vpcId), VPCRegion: ctx.region as "us-east-1" } }));
        return { message: `Disassociated ${text(v.vpcId)}. Change status: ${r.ChangeInfo?.Status ?? "unknown"}.` };
      },
    },
    {
      id: "query-logging",
      label: "Configure query logging",
      availableFor: (row) => row.type !== "Private",
      fields: [{ name: "logGroupArn", label: "CloudWatch Logs log group", kind: "select", required: true, options: logGroupOptions, help: "Public hosted zones only. Route 53 sends DNS query logs to this log group. Choosing another log group replaces the current configuration." }],
      async initialValues(ctx, id): Promise<FieldValues> {
        const arn = (await queryLogging(ctx, id))[0]?.CloudWatchLogsLogGroupArn;
        return arn ? { logGroupArn: arn.replace(/:\*$/, "") } : {};
      },
      async run(ctx, id, v) {
        const arn = text(v.logGroupArn);
        const current = await queryLogging(ctx, id);
        if (current.some((c) => (c.CloudWatchLogsLogGroupArn ?? "").replace(/:\*$/, "") === arn)) return { message: "Query logging already uses this log group. No changes." };
        for (const c of current) if (c.Id) await ctx.clients.route53.send(new DeleteQueryLoggingConfigCommand({ Id: c.Id }));
        const r = await ctx.clients.route53.send(new CreateQueryLoggingConfigCommand({ HostedZoneId: id, CloudWatchLogsLogGroupArn: arn }));
        return { message: `Query logging configured (configuration ${r.QueryLoggingConfig?.Id ?? "unknown"}).` };
      },
    },
    {
      id: "delete-query-logging",
      label: "Delete query logging",
      danger: true,
      confirm: "This stops sending DNS query logs for this hosted zone.",
      async run(ctx, id) {
        const configs = await queryLogging(ctx, id);
        if (configs.length === 0) throw new Error("Query logging is not configured for this hosted zone.");
        for (const c of configs) if (c.Id) await ctx.clients.route53.send(new DeleteQueryLoggingConfigCommand({ Id: c.Id }));
        return { message: `Deleted ${configs.length} query logging configuration${configs.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "test-record",
      label: "Test record",
      fields: [
        { name: "recordName", label: "Record name", kind: "text", help: "The subdomain, such as www. Leave empty for the zone apex.", validate: { pattern: "[A-Za-z0-9_*.-]{0,253}", message: "Letters, numbers, hyphens, underscores and dots." } },
        { name: "recordType", label: "Type", kind: "select", default: "A", options: RECORD_TYPES.map((t) => ({ value: t, label: t })) },
      ],
      async run(ctx, id, v) {
        const zone = await ctx.clients.route53.send(new GetHostedZoneCommand({ Id: id }));
        const name = fullName(text(v.recordName), zone.HostedZone?.Name ?? "");
        const r = await ctx.clients.route53.send(new TestDNSAnswerCommand({ HostedZoneId: id, RecordName: name, RecordType: text(v.recordType) as RRType }));
        return {
          message: `Response from ${r.Nameserver ?? "name server"}: ${r.ResponseCode ?? "no response code"} over ${r.Protocol ?? "UDP"}.`,
          json: { RecordName: r.RecordName, RecordType: r.RecordType, RecordData: r.RecordData, ResponseCode: r.ResponseCode, Protocol: r.Protocol },
        };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "The hosted zone's tags. Edit, add or remove keys; only the changes are saved." }],
      initialValues: async (ctx, id) => ({ tags: await tagsOf(ctx, "hostedzone", id) }),
      async run(ctx, id, v) {
        return { message: await replaceTags(ctx, "hostedzone", id, asTags(v.tags)) };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.route53.send(new DeleteHostedZoneCommand({ Id: id }));
    },
  },
};
