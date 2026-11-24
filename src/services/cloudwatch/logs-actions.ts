"use server";

/** Server actions for the log events viewer and the Logs Insights editor (permission-checked Logs client). */

import { FilterLogEventsCommand, GetQueryResultsCommand, StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { resultRows } from "./query-results.ts";

const GROUP = /^[A-Za-z0-9_./#-]{1,512}$/;
const MAX_RANGE_SECONDS = 366 * 86400;

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

export interface LogEvent {
  id: string;
  timestamp: string | null;
  ingested: string | null;
  stream: string;
  message: string;
}

export interface EventPage {
  events: LogEvent[];
  nextToken: string | null;
}

export interface EventQuery {
  group: string;
  stream?: string;
  pattern?: string;
  rangeSeconds?: number;
  nextToken?: string | null;
}

export async function filterLogEvents(q: EventQuery): Promise<Result<EventPage>> {
  return attempt(async () => {
    if (!q || typeof q.group !== "string" || !GROUP.test(q.group)) throw new Error("That is not a valid log group name.");
    const stream = typeof q.stream === "string" && q.stream !== "" ? q.stream.slice(0, 512) : undefined;
    const pattern = typeof q.pattern === "string" && q.pattern.trim() !== "" ? q.pattern.slice(0, 1024) : undefined;
    const range = typeof q.rangeSeconds === "number" && q.rangeSeconds > 0 ? Math.min(q.rangeSeconds, MAX_RANGE_SECONDS) : null;
    const r = await clients.logs.send(
      new FilterLogEventsCommand({
        logGroupName: q.group,
        logStreamNames: stream ? [stream] : undefined,
        filterPattern: pattern,
        startTime: range ? Date.now() - range * 1000 : undefined,
        nextToken: typeof q.nextToken === "string" && q.nextToken ? q.nextToken : undefined,
        limit: 500,
      })
    );
    return {
      events: (r.events ?? []).map((e, i) => ({
        id: e.eventId ?? `${e.timestamp ?? 0}-${i}`,
        timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : null,
        ingested: e.ingestionTime ? new Date(e.ingestionTime).toISOString() : null,
        stream: e.logStreamName ?? "",
        message: e.message ?? "",
      })),
      nextToken: r.nextToken ?? null,
    };
  });
}

export async function startInsightsQuery(groups: string[], query: string, rangeSeconds: number, limit: number): Promise<Result<{ queryId: string }>> {
  return attempt(async () => {
    if (!Array.isArray(groups) || groups.length === 0) throw new Error("Select at least one log group.");
    if (groups.length > 50 || groups.some((g) => typeof g !== "string" || !GROUP.test(g))) throw new Error("Select up to 50 valid log groups.");
    if (typeof query !== "string" || query.trim() === "" || query.length > 10000) throw new Error("Enter a query (up to 10,000 characters).");
    if (typeof rangeSeconds !== "number" || rangeSeconds < 60 || rangeSeconds > MAX_RANGE_SECONDS) throw new Error("Choose a time range.");
    const end = Math.floor(Date.now() / 1000);
    const r = await clients.logs.send(
      new StartQueryCommand({ logGroupNames: groups, queryString: query, startTime: end - rangeSeconds, endTime: end, limit: typeof limit === "number" && limit > 0 ? Math.min(limit, 10000) : undefined })
    );
    if (!r.queryId) throw new Error("CloudWatch Logs returned no query ID.");
    return { queryId: r.queryId };
  });
}

export interface InsightsResults {
  status: string;
  columns: string[];
  rows: Record<string, string>[];
  recordsMatched: number | null;
  recordsScanned: number | null;
  bytesScanned: number | null;
}

export async function getInsightsResults(queryId: string): Promise<Result<InsightsResults>> {
  return attempt(async () => {
    if (typeof queryId !== "string" || queryId.length === 0 || queryId.length > 256) throw new Error("Invalid query ID.");
    const r = await clients.logs.send(new GetQueryResultsCommand({ queryId }));
    const { columns, rows } = resultRows(r.results ?? []);
    return {
      status: r.status ?? "Unknown",
      columns,
      rows,
      recordsMatched: r.statistics?.recordsMatched ?? null,
      recordsScanned: r.statistics?.recordsScanned ?? null,
      bytesScanned: r.statistics?.bytesScanned ?? null,
    };
  });
}
