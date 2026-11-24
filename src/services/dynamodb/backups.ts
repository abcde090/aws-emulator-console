/**
 * DynamoDB "Backups" page: on-demand backups of tables, restore and delete.
 */

import {
  CreateBackupCommand,
  DeleteBackupCommand,
  DescribeBackupCommand,
  ListBackupsCommand,
  RestoreTableFromBackupCommand,
  type BackupSummary,
} from "@aws-sdk/client-dynamodb";
import type { Ctx, FieldDef, ResourceDef, Row } from "../../console/types.ts";
import { TABLE_NAME } from "./attr.ts";
import { keyLabel, keyNames, projectionText } from "./table-info.ts";
import { tableOptions, text } from "./shared.ts";

export const BACKUP_NAME = "[a-zA-Z0-9_.-]{3,255}";

export const restoreFields: FieldDef[] = [
  {
    name: "targetTable", label: "Name of restored table", kind: "text", required: true,
    help: "The restore creates a new table. 3-255 letters, numbers, underscores, hyphens or dots.",
    validate: { pattern: TABLE_NAME, message: "3-255 letters, numbers, underscores, hyphens or dots." },
  },
];

export async function listBackups(ctx: Ctx, tableName?: string): Promise<BackupSummary[]> {
  const out: BackupSummary[] = [];
  let start: string | undefined;
  do {
    const page = await ctx.clients.dynamodb.send(new ListBackupsCommand({ TableName: tableName, ExclusiveStartBackupArn: start, BackupType: "ALL" }));
    out.push(...(page.BackupSummaries ?? []));
    start = page.LastEvaluatedBackupArn;
  } while (start);
  return out;
}

export function backupRow(b: BackupSummary): Row {
  return {
    arn: b.BackupArn ?? "",
    name: b.BackupName ?? "",
    status: b.BackupStatus ?? null,
    table: b.TableName ?? null,
    created: b.BackupCreationDateTime ?? null,
    size: b.BackupSizeBytes ?? null,
    type: b.BackupType ?? null,
    expiry: b.BackupExpiryDateTime ?? null,
  };
}

export const backupColumns = [
  { key: "name", label: "Backup name", kind: "link" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "table", label: "Source table", kind: "text" as const },
  { key: "type", label: "Backup type", kind: "text" as const },
  { key: "size", label: "Size", kind: "bytes" as const },
  { key: "created", label: "Creation time", kind: "date" as const },
  { key: "arn", label: "Backup ARN", kind: "arn" as const, hidden: true },
];

export const backupsResource: ResourceDef = {
  id: "backups",
  name: "Backups",
  singular: "backup",
  idField: "arn",
  nameField: "name",
  description: "On-demand backups of your tables. Restoring a backup creates a new table.",
  emptyText: "No backups. Create a backup to protect a table's data.",
  columns: backupColumns,
  async list(ctx) {
    return (await listBackups(ctx)).map(backupRow);
  },
  async get(ctx, arn) {
    const d = (await ctx.clients.dynamodb.send(new DescribeBackupCommand({ BackupArn: arn }))).BackupDescription;
    const b = d?.BackupDetails;
    if (!b) throw new Error("DynamoDB returned no backup details.");
    const src = d.SourceTableDetails;
    const feats = d.SourceTableFeatureDetails;
    const keys = keyNames(src?.KeySchema);
    return {
      summary: { name: b.BackupName ?? "", Status: b.BackupStatus ?? null, "Source table": src?.TableName ?? null, "Backup ARN": b.BackupArn ?? null },
      summaryLabels: { name: "Backup name" },
      tabs: [
        {
          id: "details",
          label: "Backup details",
          kind: "keyvalue",
          data: {
            "Backup type": b.BackupType ?? null,
            "Size": b.BackupSizeBytes === undefined ? null : `${b.BackupSizeBytes} bytes`,
            "Creation time": b.BackupCreationDateTime ?? null,
            "Expiry time": b.BackupExpiryDateTime ?? null,
            "Source table ARN": src?.TableArn ?? null,
            "Partition key": keyLabel(undefined, keys.partition),
            "Sort key": keyLabel(undefined, keys.sort),
            "Item count at backup": src?.ItemCount ?? null,
            "Table size at backup (bytes)": src?.TableSizeBytes ?? null,
            "Capacity mode": src?.BillingMode === "PAY_PER_REQUEST" ? "On-demand" : src?.BillingMode ? "Provisioned" : null,
            "Encryption": feats?.SSEDescription?.SSEType ? `KMS (${feats.SSEDescription.KMSMasterKeyArn ?? "AWS managed key"})` : feats ? "Owned by Amazon DynamoDB" : null,
            "Stream": feats?.StreamDescription?.StreamEnabled ? feats.StreamDescription.StreamViewType ?? "On" : feats ? "Off" : null,
            "Time to Live": feats?.TimeToLiveDescription?.AttributeName ? `${feats.TimeToLiveDescription.TimeToLiveStatus ?? ""} (${feats.TimeToLiveDescription.AttributeName})` : null,
          },
        },
        {
          id: "indexes",
          label: "Indexes",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
            { key: "projection", label: "Projected attributes", kind: "text" },
          ],
          data: [
            ...(feats?.GlobalSecondaryIndexes ?? []).map((g) => ({ name: g.IndexName ?? "", type: "Global", projection: projectionText(g.Projection) })),
            ...(feats?.LocalSecondaryIndexes ?? []).map((l) => ({ name: l.IndexName ?? "", type: "Local", projection: projectionText(l.Projection) })),
          ],
          emptyText: "The table had no secondary indexes when it was backed up.",
        },
      ],
    };
  },
  create: {
    title: "Create backup",
    description: "Creates an on-demand backup of a table with CreateBackup.",
    fields: [
      { name: "table", label: "Source table", kind: "select", required: true, options: tableOptions, section: "Backup settings" },
      {
        name: "name", label: "Backup name", kind: "text", required: true, section: "Backup settings",
        validate: { pattern: BACKUP_NAME, message: "3-255 letters, numbers, underscores, hyphens or dots." },
      },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.dynamodb.send(new CreateBackupCommand({ TableName: text(v.table), BackupName: text(v.name) }));
      const arn = r.BackupDetails?.BackupArn;
      if (!arn) throw new Error("DynamoDB returned no backup ARN.");
      return arn;
    },
  },
  actions: [
    {
      id: "restore",
      label: "Restore",
      fields: restoreFields,
      async run(ctx, arn, v) {
        const r = await ctx.clients.dynamodb.send(new RestoreTableFromBackupCommand({ BackupArn: arn, TargetTableName: text(v.targetTable) }));
        return { message: `Restoring to new table ${r.TableDescription?.TableName ?? text(v.targetTable)} (status ${r.TableDescription?.TableStatus ?? "unknown"}).` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, arn) {
      await ctx.clients.dynamodb.send(new DeleteBackupCommand({ BackupArn: arn }));
    },
  },
};
