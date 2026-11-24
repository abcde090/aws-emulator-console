"use server";

/**
 * Server actions for the hand-built Athena query editor. Every call uses the
 * permission-checked clients (via the engine's ctx), so the IAM simulator sees each
 * StartQueryExecution, GetQueryResults, ListTableMetadata and so on.
 */

import { CreateNamedQueryCommand, GetQueryExecutionCommand, GetWorkGroupCommand, GetQueryResultsCommand, ListDataCatalogsCommand, ListTableMetadataCommand, StartQueryExecutionCommand, StopQueryExecutionCommand } from "@aws-sdk/client-athena";
import { GetDatabasesCommand } from "@aws-sdk/client-glue";
import { makeCtx } from "../../console/server.ts";
import { optionalRead } from "../../console/secondary.ts";
import { parseS3Uri } from "../../console/values.ts";
import { errorMessage, toPlain } from "../../console/serialize.ts";
import type { Result, Row } from "../../console/types.ts";
import { allWorkGroups, executionRow, recentExecutions, savedQueries } from "./def.ts";
import { checkName, checkSql, IDENT_PATTERN, optionalName, shapeResults, TERMINAL_STATES, UUID_PATTERN, type ShapedResults } from "./helpers.ts";

export interface EditorContext {
  workgroups: { name: string; state: string; outputLocation: string | null }[];
  catalogs: string[];
  databases: string[];
  /** Secondary lookups that failed (e.g. denied for the acting identity); the editor still works without them. */
  warnings: string[];
}

export interface TableInfo {
  name: string;
  type: string | null;
  columns: { name: string; type: string | null }[];
  partitionKeys: { name: string; type: string | null }[];
}

export interface QueryStatus {
  id: string;
  state: string;
  done: boolean;
  reason: string | null;
  runTimeMs: number | null;
  scannedBytes: number | null;
  outputLocation: string | null;
  statementType: string | null;
}

export interface ResultPage extends ShapedResults {
  nextToken: string | null;
}

export interface SavedQuery {
  id: string;
  name: string;
  description: string | null;
  database: string | null;
  workgroup: string | null;
  query: string;
}

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: toPlain(await fn()) as T };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

const checkId = (v: unknown, what: string): string => checkName(v, what, UUID_PATTERN);

export async function loadEditorContext(): Promise<Result<EditorContext>> {
  return attempt(async () => {
    const ctx = await makeCtx();
    const warnings: string[] = [];
    const [wgs, catalogs, dbs] = await Promise.all([allWorkGroups(ctx), optionalRead(() => allCatalogs(ctx), []), optionalRead(() => allDatabaseNames(ctx), [])]);
    if (catalogs.kind === "error") warnings.push(`Data sources are unavailable: ${catalogs.error}`);
    if (dbs.kind === "error") warnings.push(`Databases are unavailable: ${dbs.error}`);
    const detail = await Promise.all(
      wgs.flatMap((w) => (w.Name ? [w.Name] : [])).map(async (name) => {
        const listed = wgs.find((w) => w.Name === name);
        // The emulator lists "primary" but answers GetWorkGroup for it with "not found"; fall back to the list entry.
        const got = await optionalRead(() => ctx.clients.athena.send(new GetWorkGroupCommand({ WorkGroup: name })), ["InvalidRequestException"]);
        if (got.kind === "error") warnings.push(`Settings of workgroup ${name} are unavailable: ${got.error}`);
        const g = got.kind === "value" ? got.value.WorkGroup : undefined;
        return { name, state: g?.State ?? listed?.State ?? "UNKNOWN", outputLocation: g?.Configuration?.ResultConfiguration?.OutputLocation ?? null };
      })
    );
    return {
      workgroups: detail,
      catalogs: catalogs.kind === "value" ? catalogs.value : [],
      databases: dbs.kind === "value" ? dbs.value : [],
      warnings,
    };
  });
}

async function allCatalogs(ctx: Awaited<ReturnType<typeof makeCtx>>): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.athena.send(new ListDataCatalogsCommand({ NextToken: token }));
    out.push(...(r.DataCatalogsSummary ?? []).flatMap((c) => (c.CatalogName ? [c.CatalogName] : [])));
    token = r.NextToken;
  } while (token);
  return out;
}

async function allDatabaseNames(ctx: Awaited<ReturnType<typeof makeCtx>>): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.glue.send(new GetDatabasesCommand({ NextToken: token }));
    out.push(...(r.DatabaseList ?? []).flatMap((d) => (d.Name ? [d.Name] : [])));
    token = r.NextToken;
  } while (token);
  return out;
}

export async function listTables(catalog: string, database: string): Promise<Result<TableInfo[]>> {
  return attempt(async () => {
    const c = checkName(catalog, "Data source", IDENT_PATTERN);
    const d = checkName(database, "Database", IDENT_PATTERN);
    const ctx = await makeCtx();
    const out: TableInfo[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.athena.send(new ListTableMetadataCommand({ CatalogName: c, DatabaseName: d, NextToken: token }));
      for (const t of r.TableMetadataList ?? []) {
        out.push({
          name: t.Name ?? "",
          type: t.TableType ?? null,
          columns: (t.Columns ?? []).map((col) => ({ name: col.Name ?? "", type: col.Type ?? null })),
          partitionKeys: (t.PartitionKeys ?? []).map((col) => ({ name: col.Name ?? "", type: col.Type ?? null })),
        });
      }
      token = r.NextToken;
    } while (token);
    return out;
  });
}

export async function runQuery(input: { sql: string; workgroup: string; catalog?: string; database?: string; outputLocation?: string }): Promise<Result<{ id: string }>> {
  return attempt(async () => {
    const sql = checkSql(input?.sql);
    const out = typeof input?.outputLocation === "string" && input.outputLocation.trim() !== "" ? input.outputLocation.trim() : undefined;
    if (out !== undefined && (!parseS3Uri(out) || out.length > 1024)) throw new Error("Query result location must be an S3 URI such as s3://bucket/prefix/.");
    const wg = checkName(input?.workgroup, "Workgroup");
    const catalog = optionalName(input?.catalog, "Data source");
    const database = optionalName(input?.database, "Database");
    const ctx = await makeCtx();
    const r = await ctx.clients.athena.send(
      new StartQueryExecutionCommand({
        QueryString: sql,
        WorkGroup: wg,
        QueryExecutionContext: catalog || database ? { Catalog: catalog, Database: database } : undefined,
        ResultConfiguration: out ? { OutputLocation: out } : undefined,
      })
    );
    if (!r.QueryExecutionId) throw new Error("Athena returned no query execution ID.");
    return { id: r.QueryExecutionId };
  });
}

export async function queryStatus(id: string): Promise<Result<QueryStatus>> {
  return attempt(async () => {
    const qid = checkId(id, "Query execution ID");
    const ctx = await makeCtx();
    const q = (await ctx.clients.athena.send(new GetQueryExecutionCommand({ QueryExecutionId: qid }))).QueryExecution;
    const state = q?.Status?.State ?? "UNKNOWN";
    return {
      id: qid,
      state,
      done: TERMINAL_STATES.has(state),
      reason: q?.Status?.StateChangeReason ?? null,
      runTimeMs: q?.Statistics?.TotalExecutionTimeInMillis ?? null,
      scannedBytes: q?.Statistics?.DataScannedInBytes ?? null,
      outputLocation: q?.ResultConfiguration?.OutputLocation ?? null,
      statementType: q?.StatementType ?? null,
    };
  });
}

export async function queryResults(id: string, token: string | null): Promise<Result<ResultPage>> {
  return attempt(async () => {
    const qid = checkId(id, "Query execution ID");
    const ctx = await makeCtx();
    const r = await ctx.clients.athena.send(new GetQueryResultsCommand({ QueryExecutionId: qid, MaxResults: 100, NextToken: typeof token === "string" && token ? token : undefined }));
    return { ...shapeResults(r.ResultSet, !token), nextToken: r.NextToken ?? null };
  });
}

export async function stopQuery(id: string): Promise<Result<{ id: string }>> {
  return attempt(async () => {
    const qid = checkId(id, "Query execution ID");
    const ctx = await makeCtx();
    await ctx.clients.athena.send(new StopQueryExecutionCommand({ QueryExecutionId: qid }));
    return { id: qid };
  });
}

export async function recentQueries(workgroup: string): Promise<Result<Row[]>> {
  return attempt(async () => {
    const wg = checkName(workgroup, "Workgroup");
    return (await recentExecutions(await makeCtx(), wg)).map(executionRow);
  });
}

export async function listSavedQueries(workgroup: string): Promise<Result<SavedQuery[]>> {
  return attempt(async () => {
    const wg = checkName(workgroup, "Workgroup");
    return (await savedQueries(await makeCtx(), wg)).map((q) => ({
      id: q.NamedQueryId ?? "",
      name: q.Name ?? "",
      description: q.Description ?? null,
      database: q.Database ?? null,
      workgroup: q.WorkGroup ?? null,
      query: q.QueryString ?? "",
    }));
  });
}

export async function saveQuery(input: { name: string; description?: string; workgroup: string; database: string; sql: string }): Promise<Result<{ id: string }>> {
  return attempt(async () => {
    const name = checkName(input?.name, "Name", /^[A-Za-z0-9._ -]{1,128}$/);
    const wg = checkName(input?.workgroup, "Workgroup");
    const db = checkName(input?.database, "Database", IDENT_PATTERN);
    const sql = checkSql(input?.sql);
    const description = typeof input?.description === "string" && input.description.trim() !== "" ? input.description.trim().slice(0, 1024) : undefined;
    const ctx = await makeCtx();
    const r = await ctx.clients.athena.send(new CreateNamedQueryCommand({ Name: name, Description: description, WorkGroup: wg, Database: db, QueryString: sql }));
    if (!r.NamedQueryId) throw new Error("Athena returned no saved query ID.");
    return { id: r.NamedQueryId };
  });
}
