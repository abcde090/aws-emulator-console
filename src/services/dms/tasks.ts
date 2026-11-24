/** DMS database migration tasks: list, create, detail (with table statistics), start and delete. */

import {
  CreateReplicationTaskCommand,
  DeleteReplicationTaskCommand,
  DescribeReplicationTasksCommand,
  DescribeTableStatisticsCommand,
  StartReplicationTaskCommand,
  type MigrationTypeValue,
  type ReplicationTask,
  type StartReplicationTaskTypeValue,
  type TableStatistics,
} from "@aws-sdk/client-database-migration-service";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, Option, ResourceDef, Tag } from "../../console/types.ts";
import { canStartTask, defaultStartType, migrationTypeLabel, prettyJson, selectionRules, tableMappingProblem, taskSettings, type RuleAction } from "./helpers.ts";
import { endpoints, replicationInstances } from "./infra.ts";

const IDENT = { pattern: "[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z0-9]+)*", message: "Letters, numbers and single hyphens, starting with a letter; no trailing hyphen." };

async function tasks(ctx: Ctx, id?: string): Promise<ReplicationTask[]> {
  const out: ReplicationTask[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.clients.dms.send(new DescribeReplicationTasksCommand({ Filters: id ? [{ Name: "replication-task-id", Values: [id] }] : undefined, Marker: marker, MaxRecords: 100, WithoutSettings: false }));
    out.push(...(r.ReplicationTasks ?? []));
    if (!r.Marker || r.Marker === marker) break;
    marker = r.Marker;
  }
  return out;
}

async function oneTask(ctx: Ctx, id: string): Promise<ReplicationTask> {
  const [t] = await tasks(ctx, id);
  if (!t?.ReplicationTaskArn) throw new Error(`Database migration task ${id} was not found.`);
  return t;
}

/** Names for the ARNs a task refers to, so the list shows instances and endpoints by name. */
async function nameMaps(ctx: Ctx): Promise<Map<string, string>> {
  const [instances, eps] = await Promise.all([replicationInstances(ctx), endpoints(ctx)]);
  return new Map([
    ...instances.filter((r) => r.ReplicationInstanceArn).map((r) => [r.ReplicationInstanceArn as string, r.ReplicationInstanceIdentifier ?? ""] as const),
    ...eps.filter((e) => e.EndpointArn).map((e) => [e.EndpointArn as string, e.EndpointIdentifier ?? ""] as const),
  ]);
}

async function instanceOptions(ctx: Ctx): Promise<Option[]> {
  return (await replicationInstances(ctx))
    .filter((r) => r.ReplicationInstanceArn)
    .map((r) => ({ value: r.ReplicationInstanceArn as string, label: `${r.ReplicationInstanceIdentifier ?? ""} (${r.ReplicationInstanceClass ?? ""}, ${r.ReplicationInstanceStatus ?? ""})` }));
}

function endpointOptions(type: "SOURCE" | "TARGET"): (ctx: Ctx) => Promise<Option[]> {
  return async (ctx) =>
    (await endpoints(ctx))
      .filter((e) => e.EndpointArn && e.EndpointType?.toUpperCase() === type)
      .map((e) => ({ value: e.EndpointArn as string, label: `${e.EndpointIdentifier ?? ""} (${e.EngineDisplayName ?? e.EngineName ?? ""})` }));
}

function tableStatsRow(s: TableStatistics) {
  return {
    table: `${s.SchemaName ?? ""}.${s.TableName ?? ""}`,
    state: s.TableState ?? null,
    fullLoadRows: s.FullLoadRows ?? null,
    inserts: s.Inserts ?? null,
    updates: s.Updates ?? null,
    deletes: s.Deletes ?? null,
    ddls: s.Ddls ?? null,
    validation: s.ValidationState ?? null,
    lastUpdated: s.LastUpdateTime ?? null,
  };
}

async function tableStats(ctx: Ctx, arn: string): Promise<ReturnType<typeof tableStatsRow>[] | string> {
  try {
    const r = await ctx.clients.dms.send(new DescribeTableStatisticsCommand({ ReplicationTaskArn: arn, MaxRecords: 500 }));
    return (r.TableStatistics ?? []).map(tableStatsRow);
  } catch (err: unknown) {
    return `Could not read table statistics: ${errorMessage(err)}`;
  }
}

export const taskResource: ResourceDef = {
  id: "tasks",
  name: "Database migration tasks",
  singular: "database migration task",
  idField: "id",
  nameField: "id",
  description: "Tasks move data from a source endpoint to a target endpoint on a replication instance.",
  emptyText: "No database migration tasks. Create a replication instance and two endpoints first.",
  columns: [
    { key: "id", label: "Identifier", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "progress", label: "Progress", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "source", label: "Source", kind: "text" },
    { key: "target", label: "Target", kind: "text" },
    { key: "instance", label: "Replication instance", kind: "text" },
    { key: "started", label: "Started", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    const [all, names] = await Promise.all([tasks(ctx), nameMaps(ctx)]);
    const name = (arn: string | undefined) => (arn ? names.get(arn) ?? arn : null);
    return all.map((t) => ({
      id: t.ReplicationTaskIdentifier ?? "",
      status: t.Status ?? null,
      progress: typeof t.ReplicationTaskStats?.FullLoadProgressPercent === "number" ? `Load complete ${t.ReplicationTaskStats.FullLoadProgressPercent}%` : null,
      type: t.MigrationType ?? null,
      source: name(t.SourceEndpointArn),
      target: name(t.TargetEndpointArn),
      instance: name(t.ReplicationInstanceArn),
      started: t.ReplicationTaskStartDate ?? null,
      arn: t.ReplicationTaskArn ?? null,
    }));
  },
  async get(ctx, id) {
    const [t, names] = await Promise.all([oneTask(ctx, id), nameMaps(ctx)]);
    const stats = await tableStats(ctx, t.ReplicationTaskArn as string);
    const s = t.ReplicationTaskStats;
    const name = (arn: string | undefined) => (arn ? names.get(arn) ?? arn : null);
    return {
      summary: {
        Identifier: id,
        Status: t.Status ?? null,
        "Migration type": migrationTypeLabel(t.MigrationType),
        "Replication instance": name(t.ReplicationInstanceArn),
        "Source endpoint": name(t.SourceEndpointArn),
        "Target endpoint": name(t.TargetEndpointArn),
        "Stop reason": t.StopReason ?? null,
        "Last failure message": t.LastFailureMessage ?? null,
        ARN: t.ReplicationTaskArn ?? null,
      },
      tabs: [
        {
          id: "stats", label: "Table statistics", kind: "table",
          columns: [
            { key: "table", label: "Table", kind: "text" },
            { key: "state", label: "Load state", kind: "status" },
            { key: "fullLoadRows", label: "Full load rows", kind: "count" },
            { key: "inserts", label: "Inserts", kind: "count" },
            { key: "updates", label: "Updates", kind: "count" },
            { key: "deletes", label: "Deletes", kind: "count" },
            { key: "ddls", label: "DDLs", kind: "count" },
            { key: "validation", label: "Validation state", kind: "text" },
            { key: "lastUpdated", label: "Last updated", kind: "date" },
          ],
          data: typeof stats === "string" ? [] : stats,
          emptyText: typeof stats === "string" ? stats : "No table statistics. The emulator has no real source database, so no tables are loaded.",
        },
        {
          id: "progress", label: "Migration progress", kind: "keyvalue",
          data: {
            "Full load progress (%)": s?.FullLoadProgressPercent ?? null,
            "Elapsed time (ms)": s?.ElapsedTimeMillis ?? null,
            "Tables loaded": s?.TablesLoaded ?? null,
            "Tables loading": s?.TablesLoading ?? null,
            "Tables queued": s?.TablesQueued ?? null,
            "Tables errored": s?.TablesErrored ?? null,
            Created: t.ReplicationTaskCreationDate ?? null,
            Started: t.ReplicationTaskStartDate ?? s?.StartDate ?? null,
            "Full load started": s?.FullLoadStartDate ?? null,
            "Full load finished": s?.FullLoadFinishDate ?? null,
            Stopped: s?.StopDate ?? null,
          },
        },
        { id: "mappings", label: "Table mappings", kind: "json", data: prettyJson(t.TableMappings), emptyText: "No table mappings." },
        { id: "settings", label: "Task settings", kind: "json", data: prettyJson(t.ReplicationTaskSettings), emptyText: "No task settings returned." },
      ],
    };
  },
  create: {
    title: "Create database migration task",
    description: "Creates a task with CreateReplicationTask. Start it afterwards with Actions > Start.",
    fields: [
      { name: "id", label: "Task identifier", kind: "text", required: true, validate: IDENT, section: "Task configuration" },
      { name: "instance", label: "Replication instance", kind: "select", required: true, options: instanceOptions, section: "Task configuration" },
      { name: "source", label: "Source database endpoint", kind: "select", required: true, options: endpointOptions("SOURCE"), section: "Task configuration" },
      { name: "target", label: "Target database endpoint", kind: "select", required: true, options: endpointOptions("TARGET"), section: "Task configuration" },
      {
        name: "migrationType", label: "Migration type", kind: "radio", default: "full-load", section: "Task configuration",
        options: [
          { value: "full-load", label: "Migrate existing data" },
          { value: "full-load-and-cdc", label: "Migrate existing data and replicate ongoing changes" },
          { value: "cdc", label: "Replicate data changes only" },
        ],
      },
      { name: "prepMode", label: "Target table preparation mode", kind: "radio", default: "DROP_AND_CREATE", section: "Task settings", options: [{ value: "DO_NOTHING", label: "Do nothing" }, { value: "DROP_AND_CREATE", label: "Drop tables on target" }, { value: "TRUNCATE_BEFORE_LOAD", label: "Truncate" }] },
      { name: "lobMode", label: "LOB column settings", kind: "radio", default: "limited", section: "Task settings", options: [{ value: "none", label: "Don't include LOB columns" }, { value: "full", label: "Full LOB mode" }, { value: "limited", label: "Limited LOB mode (32 KB)" }] },
      { name: "validation", label: "Turn on data validation", kind: "checkbox", default: false, section: "Task settings" },
      { name: "mappingMode", label: "Editing mode", kind: "radio", default: "wizard", section: "Table mappings", options: [{ value: "wizard", label: "Wizard" }, { value: "json", label: "JSON editor" }] },
      { name: "schema", label: "Schema name", kind: "text", default: "%", section: "Table mappings", showIf: { field: "mappingMode", equals: "wizard" }, help: "% matches any schema." },
      { name: "table", label: "Source table name", kind: "text", default: "%", section: "Table mappings", showIf: { field: "mappingMode", equals: "wizard" }, help: "% matches any table." },
      { name: "action", label: "Action", kind: "select", default: "include", section: "Table mappings", showIf: { field: "mappingMode", equals: "wizard" }, options: [{ value: "include", label: "Include" }, { value: "exclude", label: "Exclude" }] },
      { name: "mappings", label: "Table mappings JSON", kind: "json", required: true, section: "Table mappings", showIf: { field: "mappingMode", equals: "json" }, placeholder: '{ "rules": [ ... ] }' },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const id = String(v.id).toLowerCase();
      const mappings = v.mappingMode === "json"
        ? String(v.mappings)
        : selectionRules(String(v.schema ?? "%"), String(v.table ?? "%"), (v.action === "exclude" ? "exclude" : "include") as RuleAction);
      const problem = tableMappingProblem(mappings);
      if (problem) throw new Error(problem);
      await ctx.clients.dms.send(new CreateReplicationTaskCommand({
        ReplicationTaskIdentifier: id,
        ReplicationInstanceArn: String(v.instance),
        SourceEndpointArn: String(v.source),
        TargetEndpointArn: String(v.target),
        MigrationType: String(v.migrationType) as MigrationTypeValue,
        TableMappings: mappings,
        ReplicationTaskSettings: taskSettings(String(v.prepMode), String(v.lobMode), v.validation === true),
        Tags: Array.isArray(v.tags) && v.tags.length ? (v.tags as Tag[]) : undefined,
      }));
      return id;
    },
  },
  actions: [
    {
      id: "start",
      label: "Restart/Resume",
      fields: [
        {
          name: "startType", label: "Start option", kind: "radio", default: "start-replication",
          options: [
            { value: "start-replication", label: "Start (first run of a new task)" },
            { value: "resume-processing", label: "Resume where the task stopped" },
            { value: "reload-target", label: "Restart: reload the target from scratch" },
          ],
        },
      ],
      availableFor: (row) => canStartTask(row.status ?? row.Status),
      async initialValues(ctx, id) {
        return { startType: defaultStartType((await oneTask(ctx, id)).Status) };
      },
      async run(ctx, id, v) {
        const t = await oneTask(ctx, id);
        const r = await ctx.clients.dms.send(new StartReplicationTaskCommand({ ReplicationTaskArn: t.ReplicationTaskArn, StartReplicationTaskType: String(v.startType) as StartReplicationTaskTypeValue }));
        return { message: `Task ${id} is ${r.ReplicationTask?.Status ?? "starting"}. Refresh to follow its progress.` };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, id) {
      const t = await oneTask(ctx, id);
      await ctx.clients.dms.send(new DeleteReplicationTaskCommand({ ReplicationTaskArn: t.ReplicationTaskArn }));
    },
  },
};
