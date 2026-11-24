/**
 * Amazon CloudWatch: dashboards, alarms, metrics, logs (log groups, Logs Insights, saved
 * queries) and Contributor Insights. Hand-built screens: the metrics explorer
 * (/cloudwatch/metrics), dashboard widgets, the log events viewer and the Logs Insights editor.
 */

import { ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import type { ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { alarms } from "./alarms.ts";
import { dashboards } from "./dashboards.ts";
import { dimensionsLabel, metricKey } from "./helpers.ts";
import { contributorRules, queryHistory, savedQueries } from "./insights.ts";
import { logGroups } from "./logs.ts";

const metrics: ResourceDef = {
  id: "metrics",
  name: "All metrics",
  singular: "metric",
  idField: "key",
  nameField: "metricName",
  description: "Browse metrics by namespace and dimension, and graph them.",
  emptyText: "No metrics yet. AWS services and PutMetricData publish metrics here.",
  columns: [
    { key: "metricName", label: "Metric name", kind: "link" },
    { key: "namespace", label: "Namespace", kind: "text" },
    { key: "dimensions", label: "Dimensions", kind: "text" },
    { key: "key", label: "Key", kind: "text", hidden: true },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.cloudwatch.send(new ListMetricsCommand({ NextToken: token }));
      for (const m of r.Metrics ?? []) {
        const dims = (m.Dimensions ?? []).map((d) => ({ Name: d.Name ?? "", Value: d.Value ?? "" }));
        rows.push({ key: metricKey({ namespace: m.Namespace ?? "", metricName: m.MetricName ?? "", dimensions: dims }), metricName: m.MetricName ?? "", namespace: m.Namespace ?? "", dimensions: dimensionsLabel(dims) });
      }
      token = r.NextToken;
    } while (token && rows.length < 5000);
    return rows;
  },
};

export const cloudwatchService: ServiceDef = {
  id: "cloudwatch",
  name: "CloudWatch",
  category: "Management & Governance",
  description: "Monitor resources and applications with metrics, alarms, dashboards and logs.",
  resources: [dashboards, alarms, metrics, logGroups, queryHistory, savedQueries, contributorRules],
  notSupported: [],
};
