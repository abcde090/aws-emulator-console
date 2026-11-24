/** GuardDuty suppression rules (filters), trusted IP lists, threat lists and publishing destinations. */

import {
  CreateFilterCommand,
  CreateIPSetCommand,
  CreatePublishingDestinationCommand,
  CreateThreatIntelSetCommand,
  DeleteFilterCommand,
  DeleteIPSetCommand,
  DeletePublishingDestinationCommand,
  DeleteThreatIntelSetCommand,
  DescribePublishingDestinationCommand,
  GetFilterCommand,
  GetIPSetCommand,
  GetThreatIntelSetCommand,
  ListFiltersCommand,
  ListIPSetsCommand,
  ListPublishingDestinationsCommand,
  ListThreatIntelSetsCommand,
  UpdateFilterCommand,
  UpdateIPSetCommand,
  UpdateThreatIntelSetCommand,
  type Condition,
  type IpSetFormat,
} from "@aws-sdk/client-guardduty";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { ListAliasesCommand, ListKeysCommand, type AliasListEntry, type KeyListEntry } from "@aws-sdk/client-kms";
import type { ActionDef, Ctx, Option, ResourceDef, Row } from "../../console/types.ts";
import { detectorId, str, tagRecord, tagRows, TAG_COLUMNS } from "./detector.ts";
import { buildCriterion, criterionRows } from "./helpers.ts";

const NAME = "[A-Za-z0-9._-]{3,64}";

/** Follows NextToken until the last page. */
async function allPages<T>(page: (token: string | undefined) => Promise<{ items?: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await page(token);
    out.push(...(r.items ?? []));
    token = r.next || undefined;
  } while (token);
  return out;
}

async function filterNames(ctx: Ctx, d: string): Promise<string[]> {
  return allPages(async (NextToken) => {
    const r = await ctx.clients.guardduty.send(new ListFiltersCommand({ DetectorId: d, MaxResults: 50, NextToken }));
    return { items: r.FilterNames, next: r.NextToken };
  });
}

const ACTIONS: Option[] = [{ value: "ARCHIVE", label: "Archive: automatically archive matching findings (suppression rule)" }, { value: "NOOP", label: "None: save as a filter only" }];

export const suppressionRules: ResourceDef = {
  id: "suppression-rules",
  name: "Suppression rules",
  singular: "suppression rule",
  idField: "name",
  nameField: "name",
  description: "Saved filters. A rule with action Archive (a suppression rule) automatically archives new findings that match it.",
  emptyText: "No suppression rules or saved filters.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "action", label: "Action", kind: "text" },
    { key: "rank", label: "Rank", kind: "count" },
    { key: "description", label: "Description", kind: "text" },
  ],
  async list(ctx) {
    const d = await detectorId(ctx);
    const names = await filterNames(ctx, d);
    return Promise.all(
      names.map(async (name) => {
        const f = await ctx.clients.guardduty.send(new GetFilterCommand({ DetectorId: d, FilterName: name }));
        return { name, action: f.Action === "ARCHIVE" ? "Suppression rule (archive)" : "Saved filter", rank: f.Rank ?? null, description: f.Description || null };
      })
    );
  },
  async get(ctx, name) {
    const d = await detectorId(ctx);
    const f = await ctx.clients.guardduty.send(new GetFilterCommand({ DetectorId: d, FilterName: name }));
    return {
      summary: { Name: f.Name, Action: f.Action === "ARCHIVE" ? "Archive (suppression rule)" : "Noop (saved filter)", Rank: f.Rank ?? null, Description: f.Description || "-" },
      tabs: [
        { id: "criteria", label: "Filter criteria", kind: "table", columns: [{ key: "attribute", label: "Attribute", kind: "code" }, { key: "condition", label: "Condition", kind: "text" }], data: criterionRows(f.FindingCriteria?.Criterion as Record<string, unknown> | undefined), emptyText: "No criteria." },
        { id: "json", label: "JSON", kind: "json", data: f.FindingCriteria ?? null },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(f.Tags), emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create suppression rule",
    description: "Creates a GuardDuty filter with CreateFilter. Fill at least one criterion.",
    fields: [
      { name: "name", label: "Suppression rule name", kind: "text", required: true, section: "Details", help: "3-64 characters: letters, numbers, period, hyphen and underscore.", validate: { pattern: NAME, message: "3-64 letters, numbers, . _ or -." } },
      { name: "description", label: "Description", kind: "text", section: "Details" },
      { name: "action", label: "Action", kind: "radio", default: "ARCHIVE", section: "Details", options: ACTIONS },
      { name: "rank", label: "Rank", kind: "number", default: 1, section: "Details", help: "Order in which filters are applied (1 first).", validate: { min: 1, max: 100, message: "Between 1 and 100." } },
      { name: "findingType", label: "Finding type", kind: "text", section: "Criteria", placeholder: "Recon:EC2/PortProbeUnprotectedPort", help: "One or more types, comma separated." },
      { name: "minSeverity", label: "Severity at least", kind: "select", section: "Criteria", options: [{ value: "Low", label: "Low" }, { value: "Medium", label: "Medium" }, { value: "High", label: "High" }, { value: "Critical", label: "Critical" }] },
      { name: "resourceType", label: "Resource type", kind: "select", section: "Criteria", options: ["Instance", "AccessKey", "S3Bucket", "EKSCluster", "ECSCluster", "Container", "RDSDBInstance", "Lambda"].map((v) => ({ value: v, label: v })) },
      { name: "accountId", label: "Account ID", kind: "text", section: "Criteria", validate: { pattern: "\\d{12}", message: "A 12-digit account ID." } },
      { name: "advanced", label: "Additional criteria (JSON)", kind: "json", section: "Criteria", placeholder: '{"service.action.actionType": {"Eq": ["PORT_PROBE"]}}', help: "A FindingCriteria.Criterion object; merged with the fields above." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const d = await detectorId(ctx);
      const criterion = buildCriterion({ findingType: str(v.findingType), minSeverity: str(v.minSeverity), resourceType: str(v.resourceType), accountId: str(v.accountId), advanced: str(v.advanced) });
      const r = await ctx.clients.guardduty.send(
        new CreateFilterCommand({
          DetectorId: d, Name: str(v.name), Description: str(v.description) || undefined, Action: v.action === "NOOP" ? "NOOP" : "ARCHIVE",
          Rank: typeof v.rank === "number" ? v.rank : 1, FindingCriteria: { Criterion: criterion as Record<string, Condition> }, Tags: tagRecord(v.tags),
        })
      );
      return r.Name ?? str(v.name);
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit suppression rule",
      fields: [
        { name: "description", label: "Description", kind: "text" },
        { name: "action", label: "Action", kind: "radio", required: true, default: "ARCHIVE", options: ACTIONS },
        { name: "rank", label: "Rank", kind: "number", required: true, default: 1, validate: { min: 1, max: 100, message: "Between 1 and 100." } },
        { name: "criteria", label: "Criteria (JSON)", kind: "json", required: true, help: "The FindingCriteria.Criterion object: attribute -> condition." },
      ],
      async initialValues(ctx, name) {
        const f = await ctx.clients.guardduty.send(new GetFilterCommand({ DetectorId: await detectorId(ctx), FilterName: name }));
        return { description: f.Description ?? "", action: f.Action === "NOOP" ? "NOOP" : "ARCHIVE", rank: f.Rank ?? 1, criteria: JSON.stringify(f.FindingCriteria?.Criterion ?? {}, null, 2) };
      },
      async run(ctx, name, v) {
        const d = await detectorId(ctx);
        const cur = await ctx.clients.guardduty.send(new GetFilterCommand({ DetectorId: d, FilterName: name }));
        const criterion = buildCriterion({ advanced: str(v.criteria) });
        const sameCriteria = JSON.stringify(criterion) === JSON.stringify(cur.FindingCriteria?.Criterion ?? {});
        const description = str(v.description);
        const action = v.action === "NOOP" ? "NOOP" : "ARCHIVE";
        const rank = typeof v.rank === "number" ? v.rank : cur.Rank;
        await ctx.clients.guardduty.send(
          new UpdateFilterCommand({
            DetectorId: d, FilterName: name,
            Description: description !== (cur.Description ?? "") ? description : undefined,
            Action: action !== cur.Action ? action : undefined,
            Rank: rank !== cur.Rank ? rank : undefined,
            FindingCriteria: sameCriteria ? undefined : { Criterion: criterion as Record<string, Condition> },
          })
        );
        return { message: "Suppression rule updated." };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.guardduty.send(new DeleteFilterCommand({ DetectorId: await detectorId(ctx), FilterName: name }));
    },
  },
};

const FORMATS: Option[] = [
  { value: "TXT", label: "Plaintext" },
  { value: "STIX", label: "Structured Threat Information Expression (STIX)" },
  { value: "OTX_CSV", label: "Open Threat Exchange (OTX) CSV" },
  { value: "ALIEN_VAULT", label: "AlienVault Reputation Feed" },
  { value: "PROOF_POINT", label: "Proof Point ET Intelligence Feed" },
  { value: "FIRE_EYE", label: "FireEye iSIGHT Threat Intelligence" },
];

type ListKind = "ip" | "threat";

interface ListInfo {
  Name?: string;
  Format?: string;
  Location?: string;
  Status?: string;
  Tags?: Record<string, string>;
}

async function getList(ctx: Ctx, kind: ListKind, d: string, id: string): Promise<ListInfo> {
  return kind === "ip"
    ? ctx.clients.guardduty.send(new GetIPSetCommand({ DetectorId: d, IpSetId: id }))
    : ctx.clients.guardduty.send(new GetThreatIntelSetCommand({ DetectorId: d, ThreatIntelSetId: id }));
}

async function listIds(ctx: Ctx, kind: ListKind, d: string): Promise<string[]> {
  return allPages(async (NextToken) => {
    if (kind === "ip") {
      const r = await ctx.clients.guardduty.send(new ListIPSetsCommand({ DetectorId: d, MaxResults: 50, NextToken }));
      return { items: r.IpSetIds, next: r.NextToken };
    }
    const r = await ctx.clients.guardduty.send(new ListThreatIntelSetsCommand({ DetectorId: d, MaxResults: 50, NextToken }));
    return { items: r.ThreatIntelSetIds, next: r.NextToken };
  });
}

async function updateList(ctx: Ctx, kind: ListKind, id: string, change: { Name?: string; Location?: string; Activate?: boolean }): Promise<void> {
  const d = await detectorId(ctx);
  if (kind === "ip") await ctx.clients.guardduty.send(new UpdateIPSetCommand({ DetectorId: d, IpSetId: id, ...change }));
  else await ctx.clients.guardduty.send(new UpdateThreatIntelSetCommand({ DetectorId: d, ThreatIntelSetId: id, ...change }));
}

/** List status from a list row ("status") or the detail summary ("Status"). */
const listStatus = (row: Row): string => String(row.status ?? row.Status ?? "");
const isActive = (row: Row) => /^ACTIV/.test(listStatus(row));
const isInactive = (row: Row) => /^(INACTIVE|DEACTIVATING)$/.test(listStatus(row));

function listActions(kind: ListKind): ActionDef[] {
  return [
    {
      id: "edit",
      label: "Edit",
      fields: [
        { name: "name", label: "List name", kind: "text", required: true, validate: { pattern: "[A-Za-z0-9._ -]{1,300}", message: "Up to 300 letters, numbers, spaces, . _ or -." } },
        { name: "location", label: "Location", kind: "text", required: true, help: "The S3 URL of the list file." },
      ],
      async initialValues(ctx, id) {
        const s = await getList(ctx, kind, await detectorId(ctx), id);
        return { name: s.Name ?? "", location: s.Location ?? "" };
      },
      async run(ctx, id, v) {
        const cur = await getList(ctx, kind, await detectorId(ctx), id);
        const name = str(v.name);
        const location = str(v.location);
        const change = { Name: name !== cur.Name ? name : undefined, Location: location !== cur.Location ? location : undefined };
        if (change.Name === undefined && change.Location === undefined) return { message: "No changes to save." };
        await updateList(ctx, kind, id, change);
        return { message: "List updated." };
      },
    },
    { id: "activate", label: "Activate", availableFor: (row) => !isActive(row), async run(ctx, id) { await updateList(ctx, kind, id, { Activate: true }); return { message: "List activated. GuardDuty now uses it when generating findings." }; } },
    { id: "deactivate", label: "Deactivate", availableFor: (row) => !isInactive(row), async run(ctx, id) { await updateList(ctx, kind, id, { Activate: false }); return { message: "List deactivated." }; } },
  ];
}

function ipList(kind: ListKind): ResourceDef {
  const trusted = kind === "ip";
  return {
    id: trusted ? "trusted-ip-lists" : "threat-lists",
    name: trusted ? "Trusted IP lists" : "Threat lists",
    singular: trusted ? "trusted IP list" : "threat list",
    idField: "id",
    nameField: "name",
    description: trusted
      ? "IP addresses you trust. GuardDuty doesn't generate VPC flow log or CloudTrail findings for them."
      : "Known malicious IP addresses. GuardDuty generates findings for activity involving them.",
    emptyText: trusted ? "No trusted IP lists." : "No threat lists.",
    columns: [
      { key: "name", label: "List name", kind: "link" },
      { key: "status", label: "Status", kind: "status" },
      { key: "format", label: "Format", kind: "text" },
      { key: "location", label: "Location", kind: "text" },
      { key: "id", label: "ID", kind: "text", hidden: true },
    ],
    async list(ctx) {
      const d = await detectorId(ctx);
      return Promise.all(
        (await listIds(ctx, kind, d)).map(async (id) => {
          const s = await getList(ctx, kind, d, id);
          return { id, name: s.Name ?? id, status: s.Status ?? null, format: s.Format ?? null, location: s.Location ?? null };
        })
      );
    },
    async get(ctx, id) {
      const s = await getList(ctx, kind, await detectorId(ctx), id);
      return {
        summary: { "List name": s.Name, ID: id, Status: s.Status, Format: s.Format, Location: s.Location },
        tabs: [{ id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(s.Tags), emptyText: "No tags." }],
      };
    },
    create: {
      title: trusted ? "Add trusted IP list" : "Add threat list",
      description: trusted ? "GuardDuty reads the list from S3. An account can have one trusted IP list per Region." : "GuardDuty reads the list from S3. An account can have up to six threat lists per Region.",
      fields: [
        { name: "name", label: "List name", kind: "text", required: true, validate: { pattern: "[A-Za-z0-9._ -]{1,300}", message: "Up to 300 letters, numbers, spaces, . _ or -." } },
        { name: "location", label: "Location", kind: "text", required: true, placeholder: "https://s3.amazonaws.com/bucket/file.txt", help: "The S3 URL of the list file, for example https://s3.amazonaws.com/my-bucket/ips.txt or s3://my-bucket/ips.txt." },
        { name: "format", label: "File format", kind: "select", required: true, default: "TXT", options: FORMATS },
        { name: "activate", label: "Activate the list", kind: "checkbox", default: true, help: "GuardDuty uses only active lists." },
        { name: "tags", label: "Tags", kind: "tags" },
      ],
      async run(ctx, v) {
        const d = await detectorId(ctx);
        const input = { DetectorId: d, Name: str(v.name), Location: str(v.location), Format: str(v.format) as IpSetFormat, Activate: v.activate === true, Tags: tagRecord(v.tags) };
        const id = trusted
          ? (await ctx.clients.guardduty.send(new CreateIPSetCommand(input))).IpSetId
          : (await ctx.clients.guardduty.send(new CreateThreatIntelSetCommand(input))).ThreatIntelSetId;
        if (!id) throw new Error("GuardDuty returned no list ID.");
        return id;
      },
    },
    actions: listActions(kind),
    delete: {
      confirmText: "delete",
      async run(ctx, id) {
        const d = await detectorId(ctx);
        if (trusted) await ctx.clients.guardduty.send(new DeleteIPSetCommand({ DetectorId: d, IpSetId: id }));
        else await ctx.clients.guardduty.send(new DeleteThreatIntelSetCommand({ DetectorId: d, ThreatIntelSetId: id }));
      },
    },
  };
}

export const trustedIpLists = ipList("ip");
export const threatLists = ipList("threat");

async function bucketOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.s3.send(new ListBucketsCommand({}));
  return (r.Buckets ?? []).filter((b) => b.Name).map((b) => ({ value: `arn:aws:s3:::${b.Name}`, label: b.Name as string }));
}

async function kmsOptions(ctx: Ctx): Promise<Option[]> {
  const [keys, aliases] = await Promise.all([
    allPages<KeyListEntry>(async (Marker) => {
      const r = await ctx.clients.kms.send(new ListKeysCommand({ Limit: 1000, Marker }));
      return { items: r.Keys, next: r.Truncated ? r.NextMarker : undefined };
    }),
    allPages<AliasListEntry>(async (Marker) => {
      const r = await ctx.clients.kms.send(new ListAliasesCommand({ Limit: 100, Marker }));
      return { items: r.Aliases, next: r.Truncated ? r.NextMarker : undefined };
    }),
  ]);
  const aliasFor = new Map(aliases.filter((a) => a.TargetKeyId).map((a) => [a.TargetKeyId as string, a.AliasName ?? ""]));
  return keys.filter((k) => k.KeyArn && k.KeyId).map((k) => ({ value: k.KeyArn as string, label: aliasFor.get(k.KeyId as string) ? `${aliasFor.get(k.KeyId as string)} (${k.KeyId})` : (k.KeyId as string) }));
}

export const publishingDestinations: ResourceDef = {
  id: "publishing-destinations",
  name: "Publishing destinations",
  singular: "publishing destination",
  idField: "id",
  nameField: "id",
  description: "Export findings to an S3 bucket, encrypted with a KMS key.",
  emptyText: "No publishing destinations. Configure one to keep findings longer than 90 days.",
  columns: [
    { key: "id", label: "Destination ID", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "bucket", label: "Destination ARN", kind: "arn" },
  ],
  async list(ctx) {
    const d = await detectorId(ctx);
    const destinations = await allPages(async (NextToken) => {
      const r = await ctx.clients.guardduty.send(new ListPublishingDestinationsCommand({ DetectorId: d, MaxResults: 50, NextToken }));
      return { items: r.Destinations, next: r.NextToken };
    });
    return Promise.all(
      destinations.map(async (x) => {
        const full = await ctx.clients.guardduty.send(new DescribePublishingDestinationCommand({ DetectorId: d, DestinationId: x.DestinationId }));
        return { id: x.DestinationId ?? "", type: x.DestinationType ?? null, status: x.Status ?? null, bucket: full.DestinationProperties?.DestinationArn ?? null };
      })
    );
  },
  async get(ctx, id) {
    const r = await ctx.clients.guardduty.send(new DescribePublishingDestinationCommand({ DetectorId: await detectorId(ctx), DestinationId: id }));
    return {
      summary: {
        "Destination ID": r.DestinationId, Type: r.DestinationType, Status: r.Status, "Destination ARN": r.DestinationProperties?.DestinationArn ?? null,
        "KMS key ARN": r.DestinationProperties?.KmsKeyArn ?? null, "Publishing failure start": r.PublishingFailureStartTimestamp ? new Date(r.PublishingFailureStartTimestamp).toISOString() : null,
      },
    };
  },
  create: {
    title: "Configure publishing destination",
    description: "Creates an S3 publishing destination with CreatePublishingDestination. The bucket policy must let GuardDuty write, and the key policy must let it encrypt.",
    fields: [
      { name: "bucket", label: "S3 bucket", kind: "select", required: true, options: bucketOptions },
      { name: "prefix", label: "Log file prefix", kind: "text", help: "Written as a folder under the bucket." },
      { name: "kmsKey", label: "KMS encryption key", kind: "select", required: true, options: kmsOptions, help: "GuardDuty requires a KMS key to encrypt exported findings." },
    ],
    async run(ctx, v) {
      const prefix = str(v.prefix).replace(/^\/+|\/+$/g, "");
      const r = await ctx.clients.guardduty.send(
        new CreatePublishingDestinationCommand({ DetectorId: await detectorId(ctx), DestinationType: "S3", DestinationProperties: { DestinationArn: prefix ? `${str(v.bucket)}/${prefix}` : str(v.bucket), KmsKeyArn: str(v.kmsKey) } })
      );
      if (!r.DestinationId) throw new Error("CreatePublishingDestination returned no ID.");
      return r.DestinationId;
    },
  },
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.guardduty.send(new DeletePublishingDestinationCommand({ DetectorId: await detectorId(ctx), DestinationId: id }));
    },
  },
};
