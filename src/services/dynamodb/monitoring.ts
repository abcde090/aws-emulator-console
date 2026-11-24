/**
 * The table's Monitoring tab: CloudWatch metrics in AWS/DynamoDB for the table, as numbers
 * (sum or average over the last 24 hours), straight from GetMetricStatistics.
 */

import { GetMetricStatisticsCommand, ListMetricsCommand, type Dimension, type Statistic } from "@aws-sdk/client-cloudwatch";
import type { Ctx, Row } from "../../console/types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const AVERAGED = new Set(["SuccessfulRequestLatency", "ProvisionedReadCapacityUnits", "ProvisionedWriteCapacityUnits", "AccountProvisionedReadCapacityUtilization"]);

export function statisticFor(metric: string): Statistic {
  return AVERAGED.has(metric) ? "Average" : "Sum";
}

/** "GlobalSecondaryIndexName=by-status, Operation=Query" without the TableName dimension. */
export function dimensionText(dims: Dimension[]): string {
  return dims.filter((d) => d.Name !== "TableName").map((d) => `${d.Name ?? ""}=${d.Value ?? ""}`).join(", ") || "Table";
}

export async function tableMetrics(ctx: Ctx, table: string): Promise<Row[]> {
  const metrics = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.cloudwatch.send(new ListMetricsCommand({ Namespace: "AWS/DynamoDB", Dimensions: [{ Name: "TableName", Value: table }], NextToken: token }));
    metrics.push(...(page.Metrics ?? []));
    token = page.NextToken;
  } while (token);
  const end = new Date();
  const start = new Date(end.getTime() - DAY_MS);
  const rows = await Promise.all(
    metrics.slice(0, 40).map(async (m) => {
      const name = m.MetricName ?? "";
      const stat = statisticFor(name);
      const r = await ctx.clients.cloudwatch.send(
        new GetMetricStatisticsCommand({ Namespace: "AWS/DynamoDB", MetricName: name, Dimensions: m.Dimensions, StartTime: start, EndTime: end, Period: 300, Statistics: [stat] })
      );
      const points = (r.Datapoints ?? []).filter((p) => typeof p[stat] === "number");
      const values = points.map((p) => p[stat] as number);
      const value = values.length === 0 ? null : stat === "Sum" ? values.reduce((a, b) => a + b, 0) : values.reduce((a, b) => a + b, 0) / values.length;
      const latest = points.map((p) => p.Timestamp).filter((d): d is Date => d instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const unit = points[0]?.Unit && points[0].Unit !== "None" ? ` ${points[0].Unit}` : "";
      return {
        metric: name,
        dimension: dimensionText(m.Dimensions ?? []),
        statistic: stat,
        datapoints: points.length,
        total: value === null ? null : `${Number.isInteger(value) ? value : value.toFixed(2)}${unit}`,
        latest,
      };
    })
  );
  return rows.sort((a, b) => a.metric.localeCompare(b.metric) || a.dimension.localeCompare(b.dimension));
}
