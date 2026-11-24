/**
 * AWS Glue: Data Catalog databases and tables, crawlers and ETL jobs. Every value comes
 * from a Glue API response.
 */

import {
  BatchStopJobRunCommand,
  CreateCrawlerCommand,
  CreateDatabaseCommand,
  CreateJobCommand,
  CreateTableCommand,
  DeleteCrawlerCommand,
  DeleteDatabaseCommand,
  DeleteJobCommand,
  DeleteTableCommand,
  GetCrawlerCommand,
  GetCrawlerMetricsCommand,
  GetCrawlersCommand,
  GetDatabaseCommand,
  GetDatabasesCommand,
  GetJobCommand,
  GetJobRunsCommand,
  GetJobsCommand,
  GetPartitionsCommand,
  GetTableCommand,
  GetTablesCommand,
  StartCrawlerCommand,
  StartCrawlerScheduleCommand,
  StopCrawlerScheduleCommand,
  StartJobRunCommand,
  UpdateCrawlerCommand,
  UpdateDatabaseCommand,
  type Crawler,
  type Database,
  type DeleteBehavior,
  type Job,
  type JobRun,
  type Table,
  type UpdateBehavior,
  type WorkerType,
} from "@aws-sdk/client-glue";
import type { Ctx, FieldValues, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { optionalRead } from "../../console/secondary.ts";
import { roleOptions } from "../efs/lookups.ts";
import { recordToTags, tagRecord } from "../../console/tags.ts";
import { joinId, numberOr, parseS3Uri, S3_URI_PATTERN, splitId, stringMap, text } from "../../console/values.ts";
import { FORMATS, SCHEDULES, glueSchedule, parseColumns, scheduleChoice, storageFormat } from "./helpers.ts";

const GLUE_PRINCIPAL = "glue.amazonaws.com";
const DB_NAME = "[a-z0-9_]{1,255}";
const glueRoleOptions = (ctx: Ctx) => roleOptions(ctx, GLUE_PRINCIPAL);
/** The permission-checked Glue client (epoch precision is fixed for every client in src/lib/aws.ts). */
const glue = (ctx: Ctx) => ctx.clients.glue;

// ---------- shared reads ----------

async function allDatabases(ctx: Ctx) {
  const out: { Name?: string; Description?: string; LocationUri?: string; CreateTime?: Date; Parameters?: Record<string, string> }[] = [];
  let token: string | undefined;
  do {
    const r = await glue(ctx).send(new GetDatabasesCommand({ NextToken: token }));
    out.push(...(r.DatabaseList ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function database(ctx: Ctx, name: string): Promise<Database> {
  const d = (await glue(ctx).send(new GetDatabaseCommand({ Name: name }))).Database;
  if (!d) throw new Error(`Database ${name} was not found.`);
  return d;
}

async function databaseOptions(ctx: Ctx): Promise<Option[]> {
  return (await allDatabases(ctx)).flatMap((d) => (d.Name ? [{ value: d.Name, label: d.Name }] : []));
}

async function tablesIn(ctx: Ctx, db: string): Promise<Table[]> {
  const out: Table[] = [];
  let token: string | undefined;
  do {
    const r = await glue(ctx).send(new GetTablesCommand({ DatabaseName: db, NextToken: token }));
    out.push(...(r.TableList ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

function tableRow(t: Table): Row {
  return {
    id: joinId(t.DatabaseName ?? "", t.Name ?? ""),
    name: t.Name ?? null,
    database: t.DatabaseName ?? null,
    location: t.StorageDescriptor?.Location ?? null,
    classification: t.Parameters?.classification ?? null,
    type: t.TableType ?? null,
    columns: (t.StorageDescriptor?.Columns ?? []).length,
    updated: t.UpdateTime ?? null,
    deprecated: t.Parameters?.DEPRECATED_BY_CRAWLER ? "Deprecated" : null,
  };
}

const columnColumns = [
  { key: "name", label: "Column name", kind: "text" as const },
  { key: "type", label: "Data type", kind: "code" as const },
  { key: "partition", label: "Partition key", kind: "text" as const },
  { key: "comment", label: "Comment", kind: "text" as const },
];

// ---------- databases ----------

const databases: ResourceDef = {
  id: "databases",
  name: "Databases",
  singular: "database",
  idField: "name",
  nameField: "Name",
  description: "Data Catalog databases: logical groups of table definitions that Athena, EMR and Glue jobs query.",
  emptyText: "No databases.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "location", label: "Location", kind: "text" },
    { key: "created", label: "Created on", kind: "date" },
  ],

  async list(ctx) {
    return (await allDatabases(ctx)).map((d) => ({ name: d.Name ?? null, description: d.Description ?? null, location: d.LocationUri ?? null, created: d.CreateTime ?? null }));
  },

  async get(ctx, name) {
    const d = await database(ctx, name);
    const tables = await optionalRead(() => tablesIn(ctx, name), []);
    return {
      summary: { Name: d.Name ?? name, Description: d.Description ?? "-", Location: d.LocationUri ?? "-", "Created on": d.CreateTime ?? null, "Catalog ID": d.CatalogId ?? null },
      tabs: [
        {
          id: "tables",
          label: "Tables",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "location", label: "Location", kind: "text" },
            { key: "classification", label: "Classification", kind: "text" },
            { key: "updated", label: "Last updated", kind: "date" },
          ],
          data: tables.kind === "value" ? tables.value.map(tableRow) : [],
          emptyText: tables.kind === "error" ? `Tables are unavailable: ${tables.error}` : "No tables in this database. Add a table or run a crawler.",
        },
        { id: "parameters", label: "Properties", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: recordToTags(d.Parameters), emptyText: "No properties." },
      ],
    };
  },

  create: {
    title: "Add database",
    description: "Creates a Data Catalog database with CreateDatabase.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Database details", help: "Lowercase letters, numbers and underscores (Athena-compatible).", validate: { pattern: DB_NAME, message: "Use lowercase letters, numbers and underscores." } },
      { name: "location", label: "Location", kind: "text", section: "Database details", placeholder: "s3://my-bucket/my-db/", help: "Default S3 location for the database's tables.", validate: { pattern: S3_URI_PATTERN, message: "Enter an S3 URI." } },
      { name: "description", label: "Description", kind: "textarea", section: "Database details", validate: { max: 2048, message: "At most 2048 characters." } },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      await glue(ctx).send(new CreateDatabaseCommand({ DatabaseInput: { Name: name, Description: text(v.description), LocationUri: text(v.location) } }));
      return name;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit",
      fields: [
        { name: "description", label: "Description", kind: "textarea", validate: { max: 2048, message: "At most 2048 characters." } },
        { name: "location", label: "Location", kind: "text", validate: { pattern: S3_URI_PATTERN, message: "Enter an S3 URI." } },
      ],
      async initialValues(ctx, name) {
        const d = await database(ctx, name);
        return { description: d.Description ?? "", location: d.LocationUri ?? "" };
      },
      async run(ctx, name, v) {
        const d = await database(ctx, name);
        const description = text(v.description);
        const location = text(v.location);
        if (description === (d.Description || undefined) && location === (d.LocationUri || undefined)) return { message: "No changes to save." };
        // UpdateDatabase replaces the whole definition: send the current one with only the edits applied.
        await glue(ctx).send(
          new UpdateDatabaseCommand({
            Name: name,
            DatabaseInput: {
              Name: name,
              Description: description,
              LocationUri: location,
              Parameters: d.Parameters,
              CreateTableDefaultPermissions: d.CreateTableDefaultPermissions,
              TargetDatabase: d.TargetDatabase,
              FederatedDatabase: d.FederatedDatabase,
            },
          })
        );
        return { message: `Database ${name} updated.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await glue(ctx).send(new DeleteDatabaseCommand({ Name: name }));
    },
  },
};

// ---------- tables ----------

const tables: ResourceDef = {
  id: "tables",
  name: "Tables",
  singular: "table",
  idField: "id",
  nameField: "Name",
  description: "Table definitions: the schema, S3 location and data format of your data.",
  emptyText: "No tables. Add a table, or run a crawler to create tables from data in S3.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "database", label: "Database", kind: "text" },
    { key: "location", label: "Location", kind: "text" },
    { key: "classification", label: "Classification", kind: "text" },
    { key: "columns", label: "Columns", kind: "count" },
    { key: "deprecated", label: "Deprecated", kind: "text" },
    { key: "updated", label: "Last updated", kind: "date" },
    { key: "type", label: "Table type", kind: "text", hidden: true },
  ],

  async list(ctx) {
    const dbs = await allDatabases(ctx);
    const all = await Promise.all(dbs.flatMap((d) => (d.Name ? [tablesIn(ctx, d.Name)] : [])));
    return all.flat().map(tableRow);
  },

  async get(ctx, id) {
    const [db, name] = splitId(id, "table");
    const t = (await glue(ctx).send(new GetTableCommand({ DatabaseName: db, Name: name }))).Table;
    if (!t) throw new Error(`Table ${db}.${name} was not found.`);
    const parts = await optionalRead(() => glue(ctx).send(new GetPartitionsCommand({ DatabaseName: db, TableName: name, MaxResults: 100 })), []);
    const sd = t.StorageDescriptor;
    const keys = t.PartitionKeys ?? [];
    return {
      summary: {
        Name: t.Name ?? name,
        Database: t.DatabaseName ?? db,
        Description: t.Description ?? "-",
        Classification: t.Parameters?.classification ?? "-",
        Location: sd?.Location ?? "-",
        "Table type": t.TableType ?? null,
        "Last updated": t.UpdateTime ?? null,
        "Created by": t.CreatedBy ?? null,
      },
      tabs: [
        {
          id: "schema",
          label: "Schema",
          kind: "table",
          columns: columnColumns,
          data: [
            ...(sd?.Columns ?? []).map((c) => ({ name: c.Name ?? null, type: c.Type ?? null, partition: "-", comment: c.Comment ?? null })),
            ...keys.map((c, i) => ({ name: c.Name ?? null, type: c.Type ?? null, partition: `Partition (${i})`, comment: c.Comment ?? null })),
          ],
          emptyText: "No columns.",
        },
        {
          id: "partitions",
          label: "Partitions",
          kind: "table",
          columns: [
            { key: "values", label: "Partition values", kind: "code" },
            { key: "location", label: "Location", kind: "text" },
            { key: "created", label: "Created", kind: "date" },
          ],
          data: (parts.kind === "value" ? parts.value.Partitions ?? [] : []).map((p) => ({ values: (p.Values ?? []).map((v, i) => `${keys[i]?.Name ?? i}=${v}`).join(", "), location: p.StorageDescriptor?.Location ?? null, created: p.CreationTime ?? null })),
          emptyText: parts.kind === "error" ? `Partitions are unavailable: ${parts.error}` : keys.length ? "No partitions are registered yet (run a crawler or MSCK REPAIR TABLE in Athena)." : "This table isn't partitioned.",
        },
        {
          id: "storage",
          label: "Storage",
          kind: "keyvalue",
          data: {
            "Input format": sd?.InputFormat ?? "-",
            "Output format": sd?.OutputFormat ?? "-",
            "SerDe library": sd?.SerdeInfo?.SerializationLibrary ?? "-",
            "SerDe parameters": sd?.SerdeInfo?.Parameters ? JSON.stringify(sd.SerdeInfo.Parameters) : "-",
            Compressed: sd?.Compressed ?? false,
          },
        },
        { id: "properties", label: "Table properties", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: recordToTags(t.Parameters), emptyText: "No properties." },
      ],
    };
  },

  create: {
    title: "Add table",
    description: "Creates a table definition in the Data Catalog with CreateTable.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Table details", help: "Lowercase letters, numbers and underscores.", validate: { pattern: "[a-z0-9_]{1,255}", message: "Use lowercase letters, numbers and underscores." } },
      { name: "database", label: "Database", kind: "select", required: true, options: databaseOptions, section: "Table details" },
      { name: "description", label: "Description", kind: "text", section: "Table details" },
      { name: "location", label: "Data location (include path)", kind: "text", required: true, section: "Data store", placeholder: "s3://my-bucket/data/orders/", help: "The S3 folder that holds the table's files.", validate: { pattern: S3_URI_PATTERN, message: "Enter an S3 URI such as s3://bucket/folder/." } },
      { name: "format", label: "Data format", kind: "select", required: true, default: "csv", options: FORMATS, section: "Data format" },
      { name: "delimiter", label: "Delimiter", kind: "select", required: true, default: ",", section: "Data format", showIf: { field: "format", equals: "csv" }, options: [{ value: ",", label: "Comma (,)" }, { value: "\t", label: "Tab" }, { value: "|", label: "Pipe (|)" }, { value: ";", label: "Semicolon (;)" }] },
      { name: "skipHeader", label: "Skip the header line", kind: "checkbox", default: true, section: "Data format", showIf: { field: "format", equals: "csv" } },
      { name: "schema", label: "Schema", kind: "textarea", required: true, section: "Schema", placeholder: "id int\nname string\namount decimal(10,2)", help: "One column per line: name, data type, optional comment. Types: string, int, bigint, double, boolean, date, timestamp, decimal(p,s), array<…>, map<…>, struct<…>." },
      { name: "partitionKeys", label: "Partition keys", kind: "textarea", section: "Schema", placeholder: "year string\nmonth string", help: "Same format. Partitions map to S3 prefixes such as year=2026/." },
    ],
    async run(ctx, v) {
      const location = String(v.location);
      if (!parseS3Uri(location)) throw new Error("Data location must be an S3 URI.");
      const columns = parseColumns(text(v.schema), "Schema");
      if (columns.length === 0) throw new Error("Add at least one column to the schema.");
      const partitions = parseColumns(text(v.partitionKeys), "Partition keys");
      const clash = partitions.find((p) => columns.some((c) => c.Name.toLowerCase() === p.Name.toLowerCase()));
      if (clash) throw new Error(`"${clash.Name}" can't be both a column and a partition key.`);
      const format = text(v.format) ?? "csv";
      const delimiter = typeof v.delimiter === "string" && v.delimiter !== "" ? v.delimiter : ",";
      const params: Record<string, string> = { classification: format };
      if (format === "csv" && v.skipHeader === true) params["skip.header.line.count"] = "1";
      const db = String(v.database);
      const name = String(v.name);
      await glue(ctx).send(
        new CreateTableCommand({
          DatabaseName: db,
          TableInput: {
            Name: name,
            Description: text(v.description),
            TableType: "EXTERNAL_TABLE",
            Parameters: params,
            PartitionKeys: partitions.length ? partitions : undefined,
            StorageDescriptor: { Columns: columns, Location: location, ...storageFormat(format, delimiter) },
          },
        })
      );
      return joinId(db, name);
    },
  },

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const [db, name] = splitId(id, "table");
      await glue(ctx).send(new DeleteTableCommand({ DatabaseName: db, Name: name }));
    },
  },
};

// ---------- crawlers ----------

async function crawler(ctx: Ctx, name: string): Promise<Crawler> {
  const c = (await glue(ctx).send(new GetCrawlerCommand({ Name: name }))).Crawler;
  if (!c) throw new Error(`Crawler ${name} was not found.`);
  return c;
}

/** The Edit schedule form for a crawler: a paused or missing schedule means on demand. */
function crawlerScheduleValues(c: Crawler): FieldValues {
  const expr = c.Schedule?.State === "NOT_SCHEDULED" ? undefined : c.Schedule?.ScheduleExpression;
  return scheduleChoice(expr);
}

function crawlerRow(c: Crawler, metrics: Map<string, { created?: number; updated?: number }>): Row {
  const m = metrics.get(c.Name ?? "");
  return {
    name: c.Name ?? null,
    state: c.State ?? null,
    schedule: !c.Schedule?.ScheduleExpression ? "On demand" : c.Schedule.State === "NOT_SCHEDULED" ? `${c.Schedule.ScheduleExpression} (paused)` : c.Schedule.ScheduleExpression,
    lastRun: c.LastCrawl?.Status ?? null,
    lastRunTime: c.LastCrawl?.StartTime ?? null,
    database: c.DatabaseName ?? null,
    tablesCreated: m?.created ?? null,
    tablesUpdated: m?.updated ?? null,
  };
}

async function crawlerMetrics(ctx: Ctx, names: string[]): Promise<Map<string, { created?: number; updated?: number }>> {
  const map = new Map<string, { created?: number; updated?: number }>();
  for (let i = 0; i < names.length; i += 100) {
    const r = await glue(ctx).send(new GetCrawlerMetricsCommand({ CrawlerNameList: names.slice(i, i + 100) }));
    for (const m of r.CrawlerMetricsList ?? []) if (m.CrawlerName) map.set(m.CrawlerName, { created: m.TablesCreated, updated: m.TablesUpdated });
  }
  return map;
}

const crawlers: ResourceDef = {
  id: "crawlers",
  name: "Crawlers",
  singular: "crawler",
  idField: "name",
  nameField: "Name",
  description: "Crawlers scan data in S3, infer schemas and create or update tables in the Data Catalog.",
  emptyText: "No crawlers. Create a crawler to catalogue data in S3.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "state", label: "State", kind: "status" },
    { key: "schedule", label: "Schedule", kind: "code" },
    { key: "lastRun", label: "Last run", kind: "status" },
    { key: "lastRunTime", label: "Last run timestamp", kind: "date" },
    { key: "database", label: "Database", kind: "text" },
    { key: "tablesCreated", label: "Tables created", kind: "count" },
    { key: "tablesUpdated", label: "Tables updated", kind: "count" },
  ],

  async list(ctx) {
    const out: Crawler[] = [];
    let token: string | undefined;
    do {
      const r = await glue(ctx).send(new GetCrawlersCommand({ NextToken: token }));
      out.push(...(r.Crawlers ?? []));
      token = r.NextToken;
    } while (token);
    // Metrics are secondary: without them the counts show as empty.
    const metrics = await optionalRead(() => crawlerMetrics(ctx, out.flatMap((c) => (c.Name ? [c.Name] : []))), []);
    return out.map((c) => crawlerRow(c, metrics.kind === "value" ? metrics.value : new Map()));
  },

  async get(ctx, name) {
    const c = await crawler(ctx, name);
    const metrics = await optionalRead(() => glue(ctx).send(new GetCrawlerMetricsCommand({ CrawlerNameList: [name] })), []);
    const m = metrics.kind === "value" ? metrics.value.CrawlerMetricsList?.[0] : undefined;
    return {
      summary: {
        Name: c.Name ?? name,
        State: c.State ?? null,
        "IAM role": c.Role ?? null,
        Database: c.DatabaseName ?? null,
        "Table prefix": c.TablePrefix ?? "-",
        Schedule: !c.Schedule?.ScheduleExpression ? "On demand" : c.Schedule.State === "NOT_SCHEDULED" ? `${c.Schedule.ScheduleExpression} (paused)` : c.Schedule.ScheduleExpression,
        Description: c.Description ?? "-",
        "Created on": c.CreationTime ?? null,
      },
      tabs: [
        {
          id: "runs",
          label: "Last run",
          kind: "keyvalue",
          data: c.LastCrawl
            ? {
                Status: c.LastCrawl.Status ?? null,
                "Start time": c.LastCrawl.StartTime ?? null,
                "Error message": c.LastCrawl.ErrorMessage ?? "-",
                "Log group": c.LastCrawl.LogGroup ?? "-",
                "Tables created": m?.TablesCreated ?? 0,
                "Tables updated": m?.TablesUpdated ?? 0,
                "Tables deleted": m?.TablesDeleted ?? 0,
                "Last runtime (seconds)": m?.LastRuntimeSeconds ?? null,
                "Median runtime (seconds)": m?.MedianRuntimeSeconds ?? null,
              }
            : {},
          description: metrics.kind === "error" ? `Crawler metrics are unavailable: ${metrics.error}` : undefined,
          emptyText: "This crawler hasn't run yet. Use Run crawler.",
        },
        {
          id: "sources",
          label: "Data sources",
          kind: "table",
          columns: [
            { key: "type", label: "Type", kind: "text" },
            { key: "path", label: "Data source", kind: "text" },
            { key: "exclusions", label: "Exclusions", kind: "code" },
          ],
          data: [
            ...(c.Targets?.S3Targets ?? []).map((t) => ({ type: "S3", path: t.Path ?? null, exclusions: (t.Exclusions ?? []).join(", ") || "-" })),
            ...(c.Targets?.DynamoDBTargets ?? []).map((t) => ({ type: "DynamoDB", path: t.Path ?? null, exclusions: "-" })),
            ...(c.Targets?.JdbcTargets ?? []).map((t) => ({ type: "JDBC", path: t.Path ?? null, exclusions: (t.Exclusions ?? []).join(", ") || "-" })),
          ],
          emptyText: "No data sources.",
        },
        {
          id: "schema-change",
          label: "Schema change policy",
          kind: "keyvalue",
          data: { "When the crawler detects schema changes": c.SchemaChangePolicy?.UpdateBehavior ?? "-", "When the crawler detects deleted objects": c.SchemaChangePolicy?.DeleteBehavior ?? "-", "Recrawl policy": c.RecrawlPolicy?.RecrawlBehavior ?? "-" },
        },
      ],
    };
  },

  create: {
    title: "Create crawler",
    description: "Creates a crawler with CreateCrawler. Run it to create tables.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Crawler properties", validate: { pattern: "[A-Za-z0-9_.-]{1,255}", message: "Letters, numbers, periods, hyphens and underscores." } },
      { name: "description", label: "Description", kind: "text", section: "Crawler properties" },
      { name: "path", label: "S3 path", kind: "text", required: true, section: "Data sources", placeholder: "s3://my-bucket/data/", help: "The crawler creates one table per folder of similar files.", validate: { pattern: S3_URI_PATTERN, message: "Enter an S3 URI." } },
      { name: "exclusions", label: "Exclude patterns", kind: "text", section: "Data sources", placeholder: "**.tmp, logs/**", help: "Glob patterns, comma-separated." },
      { name: "roleArn", label: "IAM role", kind: "select", required: true, options: glueRoleOptions, section: "Security settings", help: "A role Glue can assume (trust policy for glue.amazonaws.com) that can read the S3 path." },
      { name: "database", label: "Target database", kind: "select", required: true, options: databaseOptions, section: "Output and scheduling" },
      { name: "tablePrefix", label: "Table name prefix", kind: "text", section: "Output and scheduling", validate: { pattern: "[a-z0-9_]{1,128}", message: "Lowercase letters, numbers and underscores." } },
      { name: "frequency", label: "Crawler schedule", kind: "select", required: true, default: "on-demand", options: SCHEDULES, section: "Output and scheduling" },
      { name: "cron", label: "Cron expression", kind: "text", required: true, section: "Output and scheduling", placeholder: "cron(15 12 * * ? *)", showIf: { field: "frequency", equals: "custom" } },
      {
        name: "updateBehavior", label: "When the crawler detects schema changes", kind: "radio", default: "UPDATE_IN_DATABASE", section: "Advanced options",
        options: [{ value: "UPDATE_IN_DATABASE", label: "Update the table definition in the Data Catalog" }, { value: "LOG", label: "Ignore the change and don't update the table" }],
      },
      {
        name: "deleteBehavior", label: "When the crawler detects deleted objects", kind: "radio", default: "DEPRECATE_IN_DATABASE", section: "Advanced options",
        options: [
          { value: "DEPRECATE_IN_DATABASE", label: "Mark the table as deprecated" },
          { value: "LOG", label: "Ignore the change" },
          { value: "DELETE_FROM_DATABASE", label: "Delete tables and partitions from the Data Catalog" },
        ],
      },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const exclusions = (text(v.exclusions) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      await glue(ctx).send(
        new CreateCrawlerCommand({
          Name: name,
          Description: text(v.description),
          Role: String(v.roleArn),
          DatabaseName: String(v.database),
          TablePrefix: text(v.tablePrefix),
          Targets: { S3Targets: [{ Path: String(v.path), Exclusions: exclusions.length ? exclusions : undefined }] },
          Schedule: glueSchedule(text(v.frequency) ?? "on-demand", text(v.cron)),
          SchemaChangePolicy: { UpdateBehavior: String(v.updateBehavior) as UpdateBehavior, DeleteBehavior: String(v.deleteBehavior) as DeleteBehavior },
          Tags: tagRecord(v.tags),
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "run",
      label: "Run crawler",
      availableFor: (row) => (row.state ?? row.State ?? "READY") === "READY",
      async run(ctx, name) {
        await glue(ctx).send(new StartCrawlerCommand({ Name: name }));
        return { message: `Crawler ${name} started. Refresh to see its state and the Last run tab.` };
      },
    },
    {
      id: "schedule",
      label: "Edit schedule",
      fields: [
        { name: "frequency", label: "Crawler schedule", kind: "select", required: true, default: "on-demand", options: SCHEDULES },
        { name: "cron", label: "Cron expression", kind: "text", required: true, placeholder: "cron(15 12 * * ? *)", showIf: { field: "frequency", equals: "custom" } },
      ],
      async initialValues(ctx, name) {
        return crawlerScheduleValues(await crawler(ctx, name));
      },
      async run(ctx, name, v) {
        const schedule = glueSchedule(text(v.frequency) ?? "on-demand", text(v.cron));
        const before = crawlerScheduleValues(await crawler(ctx, name));
        if (glueSchedule(String(before.frequency), String(before.cron || "")) === schedule) return { message: "No changes to save." };
        if (!schedule) {
          // Glue keeps the expression but stops scheduling: the crawler then runs on demand only.
          await glue(ctx).send(new StopCrawlerScheduleCommand({ CrawlerName: name }));
          return { message: "Schedule paused: the crawler now runs on demand only." };
        }
        await glue(ctx).send(new UpdateCrawlerCommand({ Name: name, Schedule: schedule }));
        const now = (await glue(ctx).send(new GetCrawlerCommand({ Name: name }))).Crawler?.Schedule;
        if (now?.State === "NOT_SCHEDULED") await glue(ctx).send(new StartCrawlerScheduleCommand({ CrawlerName: name }));
        return { message: `Schedule set to ${schedule}.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await glue(ctx).send(new DeleteCrawlerCommand({ Name: name }));
    },
  },
};

// ---------- jobs ----------

function jobType(name: string | undefined): string | null {
  if (name === "glueetl") return "Spark";
  if (name === "pythonshell") return "Python shell";
  if (name === "gluestreaming") return "Spark Streaming";
  if (name === "glueray") return "Ray";
  return name ?? null;
}

function runRow(r: JobRun): Row {
  return {
    id: r.Id ?? null,
    state: r.JobRunState ?? null,
    started: r.StartedOn ?? null,
    completed: r.CompletedOn ?? null,
    executionTime: r.ExecutionTime ?? null,
    attempt: r.Attempt ?? 0,
    error: r.ErrorMessage ?? null,
  };
}

const runColumns = [
  { key: "id", label: "Run ID", kind: "code" as const },
  { key: "state", label: "Run status", kind: "status" as const },
  { key: "started", label: "Start time", kind: "date" as const },
  { key: "completed", label: "End time", kind: "date" as const },
  { key: "executionTime", label: "Duration (seconds)", kind: "count" as const },
  { key: "attempt", label: "Retries", kind: "count" as const },
  { key: "error", label: "Error message", kind: "text" as const },
];

const ACTIVE_RUN_STATES = new Set(["STARTING", "RUNNING", "WAITING"]);

/** Runs of the job (id) that can still be stopped, newest first, across every page. */
async function activeRunOptions(ctx: Ctx, jobName?: string): Promise<Option[]> {
  if (!jobName) return [];
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await glue(ctx).send(new GetJobRunsCommand({ JobName: jobName, NextToken: token }));
    for (const run of r.JobRuns ?? []) if (run.Id && ACTIVE_RUN_STATES.has(run.JobRunState ?? "")) out.push({ value: run.Id, label: `${run.Id} (${run.JobRunState})` });
    token = r.NextToken;
  } while (token);
  return out;
}

const WORKER_TYPES: Option[] = [
  { value: "G.025X", label: "G 0.25X (2 vCPU, 4 GB) - streaming" },
  { value: "G.1X", label: "G 1X (4 vCPU, 16 GB)" },
  { value: "G.2X", label: "G 2X (8 vCPU, 32 GB)" },
  { value: "G.4X", label: "G 4X (16 vCPU, 64 GB)" },
  { value: "G.8X", label: "G 8X (32 vCPU, 128 GB)" },
];

const jobs: ResourceDef = {
  id: "jobs",
  name: "ETL jobs",
  singular: "job",
  idField: "name",
  nameField: "Name",
  description: "Scripts that extract, transform and load data, run on serverless Spark or Python shell workers.",
  emptyText: "No jobs. Create a job from a script in S3.",
  columns: [
    { key: "name", label: "Job name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "lastRun", label: "Last run status", kind: "status" },
    { key: "glueVersion", label: "Glue version", kind: "text" },
    { key: "workerType", label: "Worker type", kind: "text" },
    { key: "workers", label: "Number of workers", kind: "count" },
    { key: "modified", label: "Last modified", kind: "date" },
    { key: "script", label: "Script location", kind: "text", hidden: true },
  ],

  async list(ctx) {
    const all: Job[] = [];
    let token: string | undefined;
    do {
      const r = await glue(ctx).send(new GetJobsCommand({ NextToken: token }));
      all.push(...(r.Jobs ?? []));
      token = r.NextToken;
    } while (token);
    const last = await Promise.all(
      all.map(async (j) => {
        if (!j.Name) return null;
        const name = j.Name;
        const r = await optionalRead(() => glue(ctx).send(new GetJobRunsCommand({ JobName: name, MaxResults: 1 })), []);
        return r.kind === "value" ? r.value.JobRuns?.[0]?.JobRunState ?? null : "Unavailable";
      })
    );
    return all.map((j, i) => ({
      name: j.Name ?? null,
      type: jobType(j.Command?.Name),
      lastRun: last[i],
      glueVersion: j.GlueVersion ?? null,
      workerType: j.WorkerType ?? null,
      workers: j.NumberOfWorkers ?? null,
      modified: j.LastModifiedOn ?? null,
      script: j.Command?.ScriptLocation ?? null,
    }));
  },

  async get(ctx, name) {
    const j = (await glue(ctx).send(new GetJobCommand({ JobName: name }))).Job;
    if (!j) throw new Error(`Job ${name} was not found.`);
    const runs = await optionalRead(() => glue(ctx).send(new GetJobRunsCommand({ JobName: name, MaxResults: 50 })), []);
    return {
      summary: {
        Name: j.Name ?? name,
        Type: jobType(j.Command?.Name),
        "IAM role": j.Role ?? null,
        "Glue version": j.GlueVersion ?? null,
        "Script location": j.Command?.ScriptLocation ?? null,
        "Last modified": j.LastModifiedOn ?? null,
      },
      tabs: [
        { id: "runs", label: "Runs", kind: "table", columns: runColumns, data: runs.kind === "value" ? (runs.value.JobRuns ?? []).map(runRow) : [], emptyText: runs.kind === "error" ? `Job runs are unavailable: ${runs.error}` : "No runs yet. Use Run job." },
        {
          id: "details",
          label: "Job details",
          kind: "keyvalue",
          data: {
            Description: j.Description ?? "-",
            "Python version": j.Command?.PythonVersion ?? "-",
            "Worker type": j.WorkerType ?? "-",
            "Requested number of workers": j.NumberOfWorkers ?? "-",
            "Maximum capacity (DPUs)": j.MaxCapacity ?? "-",
            "Job timeout (minutes)": j.Timeout ?? null,
            "Number of retries": j.MaxRetries ?? 0,
            "Maximum concurrency": j.ExecutionProperty?.MaxConcurrentRuns ?? null,
            "Created on": j.CreatedOn ?? null,
          },
        },
        { id: "arguments", label: "Job parameters", kind: "table", columns: [{ key: "Key", label: "Key", kind: "code" }, { key: "Value", label: "Value", kind: "code" }], data: recordToTags(j.DefaultArguments), emptyText: "No job parameters." },
      ],
    };
  },

  create: {
    title: "Create job",
    description: "Creates a script job with CreateJob. The script must already be in S3.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Basic properties", validate: { pattern: "[A-Za-z0-9_.-]{1,255}", message: "Letters, numbers, periods, hyphens and underscores." } },
      { name: "description", label: "Description", kind: "text", section: "Basic properties" },
      { name: "roleArn", label: "IAM role", kind: "select", required: true, options: glueRoleOptions, section: "Basic properties", help: "A role Glue can assume, with access to the script and the data." },
      {
        name: "type", label: "Type", kind: "radio", default: "glueetl", section: "Basic properties",
        options: [
          { value: "glueetl", label: "Spark" },
          { value: "gluestreaming", label: "Spark Streaming" },
          { value: "pythonshell", label: "Python shell" },
        ],
      },
      { name: "script", label: "Script path", kind: "text", required: true, section: "Basic properties", placeholder: "s3://my-bucket/scripts/job.py", validate: { pattern: S3_URI_PATTERN, message: "Enter an S3 URI." } },
      { name: "glueVersion", label: "Glue version", kind: "select", required: true, default: "5.0", section: "Basic properties", options: [{ value: "5.0", label: "Glue 5.0" }, { value: "4.0", label: "Glue 4.0" }, { value: "3.0", label: "Glue 3.0" }], help: "Python shell jobs use Glue 3.0 or 1.0 semantics." },
      { name: "workerType", label: "Worker type", kind: "select", required: true, default: "G.1X", options: WORKER_TYPES, section: "Capacity", help: "Spark jobs only." },
      { name: "workers", label: "Requested number of workers", kind: "number", default: 10, section: "Capacity", help: "Spark jobs only.", validate: { min: 2, max: 299, message: "Between 2 and 299." } },
      { name: "timeout", label: "Job timeout (minutes)", kind: "number", default: 480, section: "Capacity", validate: { min: 1, max: 10080, message: "Between 1 and 10080 minutes." } },
      { name: "retries", label: "Number of retries", kind: "number", default: 0, section: "Capacity", validate: { min: 0, max: 10, message: "Between 0 and 10." } },
      { name: "arguments", label: "Job parameters (JSON)", kind: "json", section: "Advanced", placeholder: '{"--TempDir":"s3://my-bucket/tmp/"}', help: "Default arguments as a JSON object of strings. Keys start with --." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const type = String(v.type ?? "glueetl");
      const spark = type !== "pythonshell";
      await glue(ctx).send(
        new CreateJobCommand({
          Name: name,
          Description: text(v.description),
          Role: String(v.roleArn),
          Command: { Name: type, ScriptLocation: String(v.script), PythonVersion: type === "pythonshell" ? "3.9" : "3" },
          GlueVersion: spark ? text(v.glueVersion) ?? "5.0" : "3.0",
          WorkerType: spark ? ((text(v.workerType) ?? "G.1X") as WorkerType) : undefined,
          NumberOfWorkers: spark ? numberOr(v.workers, 10) : undefined,
          MaxCapacity: spark ? undefined : 0.0625,
          Timeout: numberOr(v.timeout),
          MaxRetries: numberOr(v.retries),
          DefaultArguments: stringMap(v.arguments, "Job parameters"),
          Tags: tagRecord(v.tags),
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "run",
      label: "Run job",
      fields: [{ name: "arguments", label: "Run parameters (JSON)", kind: "json", placeholder: '{"--day":"2026-11-23"}', help: "Overrides the job's default parameters for this run." }],
      async run(ctx, name, v) {
        const r = await glue(ctx).send(new StartJobRunCommand({ JobName: name, Arguments: stringMap(v.arguments, "Run parameters") }));
        return { message: `Job run started. Run ID: ${r.JobRunId ?? "-"}. Refresh the Runs tab to follow it.` };
      },
    },
    {
      id: "stop",
      label: "Stop job run",
      danger: true,
      // The list row knows the latest run's state; elsewhere (detail page) the picker lists what can be stopped.
      availableFor: (row) => !("lastRun" in row) || ACTIVE_RUN_STATES.has(String(row.lastRun)),
      fields: [{ name: "runId", label: "Job run", kind: "select", required: true, options: activeRunOptions, help: "Runs that are starting, running or waiting." }],
      async run(ctx, name, v) {
        const r = await glue(ctx).send(new BatchStopJobRunCommand({ JobName: name, JobRunIds: [String(v.runId)] }));
        const err = r.Errors?.[0];
        if (err) throw new Error(`${err.ErrorDetail?.ErrorCode ?? "Error"}: ${err.ErrorDetail?.ErrorMessage ?? ""}`);
        return { message: `Stop requested for ${String(v.runId)}.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await glue(ctx).send(new DeleteJobCommand({ JobName: name }));
    },
  },
};

export const glueService: ServiceDef = {
  id: "glue",
  name: "AWS Glue",
  category: "Analytics",
  description: "Serverless data integration: the Data Catalog, crawlers that infer schemas, and ETL jobs.",
  resources: [databases, tables, crawlers, jobs],
  notSupported: ["Stopping a running crawler (StopCrawler)"],
};
