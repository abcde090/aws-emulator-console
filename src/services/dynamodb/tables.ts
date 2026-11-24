/**
 * DynamoDB "Tables": list, create form, the table detail tabs (Overview, Indexes,
 * Monitoring, Global tables, Backups, Exports and streams, Permissions, Additional
 * settings, Tags) and the table's Actions menu.
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTimeToLiveCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  type CreateTableCommandInput,
  type GlobalSecondaryIndex,
  type LocalSecondaryIndex,
  type TableClass,
  type TableDescription,
} from "@aws-sdk/client-dynamodb";
import type { Ctx, FieldDef, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import { TABLE_NAME } from "./attr.ts";
import { backupColumns, backupRow, listBackups } from "./backups.ts";
import { tableMetrics } from "./monitoring.ts";
import { optionalRead } from "../../console/secondary.ts";
import { describeTable, kmsKeyOptions, listTableNames, numberOr, optionalText, tagList, text } from "./shared.ts";
import { tableActions } from "./table-actions.ts";
import { ENCRYPTION, KEY_TYPES, PROJECTIONS, addDef, projection, sseSpec } from "./table-form.ts";
import { averageItemSize, capacityMode, capacityText, encryptionText, indexRows, keyLabel, keyNames, tableClassText } from "./table-info.ts";

const yesNo = (b: boolean | undefined): string => (b ? "On" : "Off");

export function createTableInput(v: FieldValues): CreateTableCommandInput {
  const name = text(v.tableName);
  const pk = text(v.partitionKey);
  const sk = optionalText(v.sortKey);
  if (sk === pk) throw new Error("The sort key must be different from the partition key.");
  let defs = addDef([], pk, text(v.partitionKeyType));
  if (sk) defs = addDef(defs, sk, text(v.sortKeyType));
  const provisioned = v.capacityMode === "PROVISIONED";
  const throughput = provisioned ? { ReadCapacityUnits: numberOr(v.rcu, 5), WriteCapacityUnits: numberOr(v.wcu, 5) } : undefined;

  const gsis: GlobalSecondaryIndex[] = [];
  if (v.addGsi === true) {
    const gpk = text(v.gsiPartitionKey);
    const gsk = optionalText(v.gsiSortKey);
    if (!text(v.gsiName) || !gpk) throw new Error("A global secondary index needs a name and a partition key.");
    defs = addDef(defs, gpk, text(v.gsiPartitionKeyType));
    if (gsk) defs = addDef(defs, gsk, text(v.gsiSortKeyType));
    gsis.push({
      IndexName: text(v.gsiName),
      KeySchema: [{ AttributeName: gpk, KeyType: "HASH" }, ...(gsk ? [{ AttributeName: gsk, KeyType: "RANGE" as const }] : [])],
      Projection: projection(v, "gsi"),
      ProvisionedThroughput: throughput,
    });
  }
  const lsis: LocalSecondaryIndex[] = [];
  if (v.addLsi === true) {
    if (!sk) throw new Error("A local secondary index needs a table with a sort key.");
    const lsk = text(v.lsiSortKey);
    if (!text(v.lsiName) || !lsk) throw new Error("A local secondary index needs a name and a sort key.");
    defs = addDef(defs, lsk, text(v.lsiSortKeyType));
    lsis.push({
      IndexName: text(v.lsiName),
      KeySchema: [{ AttributeName: pk, KeyType: "HASH" }, { AttributeName: lsk, KeyType: "RANGE" }],
      Projection: projection(v, "lsi"),
    });
  }
  const tags = tagList(v.tags);
  return {
    TableName: name,
    AttributeDefinitions: defs,
    KeySchema: [{ AttributeName: pk, KeyType: "HASH" }, ...(sk ? [{ AttributeName: sk, KeyType: "RANGE" as const }] : [])],
    BillingMode: provisioned ? "PROVISIONED" : "PAY_PER_REQUEST",
    ProvisionedThroughput: throughput,
    GlobalSecondaryIndexes: gsis.length ? gsis : undefined,
    LocalSecondaryIndexes: lsis.length ? lsis : undefined,
    TableClass: (v.tableClass === "STANDARD_INFREQUENT_ACCESS" ? "STANDARD_INFREQUENT_ACCESS" : "STANDARD") as TableClass,
    SSESpecification: sseSpec(v),
    DeletionProtectionEnabled: v.deletionProtection === true,
    ResourcePolicy: optionalText(v.resourcePolicy),
    Tags: tags.length ? tags : undefined,
  };
}

function tableRow(t: TableDescription): Row {
  const k = keyNames(t.KeySchema);
  return {
    name: t.TableName ?? "",
    status: t.TableStatus ?? null,
    partitionKey: keyLabel(t.AttributeDefinitions, k.partition),
    sortKey: keyLabel(t.AttributeDefinitions, k.sort),
    indexes: (t.GlobalSecondaryIndexes?.length ?? 0) + (t.LocalSecondaryIndexes?.length ?? 0),
    replicas: (t.Replicas ?? []).map((r) => r.RegionName).filter(Boolean).join(", ") || null,
    deletionProtection: yesNo(t.DeletionProtectionEnabled),
    readCapacity: capacityText(t, "read"),
    writeCapacity: capacityText(t, "write"),
    size: t.TableSizeBytes ?? null,
    tableClass: tableClassText(t),
    items: t.ItemCount ?? null,
    arn: t.TableArn ?? null,
  };
}

const keyFields = (prefix: string, section: string, label: string, optional: boolean): FieldDef[] => [
  {
    name: `${prefix}Key`, label: label, kind: "text", required: !optional, section,
    help: optional ? "Sorts and groups items that share a partition key." : "The table's primary key. Part of the hash used to spread data across partitions.",
    validate: { pattern: ".{1,255}", message: "1-255 characters." },
  },
  { name: `${prefix}KeyType`, label: `${label} type`, required: true, kind: "select", default: "S", options: KEY_TYPES, section },
];

async function readPolicy(ctx: Ctx, arn: string) {
  return optionalRead(() => ctx.clients.dynamodb.send(new GetResourcePolicyCommand({ ResourceArn: arn })), ["PolicyNotFoundException"]);
}

function parsePolicy(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function tableDetail(ctx: Ctx, name: string) {
  const ddb = ctx.clients.dynamodb;
  const t = await describeTable(ctx, name);
  const arn = t.TableArn ?? "";
  const [pitr, ttl, kinesis, insights, tags, policy, backups, metrics] = await Promise.all([
    optionalRead(() => ddb.send(new DescribeContinuousBackupsCommand({ TableName: name })), []),
    optionalRead(() => ddb.send(new DescribeTimeToLiveCommand({ TableName: name })), []),
    optionalRead(() => ddb.send(new DescribeKinesisStreamingDestinationCommand({ TableName: name })), []),
    optionalRead(() => ddb.send(new DescribeContributorInsightsCommand({ TableName: name })), []),
    optionalRead(() => ddb.send(new ListTagsOfResourceCommand({ ResourceArn: arn })), []),
    readPolicy(ctx, arn),
    optionalRead(() => listBackups(ctx, name), []),
    optionalRead(() => tableMetrics(ctx, name), []),
  ]);
  return { t, pitr, ttl, kinesis, insights, tags, policy, backups, metrics };
}

const unreadable = (o: { kind: "error"; error: string }): string => `Could not read: ${o.error}`;

const indexColumns = [
  { key: "name", label: "Name", kind: "text" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "type", label: "Type", kind: "text" as const },
  { key: "partitionKey", label: "Partition key", kind: "text" as const },
  { key: "sortKey", label: "Sort key", kind: "text" as const },
  { key: "projection", label: "Projected attributes", kind: "text" as const },
  { key: "readCapacity", label: "Read capacity", kind: "text" as const },
  { key: "writeCapacity", label: "Write capacity", kind: "text" as const },
  { key: "size", label: "Size", kind: "bytes" as const },
  { key: "items", label: "Item count", kind: "count" as const },
];

export const tablesResource: ResourceDef = {
  id: "tables",
  name: "Tables",
  singular: "table",
  idField: "name",
  nameField: "name",
  description: "DynamoDB tables store items, identified by their primary key.",
  emptyText: "You have no tables in this account in this AWS Region.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "partitionKey", label: "Partition key", kind: "text" },
    { key: "sortKey", label: "Sort key", kind: "text" },
    { key: "indexes", label: "Indexes", kind: "count" },
    { key: "replicas", label: "Replication Regions", kind: "text" },
    { key: "deletionProtection", label: "Deletion protection", kind: "text" },
    { key: "readCapacity", label: "Read capacity mode", kind: "text" },
    { key: "writeCapacity", label: "Write capacity mode", kind: "text" },
    { key: "size", label: "Total size", kind: "bytes" },
    { key: "tableClass", label: "Table class", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const names = await listTableNames(ctx);
    const rows = await Promise.all(
      names.map(async (n) => {
        try {
          return tableRow(await describeTable(ctx, n));
        } catch {
          // Deleted between ListTables and DescribeTable: leave it out.
          return null;
        }
      })
    );
    return rows.filter((r): r is Row => r !== null);
  },

  async get(ctx, name) {
    const { t, pitr, ttl, kinesis, insights, tags, policy, backups, metrics } = await tableDetail(ctx, name);
    const k = keyNames(t.KeySchema);
    const pitrDesc = pitr.kind === "value" ? pitr.value.ContinuousBackupsDescription?.PointInTimeRecoveryDescription : undefined;
    const pitrText = pitr.kind === "error" ? unreadable(pitr) : pitrDesc?.PointInTimeRecoveryStatus === "ENABLED" ? "On" : "Off";
    const ttlDesc = ttl.kind === "value" ? ttl.value.TimeToLiveDescription : undefined;
    const ttlText = ttl.kind === "error" ? unreadable(ttl) : ttlDesc?.TimeToLiveStatus && ttlDesc.TimeToLiveStatus !== "DISABLED" ? `${ttlDesc.TimeToLiveStatus} (attribute ${ttlDesc.AttributeName ?? "-"})` : "Off";
    const stream = t.StreamSpecification?.StreamEnabled ? `On (${t.StreamSpecification.StreamViewType ?? ""})` : "Off";
    const backupSummaries = backups.kind === "value" ? backups.value : [];
    return {
      summary: {
        name: t.TableName ?? name,
        status: t.TableStatus ?? null,
        partitionKey: keyLabel(t.AttributeDefinitions, k.partition),
        sortKey: keyLabel(t.AttributeDefinitions, k.sort) ?? "-",
        capacityMode: capacityMode(t),
        pitr: pitrText,
        arn: t.TableArn ?? null,
      },
      summaryLabels: {
        name: "Table name",
        status: "Table status",
        partitionKey: "Partition key",
        sortKey: "Sort key",
        capacityMode: "Capacity mode",
        pitr: "Point-in-time recovery (PITR)",
        arn: "Amazon Resource Name (ARN)",
      },
      tabs: [
        {
          id: "overview",
          label: "Overview",
          kind: "keyvalue",
          description: "Item count, table size and average item size come from DescribeTable.",
          data: {
            "Item count": t.ItemCount ?? null,
            "Table size (bytes)": t.TableSizeBytes ?? null,
            "Average item size (bytes)": averageItemSize(t),
            "Read capacity": capacityText(t, "read"),
            "Write capacity": capacityText(t, "write"),
            "Table class": tableClassText(t),
            "Encryption": encryptionText(t),
            "KMS key ARN": t.SSEDescription?.KMSMasterKeyArn ?? null,
            "Deletion protection": yesNo(t.DeletionProtectionEnabled),
            "Time to Live (TTL)": ttlText,
            "DynamoDB stream": stream,
            "Resource-based policy": policy.kind === "value" ? "Active" : policy.kind === "missing" ? "Not active" : unreadable(policy),
            "Creation date": t.CreationDateTime ?? null,
            "Table ID": t.TableId ?? null,
            "Restored from": t.RestoreSummary ? t.RestoreSummary.SourceBackupArn ?? t.RestoreSummary.SourceTableArn ?? null : null,
          },
        },
        {
          id: "indexes",
          label: "Indexes",
          kind: "table",
          columns: indexColumns,
          data: indexRows(t),
          description: "Global secondary indexes have their own key and capacity; local secondary indexes share the table's partition key.",
          emptyText: "No secondary indexes. Use Actions > Create index to add a global secondary index.",
        },
        {
          id: "monitoring",
          label: "Monitoring",
          kind: "table",
          columns: [
            { key: "metric", label: "Metric", kind: "text" },
            { key: "dimension", label: "Index / operation", kind: "text" },
            { key: "statistic", label: "Statistic", kind: "text" },
            { key: "datapoints", label: "Datapoints (24 h)", kind: "count" },
            { key: "total", label: "Value over 24 h", kind: "text" },
            { key: "latest", label: "Latest datapoint", kind: "date" },
          ],
          data: metrics.kind === "value" ? metrics.value : [],
          description: `CloudWatch metrics in AWS/DynamoDB for this table, last 24 hours, 5-minute periods. Contributor Insights: ${
            insights.kind === "value" ? insights.value.ContributorInsightsStatus ?? "DISABLED" : insights.kind === "error" ? unreadable(insights) : "DISABLED"
          } (graphs of the most accessed and throttled keys are in the Contributor Insights tab).`,
          emptyText: metrics.kind === "error" ? unreadable(metrics) : "CloudWatch has no metrics for this table yet. Read or write some items.",
        },
        {
          id: "global-tables",
          label: "Global tables",
          kind: "table",
          columns: [
            { key: "region", label: "Region", kind: "text" },
            { key: "status", label: "Replica status", kind: "status" },
            { key: "tableClass", label: "Table class", kind: "text" },
            { key: "arn", label: "Replica ARN", kind: "arn" },
          ],
          data: (t.Replicas ?? []).map((r) => ({ region: r.RegionName ?? "", status: r.ReplicaStatus ?? null, tableClass: r.ReplicaTableClassSummary?.TableClass ?? null, arn: r.ReplicaArn ?? null })),
          description: `Global table version: ${t.GlobalTableVersion ?? "not a global table"}. Replicas keep a full copy of the table in another Region.`,
          emptyText: "No replicas. Use Actions > Create replica to make this a global table.",
        },
        {
          id: "backups",
          label: "Backups",
          kind: "table",
          columns: backupColumns,
          data: backupSummaries.map(backupRow),
          description:
            pitr.kind === "value"
              ? `Point-in-time recovery (PITR): ${pitrText}${
                  pitrDesc?.PointInTimeRecoveryStatus === "ENABLED"
                    ? `. Recovery period ${pitrDesc.RecoveryPeriodInDays ?? 35} days. Earliest restorable time ${pitrDesc.EarliestRestorableDateTime?.toISOString() ?? "-"}, latest ${pitrDesc.LatestRestorableDateTime?.toISOString() ?? "-"}.`
                    : "."
                }`
              : pitrText,
          emptyText: backups.kind === "error" ? unreadable(backups) : "No on-demand backups of this table.",
        },
        {
          id: "streams",
          label: "Exports and streams",
          kind: "keyvalue",
          data: {
            "DynamoDB stream": stream,
            "Latest stream ARN": t.LatestStreamArn ?? null,
            "Latest stream label": t.LatestStreamLabel ?? null,
            "Amazon Kinesis data stream":
              kinesis.kind === "value"
                ? (kinesis.value.KinesisDataStreamDestinations ?? []).map((d) => `${d.StreamArn ?? ""} (${d.DestinationStatus ?? ""})`).join("; ") || "Off"
                : kinesis.kind === "error"
                  ? unreadable(kinesis)
                  : "Off",
          },
          description: "Exports of this table are listed on the Exports to S3 page.",
        },
        {
          id: "permissions",
          label: "Permissions",
          kind: "json",
          data: policy.kind === "value" ? parsePolicy(policy.value.Policy) : null,
          description: "The table's resource-based policy.",
          emptyText: policy.kind === "error" ? unreadable(policy) : "No resource-based policy. Use Actions > Edit resource-based policy to add one.",
        },
        {
          id: "settings",
          label: "Additional settings",
          kind: "keyvalue",
          data: {
            "Capacity mode": capacityMode(t),
            "Provisioned read capacity units": capacityMode(t) === "Provisioned" ? t.ProvisionedThroughput?.ReadCapacityUnits ?? null : null,
            "Provisioned write capacity units": capacityMode(t) === "Provisioned" ? t.ProvisionedThroughput?.WriteCapacityUnits ?? null : null,
            "Maximum on-demand read request units": t.OnDemandThroughput?.MaxReadRequestUnits ?? null,
            "Maximum on-demand write request units": t.OnDemandThroughput?.MaxWriteRequestUnits ?? null,
            "Warm throughput (reads/s)": t.WarmThroughput?.ReadUnitsPerSecond ?? null,
            "Warm throughput (writes/s)": t.WarmThroughput?.WriteUnitsPerSecond ?? null,
            "Time to Live (TTL)": ttlText,
            "Encryption": encryptionText(t),
            "Deletion protection": yesNo(t.DeletionProtectionEnabled),
            "Table class": tableClassText(t),
            "Contributor Insights": insights.kind === "value" ? insights.value.ContributorInsightsStatus ?? "DISABLED" : insights.kind === "error" ? unreadable(insights) : "DISABLED",
          },
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tags.kind === "value" ? tags.value.Tags ?? [] : [],
          emptyText: tags.kind === "error" ? unreadable(tags) : "No tags are associated with this table.",
        },
      ],
    };
  },

  create: {
    title: "Create table",
    description: "Creates a DynamoDB table with CreateTable. Indexes, encryption, deletion protection and the table class are set at creation; you can change most of them later from Actions.",
    fields: [
      {
        name: "tableName", label: "Table name", kind: "text", required: true, section: "Table details", placeholder: "Music",
        help: "Between 3 and 255 characters, containing only letters, numbers, underscores (_), hyphens (-), and periods (.).",
        validate: { pattern: TABLE_NAME, message: "3-255 letters, numbers, underscores, hyphens or periods." },
      },
      ...keyFields("partition", "Table details", "Partition key", false),
      ...keyFields("sort", "Table details", "Sort key", true),
      {
        name: "tableClass", label: "Table class", kind: "radio", default: "STANDARD", section: "Table settings",
        options: [
          { value: "STANDARD", label: "DynamoDB Standard: the default, for most workloads" },
          { value: "STANDARD_INFREQUENT_ACCESS", label: "DynamoDB Standard-IA: lower storage cost for data you rarely access" },
        ],
      },
      {
        name: "capacityMode", label: "Capacity mode", kind: "radio", default: "PAY_PER_REQUEST", section: "Read/write capacity settings",
        options: [
          { value: "PAY_PER_REQUEST", label: "On-demand: pay per request, scales automatically" },
          { value: "PROVISIONED", label: "Provisioned: set read and write capacity units" },
        ],
      },
      { name: "rcu", label: "Read capacity units", kind: "number", default: 5, section: "Read/write capacity settings", showIf: { field: "capacityMode", equals: "PROVISIONED" }, validate: { min: 1, max: 40000, message: "Between 1 and 40,000." } },
      { name: "wcu", label: "Write capacity units", kind: "number", default: 5, section: "Read/write capacity settings", showIf: { field: "capacityMode", equals: "PROVISIONED" }, validate: { min: 1, max: 40000, message: "Between 1 and 40,000." } },
      { name: "addGsi", label: "Create a global secondary index", kind: "checkbox", default: false, section: "Secondary indexes", help: "Add more indexes later with Actions > Create index." },
      { name: "gsiName", required: true, label: "Index name", kind: "text", section: "Secondary indexes", showIf: { field: "addGsi", equals: true }, validate: { pattern: "[a-zA-Z0-9_.-]{3,255}", message: "3-255 letters, numbers, underscores, hyphens or periods." } },
      { name: "gsiPartitionKey", required: true, label: "Index partition key", kind: "text", section: "Secondary indexes", showIf: { field: "addGsi", equals: true } },
      { name: "gsiPartitionKeyType", label: "Index partition key type", required: true, kind: "select", default: "S", options: KEY_TYPES, section: "Secondary indexes", showIf: { field: "addGsi", equals: true } },
      { name: "gsiSortKey", label: "Index sort key", kind: "text", section: "Secondary indexes", showIf: { field: "addGsi", equals: true } },
      { name: "gsiSortKeyType", label: "Index sort key type", required: true, kind: "select", default: "S", options: KEY_TYPES, section: "Secondary indexes", showIf: { field: "addGsi", equals: true } },
      { name: "gsiProjection", label: "Index attribute projections", required: true, kind: "select", default: "ALL", options: PROJECTIONS, section: "Secondary indexes", showIf: { field: "addGsi", equals: true } },
      { name: "gsiNonKey", label: "Index projected attributes", kind: "text", section: "Secondary indexes", showIf: { field: "gsiProjection", equals: "INCLUDE" }, help: "Comma-separated attribute names." },
      { name: "addLsi", label: "Create a local secondary index", kind: "checkbox", default: false, section: "Secondary indexes", help: "Local secondary indexes can only be created with the table, and need a table sort key." },
      { name: "lsiName", required: true, label: "Local index name", kind: "text", section: "Secondary indexes", showIf: { field: "addLsi", equals: true }, validate: { pattern: "[a-zA-Z0-9_.-]{3,255}", message: "3-255 letters, numbers, underscores, hyphens or periods." } },
      { name: "lsiSortKey", required: true, label: "Local index sort key", kind: "text", section: "Secondary indexes", showIf: { field: "addLsi", equals: true } },
      { name: "lsiSortKeyType", label: "Local index sort key type", required: true, kind: "select", default: "S", options: KEY_TYPES, section: "Secondary indexes", showIf: { field: "addLsi", equals: true } },
      { name: "lsiProjection", label: "Local index attribute projections", required: true, kind: "select", default: "ALL", options: PROJECTIONS, section: "Secondary indexes", showIf: { field: "addLsi", equals: true } },
      { name: "lsiNonKey", label: "Local index projected attributes", kind: "text", section: "Secondary indexes", showIf: { field: "lsiProjection", equals: "INCLUDE" }, help: "Comma-separated attribute names." },
      { name: "encryption", label: "Encryption key management", kind: "radio", default: "OWNED", options: ENCRYPTION, section: "Encryption at rest" },
      { name: "kmsKey", label: "AWS KMS key", kind: "select", required: true, options: kmsKeyOptions, section: "Encryption at rest", showIf: { field: "encryption", equals: "CMK" } },
      { name: "deletionProtection", label: "Turn on deletion protection", kind: "checkbox", default: false, section: "Deletion protection", help: "Protects the table from being deleted until you turn this off." },
      { name: "resourcePolicy", label: "Resource-based policy", kind: "json", section: "Resource-based policy", help: "A JSON policy that controls access to this table." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const input = createTableInput(v);
      await ctx.clients.dynamodb.send(new CreateTableCommand(input));
      return input.TableName ?? "";
    },
  },

  actions: tableActions(),

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.dynamodb.send(new DeleteTableCommand({ TableName: name }));
    },
  },
};
