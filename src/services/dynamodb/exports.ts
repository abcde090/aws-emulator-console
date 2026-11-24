/**
 * DynamoDB "Exports to S3" and "Imports from S3" pages.
 */

import {
  DescribeExportCommand,
  DescribeImportCommand,
  ExportTableToPointInTimeCommand,
  ImportTableCommand,
  ListExportsCommand,
  ListImportsCommand,
  type ExportDescription,
  type ImportTableDescription,
  type InputCompressionType,
  type InputFormat,
  type ExportFormat,
  type ExportViewType,
  type S3SseAlgorithm,
  type ScalarAttributeType,
} from "@aws-sdk/client-dynamodb";
import type { Ctx, FieldDef, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import { TABLE_NAME } from "./attr.ts";
import { bucketOptions, describeTable, kmsKeyOptions, optionalText, parseDateTime, tableOptions, text } from "./shared.ts";

const tableFromArn = (arn: string | undefined): string | null => (arn ? arn.split(":table/")[1]?.split("/")[0] ?? null : null);

export const exportFields: FieldDef[] = [
  { name: "bucket", label: "Destination S3 bucket", kind: "select", required: true, options: bucketOptions, section: "Destination S3 bucket", help: "The bucket DynamoDB writes the export to." },
  { name: "prefix", label: "S3 bucket prefix", kind: "text", section: "Destination S3 bucket", placeholder: "exports/" },
  {
    name: "exportType", label: "Export type", kind: "radio", default: "FULL_EXPORT", section: "Export settings",
    options: [
      { value: "FULL_EXPORT", label: "Full export: all of the table's data at a point in time" },
      { value: "INCREMENTAL_EXPORT", label: "Incremental export: data that changed during a period" },
    ],
  },
  { name: "exportTime", label: "Export from a specific point in time", kind: "text", section: "Export settings", showIf: { field: "exportType", equals: "FULL_EXPORT" }, placeholder: "2026-11-23T10:00:00Z", help: "Leave empty to export the current state." },
  { name: "fromTime", label: "Export period start", kind: "text", required: true, section: "Export settings", showIf: { field: "exportType", equals: "INCREMENTAL_EXPORT" }, placeholder: "2026-11-23T09:00:00Z" },
  { name: "toTime", label: "Export period end", kind: "text", required: true, section: "Export settings", showIf: { field: "exportType", equals: "INCREMENTAL_EXPORT" }, placeholder: "2026-11-23T10:00:00Z" },
  {
    name: "viewType", label: "Exported view type", kind: "radio", default: "NEW_AND_OLD_IMAGES", section: "Export settings", showIf: { field: "exportType", equals: "INCREMENTAL_EXPORT" },
    options: [
      { value: "NEW_AND_OLD_IMAGES", label: "New and old images" },
      { value: "NEW_IMAGE", label: "New images" },
    ],
  },
  {
    name: "format", label: "Exported file format", kind: "radio", default: "DYNAMODB_JSON", section: "Export settings",
    options: [
      { value: "DYNAMODB_JSON", label: "DynamoDB JSON" },
      { value: "ION", label: "Amazon Ion" },
    ],
  },
  {
    name: "sse", label: "Encryption key type", kind: "radio", default: "AES256", section: "Encryption",
    options: [
      { value: "AES256", label: "Amazon S3 key (SSE-S3)" },
      { value: "KMS", label: "AWS KMS key (SSE-KMS)" },
    ],
  },
  { name: "kmsKey", label: "AWS KMS key", kind: "select", required: true, options: kmsKeyOptions, section: "Encryption", showIf: { field: "sse", equals: "KMS" } },
];

/** Runs ExportTableToPointInTime for a table with the export form's values. */
export async function runExport(ctx: Ctx, tableName: string, v: FieldValues): Promise<ExportDescription> {
  const table = await describeTable(ctx, tableName);
  const incremental = v.exportType === "INCREMENTAL_EXPORT";
  const r = await ctx.clients.dynamodb.send(
    new ExportTableToPointInTimeCommand({
      TableArn: table.TableArn,
      S3Bucket: text(v.bucket),
      S3Prefix: optionalText(v.prefix),
      ExportFormat: (v.format === "ION" ? "ION" : "DYNAMODB_JSON") as ExportFormat,
      S3SseAlgorithm: (v.sse === "KMS" ? "KMS" : "AES256") as S3SseAlgorithm,
      S3SseKmsKeyId: v.sse === "KMS" ? optionalText(v.kmsKey) : undefined,
      ExportType: incremental ? "INCREMENTAL_EXPORT" : "FULL_EXPORT",
      ExportTime: !incremental && optionalText(v.exportTime) ? parseDateTime(v.exportTime, "Export time") : undefined,
      IncrementalExportSpecification: incremental
        ? {
            ExportFromTime: parseDateTime(v.fromTime, "Export period start"),
            ExportToTime: parseDateTime(v.toTime, "Export period end"),
            ExportViewType: (v.viewType === "NEW_IMAGE" ? "NEW_IMAGE" : "NEW_AND_OLD_IMAGES") as ExportViewType,
          }
        : undefined,
    })
  );
  if (!r.ExportDescription) throw new Error("DynamoDB returned no export description.");
  return r.ExportDescription;
}

function exportRow(e: ExportDescription): Row {
  return {
    arn: e.ExportArn ?? "",
    exportId: e.ExportArn?.split("/export/")[1] ?? e.ExportArn ?? "",
    status: e.ExportStatus ?? null,
    table: tableFromArn(e.TableArn),
    bucket: e.S3Bucket ?? null,
    type: e.ExportType === "INCREMENTAL_EXPORT" ? "Incremental export" : e.ExportType === "FULL_EXPORT" ? "Full export" : e.ExportType ?? null,
    started: e.StartTime ?? null,
    items: e.ItemCount ?? null,
  };
}

export const exportsResource: ResourceDef = {
  id: "exports",
  name: "Exports to S3",
  singular: "export",
  idField: "arn",
  nameField: "exportId",
  description: "Export table data to an Amazon S3 bucket at a point in time, without using the table's read capacity.",
  emptyText: "No exports. Export a table to S3 to get started.",
  columns: [
    { key: "exportId", label: "Export ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "table", label: "Source table", kind: "text" },
    { key: "bucket", label: "Destination S3 bucket", kind: "text" },
    { key: "type", label: "Export type", kind: "text" },
    { key: "started", label: "Export job start time", kind: "date" },
    { key: "arn", label: "Export ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    const arns: string[] = [];
    let token: string | undefined;
    do {
      const page = await ctx.clients.dynamodb.send(new ListExportsCommand({ NextToken: token, MaxResults: 25 }));
      for (const s of page.ExportSummaries ?? []) if (s.ExportArn) arns.push(s.ExportArn);
      token = page.NextToken;
    } while (token);
    const rows = await Promise.all(arns.map(async (arn) => (await ctx.clients.dynamodb.send(new DescribeExportCommand({ ExportArn: arn }))).ExportDescription));
    return rows.filter((e): e is ExportDescription => e !== undefined).map(exportRow);
  },
  async get(ctx, arn) {
    const e = (await ctx.clients.dynamodb.send(new DescribeExportCommand({ ExportArn: arn }))).ExportDescription;
    if (!e) throw new Error("DynamoDB returned no export description.");
    const row = exportRow(e);
    return {
      summary: { exportId: row.exportId, Status: row.status, "Source table": row.table, "Export ARN": e.ExportArn ?? null },
      summaryLabels: { exportId: "Export ID" },
      tabs: [
        {
          id: "details",
          label: "Export details",
          kind: "keyvalue",
          data: {
            "Export type": row.type,
            "Exported file format": e.ExportFormat === "ION" ? "Amazon Ion" : e.ExportFormat === "DYNAMODB_JSON" ? "DynamoDB JSON" : e.ExportFormat ?? null,
            "Point in time": e.ExportTime ?? null,
            "Export period start": e.IncrementalExportSpecification?.ExportFromTime ?? null,
            "Export period end": e.IncrementalExportSpecification?.ExportToTime ?? null,
            "Destination S3 bucket": e.S3Bucket ?? null,
            "S3 bucket prefix": e.S3Prefix ?? null,
            "Encryption": e.S3SseAlgorithm === "KMS" ? `SSE-KMS (${e.S3SseKmsKeyId ?? "AWS managed key"})` : e.S3SseAlgorithm === "AES256" ? "SSE-S3" : null,
            "Manifest": e.ExportManifest ?? null,
            "Items exported": e.ItemCount ?? null,
            "Billed size (bytes)": e.BilledSizeBytes ?? null,
            "Start time": e.StartTime ?? null,
            "End time": e.EndTime ?? null,
            "Failure": e.FailureCode ? `${e.FailureCode}: ${e.FailureMessage ?? ""}` : null,
          },
        },
      ],
    };
  },
  create: {
    title: "Export to S3",
    description: "Exports a table to Amazon S3 with ExportTableToPointInTime. The table needs point-in-time recovery turned on.",
    fields: [{ name: "table", label: "Source table", kind: "select", required: true, options: tableOptions, section: "Source table" }, ...exportFields],
    async run(ctx, v) {
      const e = await runExport(ctx, text(v.table), v);
      if (!e.ExportArn) throw new Error("DynamoDB returned no export ARN.");
      return e.ExportArn;
    },
  },
};

// ---- Imports ----

function importRow(i: ImportTableDescription): Row {
  return {
    arn: i.ImportArn ?? "",
    importId: i.ImportArn?.split("/import/")[1] ?? i.ImportArn ?? "",
    status: i.ImportStatus ?? null,
    table: tableFromArn(i.TableArn),
    source: i.S3BucketSource ? `s3://${i.S3BucketSource.S3Bucket ?? ""}/${i.S3BucketSource.S3KeyPrefix ?? ""}` : null,
    format: i.InputFormat ?? null,
    started: i.StartTime ?? null,
    imported: i.ImportedItemCount ?? null,
  };
}

const KEY_TYPES = [
  { value: "S", label: "String" },
  { value: "N", label: "Number" },
  { value: "B", label: "Binary" },
];

export const importsResource: ResourceDef = {
  id: "imports",
  name: "Imports from S3",
  singular: "import",
  idField: "arn",
  nameField: "importId",
  description: "Import data from Amazon S3 into a new DynamoDB table.",
  emptyText: "No imports. Import from S3 to create a table from data in a bucket.",
  columns: [
    { key: "importId", label: "Import ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "table", label: "Destination table", kind: "text" },
    { key: "source", label: "Source S3 URL", kind: "text" },
    { key: "format", label: "Import file format", kind: "text" },
    { key: "imported", label: "Items imported", kind: "count" },
    { key: "started", label: "Start time", kind: "date" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const page = await ctx.clients.dynamodb.send(new ListImportsCommand({ NextToken: token, PageSize: 25 }));
      for (const s of page.ImportSummaryList ?? []) {
        if (!s.ImportArn) continue;
        const d = (await ctx.clients.dynamodb.send(new DescribeImportCommand({ ImportArn: s.ImportArn }))).ImportTableDescription;
        if (d) rows.push(importRow(d));
      }
      token = page.NextToken;
    } while (token);
    return rows;
  },
  async get(ctx, arn) {
    const i = (await ctx.clients.dynamodb.send(new DescribeImportCommand({ ImportArn: arn }))).ImportTableDescription;
    if (!i) throw new Error("DynamoDB returned no import description.");
    const row = importRow(i);
    const p = i.TableCreationParameters;
    return {
      summary: { importId: row.importId, Status: row.status, "Destination table": row.table, "Import ARN": i.ImportArn ?? null },
      summaryLabels: { importId: "Import ID" },
      tabs: [
        {
          id: "details",
          label: "Import details",
          kind: "keyvalue",
          data: {
            "Source S3 URL": row.source,
            "Import file format": i.InputFormat ?? null,
            "Compression type": i.InputCompressionType ?? null,
            "Processed items": i.ProcessedItemCount ?? null,
            "Imported items": i.ImportedItemCount ?? null,
            "Processed size (bytes)": i.ProcessedSizeBytes ?? null,
            "Errors": i.ErrorCount ?? null,
            "Failure": i.FailureCode ? `${i.FailureCode}: ${i.FailureMessage ?? ""}` : null,
            "CloudWatch log group": i.CloudWatchLogGroupArn ?? null,
            "Start time": i.StartTime ?? null,
            "End time": i.EndTime ?? null,
          },
        },
        { id: "table", label: "Table creation parameters", kind: "json", data: p ?? null, emptyText: "No table creation parameters were returned." },
      ],
    };
  },
  create: {
    title: "Import from S3",
    description: "Creates a new table and loads it from files in S3 with ImportTable.",
    fields: [
      { name: "bucket", label: "Source S3 bucket", kind: "select", required: true, options: bucketOptions, section: "Import details" },
      { name: "prefix", label: "S3 key prefix", kind: "text", section: "Import details", placeholder: "AWSDynamoDB/01234567890123-abcdef12/data/" },
      {
        name: "format", label: "Import file format", kind: "radio", default: "DYNAMODB_JSON", section: "Import details",
        options: [
          { value: "DYNAMODB_JSON", label: "DynamoDB JSON" },
          { value: "ION", label: "Amazon Ion" },
          { value: "CSV", label: "CSV" },
        ],
      },
      {
        name: "compression", label: "Import file compression", kind: "radio", default: "NONE", section: "Import details",
        options: [
          { value: "NONE", label: "No compression" },
          { value: "GZIP", label: "GZIP" },
          { value: "ZSTD", label: "ZSTD" },
        ],
      },
      { name: "csvDelimiter", label: "CSV delimiter character", kind: "text", default: ",", section: "Import details", showIf: { field: "format", equals: "CSV" }, validate: { pattern: "[,\\t:;| ]", message: "Use comma, tab, colon, semicolon, pipe or space." } },
      {
        name: "tableName", label: "Table name", kind: "text", required: true, section: "Destination table - new table",
        validate: { pattern: TABLE_NAME, message: "3-255 letters, numbers, underscores, hyphens or dots." },
      },
      { name: "partitionKey", label: "Partition key", kind: "text", required: true, section: "Destination table - new table" },
      { name: "partitionKeyType", label: "Partition key type", required: true, kind: "select", default: "S", options: KEY_TYPES, section: "Destination table - new table" },
      { name: "sortKey", label: "Sort key", kind: "text", section: "Destination table - new table" },
      { name: "sortKeyType", label: "Sort key type", required: true, kind: "select", default: "S", options: KEY_TYPES, section: "Destination table - new table" },
    ],
    async run(ctx, v) {
      const pk = text(v.partitionKey);
      const sk = optionalText(v.sortKey);
      if (sk === pk) throw new Error("The sort key must be different from the partition key.");
      const r = await ctx.clients.dynamodb.send(
        new ImportTableCommand({
          S3BucketSource: { S3Bucket: text(v.bucket), S3KeyPrefix: optionalText(v.prefix) },
          InputFormat: text(v.format) as InputFormat,
          InputCompressionType: text(v.compression) as InputCompressionType,
          InputFormatOptions: v.format === "CSV" ? { Csv: { Delimiter: text(v.csvDelimiter) || "," } } : undefined,
          TableCreationParameters: {
            TableName: text(v.tableName),
            BillingMode: "PAY_PER_REQUEST",
            AttributeDefinitions: [
              { AttributeName: pk, AttributeType: text(v.partitionKeyType) as ScalarAttributeType },
              ...(sk ? [{ AttributeName: sk, AttributeType: text(v.sortKeyType) as ScalarAttributeType }] : []),
            ],
            KeySchema: [{ AttributeName: pk, KeyType: "HASH" }, ...(sk ? [{ AttributeName: sk, KeyType: "RANGE" as const }] : [])],
          },
        })
      );
      const arn = r.ImportTableDescription?.ImportArn;
      if (!arn) throw new Error("DynamoDB returned no import ARN.");
      return arn;
    },
  },
};
