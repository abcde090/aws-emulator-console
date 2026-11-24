/**
 * Logs Insights query history and saved queries, and Contributor Insights rules.
 * The query editor itself is hand-built (LogsInsights.tsx).
 */

import {
  DeleteQueryDefinitionCommand,
  DescribeQueriesCommand,
  DescribeQueryDefinitionsCommand,
  GetQueryResultsCommand,
  PutQueryDefinitionCommand,
  StopQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  DeleteInsightRulesCommand,
  DescribeInsightRulesCommand,
  DisableInsightRulesCommand,
  EnableInsightRulesCommand,
  GetInsightRuleReportCommand,
  PutInsightRuleCommand,
  type InsightRule,
} from "@aws-sdk/client-cloudwatch";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { logGroupOptions } from "./logs.ts";
import { resultRows } from "./query-results.ts";

export const queryHistory: ResourceDef = {
  id: "logs-insights",
  name: "Logs Insights",
  singular: "query",
  idField: "queryId",
  nameField: "queryId",
  description: "Queries you ran with CloudWatch Logs Insights. Open one to see its results again.",
  emptyText: "No queries yet. Run a query above.",
  columns: [
    { key: "queryId", label: "Query ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "logGroup", label: "Log group", kind: "text" },
    { key: "query", label: "Query", kind: "code" },
    { key: "created", label: "Created", kind: "date" },
  ],

  async list(ctx) {
    const r = await ctx.clients.logs.send(new DescribeQueriesCommand({ maxResults: 1000 }));
    return (r.queries ?? [])
      .map((q) => ({ queryId: q.queryId ?? "", status: q.status ?? null, logGroup: q.logGroupName ?? null, query: q.queryString ?? "", created: q.createTime ? new Date(q.createTime).toISOString() : null }))
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  },

  async get(ctx, id) {
    const [results, history] = await Promise.all([
      ctx.clients.logs.send(new GetQueryResultsCommand({ queryId: id })),
      ctx.clients.logs.send(new DescribeQueriesCommand({ maxResults: 1000 })),
    ]);
    const q = (history.queries ?? []).find((x) => x.queryId === id);
    const { columns, rows } = resultRows(results.results ?? []);
    return {
      summary: {
        "Query ID": id,
        Status: results.status ?? null,
        "Log group": q?.logGroupName ?? null,
        Query: q?.queryString ?? null,
        "Records matched": results.statistics?.recordsMatched ?? null,
        "Records scanned": results.statistics?.recordsScanned ?? null,
        "Bytes scanned": results.statistics?.bytesScanned ?? null,
      },
      tabs: [{ id: "logs", label: "Logs", kind: "table", data: rows, columns: columns.map((c) => ({ key: c, label: c, kind: "code" as const })), emptyText: "The query returned no records." }],
    };
  },

  actions: [
    {
      id: "stop",
      label: "Stop query",
      availableFor: (row) => {
        const st = row.status ?? row.Status;
        return st === undefined || st === null || st === "Scheduled" || st === "Running";
      },
      confirm: "Stops the query if it is still running.",
      async run(ctx, id) {
        const r = await ctx.clients.logs.send(new StopQueryCommand({ queryId: id }));
        return { message: r.success ? `Query ${id} stopped.` : `Query ${id} was not running.` };
      },
    },
  ],
};

export const savedQueries: ResourceDef = {
  id: "saved-queries",
  name: "Saved queries",
  singular: "saved query",
  idField: "id",
  nameField: "name",
  description: "Query definitions saved for reuse in Logs Insights.",
  emptyText: "No saved queries.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "query", label: "Query", kind: "code" },
    { key: "logGroups", label: "Log groups", kind: "text" },
    { key: "modified", label: "Last modified", kind: "date" },
    { key: "id", label: "ID", kind: "text", hidden: true },
  ],

  async list(ctx) {
    const r = await ctx.clients.logs.send(new DescribeQueryDefinitionsCommand({ maxResults: 1000 }));
    return (r.queryDefinitions ?? []).map((d) => ({
      id: d.queryDefinitionId ?? "",
      name: d.name ?? "",
      query: d.queryString ?? "",
      logGroups: (d.logGroupNames ?? []).join(", "),
      modified: d.lastModified ? new Date(d.lastModified).toISOString() : null,
    }));
  },

  async get(ctx, id) {
    const r = await ctx.clients.logs.send(new DescribeQueryDefinitionsCommand({ maxResults: 1000 }));
    const d = (r.queryDefinitions ?? []).find((x) => x.queryDefinitionId === id);
    if (!d) throw new Error(`ResourceNotFoundException: saved query ${id} does not exist.`);
    return {
      summary: { Name: d.name ?? null, ID: id, "Log groups": (d.logGroupNames ?? []).join(", ") || null, "Last modified": d.lastModified ? new Date(d.lastModified).toISOString() : null },
      tabs: [{ id: "query", label: "Query", kind: "text", data: d.queryString ?? "" }],
    };
  },

  create: {
    title: "Save query",
    fields: [
      { name: "name", label: "Query name", kind: "text", required: true, help: "Use / to put the query in a folder, e.g. errors/by-path.", validate: { max: 255, message: "Up to 255 characters." } },
      { name: "query", label: "Query", kind: "textarea", required: true, default: "fields @timestamp, @message, @logStream\n| sort @timestamp desc\n| limit 20" },
      { name: "logGroups", label: "Log groups", kind: "multiselect", options: logGroupOptions },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.logs.send(
        new PutQueryDefinitionCommand({ name: String(v.name), queryString: String(v.query), logGroupNames: Array.isArray(v.logGroups) && v.logGroups.length ? (v.logGroups as string[]) : undefined })
      );
      if (!r.queryDefinitionId) throw new Error("CloudWatch Logs returned no query definition ID.");
      return r.queryDefinitionId;
    },
  },

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.logs.send(new DeleteQueryDefinitionCommand({ queryDefinitionId: id }));
    },
  },
};

// ---- Contributor Insights ----

async function allRules(ctx: Ctx): Promise<InsightRule[]> {
  const out: InsightRule[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.cloudwatch.send(new DescribeInsightRulesCommand({ NextToken: token }));
    out.push(...(r.InsightRules ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

function ruleDefinition(groups: string[], format: string, keys: string[], valueOf: string, aggregate: string): string {
  return JSON.stringify(
    {
      Schema: { Name: "CloudWatchLogRule", Version: 1 },
      LogGroupNames: groups,
      LogFormat: format,
      ...(format === "CLF" ? { Fields: { "1": "sourceIp", "2": "identity", "3": "user", "4": "time", "5": "request", "6": "statusCode", "7": "size" } } : {}),
      Contribution: { Keys: keys, ...(valueOf ? { ValueOf: valueOf } : {}), Filters: [] },
      AggregateOn: aggregate,
    },
    null,
    2
  );
}

export interface RuleReport {
  keyLabels: string[];
  aggregateValue: number | null;
  uniqueContributors: number | null;
  contributors: { keys: string[]; value: number | null; points: { t: number; v: number }[] }[];
}

/**
 * GetInsightRuleReport for one rule over [start, end]: the top contributors with their
 * datapoints. Shared by the Contributor Insights page and DynamoDB's table Monitoring tab.
 */
export async function insightRuleReport(ctx: Ctx, name: string, start: Date, end: Date, period = 300, max = 10): Promise<RuleReport> {
  const report = await ctx.clients.cloudwatch.send(new GetInsightRuleReportCommand({ RuleName: name, StartTime: start, EndTime: end, Period: period, MaxContributorCount: max }));
  return {
    keyLabels: report.KeyLabels ?? [],
    aggregateValue: report.AggregateValue ?? null,
    uniqueContributors: report.ApproximateUniqueCount ?? null,
    contributors: (report.Contributors ?? []).map((c) => ({
      keys: c.Keys ?? [],
      value: c.ApproximateAggregateValue ?? null,
      points: (c.Datapoints ?? [])
        .filter((d) => d.Timestamp && typeof d.ApproximateValue === "number")
        .map((d) => ({ t: new Date(d.Timestamp as Date).getTime(), v: d.ApproximateValue as number }))
        .sort((a, b) => a.t - b.t),
    })),
  };
}

function ruleRow(r: InsightRule): Row {
  return { name: r.Name ?? "", state: r.State ?? null, schema: r.Schema ?? null, managed: r.ManagedRule ? "Yes" : "No" };
}

export const contributorRules: ResourceDef = {
  id: "contributor-insights",
  name: "Contributor Insights",
  singular: "rule",
  idField: "name",
  nameField: "name",
  description: "Rules that find the top contributors (for example the busiest IP addresses) in log data.",
  emptyText: "No Contributor Insights rules.",
  columns: [
    { key: "name", label: "Rule name", kind: "link" },
    { key: "state", label: "State", kind: "status" },
    { key: "schema", label: "Rule type", kind: "text" },
    { key: "managed", label: "Managed", kind: "text" },
  ],

  async list(ctx) {
    return (await allRules(ctx)).map(ruleRow);
  },

  async get(ctx, name) {
    const rule = (await allRules(ctx)).find((r) => r.Name === name);
    if (!rule) throw new Error(`ResourceNotFoundException: rule ${name} does not exist.`);
    const end = new Date();
    const start = new Date(end.getTime() - 3600_000);
    let definition: unknown = rule.Definition ?? "";
    try {
      definition = JSON.parse(rule.Definition ?? "");
    } catch {
      definition = rule.Definition ?? "";
    }
    const report = await insightRuleReport(ctx, name, start, end);
    return {
      summary: { "Rule name": name, State: rule.State ?? null, "Rule type": rule.Schema ?? null, Managed: rule.ManagedRule ? "Yes" : "No", "Aggregate value (last hour)": report.aggregateValue, "Unique contributors (last hour)": report.uniqueContributors },
      tabs: [
        {
          id: "contributors",
          label: "Top contributors",
          kind: "table",
          description: `Last hour, keys: ${report.keyLabels.join(", ") || "-"}.`,
          data: report.contributors.map((c) => ({ keys: c.keys.join(", "), value: c.value })),
          columns: [
            { key: "keys", label: "Contributor", kind: "text" },
            { key: "value", label: "Value", kind: "count" },
          ],
          emptyText: "No contributors in the last hour.",
        },
        { id: "definition", label: "Rule definition", kind: "json", data: definition },
      ],
    };
  },

  create: {
    title: "Create rule",
    description: "A rule reads JSON or Common Log Format log events and ranks contributors by the keys you choose.",
    fields: [
      { name: "name", label: "Rule name", kind: "text", required: true, section: "Rule details", validate: { pattern: "[\\x20-\\x7E]{1,128}", message: "Up to 128 printable characters." } },
      { name: "logGroups", label: "Log groups", kind: "multiselect", required: true, section: "Rule details", options: logGroupOptions },
      {
        name: "format",
        label: "Log format",
        kind: "radio",
        section: "Rule details",
        default: "JSON",
        options: [
          { value: "JSON", label: "JSON" },
          { value: "CLF", label: "CLF (Common Log Format)" },
        ],
      },
      { name: "keys", label: "Contribution (keys)", kind: "text", required: true, section: "Contribution", placeholder: "$.ip", help: "Up to 4 comma-separated fields, e.g. $.ip, $.path (JSON) or sourceIp (CLF)." },
      {
        name: "aggregate",
        label: "Aggregate on",
        kind: "radio",
        section: "Contribution",
        default: "Count",
        options: [
          { value: "Count", label: "Count - number of log events" },
          { value: "Sum", label: "Sum - of the value field" },
        ],
      },
      { name: "valueField", label: "Value field", kind: "text", section: "Contribution", showIf: { field: "aggregate", equals: "Sum" }, placeholder: "$.bytes" },
      { name: "enabled", label: "Create rule in Enabled state", kind: "checkbox", section: "Rule state", default: true },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const keys = String(v.keys).split(",").map((k) => k.trim()).filter(Boolean);
      if (keys.length === 0 || keys.length > 4) throw new Error("Give between 1 and 4 keys.");
      const def = ruleDefinition(v.logGroups as string[], String(v.format), keys, typeof v.valueField === "string" ? v.valueField : "", String(v.aggregate));
      await ctx.clients.cloudwatch.send(new PutInsightRuleCommand({ RuleName: name, RuleDefinition: def, RuleState: v.enabled === true ? "ENABLED" : "DISABLED" }));
      return name;
    },
  },

  actions: [
    {
      id: "enable",
      label: "Enable",
      availableFor: (row) => (row.state ?? row.State) !== "ENABLED",
      async run(ctx, name) {
        const r = await ctx.clients.cloudwatch.send(new EnableInsightRulesCommand({ RuleNames: [name] }));
        if (r.Failures?.length) throw new Error(r.Failures.map((f) => `${f.FailureCode}: ${f.FailureDescription}`).join("; "));
        return { message: `Rule ${name} enabled.` };
      },
    },
    {
      id: "disable",
      label: "Disable",
      availableFor: (row) => (row.state ?? row.State) !== "DISABLED",
      async run(ctx, name) {
        const r = await ctx.clients.cloudwatch.send(new DisableInsightRulesCommand({ RuleNames: [name] }));
        if (r.Failures?.length) throw new Error(r.Failures.map((f) => `${f.FailureCode}: ${f.FailureDescription}`).join("; "));
        return { message: `Rule ${name} disabled.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      const r = await ctx.clients.cloudwatch.send(new DeleteInsightRulesCommand({ RuleNames: [name] }));
      if (r.Failures?.length) throw new Error(r.Failures.map((f) => `${f.FailureCode}: ${f.FailureDescription}`).join("; "));
    },
  },
};
