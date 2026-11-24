/**
 * The Databases page's Actions menu. Ids are "db:<instance>" or "cluster:<cluster>"; an
 * action that only exists for one kind says so instead of calling the wrong API.
 */

import { fieldTags, tagDiff, tagDiffMessage, tagPairs } from "../../console/tags.ts";
import {
  AddTagsToResourceCommand,
  CreateDBClusterSnapshotCommand,
  CreateDBInstanceCommand,
  CreateDBInstanceReadReplicaCommand,
  CreateDBSnapshotCommand,
  DeleteDBClusterCommand,
  DeleteDBInstanceCommand,
  FailoverDBClusterCommand,
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
  RebootDBInstanceCommand,
  RemoveTagsFromResourceCommand,
  RestoreDBClusterToPointInTimeCommand,
  RestoreDBInstanceToPointInTimeCommand,
  StartDBClusterCommand,
  StartDBInstanceCommand,
  StopDBClusterCommand,
  StopDBInstanceCommand,
} from "@aws-sdk/client-rds";
import type { ActionDef, Ctx, FieldDef, FieldValues, Option, Row } from "../../console/types.ts";
import { IDENTIFIER, INSTANCE_CLASSES, parseDbKey, type DbKey } from "./format.ts";
import { getCluster, getInstance, optionalNumber, optionalText, parameterGroupOptions, parseDateTime, securityGroupOptions, strings, text } from "./shared.ts";

const CLASS_OPTIONS = INSTANCE_CLASSES.map((c) => ({ value: c, label: c }));
const identifierField = (name: string, label: string, help?: string): FieldDef => ({
  name, label, kind: "text", required: true, help,
  validate: { pattern: IDENTIFIER, message: "1-63 letters, numbers or hyphens; starts with a letter; no two hyphens in a row and no hyphen at the end." },
});

function only(kind: DbKey["kind"], key: string, what: string): string {
  const k = parseDbKey(key);
  if (k.kind !== kind) throw new Error(`${what} applies to ${kind === "db" ? "DB instances" : "DB clusters"}. Select ${kind === "db" ? "an instance" : "the cluster"} instead.`);
  return k.id;
}

async function arnOf(ctx: Ctx, k: DbKey): Promise<string> {
  const arn = k.kind === "db" ? (await getInstance(ctx, k.id)).DBInstanceArn : (await getCluster(ctx, k.id)).DBClusterArn;
  if (!arn) throw new Error("RDS returned no ARN.");
  return arn;
}

/** The wanted value when it differs from the current one, else undefined (nothing to send). */
function changed<T>(wanted: T | undefined, current: T | undefined): T | undefined {
  return wanted !== undefined && wanted !== current ? wanted : undefined;
}

function changedList(wanted: string[], current: string[]): string[] | undefined {
  if (wanted.length === 0) return undefined;
  const a = [...wanted].sort().join(",");
  const b = current.filter(Boolean).sort().join(",");
  return a === b ? undefined : wanted;
}

function hasChanges(o: Record<string, unknown>): boolean {
  return Object.values(o).some((x) => x !== undefined);
}

/** The instance classes, plus the instance's current class when it isn't in the list. */
async function classOptionsFor(ctx: Ctx, key?: string): Promise<Option[]> {
  const out = [...CLASS_OPTIONS];
  if (!key) return out;
  const k = parseDbKey(key);
  if (k.kind !== "db") return out;
  const current = (await getInstance(ctx, k.id)).DBInstanceClass;
  if (current && !out.some((o) => o.value === current)) out.unshift({ value: current, label: current });
  return out;
}

/** Security groups, plus any the database uses that EC2 doesn't list (so the prefill is a valid choice). */
async function securityGroupOptionsFor(ctx: Ctx, key?: string): Promise<Option[]> {
  const out = await securityGroupOptions(ctx);
  if (!key) return out;
  const k = parseDbKey(key);
  const groups = k.kind === "db" ? (await getInstance(ctx, k.id)).VpcSecurityGroups : (await getCluster(ctx, k.id)).VpcSecurityGroups;
  for (const g of groups ?? []) {
    if (g.VpcSecurityGroupId && !out.some((o) => o.value === g.VpcSecurityGroupId)) out.push({ value: g.VpcSecurityGroupId, label: g.VpcSecurityGroupId });
  }
  return out;
}

/** Parameter groups, plus the instance's current one if the list lacks it. */
async function parameterGroupOptionsFor(ctx: Ctx, key?: string): Promise<Option[]> {
  const out = await parameterGroupOptions(ctx);
  if (!key) return out;
  const k = parseDbKey(key);
  if (k.kind !== "db") return out;
  const current = (await getInstance(ctx, k.id)).DBParameterGroups?.[0]?.DBParameterGroupName;
  if (current && !out.some((o) => o.value === current)) out.unshift({ value: current, label: current });
  return out;
}

const CLUSTER_ROLES = new Set(["Regional cluster", "Multi-AZ DB cluster", "Serverless"]);

/** Whether a list row or detail summary is a DB cluster; undefined when it can't tell. */
function isClusterRow(row: Row): boolean | undefined {
  if (typeof row.key === "string") return row.key.startsWith("cluster:");
  if (typeof row.role === "string") return CLUSTER_ROLES.has(row.role);
  return undefined;
}

const statusIs = (row: Row, ...wanted: string[]): boolean => typeof row.status !== "string" || wanted.includes(row.status);

/** Reader instances of a cluster, for Failover. */
async function readerOptions(ctx: Ctx, key?: string): Promise<Option[]> {
  if (!key) return [];
  const k = parseDbKey(key);
  if (k.kind !== "cluster") return [];
  const c = await getCluster(ctx, k.id);
  return (c.DBClusterMembers ?? []).filter((m) => !m.IsClusterWriter && m.DBInstanceIdentifier).map((m) => ({ value: m.DBInstanceIdentifier as string, label: m.DBInstanceIdentifier as string }));
}

export const databaseActions: ActionDef[] = [
  {
    id: "modify",
    label: "Modify",
    fields: [
      { name: "instanceClass", label: "DB instance class", kind: "select", options: classOptionsFor, help: "Instances only." },
      { name: "allocatedStorage", label: "Allocated storage (GiB)", kind: "number", help: "Instances only.", validate: { min: 20, max: 65536, message: "Between 20 and 65,536 GiB." } },
      { name: "multiAz", label: "Multi-AZ deployment", kind: "checkbox", default: false, help: "Instances only." },
      { name: "publicAccess", label: "Publicly accessible", kind: "checkbox", default: false, help: "Instances only." },
      { name: "securityGroups", label: "VPC security groups", kind: "multiselect", options: securityGroupOptionsFor },
      { name: "parameterGroup", label: "DB parameter group", kind: "select", options: parameterGroupOptionsFor, help: "Instances only." },
      { name: "backupRetention", label: "Backup retention period (days)", kind: "number", validate: { min: 0, max: 35, message: "Between 0 and 35 days." } },
      { name: "deletionProtection", label: "Enable deletion protection", kind: "checkbox", default: false },
      { name: "autoMinor", label: "Enable auto minor version upgrade", kind: "checkbox", default: false, help: "Instances only." },
      { name: "newPassword", label: "New master password", kind: "password", help: "Only for self-managed credentials. Leave empty to keep the current password.", validate: { pattern: "[^/\"@ ]{8,41}", message: "8-41 printable characters, not / \" @ or a space." } },
      {
        name: "apply", label: "Schedule modifications", kind: "radio", required: true, default: "immediately",
        options: [
          { value: "immediately", label: "Apply immediately" },
          { value: "window", label: "Apply during the next scheduled maintenance window" },
        ],
      },
    ],
    async initialValues(ctx, key): Promise<FieldValues> {
      const k = parseDbKey(key);
      if (k.kind === "cluster") {
        const c = await getCluster(ctx, k.id);
        return {
          securityGroups: (c.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId ?? "").filter(Boolean),
          backupRetention: c.BackupRetentionPeriod ?? null,
          deletionProtection: c.DeletionProtection === true,
        };
      }
      const i = await getInstance(ctx, k.id);
      return {
        instanceClass: i.DBInstanceClass ?? "",
        allocatedStorage: i.AllocatedStorage ?? null,
        multiAz: i.MultiAZ === true,
        publicAccess: i.PubliclyAccessible === true,
        securityGroups: (i.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId ?? "").filter(Boolean),
        parameterGroup: i.DBParameterGroups?.[0]?.DBParameterGroupName ?? "",
        backupRetention: i.BackupRetentionPeriod ?? null,
        deletionProtection: i.DeletionProtection === true,
        autoMinor: i.AutoMinorVersionUpgrade === true,
      };
    },
    async run(ctx, key, v) {
      const k = parseDbKey(key);
      const immediately = v.apply === "immediately";
      const groups = strings(v.securityGroups);
      const password = optionalText(v.newPassword);
      if (k.kind === "cluster") {
        const c = await getCluster(ctx, k.id);
        const changes = {
          BackupRetentionPeriod: changed(optionalNumber(v.backupRetention), c.BackupRetentionPeriod),
          DeletionProtection: changed(v.deletionProtection === true, c.DeletionProtection === true),
          VpcSecurityGroupIds: changedList(groups, (c.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId ?? "")),
          MasterUserPassword: password,
        };
        if (!hasChanges(changes)) return { message: `No changes to DB cluster ${k.id}.` };
        const r = await ctx.clients.rds.send(new ModifyDBClusterCommand({ DBClusterIdentifier: k.id, ApplyImmediately: immediately, ...changes }));
        return { message: `Modifying DB cluster ${k.id} (status ${r.DBCluster?.Status ?? "unknown"}).` };
      }
      const i = await getInstance(ctx, k.id);
      const changes = {
        DBInstanceClass: changed(optionalText(v.instanceClass), i.DBInstanceClass),
        AllocatedStorage: changed(optionalNumber(v.allocatedStorage), i.AllocatedStorage),
        MultiAZ: changed(v.multiAz === true, i.MultiAZ === true),
        PubliclyAccessible: changed(v.publicAccess === true, i.PubliclyAccessible === true),
        VpcSecurityGroupIds: changedList(groups, (i.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId ?? "")),
        DBParameterGroupName: changed(optionalText(v.parameterGroup), i.DBParameterGroups?.[0]?.DBParameterGroupName),
        BackupRetentionPeriod: changed(optionalNumber(v.backupRetention), i.BackupRetentionPeriod),
        DeletionProtection: changed(v.deletionProtection === true, i.DeletionProtection === true),
        AutoMinorVersionUpgrade: changed(v.autoMinor === true, i.AutoMinorVersionUpgrade === true),
        MasterUserPassword: password,
      };
      if (!hasChanges(changes)) return { message: `No changes to DB instance ${k.id}.` };
      const r = await ctx.clients.rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: k.id, ApplyImmediately: immediately, ...changes }));
      return { message: `Modifying DB instance ${k.id} (status ${r.DBInstance?.DBInstanceStatus ?? "unknown"}).`, json: { PendingModifiedValues: r.DBInstance?.PendingModifiedValues ?? {} } };
    },
  },
  {
    id: "reboot",
    label: "Reboot",
    fields: [{ name: "failover", label: "Reboot with failover", kind: "checkbox", default: false, help: "Multi-AZ instances only: the standby becomes the primary." }],
    availableFor: (row) => isClusterRow(row) !== true && statusIs(row, "available"),
    async run(ctx, key, v) {
      const id = only("db", key, "Reboot");
      const r = await ctx.clients.rds.send(new RebootDBInstanceCommand({ DBInstanceIdentifier: id, ForceFailover: v.failover === true || undefined }));
      return { message: `Rebooting ${id} (status ${r.DBInstance?.DBInstanceStatus ?? "unknown"}).` };
    },
  },
  {
    id: "stop",
    label: "Stop temporarily",
    confirm: "The database stops for up to 7 days, then RDS starts it again automatically. You keep paying for storage.",
    // Aurora members and read replicas can't be stopped on their own.
    availableFor: (row) => statusIs(row, "available") && !["Writer instance", "Reader instance", "Replica"].includes(String(row.role)),
    async run(ctx, key) {
      const k = parseDbKey(key);
      if (k.kind === "cluster") {
        const r = await ctx.clients.rds.send(new StopDBClusterCommand({ DBClusterIdentifier: k.id }));
        return { message: `Stopping DB cluster ${k.id} (status ${r.DBCluster?.Status ?? "unknown"}).` };
      }
      const r = await ctx.clients.rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: k.id }));
      return { message: `Stopping DB instance ${k.id} (status ${r.DBInstance?.DBInstanceStatus ?? "unknown"}).` };
    },
  },
  {
    id: "start",
    label: "Start",
    availableFor: (row) => statusIs(row, "stopped"),
    async run(ctx, key) {
      const k = parseDbKey(key);
      if (k.kind === "cluster") {
        const r = await ctx.clients.rds.send(new StartDBClusterCommand({ DBClusterIdentifier: k.id }));
        return { message: `Starting DB cluster ${k.id} (status ${r.DBCluster?.Status ?? "unknown"}).` };
      }
      const r = await ctx.clients.rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: k.id }));
      return { message: `Starting DB instance ${k.id} (status ${r.DBInstance?.DBInstanceStatus ?? "unknown"}).` };
    },
  },
  {
    id: "snapshot",
    label: "Take snapshot",
    fields: [identifierField("snapshotId", "Snapshot name")],
    async run(ctx, key, v) {
      const k = parseDbKey(key);
      if (k.kind === "cluster") {
        const r = await ctx.clients.rds.send(new CreateDBClusterSnapshotCommand({ DBClusterIdentifier: k.id, DBClusterSnapshotIdentifier: text(v.snapshotId) }));
        return { message: `Cluster snapshot ${r.DBClusterSnapshot?.DBClusterSnapshotIdentifier ?? text(v.snapshotId)} is ${r.DBClusterSnapshot?.Status ?? "being created"}.` };
      }
      const r = await ctx.clients.rds.send(new CreateDBSnapshotCommand({ DBInstanceIdentifier: k.id, DBSnapshotIdentifier: text(v.snapshotId) }));
      return { message: `Snapshot ${r.DBSnapshot?.DBSnapshotIdentifier ?? text(v.snapshotId)} is ${r.DBSnapshot?.Status ?? "being created"}.` };
    },
  },
  {
    id: "read-replica",
    label: "Create read replica",
    availableFor: (row) => isClusterRow(row) !== true && !["Writer instance", "Reader instance"].includes(String(row.role)),
    fields: [
      identifierField("replicaId", "Replica DB instance identifier"),
      { name: "instanceClass", label: "DB instance class", kind: "select", default: "", options: CLASS_OPTIONS, help: "Leave empty to use the source's class." },
      { name: "multiAz", label: "Multi-AZ replica", kind: "checkbox", default: false },
      { name: "publicAccess", label: "Publicly accessible", kind: "checkbox", default: false },
    ],
    async run(ctx, key, v) {
      const id = only("db", key, "Create read replica");
      const r = await ctx.clients.rds.send(
        new CreateDBInstanceReadReplicaCommand({
          DBInstanceIdentifier: text(v.replicaId),
          SourceDBInstanceIdentifier: id,
          DBInstanceClass: optionalText(v.instanceClass),
          MultiAZ: v.multiAz === true,
          PubliclyAccessible: v.publicAccess === true,
        })
      );
      return { message: `Creating read replica ${r.DBInstance?.DBInstanceIdentifier ?? text(v.replicaId)} of ${id}.` };
    },
  },
  {
    id: "add-reader",
    label: "Add reader",
    availableFor: (row) => isClusterRow(row) !== false,
    fields: [identifierField("readerId", "DB instance identifier"), { name: "instanceClass", label: "DB instance class", kind: "select", required: true, default: "db.r6g.large", options: CLASS_OPTIONS }],
    async run(ctx, key, v) {
      const id = only("cluster", key, "Add reader");
      const c = await getCluster(ctx, id);
      const r = await ctx.clients.rds.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: text(v.readerId), DBClusterIdentifier: id, Engine: c.Engine, DBInstanceClass: text(v.instanceClass) }));
      return { message: `Adding reader ${r.DBInstance?.DBInstanceIdentifier ?? text(v.readerId)} to ${id}.` };
    },
  },
  {
    id: "failover",
    label: "Failover",
    availableFor: (row) => isClusterRow(row) !== false && statusIs(row, "available"),
    fields: [{ name: "target", label: "Target instance", kind: "select", options: readerOptions, help: "The reader to promote. Leave empty to let RDS choose." }],
    async run(ctx, key, v) {
      const id = only("cluster", key, "Failover");
      const r = await ctx.clients.rds.send(new FailoverDBClusterCommand({ DBClusterIdentifier: id, TargetDBInstanceIdentifier: optionalText(v.target) }));
      const writer = r.DBCluster?.DBClusterMembers?.find((m) => m.IsClusterWriter)?.DBInstanceIdentifier;
      return { message: `Failing over ${id} (status ${r.DBCluster?.Status ?? "unknown"}). Writer: ${writer ?? "unknown"}.` };
    },
  },
  {
    id: "restore-pitr",
    label: "Restore to point in time",
    fields: [
      identifierField("targetId", "New DB identifier", "The restore creates a new instance or cluster."),
      { name: "latest", label: "Latest restorable time", kind: "checkbox", default: true },
      { name: "restoreTime", label: "Custom date and time (UTC)", kind: "text", required: true, placeholder: "2026-11-23T10:00:00Z", showIf: { field: "latest", equals: false } },
      { name: "instanceClass", label: "DB instance class", kind: "select", default: "", options: CLASS_OPTIONS, help: "Instances only. Leave empty to use the source's class." },
    ],
    async run(ctx, key, v) {
      const k = parseDbKey(key);
      const latest = v.latest === true;
      const time = latest ? undefined : parseDateTime(v.restoreTime, "Custom date and time");
      if (k.kind === "cluster") {
        const r = await ctx.clients.rds.send(
          new RestoreDBClusterToPointInTimeCommand({ SourceDBClusterIdentifier: k.id, DBClusterIdentifier: text(v.targetId), UseLatestRestorableTime: latest || undefined, RestoreToTime: time })
        );
        return { message: `Restoring to new DB cluster ${r.DBCluster?.DBClusterIdentifier ?? text(v.targetId)}. Add an instance to it with Add reader once it is available.` };
      }
      const r = await ctx.clients.rds.send(
        new RestoreDBInstanceToPointInTimeCommand({
          SourceDBInstanceIdentifier: k.id,
          TargetDBInstanceIdentifier: text(v.targetId),
          UseLatestRestorableTime: latest || undefined,
          RestoreTime: time,
          DBInstanceClass: optionalText(v.instanceClass),
        })
      );
      return { message: `Restoring to new DB instance ${r.DBInstance?.DBInstanceIdentifier ?? text(v.targetId)}.` };
    },
  },
  {
    id: "tags",
    label: "Manage tags",
    fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Tags you remove here are removed from the database." }],
    async initialValues(ctx, key) {
      const k = parseDbKey(key);
      const current = (k.kind === "db" ? (await getInstance(ctx, k.id)).TagList : (await getCluster(ctx, k.id)).TagList) ?? [];
      return { tags: tagPairs(current) };
    },
    async run(ctx, key, v) {
      const k = parseDbKey(key);
      const arn = await arnOf(ctx, k);
      const current = (k.kind === "db" ? (await getInstance(ctx, k.id)).TagList : (await getCluster(ctx, k.id)).TagList) ?? [];
      const diff = tagDiff(current, fieldTags(v.tags));
      if (diff.remove.length) await ctx.clients.rds.send(new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: diff.remove }));
      if (diff.set.length) await ctx.clients.rds.send(new AddTagsToResourceCommand({ ResourceName: arn, Tags: diff.set }));
      return { message: tagDiffMessage(diff) };
    },
  },
  {
    id: "delete",
    label: "Delete",
    danger: true,
    fields: [
      { name: "finalSnapshot", label: "Create final snapshot", kind: "checkbox", default: true },
      { ...identifierField("finalSnapshotId", "Final snapshot name"), showIf: { field: "finalSnapshot", equals: true } },
      { name: "retainBackups", label: "Retain automated backups", kind: "checkbox", default: false, help: "Instances only." },
      { name: "confirmText", label: "To confirm deletion, type delete me", kind: "text", required: true, validate: { pattern: "delete me", message: "Type delete me to confirm." } },
    ],
    async run(ctx, key, v) {
      const k = parseDbKey(key);
      const finalId = v.finalSnapshot === true ? text(v.finalSnapshotId) : undefined;
      if (k.kind === "cluster") {
        const c = await getCluster(ctx, k.id);
        if ((c.DBClusterMembers ?? []).length > 0) throw new Error(`Delete the cluster's ${c.DBClusterMembers?.length} DB instance(s) first; RDS deletes a cluster only when it has no instances.`);
        await ctx.clients.rds.send(new DeleteDBClusterCommand({ DBClusterIdentifier: k.id, SkipFinalSnapshot: !finalId, FinalDBSnapshotIdentifier: finalId }));
        return { message: `Deleting DB cluster ${k.id}${finalId ? ` with final snapshot ${finalId}` : ""}.` };
      }
      const i = await getInstance(ctx, k.id);
      const inCluster = Boolean(i.DBClusterIdentifier);
      await ctx.clients.rds.send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: k.id,
          SkipFinalSnapshot: inCluster ? undefined : !finalId,
          FinalDBSnapshotIdentifier: inCluster ? undefined : finalId,
          DeleteAutomatedBackups: v.retainBackups !== true,
        })
      );
      return { message: `Deleting DB instance ${k.id}${finalId && !inCluster ? ` with final snapshot ${finalId}` : ""}.` };
    },
  },
];
