"use server";

/**
 * Server actions for the hand-built CloudWatch screens (metrics explorer, dashboard
 * widgets). Every call uses the permission-checked CloudWatch client.
 */

import { DescribeAlarmsCommand, GetMetricDataCommand, ListMetricsCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { QUERY_ID, type ChartQuery, type MetricId, type Series } from "./helpers.ts";

const MAX_METRICS = 5000;
const MAX_QUERIES = 50;
const MAX_RANGE = 15 * 86400 * 30;

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Every metric (optionally in one namespace), up to a safety cap. */
export async function listAllMetrics(namespace?: string | null): Promise<Result<{ metrics: MetricId[]; truncated: boolean }>> {
  return attempt(async () => {
    if (namespace !== undefined && namespace !== null && (typeof namespace !== "string" || namespace.length > 255)) throw new Error("Invalid namespace.");
    const metrics: MetricId[] = [];
    let token: string | undefined;
    do {
      const r = await clients.cloudwatch.send(new ListMetricsCommand({ Namespace: namespace || undefined, NextToken: token }));
      for (const m of r.Metrics ?? []) {
        if (!m.Namespace || !m.MetricName) continue;
        metrics.push({
          namespace: m.Namespace,
          metricName: m.MetricName,
          dimensions: (m.Dimensions ?? []).filter((d) => d.Name && d.Value !== undefined).map((d) => ({ Name: d.Name as string, Value: d.Value as string })),
        });
      }
      token = r.NextToken;
    } while (token && metrics.length < MAX_METRICS);
    return { metrics, truncated: Boolean(token) };
  });
}

function checkQuery(q: ChartQuery): MetricDataQuery {
  if (!q || typeof q.id !== "string" || !QUERY_ID.test(q.id)) throw new Error("Each query needs an id that starts with a lowercase letter.");
  const label = typeof q.label === "string" && q.label !== "" ? q.label.slice(0, 1024) : undefined;
  const returnData = q.visible !== false;
  if (typeof q.expression === "string" && q.expression.trim() !== "") {
    if (q.expression.length > 2048) throw new Error("Expressions are at most 2,048 characters.");
    return { Id: q.id, Expression: q.expression, Label: label, ReturnData: returnData, Period: typeof q.period === "number" ? q.period : undefined };
  }
  const m = q.metric;
  if (!m || typeof m.namespace !== "string" || typeof m.metricName !== "string" || !Array.isArray(m.dimensions)) throw new Error(`Query ${q.id} has no metric.`);
  if (typeof q.stat !== "string" || q.stat.length > 50) throw new Error(`Query ${q.id} needs a statistic.`);
  if (typeof q.period !== "number" || q.period < 1) throw new Error(`Query ${q.id} needs a period.`);
  return {
    Id: q.id,
    Label: label,
    ReturnData: returnData,
    MetricStat: {
      Metric: { Namespace: m.namespace, MetricName: m.metricName, Dimensions: m.dimensions.map((d) => ({ Name: String(d.Name), Value: String(d.Value) })) },
      Stat: q.stat,
      Period: q.period,
    },
  };
}

/** Runs GetMetricData for the last `rangeSeconds` and returns one series per returned query. */
export async function fetchMetricData(queries: ChartQuery[], rangeSeconds: number): Promise<Result<{ series: Series[]; start: number; end: number }>> {
  return attempt(async () => {
    if (!Array.isArray(queries) || queries.length === 0) throw new Error("Add a metric to graph.");
    if (queries.length > MAX_QUERIES) throw new Error(`At most ${MAX_QUERIES} metrics and expressions per graph.`);
    if (typeof rangeSeconds !== "number" || rangeSeconds < 60 || rangeSeconds > MAX_RANGE) throw new Error("Choose a time range.");
    const checked = queries.map(checkQuery);
    const end = Date.now();
    const start = end - rangeSeconds * 1000;
    const series: Series[] = [];
    let token: string | undefined;
    do {
      const r = await clients.cloudwatch.send(
        new GetMetricDataCommand({ MetricDataQueries: checked, StartTime: new Date(start), EndTime: new Date(end), NextToken: token, ScanBy: "TimestampAscending" })
      );
      for (const res of r.MetricDataResults ?? []) {
        const id = res.Id ?? "";
        const ts = res.Timestamps ?? [];
        const vals = res.Values ?? [];
        const points = ts.map((t, i) => ({ t: t.getTime(), v: vals[i] })).filter((p): p is { t: number; v: number } => typeof p.v === "number" && Number.isFinite(p.v));
        const existing = series.find((s) => s.id === id);
        if (existing) existing.points.push(...points);
        else
          series.push({
            id,
            label: res.Label ?? id,
            points,
            status: res.StatusCode,
            message: (res.Messages ?? []).map((m) => `${m.Code ?? ""} ${m.Value ?? ""}`.trim()).join("; ") || undefined,
          });
      }
      token = r.NextToken;
    } while (token);
    return { series, start, end };
  });
}

export interface AlarmStatus {
  name: string;
  type: "Metric alarm" | "Composite alarm";
  state: string | null;
  reason: string | null;
  updated: string | null;
}

/** Current state of the named alarms (metric and composite), for dashboard alarm widgets. */
export async function describeAlarmStates(names: string[]): Promise<Result<{ alarms: AlarmStatus[]; missing: string[] }>> {
  return attempt(async () => {
    if (!Array.isArray(names) || names.length === 0 || names.length > 100 || names.some((n) => typeof n !== "string" || n.length === 0 || n.length > 255)) {
      throw new Error("An alarm widget lists 1-100 alarms.");
    }
    const alarms: AlarmStatus[] = [];
    let token: string | undefined;
    do {
      const r = await clients.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: names, AlarmTypes: ["MetricAlarm", "CompositeAlarm"], NextToken: token }));
      for (const a of r.MetricAlarms ?? []) alarms.push({ name: a.AlarmName ?? "", type: "Metric alarm", state: a.StateValue ?? null, reason: a.StateReason ?? null, updated: a.StateUpdatedTimestamp ? new Date(a.StateUpdatedTimestamp).toISOString() : null });
      for (const a of r.CompositeAlarms ?? []) alarms.push({ name: a.AlarmName ?? "", type: "Composite alarm", state: a.StateValue ?? null, reason: a.StateReason ?? null, updated: a.StateUpdatedTimestamp ? new Date(a.StateUpdatedTimestamp).toISOString() : null });
      token = r.NextToken;
    } while (token);
    const found = new Set(alarms.map((a) => a.name));
    return { alarms: names.flatMap((n) => alarms.filter((a) => a.name === n)), missing: names.filter((n) => !found.has(n)) };
  });
}
