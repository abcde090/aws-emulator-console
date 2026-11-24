/**
 * AWS X-Ray: traces (with filter expressions and a segment timeline), the service map,
 * sampling rules and groups. Hand-built: /xray/traces (query), /xray/traces/<id>
 * (timeline) and /xray/service-map (graph).
 */

import {
  BatchGetTracesCommand,
  CreateGroupCommand,
  CreateSamplingRuleCommand,
  DeleteGroupCommand,
  DeleteSamplingRuleCommand,
  GetGroupCommand,
  GetGroupsCommand,
  GetSamplingRulesCommand,
  GetServiceGraphCommand,
  GetTraceSummariesCommand,
  UpdateGroupCommand,
  UpdateSamplingRuleCommand,
  type SamplingRule,
  type Service,
  type TraceSummary,
} from "@aws-sdk/client-xray";
import type { Ctx, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { timelineRows } from "./helpers.ts";

export const DEFAULT_RANGE_SECONDS = 6 * 3600;

export function traceRow(t: TraceSummary): Row {
  return {
    id: t.Id ?? "",
    time: t.StartTime ?? null,
    status: t.HasFault ? "Fault" : t.HasError ? "Error" : t.HasThrottle ? "Throttle" : "OK",
    responseCode: t.Http?.HttpStatus ?? null,
    responseTime: t.ResponseTime ?? null,
    duration: t.Duration ?? null,
    method: t.Http?.HttpMethod ?? null,
    url: t.Http?.HttpURL ?? null,
    clientIp: t.Http?.ClientIp ?? null,
    services: (t.ServiceIds ?? []).map((s) => s.Name).filter(Boolean).join(", "),
  };
}

export const TRACE_COLUMNS = [
  { key: "id", label: "Trace ID", kind: "link" as const },
  { key: "time", label: "Trace start time", kind: "date" as const },
  { key: "status", label: "Trace status", kind: "status" as const },
  { key: "responseCode", label: "Response code", kind: "text" as const },
  { key: "responseTime", label: "Response time (s)", kind: "text" as const },
  { key: "method", label: "HTTP method", kind: "text" as const },
  { key: "url", label: "URL address", kind: "text" as const },
  { key: "services", label: "Nodes", kind: "text" as const },
];

export async function traceSummaries(ctx: Ctx, rangeSeconds: number, filter?: string): Promise<Row[]> {
  const end = new Date();
  const start = new Date(end.getTime() - rangeSeconds * 1000);
  const rows: Row[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.xray.send(new GetTraceSummariesCommand({ StartTime: start, EndTime: end, FilterExpression: filter || undefined, NextToken: token }));
    rows.push(...(r.TraceSummaries ?? []).map(traceRow));
    token = r.NextToken;
  } while (token && rows.length < 1000);
  return rows;
}

const traces: ResourceDef = {
  id: "traces",
  name: "Traces",
  singular: "trace",
  idField: "id",
  nameField: "id",
  description: "Requests traced end to end through your application. Last 6 hours.",
  emptyText: "No traces in the last 6 hours. Instrumented applications send segments with PutTraceSegments.",
  columns: TRACE_COLUMNS,
  list: (ctx) => traceSummaries(ctx, DEFAULT_RANGE_SECONDS),

  async get(ctx, id) {
    const r = await ctx.clients.xray.send(new BatchGetTracesCommand({ TraceIds: [id] }));
    const trace = (r.Traces ?? [])[0];
    if (!trace) throw new Error(`Trace ${id} was not found. Traces are kept for 30 days.`);
    const docs = (trace.Segments ?? []).map((s) => s.Document ?? "").filter(Boolean);
    const rows = timelineRows(docs);
    const root = rows[0];
    return {
      summary: {
        "Trace ID": id,
        Duration: trace.Duration !== undefined ? `${trace.Duration}s` : null,
        Segments: (trace.Segments ?? []).length,
        "Root segment": root?.name ?? null,
        "HTTP method": root?.method ?? null,
        URL: root?.url ?? null,
        "Response code": root?.httpStatus ?? null,
        Status: root?.status ?? null,
      },
      tabs: [
        {
          id: "segments",
          label: "Segments",
          kind: "table",
          data: rows.map((x) => ({ name: `${"— ".repeat(x.depth)}${x.name}`, kind: x.kind, status: x.status, duration: x.end !== null ? `${(x.end - x.start).toFixed(3)}s` : "in progress", httpStatus: x.httpStatus, id: x.id })),
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "kind", label: "Type", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "duration", label: "Duration", kind: "text" },
            { key: "httpStatus", label: "Response code", kind: "text" },
            { key: "id", label: "ID", kind: "code" },
          ],
        },
        { id: "raw", label: "Raw data", kind: "json", data: docs.map((d) => { try { return JSON.parse(d) as unknown; } catch { return d; } }) },
      ],
    };
  },
};

/**
 * Node names repeat (a Lambda function, its context and its client), so the id joins the
 * name, type and the graph's reference number.
 */
export function nodeId(s: Pick<Service, "Name" | "Type" | "ReferenceId">): string {
  return `${s.Name ?? "node"}~${s.Type ?? "client"}~${s.ReferenceId ?? 0}`;
}

function serviceRows(services: Service[]): Row[] {
  return services.map((s) => {
    const stats = s.SummaryStatistics;
    const total = stats?.TotalCount ?? 0;
    return {
      id: nodeId(s),
      name: s.Name ?? `(${s.ReferenceId})`,
      type: s.Type ?? "client",
      state: s.State ?? null,
      requests: total,
      ok: stats?.OkCount ?? null,
      errors: stats?.ErrorStatistics?.TotalCount ?? null,
      faults: stats?.FaultStatistics?.TotalCount ?? null,
      avgResponse: total && stats?.TotalResponseTime !== undefined ? `${(stats.TotalResponseTime / total).toFixed(3)}s` : null,
      calls: (s.Edges ?? []).map((e) => services.find((x) => x.ReferenceId === e.ReferenceId)?.Name ?? e.ReferenceId).join(", "),
    };
  });
}

export async function serviceGraph(ctx: Ctx, rangeSeconds: number): Promise<Service[]> {
  const end = new Date();
  const start = new Date(end.getTime() - rangeSeconds * 1000);
  const out: Service[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.xray.send(new GetServiceGraphCommand({ StartTime: start, EndTime: end, NextToken: token }));
    out.push(...(r.Services ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

const serviceMap: ResourceDef = {
  id: "service-map",
  name: "Service map",
  singular: "node",
  idField: "id",
  nameField: "name",
  description: "Services and resources that served traced requests in the last 6 hours, and the calls between them.",
  emptyText: "No services in the last 6 hours.",
  columns: [
    { key: "name", label: "Node", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "requests", label: "Requests", kind: "count" },
    { key: "avgResponse", label: "Avg. latency", kind: "text" },
    { key: "errors", label: "Errors (4xx)", kind: "count" },
    { key: "faults", label: "Faults (5xx)", kind: "count" },
    { key: "calls", label: "Calls", kind: "text" },
    { key: "id", label: "Node ID", kind: "text", hidden: true },
  ],
  list: async (ctx) => serviceRows(await serviceGraph(ctx, DEFAULT_RANGE_SECONDS)),
  async get(ctx, id) {
    const all = await serviceGraph(ctx, DEFAULT_RANGE_SECONDS);
    const s = all.find((x) => nodeId(x) === id);
    if (!s) throw new Error(`No node ${id} in the last 6 hours.`);
    const name = s.Name ?? id;
    const row = serviceRows(all).find((x) => x.id === id) ?? {};
    return {
      summary: { Name: name, Type: row.type, Requests: row.requests, "Avg. latency": row.avgResponse, "Errors (4xx)": row.errors, "Faults (5xx)": row.faults, "Account ID": s.AccountId ?? null },
      tabs: [
        {
          id: "edges",
          label: "Downstream calls",
          kind: "table",
          data: (s.Edges ?? []).map((e) => ({
            to: all.find((x) => x.ReferenceId === e.ReferenceId)?.Name ?? String(e.ReferenceId),
            requests: e.SummaryStatistics?.TotalCount ?? null,
            avg: e.SummaryStatistics?.TotalCount ? `${((e.SummaryStatistics.TotalResponseTime ?? 0) / e.SummaryStatistics.TotalCount).toFixed(3)}s` : null,
            faults: e.SummaryStatistics?.FaultStatistics?.TotalCount ?? null,
          })),
          columns: [
            { key: "to", label: "Calls", kind: "text" },
            { key: "requests", label: "Requests", kind: "count" },
            { key: "avg", label: "Avg. latency", kind: "text" },
            { key: "faults", label: "Faults", kind: "count" },
          ],
          emptyText: "This node made no traced downstream calls.",
        },
        { id: "histogram", label: "Response time distribution", kind: "table", data: (s.ResponseTimeHistogram ?? []).map((h) => ({ value: `${h.Value}s`, count: h.Count ?? 0 })), columns: [{ key: "value", label: "Response time", kind: "text" }, { key: "count", label: "Requests", kind: "count" }] },
      ],
    };
  },
};

const RULE_NAME = "[A-Za-z0-9_-]{1,32}";

async function findSamplingRule(ctx: Ctx, name: string): Promise<SamplingRule> {
  let token: string | undefined;
  do {
    const r = await ctx.clients.xray.send(new GetSamplingRulesCommand({ NextToken: token }));
    const hit = (r.SamplingRuleRecords ?? []).find((rec) => rec.SamplingRule?.RuleName === name)?.SamplingRule;
    if (hit) return hit;
    token = r.NextToken;
  } while (token);
  throw new Error(`Sampling rule ${name} does not exist.`);
}

const isDefault = (row: Row): boolean => [row.name, row.Name, row["Group name"]].includes("Default");

const samplingRules: ResourceDef = {
  id: "sampling-rules",
  name: "Sampling rules",
  singular: "sampling rule",
  idField: "name",
  nameField: "name",
  description: "Rules that decide which requests the X-Ray SDK records. The lowest priority number is matched first; Default applies last.",
  emptyText: "No sampling rules.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "priority", label: "Priority", kind: "count" },
    { key: "reservoir", label: "Reservoir", kind: "count" },
    { key: "rate", label: "Rate", kind: "text" },
    { key: "serviceName", label: "Service name", kind: "text" },
    { key: "host", label: "Host", kind: "text" },
    { key: "method", label: "HTTP method", kind: "text" },
    { key: "urlPath", label: "URL path", kind: "text" },
    { key: "modified", label: "Last modified", kind: "date" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.xray.send(new GetSamplingRulesCommand({ NextToken: token }));
      for (const rec of r.SamplingRuleRecords ?? []) {
        const s = rec.SamplingRule;
        if (!s) continue;
        rows.push({
          name: s.RuleName ?? "",
          priority: s.Priority ?? null,
          reservoir: s.ReservoirSize ?? null,
          rate: s.FixedRate !== undefined ? `${Math.round(s.FixedRate * 10000) / 100}%` : null,
          serviceName: s.ServiceName ?? null,
          serviceType: s.ServiceType ?? null,
          host: s.Host ?? null,
          method: s.HTTPMethod ?? null,
          urlPath: s.URLPath ?? null,
          resourceArn: s.ResourceARN ?? null,
          arn: s.RuleARN ?? null,
          created: rec.CreatedAt ?? null,
          modified: rec.ModifiedAt ?? null,
        });
      }
      token = r.NextToken;
    } while (token);
    return rows;
  },
  async get(ctx, name) {
    const row = (await samplingRules.list(ctx)).find((r) => r.name === name);
    if (!row) throw new Error(`Sampling rule ${name} does not exist.`);
    return {
      summary: { Name: name, Priority: row.priority, Reservoir: row.reservoir, Rate: row.rate, ARN: row.arn },
      tabs: [
        {
          id: "matching",
          label: "Matching criteria",
          kind: "keyvalue",
          data: { "Service name": row.serviceName, "Service type": row.serviceType, Host: row.host, "HTTP method": row.method, "URL path": row.urlPath, "Resource ARN": row.resourceArn, Created: row.created, "Last modified": row.modified },
        },
      ],
    };
  },
  create: {
    title: "Create sampling rule",
    fields: [
      { name: "name", label: "Rule name", kind: "text", required: true, section: "Rule definition", validate: { pattern: RULE_NAME, message: "Up to 32 letters, numbers, hyphens and underscores." } },
      { name: "priority", label: "Priority", kind: "number", required: true, default: 1000, section: "Rule definition", help: "1 to 9999. Lower numbers are evaluated first.", validate: { min: 1, max: 9999, message: "Between 1 and 9999." } },
      { name: "reservoir", label: "Reservoir", kind: "number", required: true, default: 1, section: "Rule definition", help: "Requests per second to record before applying the rate.", validate: { min: 0, max: 100000, message: "0 or more." } },
      { name: "rate", label: "Rate", kind: "number", required: true, default: 0.05, section: "Rule definition", help: "Fraction of requests to record after the reservoir, from 0 to 1 (0.05 = 5%).", validate: { min: 0, max: 1, message: "Between 0 and 1." } },
      { name: "serviceName", label: "Service name", kind: "text", default: "*", section: "Matching criteria" },
      { name: "serviceType", label: "Service type", kind: "text", default: "*", section: "Matching criteria", help: "e.g. AWS::EC2::Instance" },
      { name: "host", label: "Host", kind: "text", default: "*", section: "Matching criteria" },
      { name: "method", label: "HTTP method", kind: "text", default: "*", section: "Matching criteria" },
      { name: "urlPath", label: "URL path", kind: "text", default: "*", section: "Matching criteria" },
      { name: "resourceArn", label: "Resource ARN", kind: "text", default: "*", section: "Matching criteria" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const t = (k: string) => (typeof v[k] === "string" && v[k] !== "" ? String(v[k]) : "*");
      await ctx.clients.xray.send(
        new CreateSamplingRuleCommand({
          SamplingRule: {
            RuleName: name,
            Priority: Number(v.priority),
            ReservoirSize: Number(v.reservoir),
            FixedRate: Number(v.rate),
            ServiceName: t("serviceName"),
            ServiceType: t("serviceType"),
            Host: t("host"),
            HTTPMethod: t("method"),
            URLPath: t("urlPath"),
            ResourceARN: t("resourceArn"),
            Version: 1,
          },
        })
      );
      return name;
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit limits",
      fields: [
        { name: "priority", label: "Priority", kind: "number", help: "1 to 9999. The Default rule's priority can't be changed.", validate: { min: 1, max: 9999, message: "Between 1 and 9999." } },
        { name: "reservoir", label: "Reservoir", kind: "number", validate: { min: 0, max: 100000, message: "0 or more." } },
        { name: "rate", label: "Rate", kind: "number", help: "From 0 to 1 (0.05 = 5%).", validate: { min: 0, max: 1, message: "Between 0 and 1." } },
      ],
      async initialValues(ctx, name) {
        const r = await findSamplingRule(ctx, name);
        return {
          // The Default rule's priority (10000) is fixed and outside the editable range.
          ...(name === "Default" ? {} : { priority: r.Priority ?? null }),
          reservoir: r.ReservoirSize ?? null,
          rate: r.FixedRate ?? null,
        };
      },
      async run(ctx, name, v) {
        await ctx.clients.xray.send(
          new UpdateSamplingRuleCommand({
            SamplingRuleUpdate: {
              RuleName: name,
              Priority: typeof v.priority === "number" && name !== "Default" ? v.priority : undefined,
              ReservoirSize: typeof v.reservoir === "number" ? v.reservoir : undefined,
              FixedRate: typeof v.rate === "number" ? v.rate : undefined,
            },
          })
        );
        return { message: `Sampling rule ${name} updated.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    // The Default sampling rule can't be deleted (OG-9): the console offers no Delete for it.
    availableFor: (row) => !isDefault(row),
    async run(ctx, name) {
      if (name === "Default") throw new Error("The Default sampling rule can't be deleted.");
      await ctx.clients.xray.send(new DeleteSamplingRuleCommand({ RuleName: name }));
    },
  },
};

const groups: ResourceDef = {
  id: "groups",
  name: "Groups",
  singular: "group",
  idField: "name",
  nameField: "name",
  description: "Groups save a filter expression so you can view a subset of traces and its own service map.",
  emptyText: "No groups.",
  columns: [
    { key: "name", label: "Group name", kind: "link" },
    { key: "filter", label: "Filter expression", kind: "code" },
    { key: "arn", label: "ARN", kind: "arn" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.xray.send(new GetGroupsCommand({ NextToken: token }));
      rows.push(...(r.Groups ?? []).map((g) => ({ name: g.GroupName ?? "", filter: g.FilterExpression ?? null, arn: g.GroupARN ?? null })));
      token = r.NextToken;
    } while (token);
    return rows;
  },
  async get(ctx, name) {
    const r = await ctx.clients.xray.send(new GetGroupCommand({ GroupName: name }));
    const g = r.Group;
    return {
      summary: { "Group name": g?.GroupName ?? name, "Filter expression": g?.FilterExpression ?? "(all traces)", ARN: g?.GroupARN ?? null, Insights: g?.InsightsConfiguration?.InsightsEnabled ? "Enabled" : "Disabled" },
    };
  },
  create: {
    title: "Create group",
    fields: [
      { name: "name", label: "Group name", kind: "text", required: true, validate: { pattern: "[A-Za-z0-9_-]{1,32}", message: "Up to 32 letters, numbers, hyphens and underscores." } },
      { name: "filter", label: "Filter expression", kind: "textarea", required: true, placeholder: 'service("api") AND responsetime > 1', help: "Traces that match the expression belong to the group." },
      { name: "tags", label: "Tags", kind: "tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      await ctx.clients.xray.send(new CreateGroupCommand({ GroupName: name, FilterExpression: String(v.filter), Tags: Array.isArray(v.tags) && v.tags.length ? (v.tags as { Key: string; Value: string }[]) : undefined }));
      return name;
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit filter expression",
      availableFor: (row) => !isDefault(row),
      fields: [{ name: "filter", label: "Filter expression", kind: "textarea", required: true }],
      async initialValues(ctx, name) {
        const r = await ctx.clients.xray.send(new GetGroupCommand({ GroupName: name }));
        return { filter: r.Group?.FilterExpression ?? "" };
      },
      async run(ctx, name, v) {
        await ctx.clients.xray.send(new UpdateGroupCommand({ GroupName: name, FilterExpression: String(v.filter) }));
        return { message: `Group ${name} updated.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    // The Default group can't be deleted (OG-9): the console offers no Delete for it.
    availableFor: (row) => !isDefault(row),
    async run(ctx, name) {
      if (name === "Default") throw new Error("The Default group can't be deleted.");
      await ctx.clients.xray.send(new DeleteGroupCommand({ GroupName: name }));
    },
  },
};

export const xrayService: ServiceDef = {
  id: "xray",
  name: "X-Ray",
  category: "Management & Governance",
  description: "Trace requests through distributed applications and see a map of the services they call.",
  resources: [traces, serviceMap, samplingRules, groups],
  notSupported: [],
};
