/**
 * Amazon Athena: the query editor (hand-built, src/services/athena/QueryEditor.tsx), saved
 * queries, workgroups and data sources. Every value comes from an Athena (or Glue, for the
 * database list) API response.
 */

import {
  BatchGetNamedQueryCommand,
  BatchGetQueryExecutionCommand,
  CreateDataCatalogCommand,
  CreateNamedQueryCommand,
  CreateWorkGroupCommand,
  DeleteDataCatalogCommand,
  DeleteNamedQueryCommand,
  DeleteWorkGroupCommand,
  GetDataCatalogCommand,
  GetNamedQueryCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  GetWorkGroupCommand,
  ListDataCatalogsCommand,
  ListNamedQueriesCommand,
  ListQueryExecutionsCommand,
  ListTagsForResourceCommand,
  ListWorkGroupsCommand,
  StartQueryExecutionCommand,
  UpdateWorkGroupCommand,
  type DataCatalogType,
  type EncryptionOption,
  type NamedQuery,
  type QueryExecution,
  type WorkGroup,
  type WorkGroupConfigurationUpdates,
  type WorkGroupSummary,
} from "@aws-sdk/client-athena";
import { GetDatabasesCommand } from "@aws-sdk/client-glue";
import type { Ctx, FieldValues, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { optionalRead } from "../../console/secondary.ts";
import { fieldTags } from "../../console/tags.ts";
import { numberOr, parseS3Uri, S3_URI_PATTERN, text } from "../../console/values.ts";
import { formatRunTime, shapeResults } from "./helpers.ts";

const MB = 1024 * 1024;

export async function allWorkGroups(ctx: Ctx): Promise<WorkGroupSummary[]> {
  const out: WorkGroupSummary[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.athena.send(new ListWorkGroupsCommand({ NextToken: token }));
    out.push(...(r.WorkGroups ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function workGroupOptions(ctx: Ctx): Promise<Option[]> {
  return (await allWorkGroups(ctx)).flatMap((w) => (w.Name ? [{ value: w.Name, label: w.State === "DISABLED" ? `${w.Name} (disabled)` : w.Name }] : []));
}

async function databaseOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.glue.send(new GetDatabasesCommand({ NextToken: token }));
    for (const d of r.DatabaseList ?? []) if (d.Name) out.push({ value: d.Name, label: d.Name });
    token = r.NextToken;
  } while (token);
  return out;
}

export function executionRow(q: QueryExecution): Row {
  return {
    id: q.QueryExecutionId ?? null,
    query: q.Query ?? null,
    state: q.Status?.State ?? null,
    workgroup: q.WorkGroup ?? null,
    database: q.QueryExecutionContext?.Database ?? null,
    submitted: q.Status?.SubmissionDateTime ?? null,
    runTime: formatRunTime(q.Statistics?.TotalExecutionTimeInMillis),
    scanned: q.Statistics?.DataScannedInBytes ?? null,
    reason: q.Status?.StateChangeReason ?? null,
  };
}

/** Recent query executions across every workgroup, newest first (up to 50 per workgroup). */
export async function recentExecutions(ctx: Ctx, workgroup?: string): Promise<QueryExecution[]> {
  const groups = workgroup ? [workgroup] : (await allWorkGroups(ctx)).flatMap((w) => (w.Name ? [w.Name] : []));
  const ids = (await Promise.all(groups.map((g) => ctx.clients.athena.send(new ListQueryExecutionsCommand({ WorkGroup: g, MaxResults: 50 }))))).flatMap((r) => r.QueryExecutionIds ?? []);
  const out: QueryExecution[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await ctx.clients.athena.send(new BatchGetQueryExecutionCommand({ QueryExecutionIds: ids.slice(i, i + 50) }));
    out.push(...(r.QueryExecutions ?? []));
  }
  return out.sort((a, b) => (b.Status?.SubmissionDateTime?.getTime() ?? 0) - (a.Status?.SubmissionDateTime?.getTime() ?? 0));
}

/** Saved (named) queries across every workgroup. */
export async function savedQueries(ctx: Ctx, workgroup?: string): Promise<NamedQuery[]> {
  const groups = workgroup ? [workgroup] : (await allWorkGroups(ctx)).flatMap((w) => (w.Name ? [w.Name] : []));
  const ids: string[] = [];
  for (const g of groups) {
    let token: string | undefined;
    do {
      const r = await ctx.clients.athena.send(new ListNamedQueriesCommand({ WorkGroup: g, NextToken: token }));
      ids.push(...(r.NamedQueryIds ?? []));
      token = r.NextToken;
    } while (token);
  }
  const out: NamedQuery[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await ctx.clients.athena.send(new BatchGetNamedQueryCommand({ NamedQueryIds: ids.slice(i, i + 50) }));
    out.push(...(r.NamedQueries ?? []));
  }
  return out;
}

const queryEditor: ResourceDef = {
  id: "query-editor",
  name: "Query editor",
  singular: "query",
  idField: "id",
  nameField: "Query execution ID",
  description: "Run SQL against tables in the Glue Data Catalog. Results are written to the workgroup's S3 results location.",
  emptyText: "No queries have run yet.",
  columns: [
    { key: "id", label: "Execution ID", kind: "link" },
    { key: "query", label: "Query", kind: "code" },
    { key: "state", label: "Status", kind: "status" },
    { key: "workgroup", label: "Workgroup", kind: "text" },
    { key: "submitted", label: "Time submitted", kind: "date" },
    { key: "runTime", label: "Run time", kind: "text" },
    { key: "scanned", label: "Data scanned", kind: "bytes" },
  ],

  async list(ctx) {
    return (await recentExecutions(ctx)).map(executionRow);
  },

  async get(ctx, id) {
    const r = await ctx.clients.athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const q = r.QueryExecution;
    if (!q) throw new Error(`Query execution ${id} was not found.`);
    const results = q.Status?.State === "SUCCEEDED" ? shapeResults((await ctx.clients.athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 100 }))).ResultSet, true) : null;
    return {
      summary: {
        "Query execution ID": q.QueryExecutionId ?? id,
        Status: q.Status?.State ?? null,
        Workgroup: q.WorkGroup ?? null,
        Database: q.QueryExecutionContext?.Database ?? "-",
        "Statement type": q.StatementType ?? null,
        "Time submitted": q.Status?.SubmissionDateTime ?? null,
        "Run time": formatRunTime(q.Statistics?.TotalExecutionTimeInMillis),
        "Data scanned (bytes)": q.Statistics?.DataScannedInBytes ?? null,
        "Result location": q.ResultConfiguration?.OutputLocation ?? null,
        "Engine version": q.EngineVersion?.EffectiveEngineVersion ?? null,
      },
      tabs: [
        { id: "query", label: "Query", kind: "text", data: q.Query ?? "" },
        {
          id: "results",
          label: "Results (first 100 rows)",
          kind: "table",
          columns: (results?.columns ?? []).map((c, i) => ({ key: `c${i}`, label: c.name, kind: "text" as const })),
          data: (results?.rows ?? []).map((row) => Object.fromEntries(row.map((v, i) => [`c${i}`, v]))),
          emptyText: q.Status?.State === "SUCCEEDED" ? "The query returned no rows." : `No results: the query is ${q.Status?.State ?? "unknown"}. ${q.Status?.StateChangeReason ?? ""}`,
        },
      ],
    };
  },
};

const savedQueriesResource: ResourceDef = {
  id: "saved-queries",
  name: "Saved queries",
  singular: "saved query",
  idField: "id",
  nameField: "Name",
  description: "Named queries you can load into the query editor and share within a workgroup.",
  emptyText: "No saved queries.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "database", label: "Database", kind: "text" },
    { key: "workgroup", label: "Workgroup", kind: "text" },
    { key: "query", label: "Query", kind: "code", hidden: true },
    { key: "id", label: "ID", kind: "text", hidden: true },
  ],

  async list(ctx) {
    return (await savedQueries(ctx)).map((q) => ({ id: q.NamedQueryId ?? null, name: q.Name ?? null, description: q.Description ?? null, database: q.Database ?? null, workgroup: q.WorkGroup ?? null, query: q.QueryString ?? null }));
  },

  async get(ctx, id) {
    const r = await ctx.clients.athena.send(new GetNamedQueryCommand({ NamedQueryId: id }));
    const q = r.NamedQuery;
    if (!q) throw new Error(`Saved query ${id} was not found.`);
    return {
      summary: { Name: q.Name ?? null, Description: q.Description ?? "-", Database: q.Database ?? null, Workgroup: q.WorkGroup ?? null, ID: q.NamedQueryId ?? id },
      tabs: [{ id: "query", label: "Query", kind: "text", data: q.QueryString ?? "" }],
    };
  },

  create: {
    title: "Save query",
    description: "Saves a named query with CreateNamedQuery.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Query", validate: { pattern: "[A-Za-z0-9._ -]{1,128}", message: "Up to 128 letters, numbers, spaces, periods, hyphens or underscores." } },
      { name: "description", label: "Description", kind: "text", section: "Query", validate: { max: 1024, message: "At most 1024 characters." } },
      { name: "workgroup", label: "Workgroup", kind: "select", required: true, default: "primary", options: workGroupOptions, section: "Query" },
      { name: "database", label: "Database", kind: "select", required: true, options: databaseOptions, section: "Query" },
      { name: "query", label: "Query", kind: "textarea", required: true, section: "Query", placeholder: "SELECT * FROM my_table LIMIT 10", validate: { max: 262144, message: "At most 256 KiB." } },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.athena.send(
        new CreateNamedQueryCommand({ Name: String(v.name), Description: text(v.description), WorkGroup: String(v.workgroup), Database: String(v.database), QueryString: String(v.query) })
      );
      if (!r.NamedQueryId) throw new Error("Athena returned no saved query ID.");
      return r.NamedQueryId;
    },
  },

  actions: [
    {
      id: "run",
      label: "Run query",
      async run(ctx, id) {
        const q = (await ctx.clients.athena.send(new GetNamedQueryCommand({ NamedQueryId: id }))).NamedQuery;
        if (!q?.QueryString) throw new Error("The saved query has no query text.");
        const r = await ctx.clients.athena.send(new StartQueryExecutionCommand({ QueryString: q.QueryString, WorkGroup: q.WorkGroup, QueryExecutionContext: q.Database ? { Database: q.Database } : undefined }));
        return { message: `Query started. Execution ID: ${r.QueryExecutionId ?? "-"}. See it in Query editor → Recent queries.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.athena.send(new DeleteNamedQueryCommand({ NamedQueryId: id }));
    },
  },
};

const ENCRYPTION: Option[] = [
  { value: "NONE", label: "No encryption" },
  { value: "SSE_S3", label: "SSE-S3 (Amazon S3 managed keys)" },
  { value: "SSE_KMS", label: "SSE-KMS (AWS KMS key)" },
  { value: "CSE_KMS", label: "CSE-KMS (client-side, AWS KMS key)" },
];

async function workGroup(ctx: Ctx, name: string): Promise<WorkGroup> {
  const w = (await ctx.clients.athena.send(new GetWorkGroupCommand({ WorkGroup: name }))).WorkGroup;
  if (!w) throw new Error(`Workgroup ${name} was not found.`);
  return w;
}

/** AWS Emulator can't describe or update the primary workgroup (see notSupported). */
function editableWorkGroup(row: Row): boolean {
  return (row.name ?? row.Name) !== "primary";
}

/** The Edit settings form's values for a workgroup as GetWorkGroup returns it. */
function workGroupFormValues(w: WorkGroup): FieldValues {
  const c = w.Configuration;
  const cutoff = c?.BytesScannedCutoffPerQuery;
  return {
    description: w.Description ?? "",
    outputLocation: c?.ResultConfiguration?.OutputLocation ?? "",
    enforce: c?.EnforceWorkGroupConfiguration ?? false,
    metrics: c?.PublishCloudWatchMetricsEnabled ?? false,
    requesterPays: c?.RequesterPaysEnabled ?? false,
    limitMb: cutoff !== undefined ? cutoff / MB : null,
  };
}

/**
 * Only what the user changed: UpdateWorkGroup applies every field it is sent, so untouched
 * settings (enforce, metrics, the data limit...) are left out instead of being re-sent.
 */
function workGroupChanges(before: FieldValues, v: FieldValues): { description?: string; updates: WorkGroupConfigurationUpdates } {
  const updates: WorkGroupConfigurationUpdates = {};
  const desc = text(v.description) ?? "";
  const out = text(v.outputLocation) ?? "";
  if (out !== before.outputLocation) updates.ResultConfigurationUpdates = out ? { OutputLocation: out } : { RemoveOutputLocation: true };
  if ((v.enforce === true) !== before.enforce) updates.EnforceWorkGroupConfiguration = v.enforce === true;
  if ((v.metrics === true) !== before.metrics) updates.PublishCloudWatchMetricsEnabled = v.metrics === true;
  if ((v.requesterPays === true) !== before.requesterPays) updates.RequesterPaysEnabled = v.requesterPays === true;
  const limit = numberOr(v.limitMb);
  const beforeLimit = typeof before.limitMb === "number" ? before.limitMb : undefined;
  if (limit !== beforeLimit) {
    if (limit === undefined) updates.RemoveBytesScannedCutoffPerQuery = true;
    else updates.BytesScannedCutoffPerQuery = Math.round(limit * MB);
  }
  return { description: desc !== before.description ? desc : undefined, updates };
}

const workgroups: ResourceDef = {
  id: "workgroups",
  name: "Workgroups",
  singular: "workgroup",
  idField: "name",
  nameField: "Name",
  description: "Separate users, teams and applications; set query result locations, encryption and per-query data limits.",
  emptyText: "No workgroups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "state", label: "State", kind: "status" },
    { key: "engine", label: "Analytics engine", kind: "text" },
    { key: "created", label: "Creation time", kind: "date" },
  ],

  async list(ctx) {
    return (await allWorkGroups(ctx)).map((w) => ({ name: w.Name ?? null, description: w.Description ?? null, state: w.State ?? null, engine: w.EngineVersion?.EffectiveEngineVersion ?? null, created: w.CreationTime ?? null }));
  },

  async get(ctx, name) {
    const got = await optionalRead(() => ctx.clients.athena.send(new GetWorkGroupCommand({ WorkGroup: name })), ["InvalidRequestException"]);
    if (got.kind === "error") throw new Error(got.error);
    if (got.kind === "missing") {
      // The emulator lists "primary" but can't describe or update it; show what the list says.
      const listed = (await allWorkGroups(ctx)).find((w) => w.Name === name);
      if (!listed) throw new Error(`Workgroup ${name} was not found.`);
      return {
        summary: { Name: listed.Name ?? name, Description: listed.Description ?? "-", State: listed.State ?? null, "Analytics engine": listed.EngineVersion?.EffectiveEngineVersion ?? null, "Creation time": listed.CreationTime ?? null },
        tabs: [{ id: "settings", label: "Settings", kind: "keyvalue", data: {}, emptyText: "AWS Emulator lists this workgroup but doesn't return its settings (GetWorkGroup answers \"not found\"). Enter a query result location in the query editor to run queries in it." }],
      };
    }
    const w = got.value.WorkGroup;
    if (!w) throw new Error(`Workgroup ${name} was not found.`);
    const c = w.Configuration;
    const arn = `arn:aws:athena:${ctx.region}:${ctx.accountId}:workgroup/${name}`;
    const tags = await optionalRead(() => ctx.clients.athena.send(new ListTagsForResourceCommand({ ResourceARN: arn })), []);
    const cutoff = c?.BytesScannedCutoffPerQuery;
    return {
      summary: {
        Name: w.Name ?? name,
        Description: w.Description ?? "-",
        State: w.State ?? null,
        "Analytics engine": c?.EngineVersion?.EffectiveEngineVersion ?? null,
        "Creation time": w.CreationTime ?? null,
      },
      tabs: [
        {
          id: "settings",
          label: "Settings",
          kind: "keyvalue",
          data: {
            "Query result location": c?.ResultConfiguration?.OutputLocation ?? "Not set",
            "Encryption of query results": c?.ResultConfiguration?.EncryptionConfiguration?.EncryptionOption ?? "None",
            "KMS key": c?.ResultConfiguration?.EncryptionConfiguration?.KmsKey ?? "-",
            "Expected bucket owner": c?.ResultConfiguration?.ExpectedBucketOwner ?? "-",
            "Override client-side settings": c?.EnforceWorkGroupConfiguration ?? false,
            "Publish query metrics to CloudWatch": c?.PublishCloudWatchMetricsEnabled ?? false,
            "Requester pays S3 buckets": c?.RequesterPaysEnabled ?? false,
            "Data limit per query": cutoff !== undefined ? `${(cutoff / MB).toFixed(0)} MB (${cutoff} bytes)` : "No limit",
          },
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }],
          data: tags.kind === "value" ? tags.value.Tags ?? [] : [],
          emptyText: tags.kind === "error" ? `Tags are unavailable: ${tags.error}` : "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create workgroup",
    description: "Creates a workgroup with CreateWorkGroup.",
    fields: [
      { name: "name", label: "Workgroup name", kind: "text", required: true, section: "Workgroup details", validate: { pattern: "[A-Za-z0-9._-]{1,128}", message: "Up to 128 letters, numbers, periods, hyphens or underscores." } },
      { name: "description", label: "Description", kind: "text", section: "Workgroup details", validate: { max: 1024, message: "At most 1024 characters." } },
      { name: "outputLocation", label: "Location of query result", kind: "text", section: "Query result configuration", placeholder: "s3://my-bucket/athena-results/", help: "The S3 location where Athena writes query results.", validate: { pattern: S3_URI_PATTERN, message: "Enter an S3 URI such as s3://bucket/prefix/." } },
      { name: "encryption", label: "Encrypt query results", kind: "select", required: true, default: "NONE", options: ENCRYPTION, section: "Query result configuration" },
      { name: "kmsKey", label: "KMS key ARN or ID", kind: "text", section: "Query result configuration", help: "Required for SSE-KMS and CSE-KMS." },
      { name: "enforce", label: "Override client-side settings", kind: "checkbox", default: true, section: "Settings", help: "Queries use the workgroup's settings even if the client sets its own." },
      { name: "metrics", label: "Publish query metrics to AWS CloudWatch", kind: "checkbox", default: true, section: "Settings" },
      { name: "requesterPays", label: "Turn on queries on requester pays buckets in Amazon S3", kind: "checkbox", default: false, section: "Settings" },
      { name: "limitMb", label: "Data limit per query (MB)", kind: "number", section: "Per query data usage control", help: "Queries that scan more data are cancelled. Minimum 10 MB. Leave empty for no limit.", validate: { min: 10, max: 7_000_000_000, message: "At least 10 MB." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const out = text(v.outputLocation);
      if (out && !parseS3Uri(out)) throw new Error("Location of query result must be an S3 URI.");
      const enc = text(v.encryption) ?? "NONE";
      if ((enc === "SSE_KMS" || enc === "CSE_KMS") && !text(v.kmsKey)) throw new Error("Enter a KMS key for KMS encryption.");
      const limit = numberOr(v.limitMb);
      await ctx.clients.athena.send(
        new CreateWorkGroupCommand({
          Name: name,
          Description: text(v.description),
          Configuration: {
            ResultConfiguration: out || enc !== "NONE" ? { OutputLocation: out, EncryptionConfiguration: enc !== "NONE" ? { EncryptionOption: enc as EncryptionOption, KmsKey: text(v.kmsKey) } : undefined } : undefined,
            EnforceWorkGroupConfiguration: v.enforce === true,
            PublishCloudWatchMetricsEnabled: v.metrics === true,
            RequesterPaysEnabled: v.requesterPays === true,
            BytesScannedCutoffPerQuery: limit !== undefined ? Math.round(limit * MB) : undefined,
          },
          Tags: fieldTags(v.tags),
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit settings",
      availableFor: editableWorkGroup,
      fields: [
        { name: "description", label: "Description", kind: "text", validate: { max: 1024, message: "At most 1024 characters." } },
        { name: "outputLocation", label: "Location of query result", kind: "text", placeholder: "s3://my-bucket/athena-results/", help: "Clear it to remove the location.", validate: { pattern: S3_URI_PATTERN, message: "Enter an S3 URI such as s3://bucket/prefix/." } },
        { name: "enforce", label: "Override client-side settings", kind: "checkbox" },
        { name: "metrics", label: "Publish query metrics to AWS CloudWatch", kind: "checkbox" },
        { name: "requesterPays", label: "Turn on queries on requester pays buckets in Amazon S3", kind: "checkbox" },
        { name: "limitMb", label: "Data limit per query (MB)", kind: "number", help: "Leave empty for no limit.", validate: { min: 10, max: 7_000_000_000, message: "At least 10 MB." } },
      ],
      async initialValues(ctx, name) {
        return workGroupFormValues(await workGroup(ctx, name));
      },
      async run(ctx, name, v) {
        const current = await workGroup(ctx, name);
        const out = text(v.outputLocation);
        if (out && !parseS3Uri(out)) throw new Error("Location of query result must be an S3 URI.");
        const { description, updates } = workGroupChanges(workGroupFormValues(current), v);
        if (description === undefined && Object.keys(updates).length === 0) return { message: "No changes to save." };
        await ctx.clients.athena.send(new UpdateWorkGroupCommand({ WorkGroup: name, Description: description, ConfigurationUpdates: Object.keys(updates).length ? updates : undefined }));
        return { message: `Workgroup ${name} updated.` };
      },
    },
    {
      id: "state",
      label: "Enable or disable",
      availableFor: editableWorkGroup,
      async initialValues(ctx, name) {
        return { state: (await workGroup(ctx, name)).State === "DISABLED" ? "DISABLED" : "ENABLED" };
      },
      fields: [{ name: "state", label: "State", kind: "radio", default: "ENABLED", options: [{ value: "ENABLED", label: "Enabled" }, { value: "DISABLED", label: "Disabled: no queries can run in it" }] }],
      async run(ctx, name, v) {
        const state = v.state === "ENABLED" ? "ENABLED" : "DISABLED";
        if ((await workGroup(ctx, name)).State === state) return { message: `Workgroup ${name} is already ${state}.` };
        await ctx.clients.athena.send(new UpdateWorkGroupCommand({ WorkGroup: name, State: state }));
        return { message: `Workgroup ${name} is now ${state}.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      if (name === "primary") throw new Error("The primary workgroup can't be deleted.");
      await ctx.clients.athena.send(new DeleteWorkGroupCommand({ WorkGroup: name, RecursiveDeleteOption: true }));
    },
  },
};

const dataSources: ResourceDef = {
  id: "data-sources",
  name: "Data sources",
  singular: "data source",
  idField: "name",
  nameField: "Data source name",
  description: "Catalogs Athena queries: the account's AWS Glue Data Catalog, another account's Glue catalog, or a Lambda-based connector.",
  emptyText: "No data sources.",
  columns: [
    { key: "name", label: "Data source name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
  ],

  async list(ctx) {
    const out: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.athena.send(new ListDataCatalogsCommand({ NextToken: token }));
      for (const c of r.DataCatalogsSummary ?? []) out.push({ name: c.CatalogName ?? null, type: c.Type ?? null, status: c.Status ?? null });
      token = r.NextToken;
    } while (token);
    return out;
  },

  async get(ctx, name) {
    const c = (await ctx.clients.athena.send(new GetDataCatalogCommand({ Name: name }))).DataCatalog;
    if (!c) throw new Error(`Data source ${name} was not found.`);
    return {
      summary: { "Data source name": c.Name ?? name, Type: c.Type ?? null, Status: c.Status ?? null, Description: c.Description ?? "-" },
      tabs: [{ id: "parameters", label: "Parameters", kind: "table", columns: [{ key: "key", label: "Parameter", kind: "text" }, { key: "value", label: "Value", kind: "code" }], data: Object.entries(c.Parameters ?? {}).map(([key, value]) => ({ key, value })), emptyText: "No parameters." }],
    };
  },

  create: {
    title: "Create data source",
    description: "Registers a catalog with CreateDataCatalog.",
    fields: [
      { name: "name", label: "Data source name", kind: "text", required: true, section: "Data source details", validate: { pattern: "[A-Za-z0-9_@-]{1,127}", message: "Up to 127 letters, numbers, @, hyphens or underscores." } },
      {
        name: "type", label: "Data source type", kind: "radio", default: "GLUE", section: "Data source details",
        options: [
          { value: "GLUE", label: "AWS Glue Data Catalog in another account" },
          { value: "LAMBDA", label: "Lambda-based connector (federated query)" },
          { value: "HIVE", label: "Apache Hive metastore (through a Lambda function)" },
        ],
      },
      { name: "catalogId", label: "Catalog ID (AWS account ID)", kind: "text", required: true, section: "Connection details", showIf: { field: "type", equals: "GLUE" }, validate: { pattern: "\\d{12}", message: "A 12-digit account ID." } },
      { name: "functionArn", label: "Lambda function ARN", kind: "text", required: true, section: "Connection details", showIf: { field: "type", equals: "LAMBDA" }, validate: { pattern: "arn:aws:lambda:.+", message: "A Lambda function ARN." } },
      { name: "metadataFunction", label: "Metadata Lambda function ARN", kind: "text", required: true, section: "Connection details", showIf: { field: "type", equals: "HIVE" }, validate: { pattern: "arn:aws:lambda:.+", message: "A Lambda function ARN." } },
      { name: "description", label: "Description", kind: "text", section: "Data source details" },
    ],
    async run(ctx, v) {
      const type = String(v.type) as DataCatalogType;
      const params: Record<string, string> =
        type === "GLUE" ? { "catalog-id": String(v.catalogId) } : type === "LAMBDA" ? { function: String(v.functionArn) } : { "metadata-function": String(v.metadataFunction) };
      const name = String(v.name);
      await ctx.clients.athena.send(new CreateDataCatalogCommand({ Name: name, Type: type, Parameters: params, Description: text(v.description) }));
      return name;
    },
  },

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      if (name === "AwsDataCatalog") throw new Error("AwsDataCatalog is the account's own Glue Data Catalog and can't be deleted.");
      await ctx.clients.athena.send(new DeleteDataCatalogCommand({ Name: name }));
    },
  },
};

export const athenaService: ServiceDef = {
  id: "athena",
  name: "Amazon Athena",
  category: "Analytics",
  description: "Serverless interactive SQL queries over data in Amazon S3, using the AWS Glue Data Catalog.",
  resources: [queryEditor, savedQueriesResource, workgroups, dataSources],
  notSupported: [
    "Listing databases through Athena (ListDatabases / GetDatabase): the editor reads them from the Glue Data Catalog instead",
    "Settings of the primary workgroup (GetWorkGroup / UpdateWorkGroup answer \"not found\")",
  ],
};
