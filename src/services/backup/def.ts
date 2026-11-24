/**
 * AWS Backup: vaults, recovery points, backup plans (rules, copy to another Region,
 * resource assignments) and backup / restore / copy jobs. The dashboard is hand-built
 * (src/app/backup/page.tsx). Every value comes from a Backup API response.
 */

import {
  CreateBackupPlanCommand,
  CreateBackupSelectionCommand,
  CreateBackupVaultCommand,
  DeleteBackupPlanCommand,
  DeleteBackupSelectionCommand,
  DeleteBackupVaultAccessPolicyCommand,
  DeleteBackupVaultCommand,
  DeleteBackupVaultLockConfigurationCommand,
  DeleteRecoveryPointCommand,
  DescribeBackupJobCommand,
  DescribeBackupVaultCommand,
  DescribeCopyJobCommand,
  DescribeRecoveryPointCommand,
  DescribeRestoreJobCommand,
  GetBackupPlanCommand,
  GetBackupSelectionCommand,
  GetBackupVaultAccessPolicyCommand,
  ListBackupJobsCommand,
  ListBackupPlansCommand,
  ListBackupSelectionsCommand,
  ListBackupVaultsCommand,
  ListCopyJobsCommand,
  ListRecoveryPointsByBackupVaultCommand,
  ListRestoreJobsCommand,
  ListTagsCommand,
  PutBackupVaultAccessPolicyCommand,
  PutBackupVaultLockConfigurationCommand,
  StartBackupJobCommand,
  StartCopyJobCommand,
  StartRestoreJobCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type BackupJob,
  type BackupSelectionsListMember,
  type BackupVaultListMember,
  type CopyJob,
  type RecoveryPointByBackupVault,
  type RestoreJobsListMember,
} from "@aws-sdk/client-backup";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DescribeFileSystemsCommand } from "@aws-sdk/client-efs";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import type { ActionResult, Ctx, FieldDef, FieldValues, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { optionalRead } from "../../console/secondary.ts";
import { roleOptions } from "../efs/lookups.ts";
import { fieldTags, recordTagDiff, recordToTags, tagDiffMessage, tagRecord, tagsToRecord } from "../../console/tags.ts";
import { joinId, numberOr, parseJsonText, prettyJson, splitId, strList, stringMap, text } from "../../console/values.ts";
import { CONSOLE_REGIONS } from "../../lib/regions.ts";
import { FREQUENCIES, backupVaultArn, buildPlanInput, resourceNameFromArn, scheduleExpression } from "./helpers.ts";

const BACKUP_PRINCIPAL = "backup.amazonaws.com";
const VAULT_NAME = "[a-zA-Z0-9_-]{2,50}";
const REGIONS: Option[] = CONSOLE_REGIONS.map((r) => ({ value: r.code, label: `${r.name} ${r.code}` }));

// ---------- shared reads ----------

async function allVaults(ctx: Ctx): Promise<BackupVaultListMember[]> {
  const out: BackupVaultListMember[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.backup.send(new ListBackupVaultsCommand({ NextToken: token }));
    out.push(...(r.BackupVaultList ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function vaultOptions(ctx: Ctx): Promise<Option[]> {
  return (await allVaults(ctx)).flatMap((v) => (v.BackupVaultName ? [{ value: v.BackupVaultName, label: v.BackupVaultName }] : []));
}

async function recoveryPointsIn(ctx: Ctx, vault: string): Promise<RecoveryPointByBackupVault[]> {
  const out: RecoveryPointByBackupVault[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.backup.send(new ListRecoveryPointsByBackupVaultCommand({ BackupVaultName: vault, NextToken: token }));
    out.push(...(r.RecoveryPoints ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function tableNames(ctx: Ctx): Promise<string[]> {
  const out: string[] = [];
  let start: string | undefined;
  do {
    const r = await ctx.clients.dynamodb.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    out.push(...(r.TableNames ?? []));
    start = r.LastEvaluatedTableName;
  } while (start);
  return out;
}

async function efsFileSystems(ctx: Ctx) {
  const out: { arn: string; label: string }[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.efs.send(new DescribeFileSystemsCommand({ Marker: marker }));
    for (const f of r.FileSystems ?? []) if (f.FileSystemArn) out.push({ arn: f.FileSystemArn, label: f.Name ? `${f.Name} (${f.FileSystemId})` : String(f.FileSystemId) });
    marker = r.NextMarker;
  } while (marker);
  return out;
}

async function bucketNames(ctx: Ctx): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.s3.send(new ListBucketsCommand({ ContinuationToken: token }));
    out.push(...(r.Buckets ?? []).flatMap((b) => (b.Name ? [b.Name] : [])));
    token = r.ContinuationToken;
  } while (token);
  return out;
}

/**
 * Resources this console can offer for on-demand backups and assignments: DynamoDB tables, EFS
 * file systems, S3 buckets. A service the identity can't list is skipped; if none can be listed, the error is shown.
 */
async function protectableOptions(ctx: Ctx): Promise<Option[]> {
  const [tables, fss, buckets] = await Promise.all([optionalRead(() => tableNames(ctx), []), optionalRead(() => efsFileSystems(ctx), []), optionalRead(() => bucketNames(ctx), [])]);
  if (tables.kind === "error" && fss.kind === "error" && buckets.kind === "error") throw new Error(tables.error);
  const opts: Option[] = [];
  for (const t of tables.kind === "value" ? tables.value : []) opts.push({ value: `arn:aws:dynamodb:${ctx.region}:${ctx.accountId}:table/${t}`, label: `DynamoDB table: ${t}` });
  for (const f of fss.kind === "value" ? fss.value : []) opts.push({ value: f.arn, label: `EFS file system: ${f.label}` });
  for (const b of buckets.kind === "value" ? buckets.value : []) opts.push({ value: `arn:aws:s3:::${b}`, label: `S3 bucket: ${b}` });
  return opts;
}

const backupRoleOptions = (ctx: Ctx) => roleOptions(ctx, BACKUP_PRINCIPAL);

const roleField = (section?: string): FieldDef => ({
  name: "roleArn",
  label: "IAM role",
  kind: "select",
  required: true,
  options: backupRoleOptions,
  section,
  help: "A role AWS Backup can assume (trust policy for backup.amazonaws.com) with backup permissions, e.g. the managed policy AWSBackupServiceRolePolicyForBackup.",
});

const tagColumns = [
  { key: "Key", label: "Key", kind: "text" as const },
  { key: "Value", label: "Value", kind: "text" as const },
];

// ---------- vaults ----------

function recoveryPointRow(rp: RecoveryPointByBackupVault): Row {
  return {
    id: joinId(rp.BackupVaultName ?? "", rp.RecoveryPointArn ?? ""),
    recoveryPointArn: rp.RecoveryPointArn ?? null,
    vault: rp.BackupVaultName ?? null,
    resourceName: rp.ResourceName ?? resourceNameFromArn(rp.ResourceArn),
    resourceArn: rp.ResourceArn ?? null,
    resourceType: rp.ResourceType ?? null,
    status: rp.Status ?? null,
    created: rp.CreationDate ?? null,
    size: rp.BackupSizeInBytes ?? null,
    retention: rp.Lifecycle?.DeleteAfterDays !== undefined ? `${rp.Lifecycle.DeleteAfterDays} days` : "Always",
    deleteAt: rp.CalculatedLifecycle?.DeleteAt ?? null,
    encrypted: rp.IsEncrypted ? "Yes" : "No",
  };
}

const rpColumns = [
  { key: "recoveryPointArn", label: "Recovery point ID", kind: "link" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "resourceName", label: "Resource name", kind: "text" as const },
  { key: "resourceType", label: "Resource type", kind: "text" as const },
  { key: "vault", label: "Backup vault", kind: "text" as const },
  { key: "created", label: "Creation time", kind: "date" as const },
  { key: "retention", label: "Retention", kind: "text" as const },
  { key: "size", label: "Backup size", kind: "bytes" as const, hidden: true },
  { key: "resourceArn", label: "Resource ARN", kind: "arn" as const, hidden: true },
];

/** Every tag on a vault (ListTags pages with NextToken). */
async function vaultTags(ctx: Ctx, arn: string | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!arn) return out;
  let token: string | undefined;
  do {
    const r = await ctx.clients.backup.send(new ListTagsCommand({ ResourceArn: arn, NextToken: token }));
    Object.assign(out, r.Tags ?? {});
    token = r.NextToken;
  } while (token);
  return out;
}

const vaultArnOf = async (ctx: Ctx, name: string): Promise<string> => {
  const arn = (await ctx.clients.backup.send(new DescribeBackupVaultCommand({ BackupVaultName: name }))).BackupVaultArn;
  if (!arn) throw new Error(`Backup vault ${name} has no ARN.`);
  return arn;
};

const vaultLocked = (row: Row): boolean => {
  const v = row.locked ?? row["Vault lock"];
  return v === undefined || v === "Locked";
};

const vaults: ResourceDef = {
  id: "vaults",
  name: "Backup vaults",
  singular: "backup vault",
  idField: "name",
  nameField: "Backup vault name",
  description: "Containers that store and organise your recovery points.",
  emptyText: "No backup vaults. Create a backup vault to store recovery points.",
  columns: [
    { key: "name", label: "Vault name", kind: "link" },
    { key: "recoveryPoints", label: "Recovery points", kind: "count" },
    { key: "locked", label: "Vault lock", kind: "text" },
    { key: "encryptionKey", label: "Encryption key", kind: "arn", hidden: true },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await allVaults(ctx)).map((v) => ({
      name: v.BackupVaultName ?? null,
      recoveryPoints: v.NumberOfRecoveryPoints ?? 0,
      locked: v.Locked ? "Locked" : "Not locked",
      encryptionKey: v.EncryptionKeyArn ?? null,
      created: v.CreationDate ?? null,
      arn: v.BackupVaultArn ?? null,
    }));
  },

  async get(ctx, name) {
    const v = await ctx.clients.backup.send(new DescribeBackupVaultCommand({ BackupVaultName: name }));
    const [rps, policy, tags] = await Promise.all([
      optionalRead(() => recoveryPointsIn(ctx, name), []),
      optionalRead(() => ctx.clients.backup.send(new GetBackupVaultAccessPolicyCommand({ BackupVaultName: name })), ["ResourceNotFoundException"]),
      optionalRead(() => vaultTags(ctx, v.BackupVaultArn), []),
    ]);
    return {
      summary: {
        "Backup vault name": v.BackupVaultName ?? name,
        ARN: v.BackupVaultArn ?? null,
        "Vault type": v.VaultType ?? null,
        "Encryption key": v.EncryptionKeyArn ?? null,
        "Recovery points": v.NumberOfRecoveryPoints ?? 0,
        "Vault lock": v.Locked ? "Locked" : "Not locked",
        "Creation time": v.CreationDate ?? null,
      },
      tabs: [
        {
          id: "recovery-points",
          label: "Recovery points",
          kind: "table",
          columns: rpColumns.filter((c) => c.key !== "vault").map((c) => (c.kind === "link" ? { ...c, kind: "code" as const } : c)),
          data: rps.kind === "value" ? rps.value.map(recoveryPointRow) : [],
          emptyText: rps.kind === "error" ? `Recovery points are unavailable: ${rps.error}` : "No recovery points in this vault.",
        },
        {
          id: "lock",
          label: "Vault lock",
          kind: "keyvalue",
          data: {
            Locked: v.Locked ? "Yes" : "No",
            "Minimum retention (days)": v.MinRetentionDays ?? "-",
            "Maximum retention (days)": v.MaxRetentionDays ?? "-",
            "Lock date (end of grace time)": v.LockDate ?? "-",
          },
        },
        {
          id: "policy",
          label: "Access policy",
          kind: "json",
          data: policy.kind === "value" ? parseJsonText(policy.value.Policy) : policy.kind === "error" ? { error: policy.error } : null,
          emptyText: "No access policy. Only IAM permissions control access to this vault.",
        },
        { id: "tags", label: "Tags", kind: "table", columns: tagColumns, data: tags.kind === "value" ? recordToTags(tags.value) : [], emptyText: tags.kind === "error" ? `Tags are unavailable: ${tags.error}` : "No tags." },
      ],
    };
  },

  create: {
    title: "Create backup vault",
    description: "Creates a backup vault with CreateBackupVault. Recovery points are encrypted with the vault's AWS managed key.",
    fields: [
      {
        name: "name", label: "Backup vault name", kind: "text", required: true, section: "General", placeholder: "my-backup-vault",
        help: "2 to 50 characters: letters, numbers, hyphens and underscores.",
        validate: { pattern: VAULT_NAME, message: "Use 2 to 50 letters, numbers, hyphens or underscores." },
      },
      { name: "tags", label: "Backup vault tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      await ctx.clients.backup.send(new CreateBackupVaultCommand({ BackupVaultName: name, BackupVaultTags: tagRecord(v.tags) }));
      return name;
    },
  },

  actions: [
    {
      id: "edit-policy",
      label: "Edit access policy",
      fields: [{ name: "policy", label: "Access policy (JSON)", kind: "json", required: true, help: "For example, deny backup:DeleteRecoveryPoint to protect recovery points." }],
      async initialValues(ctx, name) {
        const r = await optionalRead(() => ctx.clients.backup.send(new GetBackupVaultAccessPolicyCommand({ BackupVaultName: name })), ["ResourceNotFoundException"]);
        if (r.kind === "error") throw new Error(r.error);
        return { policy: r.kind === "value" ? prettyJson(r.value.Policy) : "" };
      },
      async run(ctx, name, v) {
        await ctx.clients.backup.send(new PutBackupVaultAccessPolicyCommand({ BackupVaultName: name, Policy: String(v.policy) }));
        return { message: "Access policy saved." };
      },
    },
    {
      id: "delete-policy",
      label: "Delete access policy",
      danger: true,
      confirm: "Removes the vault's access policy.",
      async run(ctx, name) {
        await ctx.clients.backup.send(new DeleteBackupVaultAccessPolicyCommand({ BackupVaultName: name }));
        return { message: "Access policy deleted." };
      },
    },
    {
      id: "lock",
      label: "Create or edit vault lock",
      async initialValues(ctx, name) {
        const v = await ctx.clients.backup.send(new DescribeBackupVaultCommand({ BackupVaultName: name }));
        const values: FieldValues = v.Locked ? { minDays: v.MinRetentionDays ?? null, maxDays: v.MaxRetentionDays ?? null } : {};
        return values;
      },
      fields: [
        { name: "minDays", label: "Minimum retention period (days)", kind: "number", default: 1, validate: { min: 1, max: 36500, message: "Between 1 and 36500 days." } },
        { name: "maxDays", label: "Maximum retention period (days)", kind: "number", validate: { min: 1, max: 36500, message: "Between 1 and 36500 days." } },
        { name: "graceDays", label: "Grace time (days) before the lock becomes immutable", kind: "number", help: "Leave empty for governance mode (the lock can be removed). 3 days or more gives compliance mode.", validate: { min: 3, max: 36500, message: "At least 3 days." } },
      ],
      async run(ctx, name, v) {
        await ctx.clients.backup.send(
          new PutBackupVaultLockConfigurationCommand({ BackupVaultName: name, MinRetentionDays: numberOr(v.minDays), MaxRetentionDays: numberOr(v.maxDays), ChangeableForDays: numberOr(v.graceDays) })
        );
        return { message: "Vault lock configured." };
      },
    },
    {
      id: "unlock",
      label: "Delete vault lock",
      danger: true,
      availableFor: vaultLocked,
      confirm: "Removes the vault lock. This only works in governance mode or during the grace time.",
      async run(ctx, name) {
        await ctx.clients.backup.send(new DeleteBackupVaultLockConfigurationCommand({ BackupVaultName: name }));
        return { message: "Vault lock deleted." };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Remove a row to delete that tag." }],
      async initialValues(ctx, name) {
        return { tags: recordToTags(await vaultTags(ctx, await vaultArnOf(ctx, name))) };
      },
      async run(ctx, name, v) {
        const arn = await vaultArnOf(ctx, name);
        const diff = recordTagDiff(await vaultTags(ctx, arn), tagsToRecord(fieldTags(v.tags)));
        if (diff.remove.length) await ctx.clients.backup.send(new UntagResourceCommand({ ResourceArn: arn, TagKeyList: diff.remove }));
        if (Object.keys(diff.set).length) await ctx.clients.backup.send(new TagResourceCommand({ ResourceArn: arn, Tags: diff.set }));
        return { message: tagDiffMessage(diff) };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.backup.send(new DeleteBackupVaultCommand({ BackupVaultName: name }));
    },
  },
};

// ---------- recovery points ----------

async function recoveryPoint(ctx: Ctx, id: string) {
  const [vault, arn] = splitId(id, "recovery point");
  return { vault, arn, rp: await ctx.clients.backup.send(new DescribeRecoveryPointCommand({ BackupVaultName: vault, RecoveryPointArn: arn })) };
}

const recoveryPoints: ResourceDef = {
  id: "recovery-points",
  name: "Recovery points",
  singular: "recovery point",
  idField: "id",
  nameField: "Recovery point ARN",
  description: "Backups of your resources, stored in backup vaults. Restore or copy them from here.",
  emptyText: "No recovery points. Run an on-demand backup or a backup plan to create one.",
  columns: rpColumns,

  async list(ctx) {
    const vs = await allVaults(ctx);
    const all = await Promise.all(vs.flatMap((v) => (v.BackupVaultName ? [recoveryPointsIn(ctx, v.BackupVaultName)] : [])));
    return all.flat().map(recoveryPointRow);
  },

  async get(ctx, id) {
    const { rp } = await recoveryPoint(ctx, id);
    return {
      summary: {
        "Recovery point ARN": rp.RecoveryPointArn ?? null,
        Status: rp.Status ?? null,
        "Backup vault": rp.BackupVaultName ?? null,
        "Resource type": rp.ResourceType ?? null,
        "Resource ARN": rp.ResourceArn ?? null,
        "Creation time": rp.CreationDate ?? null,
        "Completion time": rp.CompletionDate ?? null,
        "Storage class": rp.StorageClass ?? null,
      },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            "Backup size (bytes)": rp.BackupSizeInBytes ?? null,
            "IAM role": rp.IamRoleArn ?? null,
            Encrypted: rp.IsEncrypted ? "Yes" : "No",
            "Encryption key type": rp.EncryptionKeyType ?? null,
            "Move to cold storage after (days)": rp.Lifecycle?.MoveToColdStorageAfterDays ?? "Never",
            "Retention (days)": rp.Lifecycle?.DeleteAfterDays ?? "Always",
            "Scheduled deletion": rp.CalculatedLifecycle?.DeleteAt ?? "-",
            "Created by backup plan": rp.CreatedBy?.BackupPlanId ?? "On-demand",
            "Source backup vault": rp.SourceBackupVaultArn ?? "-",
            "Vault type": rp.VaultType ?? null,
          },
        },
      ],
    };
  },

  actions: [
    {
      id: "restore",
      label: "Restore",
      fields: [
        roleField(),
        { name: "newTableName", label: "New table name (DynamoDB)", kind: "text", help: "For a DynamoDB recovery point: the restored table's name. Must not exist yet.", validate: { pattern: "[a-zA-Z0-9_.-]{3,255}", message: "3-255 letters, numbers, _ . or -." } },
        { name: "metadata", label: "Restore metadata (JSON, other resource types)", kind: "json", help: 'Resource-specific restore settings as a JSON object of strings, e.g. {"DestinationBucketName":"my-bucket","NewBucket":"false"} for S3.' },
      ],
      async run(ctx, id, v) {
        const { rp } = await recoveryPoint(ctx, id);
        const extra = stringMap(v.metadata, "Restore metadata") ?? {};
        const table = text(v.newTableName);
        const metadata = rp.ResourceType === "DynamoDB" && table ? { ...extra, targetTableName: table } : extra;
        if (rp.ResourceType === "DynamoDB" && !metadata.targetTableName) throw new Error("Enter a new table name for the restored DynamoDB table.");
        const r = await ctx.clients.backup.send(new StartRestoreJobCommand({ RecoveryPointArn: rp.RecoveryPointArn, IamRoleArn: String(v.roleArn), Metadata: metadata }));
        return { message: `Restore job ${r.RestoreJobId ?? "-"} started. Follow it in Jobs → Restore jobs.` };
      },
    },
    {
      id: "copy",
      label: "Copy",
      fields: [
        { name: "region", label: "Copy to destination", kind: "select", required: true, default: "us-east-1", options: REGIONS, help: "Copying to another Region protects against a Regional outage (cross-Region DR)." },
        { name: "vaultName", label: "Destination backup vault name", kind: "text", required: true, help: "The vault must already exist in the destination Region (create one in another Region with the CLI).", validate: { pattern: VAULT_NAME, message: "2 to 50 letters, numbers, hyphens or underscores." } },
        roleField(),
        { name: "deleteAfterDays", label: "Retention period of the copy (days)", kind: "number", help: "Leave empty to keep the copy until you delete it.", validate: { min: 1, max: 36500, message: "Between 1 and 36500 days." } },
      ],
      async run(ctx, id, v) {
        const { vault, rp } = await recoveryPoint(ctx, id);
        const days = numberOr(v.deleteAfterDays);
        const r = await ctx.clients.backup.send(
          new StartCopyJobCommand({
            RecoveryPointArn: rp.RecoveryPointArn,
            SourceBackupVaultName: vault,
            DestinationBackupVaultArn: backupVaultArn(String(v.region), ctx.accountId, String(v.vaultName)),
            IamRoleArn: String(v.roleArn),
            Lifecycle: days !== undefined ? { DeleteAfterDays: days } : undefined,
          })
        );
        return { message: `Copy job ${r.CopyJobId ?? "-"} started. Follow it in Jobs → Copy jobs.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const [vault, arn] = splitId(id, "recovery point");
      await ctx.clients.backup.send(new DeleteRecoveryPointCommand({ BackupVaultName: vault, RecoveryPointArn: arn }));
    },
  },
};

// ---------- backup plans ----------

async function selections(ctx: Ctx, planId: string): Promise<BackupSelectionsListMember[]> {
  const out: BackupSelectionsListMember[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.backup.send(new ListBackupSelectionsCommand({ BackupPlanId: planId, NextToken: token }));
    out.push(...(r.BackupSelectionsList ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function assignmentsResult(ctx: Ctx, planId: string, message: string): Promise<ActionResult> {
  const sels = await selections(ctx, planId);
  const details = await Promise.all(sels.map((s) => ctx.clients.backup.send(new GetBackupSelectionCommand({ BackupPlanId: planId, SelectionId: s.SelectionId }))));
  return {
    message,
    table: {
      rowKey: "selectionId",
      emptyText: "No resource assignments. Use Assign resources so the plan backs something up.",
      columns: [
        { key: "name", label: "Resource assignment name", kind: "text" },
        { key: "role", label: "IAM role", kind: "arn" },
        { key: "resources", label: "Resources", kind: "code" },
        { key: "tags", label: "Tag conditions", kind: "code" },
        { key: "created", label: "Created", kind: "date" },
      ],
      rows: details.map((d) => ({
        selectionId: d.SelectionId ?? "",
        name: d.BackupSelection?.SelectionName ?? null,
        role: d.BackupSelection?.IamRoleArn ?? null,
        resources: (d.BackupSelection?.Resources ?? []).join("\n") || "-",
        tags: (d.BackupSelection?.ListOfTags ?? []).map((t) => `${t.ConditionKey} ${t.ConditionType} ${t.ConditionValue}`).join("\n") || "-",
        created: d.CreationDate ?? null,
      })),
      selectionAction: { actionId: "delete-assignments", label: "Delete", danger: true, valuesField: "selectionIds" },
    },
  };
}

const plans: ResourceDef = {
  id: "plans",
  name: "Backup plans",
  singular: "backup plan",
  idField: "id",
  nameField: "Backup plan name",
  description: "Policies that say when to back up (rules), how long to keep backups, where to copy them, and which resources to protect.",
  emptyText: "No backup plans. Create a backup plan to schedule backups.",
  columns: [
    { key: "name", label: "Backup plan name", kind: "link" },
    { key: "id", label: "Backup plan ID", kind: "text" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "lastExecution", label: "Last runtime", kind: "date" },
    { key: "versionId", label: "Version ID", kind: "code", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const out: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.backup.send(new ListBackupPlansCommand({ NextToken: token }));
      for (const p of r.BackupPlansList ?? []) {
        out.push({ id: p.BackupPlanId ?? null, name: p.BackupPlanName ?? null, created: p.CreationDate ?? null, lastExecution: p.LastExecutionDate ?? null, versionId: p.VersionId ?? null, arn: p.BackupPlanArn ?? null });
      }
      token = r.NextToken;
    } while (token);
    return out;
  },

  async get(ctx, id) {
    const [p, sels] = await Promise.all([ctx.clients.backup.send(new GetBackupPlanCommand({ BackupPlanId: id })), optionalRead(() => selections(ctx, id), [])]);
    const rules = p.BackupPlan?.Rules ?? [];
    return {
      summary: {
        "Backup plan name": p.BackupPlan?.BackupPlanName ?? null,
        "Backup plan ID": p.BackupPlanId ?? id,
        ARN: p.BackupPlanArn ?? null,
        "Version ID": p.VersionId ?? null,
        "Creation time": p.CreationDate ?? null,
        "Last runtime": p.LastExecutionDate ?? "Never",
      },
      tabs: [
        {
          id: "rules",
          label: "Backup rules",
          kind: "table",
          columns: [
            { key: "name", label: "Backup rule name", kind: "text" },
            { key: "vault", label: "Backup vault", kind: "text" },
            { key: "schedule", label: "Frequency", kind: "code" },
            { key: "timezone", label: "Time zone", kind: "text" },
            { key: "startWindow", label: "Start within (minutes)", kind: "count" },
            { key: "completionWindow", label: "Complete within (minutes)", kind: "count" },
            { key: "cold", label: "Move to cold storage", kind: "text" },
            { key: "retention", label: "Retention", kind: "text" },
            { key: "copies", label: "Copy to destinations", kind: "code" },
          ],
          data: rules.map((r) => ({
            name: r.RuleName ?? null,
            vault: r.TargetBackupVaultName ?? null,
            schedule: r.ScheduleExpression ?? "On demand only",
            timezone: r.ScheduleExpressionTimezone ?? null,
            startWindow: r.StartWindowMinutes ?? null,
            completionWindow: r.CompletionWindowMinutes ?? null,
            cold: r.Lifecycle?.MoveToColdStorageAfterDays !== undefined ? `${r.Lifecycle.MoveToColdStorageAfterDays} days` : "Never",
            retention: r.Lifecycle?.DeleteAfterDays !== undefined ? `${r.Lifecycle.DeleteAfterDays} days` : "Always",
            copies: (r.CopyActions ?? []).map((c) => `${c.DestinationBackupVaultArn}${c.Lifecycle?.DeleteAfterDays !== undefined ? ` (keep ${c.Lifecycle.DeleteAfterDays} days)` : ""}`).join("\n") || "-",
          })),
          emptyText: "No backup rules.",
        },
        {
          id: "assignments",
          label: "Resource assignments",
          kind: "table",
          columns: [
            { key: "name", label: "Resource assignment name", kind: "text" },
            { key: "id", label: "ID", kind: "code" },
            { key: "role", label: "IAM role", kind: "arn" },
            { key: "created", label: "Creation time", kind: "date" },
          ],
          data: (sels.kind === "value" ? sels.value : []).map((s) => ({ name: s.SelectionName ?? null, id: s.SelectionId ?? null, role: s.IamRoleArn ?? null, created: s.CreationDate ?? null })),
          description: "Use Actions → View resource assignments to see the resources and tag conditions, or to delete assignments.",
          emptyText: sels.kind === "error" ? `Resource assignments are unavailable: ${sels.error}` : "No resource assignments. This plan doesn't back anything up until you assign resources.",
        },
        { id: "json", label: "JSON", kind: "json", data: p.BackupPlan ?? null },
      ],
    };
  },

  create: {
    title: "Create backup plan",
    description: "Builds a new plan with one backup rule using CreateBackupPlan. Assign resources to it afterwards.",
    fields: [
      { name: "planName", label: "Backup plan name", kind: "text", required: true, section: "Backup plan options", placeholder: "my-backup-plan", validate: { pattern: "[a-zA-Z0-9_.-]{1,50}", message: "Up to 50 letters, numbers, hyphens, underscores or periods." } },
      { name: "ruleName", label: "Backup rule name", kind: "text", required: true, default: "DailyBackups", section: "Backup rule configuration", validate: { pattern: "[a-zA-Z0-9_.-]{1,50}", message: "Up to 50 letters, numbers, hyphens, underscores or periods." } },
      { name: "vaultName", label: "Backup vault", kind: "select", required: true, options: vaultOptions, section: "Backup rule configuration" },
      { name: "frequency", label: "Backup frequency", kind: "select", required: true, default: "daily", options: FREQUENCIES, section: "Backup rule configuration", help: "Scheduled backups start at 05:00 UTC (hourly: on the hour)." },
      { name: "cron", label: "Cron expression", kind: "text", required: true, placeholder: "cron(0 5 ? * * *)", section: "Backup rule configuration", showIf: { field: "frequency", equals: "custom" } },
      { name: "startWindow", label: "Start within (minutes)", kind: "number", default: 480, section: "Backup window", help: "If the backup doesn't start within this time, it's cancelled.", validate: { min: 60, max: 43200, message: "Between 60 minutes and 30 days." } },
      { name: "completionWindow", label: "Complete within (minutes)", kind: "number", default: 10080, section: "Backup window", validate: { min: 120, max: 1440000, message: "At least 120 minutes." } },
      { name: "coldAfterDays", label: "Move to cold storage after (days)", kind: "number", section: "Lifecycle", help: "Leave empty to never move to cold storage. Supported for EFS and some other resource types.", validate: { min: 1, max: 36500, message: "Between 1 and 36500 days." } },
      { name: "deleteAfterDays", label: "Retention period (days)", kind: "number", default: 35, section: "Lifecycle", help: "Leave empty to keep recovery points until you delete them.", validate: { min: 1, max: 36500, message: "Between 1 and 36500 days." } },
      { name: "copyEnabled", label: "Copy to destination", kind: "checkbox", default: false, section: "Copy to destination", help: "Copy each recovery point to a vault in another Region (or account) for disaster recovery." },
      { name: "copyRegion", label: "Destination Region", kind: "select", required: true, default: "us-west-2", options: REGIONS, section: "Copy to destination", showIf: { field: "copyEnabled", equals: true } },
      { name: "copyVault", label: "Destination backup vault name", kind: "text", required: true, section: "Copy to destination", showIf: { field: "copyEnabled", equals: true }, help: "Must already exist in that Region.", validate: { pattern: VAULT_NAME, message: "2 to 50 letters, numbers, hyphens or underscores." } },
      { name: "copyDeleteAfterDays", label: "Copy retention period (days)", kind: "number", section: "Copy to destination", showIf: { field: "copyEnabled", equals: true }, validate: { min: 1, max: 36500, message: "Between 1 and 36500 days." } },
      { name: "tags", label: "Tags added to backup plan", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const input = buildPlanInput({
        planName: String(v.planName),
        ruleName: String(v.ruleName),
        vaultName: String(v.vaultName),
        schedule: scheduleExpression(text(v.frequency) ?? "daily", text(v.cron)),
        startWindowMinutes: numberOr(v.startWindow),
        completionWindowMinutes: numberOr(v.completionWindow),
        coldAfterDays: numberOr(v.coldAfterDays),
        deleteAfterDays: numberOr(v.deleteAfterDays),
        copyToVaultArn: v.copyEnabled === true ? backupVaultArn(String(v.copyRegion), ctx.accountId, String(v.copyVault)) : undefined,
        copyDeleteAfterDays: v.copyEnabled === true ? numberOr(v.copyDeleteAfterDays) : undefined,
      });
      const r = await ctx.clients.backup.send(new CreateBackupPlanCommand({ BackupPlan: input, BackupPlanTags: tagRecord(v.tags) }));
      if (!r.BackupPlanId) throw new Error("AWS Backup returned no plan ID.");
      return r.BackupPlanId;
    },
  },

  actions: [
    {
      id: "assign",
      label: "Assign resources",
      fields: [
        { name: "name", label: "Resource assignment name", kind: "text", required: true, validate: { pattern: "[a-zA-Z0-9_.-]{1,50}", message: "Up to 50 letters, numbers, hyphens, underscores or periods." } },
        roleField(),
        { name: "resources", label: "Specific resources", kind: "multiselect", options: protectableOptions, help: "Choose resources by ARN, or use a tag condition below (or both)." },
        { name: "tagKey", label: "Tag key", kind: "text", help: "Include resources with this tag (StringEquals)." },
        { name: "tagValue", label: "Tag value", kind: "text" },
      ],
      async run(ctx, planId, v) {
        const resources = strList(v.resources);
        const key = text(v.tagKey);
        if (resources.length === 0 && !key) throw new Error("Choose at least one resource or enter a tag key.");
        const r = await ctx.clients.backup.send(
          new CreateBackupSelectionCommand({
            BackupPlanId: planId,
            BackupSelection: {
              SelectionName: String(v.name),
              IamRoleArn: String(v.roleArn),
              Resources: resources.length ? resources : undefined,
              ListOfTags: key ? [{ ConditionType: "STRINGEQUALS", ConditionKey: key, ConditionValue: text(v.tagValue) ?? "" }] : undefined,
            },
          })
        );
        return assignmentsResult(ctx, planId, `Resource assignment ${r.SelectionId ?? ""} created.`);
      },
    },
    {
      id: "view-assignments",
      label: "View resource assignments",
      async run(ctx, planId) {
        return assignmentsResult(ctx, planId, "Resource assignments of this plan. Select assignments to delete them.");
      },
    },
    {
      id: "delete-assignments",
      label: "Delete resource assignments",
      hidden: true,
      danger: true,
      fields: [{ name: "selectionIds", label: "Resource assignments", kind: "multiselect", required: true }],
      async run(ctx, planId, v) {
        const ids = strList(v.selectionIds);
        for (const sid of ids) await ctx.clients.backup.send(new DeleteBackupSelectionCommand({ BackupPlanId: planId, SelectionId: sid }));
        return { message: `Deleted ${ids.length} resource assignment${ids.length === 1 ? "" : "s"}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const sels = await selections(ctx, id);
      if (sels.length) throw new Error(`Delete this plan's ${sels.length} resource assignment${sels.length === 1 ? "" : "s"} first (Actions → View resource assignments).`);
      await ctx.clients.backup.send(new DeleteBackupPlanCommand({ BackupPlanId: id }));
    },
  },
};

// ---------- jobs ----------

async function allPages<T>(fetch: (token: string | undefined) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const page = await fetch(token);
    out.push(...page.items);
    token = page.next;
  } while (token);
  return out;
}

function backupJobRow(j: BackupJob): Row {
  return {
    jobId: j.BackupJobId ?? null,
    status: j.State ?? null,
    resourceName: j.ResourceName ?? resourceNameFromArn(j.ResourceArn),
    resourceType: j.ResourceType ?? null,
    resourceArn: j.ResourceArn ?? null,
    vault: j.BackupVaultName ?? null,
    created: j.CreationDate ?? null,
    completed: j.CompletionDate ?? null,
    percentDone: j.PercentDone ?? null,
    recoveryPointArn: j.RecoveryPointArn ?? null,
    plan: j.CreatedBy?.BackupPlanId ?? "On-demand",
  };
}

function restoreJobRow(j: RestoreJobsListMember): Row {
  return {
    jobId: j.RestoreJobId ?? null,
    status: j.Status ?? null,
    resourceType: j.ResourceType ?? null,
    sourceResource: j.SourceResourceArn ?? null,
    createdResource: j.CreatedResourceArn ?? null,
    recoveryPointArn: j.RecoveryPointArn ?? null,
    created: j.CreationDate ?? null,
    completed: j.CompletionDate ?? null,
    statusMessage: j.StatusMessage ?? null,
  };
}

function copyJobRow(j: CopyJob): Row {
  return {
    jobId: j.CopyJobId ?? null,
    status: j.State ?? null,
    resourceName: j.ResourceName ?? resourceNameFromArn(j.ResourceArn),
    resourceType: j.ResourceType ?? null,
    source: j.SourceBackupVaultArn ?? null,
    destination: j.DestinationBackupVaultArn ?? null,
    destinationRecoveryPoint: j.DestinationRecoveryPointArn ?? null,
    created: j.CreationDate ?? null,
    completed: j.CompletionDate ?? null,
    statusMessage: j.StatusMessage ?? null,
  };
}

const backupJobs: ResourceDef = {
  id: "backup-jobs",
  name: "Backup jobs",
  singular: "backup job",
  idField: "jobId",
  nameField: "Backup job ID",
  description: "Backups run by your plans and on demand. Create on-demand backup starts one now.",
  emptyText: "No backup jobs.",
  columns: [
    { key: "jobId", label: "Backup job ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "resourceName", label: "Resource name", kind: "text" },
    { key: "resourceType", label: "Resource type", kind: "text" },
    { key: "vault", label: "Backup vault", kind: "text" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "completed", label: "Completion time", kind: "date", hidden: true },
    { key: "plan", label: "Backup plan", kind: "text", hidden: true },
    { key: "resourceArn", label: "Resource ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const jobs = await allPages(async (t) => {
      const r = await ctx.clients.backup.send(new ListBackupJobsCommand({ NextToken: t }));
      return { items: r.BackupJobs ?? [], next: r.NextToken };
    });
    return jobs.map(backupJobRow);
  },

  async get(ctx, id) {
    const j = await ctx.clients.backup.send(new DescribeBackupJobCommand({ BackupJobId: id }));
    return {
      summary: {
        "Backup job ID": j.BackupJobId ?? id,
        Status: j.State ?? null,
        "Status message": j.StatusMessage ?? "-",
        "Resource type": j.ResourceType ?? null,
        "Resource ARN": j.ResourceArn ?? null,
        "Backup vault": j.BackupVaultName ?? null,
        "Recovery point ARN": j.RecoveryPointArn ?? null,
        "IAM role": j.IamRoleArn ?? null,
        "Creation time": j.CreationDate ?? null,
        "Completion time": j.CompletionDate ?? null,
        "Percent done": j.PercentDone ?? null,
        "Backup size (bytes)": j.BackupSizeInBytes ?? null,
        "Retention (days)": j.RecoveryPointLifecycle?.DeleteAfterDays ?? "Always",
        "Created by": j.CreatedBy?.BackupPlanId ? `Backup plan ${j.CreatedBy.BackupPlanId}` : "On-demand",
      },
    };
  },

  create: {
    title: "Create on-demand backup",
    description: "Starts a backup now with StartBackupJob.",
    fields: [
      { name: "resourceArn", label: "Resource", kind: "select", required: true, options: protectableOptions, section: "Settings" },
      { name: "vaultName", label: "Backup vault", kind: "select", required: true, options: vaultOptions, section: "Settings" },
      {
        name: "retention", label: "Total retention period", kind: "radio", default: "days", section: "Settings",
        options: [
          { value: "days", label: "Days" },
          { value: "always", label: "Always (never expire)" },
        ],
      },
      { name: "deleteAfterDays", label: "Retention (days)", kind: "number", default: 35, required: true, section: "Settings", showIf: { field: "retention", equals: "days" }, validate: { min: 1, max: 36500, message: "Between 1 and 36500 days." } },
      roleField("Settings"),
      { name: "tags", label: "Tags added to recovery points", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.backup.send(
        new StartBackupJobCommand({
          ResourceArn: String(v.resourceArn),
          BackupVaultName: String(v.vaultName),
          IamRoleArn: String(v.roleArn),
          Lifecycle: v.retention === "days" ? { DeleteAfterDays: numberOr(v.deleteAfterDays) } : undefined,
          RecoveryPointTags: tagRecord(v.tags),
        })
      );
      if (!r.BackupJobId) throw new Error("AWS Backup returned no backup job ID.");
      return r.BackupJobId;
    },
  },
};

const restoreJobs: ResourceDef = {
  id: "restore-jobs",
  name: "Restore jobs",
  singular: "restore job",
  idField: "jobId",
  nameField: "Restore job ID",
  description: "Restores started from recovery points (Recovery points → Actions → Restore).",
  emptyText: "No restore jobs.",
  columns: [
    { key: "jobId", label: "Restore job ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "resourceType", label: "Resource type", kind: "text" },
    { key: "createdResource", label: "Restored resource", kind: "arn" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "statusMessage", label: "Status message", kind: "text", hidden: true },
    { key: "sourceResource", label: "Source resource", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const jobs = await allPages(async (t) => {
      const r = await ctx.clients.backup.send(new ListRestoreJobsCommand({ NextToken: t }));
      return { items: r.RestoreJobs ?? [], next: r.NextToken };
    });
    return jobs.map(restoreJobRow);
  },

  async get(ctx, id) {
    const j = await ctx.clients.backup.send(new DescribeRestoreJobCommand({ RestoreJobId: id }));
    return {
      summary: {
        "Restore job ID": j.RestoreJobId ?? id,
        Status: j.Status ?? null,
        "Status message": j.StatusMessage ?? "-",
        "Resource type": j.ResourceType ?? null,
        "Recovery point ARN": j.RecoveryPointArn ?? null,
        "Source resource": j.SourceResourceArn ?? null,
        "Restored resource": j.CreatedResourceArn ?? null,
        "IAM role": j.IamRoleArn ?? null,
        "Creation time": j.CreationDate ?? null,
        "Completion time": j.CompletionDate ?? null,
        "Percent done": j.PercentDone ?? null,
      },
    };
  },
};

const copyJobs: ResourceDef = {
  id: "copy-jobs",
  name: "Copy jobs",
  singular: "copy job",
  idField: "jobId",
  nameField: "Copy job ID",
  description: "Copies of recovery points to other vaults or Regions, from plan copy rules or Recovery points → Actions → Copy.",
  emptyText: "No copy jobs.",
  columns: [
    { key: "jobId", label: "Copy job ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "resourceName", label: "Resource name", kind: "text" },
    { key: "resourceType", label: "Resource type", kind: "text" },
    { key: "destination", label: "Destination vault", kind: "arn" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "source", label: "Source vault", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const jobs = await allPages(async (t) => {
      const r = await ctx.clients.backup.send(new ListCopyJobsCommand({ NextToken: t }));
      return { items: r.CopyJobs ?? [], next: r.NextToken };
    });
    return jobs.map(copyJobRow);
  },

  async get(ctx, id) {
    const r = await ctx.clients.backup.send(new DescribeCopyJobCommand({ CopyJobId: id }));
    const j = r.CopyJob ?? {};
    return {
      summary: {
        "Copy job ID": j.CopyJobId ?? id,
        Status: j.State ?? null,
        "Status message": j.StatusMessage ?? "-",
        "Resource type": j.ResourceType ?? null,
        "Resource ARN": j.ResourceArn ?? null,
        "Source vault": j.SourceBackupVaultArn ?? null,
        "Source recovery point": j.SourceRecoveryPointArn ?? null,
        "Destination vault": j.DestinationBackupVaultArn ?? null,
        "Destination recovery point": j.DestinationRecoveryPointArn ?? null,
        "IAM role": j.IamRoleArn ?? null,
        "Creation time": j.CreationDate ?? null,
        "Completion time": j.CompletionDate ?? null,
      },
    };
  },
};

export const backupService: ServiceDef = {
  id: "backup",
  name: "AWS Backup",
  category: "Storage",
  description: "Centrally manage and automate backups across AWS services, with cross-Region copies and vault lock.",
  resources: [vaults, plans, recoveryPoints, backupJobs, restoreJobs, copyJobs],
  notSupported: [
    "Protected resources list (ListProtectedResources)",
    "Backup plan templates and versions",
    "Vault notifications",
    "Editing a recovery point's lifecycle (UpdateRecoveryPointLifecycle)",
    "Stopping a backup job (StopBackupJob)",
    "Restore metadata lookup (GetRecoveryPointRestoreMetadata)",
    "Audit Manager report plans, restore testing, Region settings",
  ],
};
