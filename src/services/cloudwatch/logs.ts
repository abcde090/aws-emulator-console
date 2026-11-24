/**
 * CloudWatch Logs: log groups with retention, log streams, metric filters and
 * subscription filters. The log events viewer is hand-built (LogEventsViewer.tsx).
 */

import {
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  DeleteLogGroupCommand,
  DeleteLogStreamCommand,
  DeleteMetricFilterCommand,
  DeleteRetentionPolicyCommand,
  DeleteSubscriptionFilterCommand,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  DescribeMetricFiltersCommand,
  DescribeSubscriptionFiltersCommand,
  ListTagsForResourceCommand,
  PutMetricFilterCommand,
  PutRetentionPolicyCommand,
  PutSubscriptionFilterCommand,
  TestMetricFilterCommand,
  type LogGroup,
} from "@aws-sdk/client-cloudwatch-logs";
import { ListKeysCommand, ListAliasesCommand } from "@aws-sdk/client-kms";
import { ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { ListStreamsCommand } from "@aws-sdk/client-kinesis";
import { ListDeliveryStreamsCommand } from "@aws-sdk/client-firehose";
import { ListRolesCommand } from "@aws-sdk/client-iam";
import type { Ctx, Option, ResourceDef, Row } from "../../console/types.ts";
import { secondary } from "../../console/secondary.ts";
import { retentionLabel, RETENTION_DAYS } from "./helpers.ts";

export const LOG_GROUP_NAME = "[A-Za-z0-9_./#-]{1,512}";
const FILTER_NAME = "[^:*]{1,512}";

export async function allLogGroups(ctx: Ctx): Promise<LogGroup[]> {
  const out: LogGroup[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.logs.send(new DescribeLogGroupsCommand({ nextToken: token }));
    out.push(...(r.logGroups ?? []));
    token = r.nextToken;
  } while (token && out.length < 5000);
  return out;
}

export async function logGroupOptions(ctx: Ctx): Promise<Option[]> {
  return (await allLogGroups(ctx)).filter((g) => g.logGroupName).map((g) => ({ value: g.logGroupName as string, label: g.logGroupName as string }));
}

async function findGroup(ctx: Ctx, name: string): Promise<LogGroup> {
  const r = await ctx.clients.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name }));
  const g = (r.logGroups ?? []).find((x) => x.logGroupName === name);
  if (!g) throw new Error(`ResourceNotFoundException: log group ${name} does not exist.`);
  return g;
}

/** Collects every page of a paginated list call. */
async function allPages<T>(page: (token: string | undefined) => Promise<{ items: T[]; next: string | undefined }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await page(token);
    out.push(...r.items);
    token = r.next;
  } while (token);
  return out;
}

async function kmsOptions(ctx: Ctx): Promise<Option[]> {
  const kms = ctx.clients.kms;
  const [keys, aliases] = await Promise.all([
    allPages(async (Marker) => {
      const r = await kms.send(new ListKeysCommand({ Marker }));
      return { items: r.Keys ?? [], next: r.Truncated ? r.NextMarker : undefined };
    }),
    allPages(async (Marker) => {
      const r = await kms.send(new ListAliasesCommand({ Marker }));
      return { items: r.Aliases ?? [], next: r.Truncated ? r.NextMarker : undefined };
    }),
  ]);
  return keys
    .filter((k) => k.KeyArn)
    .map((k) => {
      const alias = aliases.find((a) => a.TargetKeyId === k.KeyId)?.AliasName;
      return { value: k.KeyArn as string, label: alias ? `${alias} (${k.KeyId})` : (k.KeyId ?? (k.KeyArn as string)) };
    });
}

async function destinationOptions(ctx: Ctx): Promise<Option[]> {
  const [fns, streams, firehose] = await Promise.all([
    allPages(async (Marker) => {
      const r = await ctx.clients.lambda.send(new ListFunctionsCommand({ Marker }));
      return { items: r.Functions ?? [], next: r.NextMarker };
    }),
    allPages(async (NextToken) => {
      const r = await ctx.clients.kinesis.send(new ListStreamsCommand({ NextToken }));
      return { items: r.StreamSummaries ?? [], next: r.HasMoreStreams ? r.NextToken : undefined };
    }),
    allPages(async (start) => {
      const r = await ctx.clients.firehose.send(new ListDeliveryStreamsCommand({ ExclusiveStartDeliveryStreamName: start }));
      const names = r.DeliveryStreamNames ?? [];
      return { items: names, next: r.HasMoreDeliveryStreams && names.length ? names[names.length - 1] : undefined };
    }),
  ]);
  return [
    ...fns.filter((f) => f.FunctionArn).map((f) => ({ value: f.FunctionArn as string, label: `Lambda: ${f.FunctionName}` })),
    ...streams.filter((s) => s.StreamARN).map((s) => ({ value: s.StreamARN as string, label: `Kinesis: ${s.StreamName}` })),
    ...firehose.map((n) => ({ value: `arn:aws:firehose:${ctx.region}:${ctx.accountId}:deliverystream/${n}`, label: `Firehose: ${n}` })),
  ];
}

async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const roles = await allPages(async (Marker) => {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker }));
    return { items: r.Roles ?? [], next: r.IsTruncated ? r.Marker : undefined };
  });
  return roles.filter((x) => x.Arn).map((x) => ({ value: x.Arn as string, label: x.RoleName ?? (x.Arn as string) }));
}

async function metricFilterOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  const filters = await allPages(async (nextToken) => {
    const r = await ctx.clients.logs.send(new DescribeMetricFiltersCommand({ logGroupName: name, nextToken }));
    return { items: r.metricFilters ?? [], next: r.nextToken };
  });
  return filters.filter((f) => f.filterName).map((f) => ({ value: f.filterName as string, label: f.filterName as string }));
}

async function subscriptionFilterOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  const r = await ctx.clients.logs.send(new DescribeSubscriptionFiltersCommand({ logGroupName: name }));
  return (r.subscriptionFilters ?? []).filter((f) => f.filterName).map((f) => ({ value: f.filterName as string, label: f.filterName as string }));
}

function groupRow(g: LogGroup): Row {
  return {
    name: g.logGroupName ?? "",
    logClass: g.logGroupClass ?? "STANDARD",
    retention: retentionLabel(g.retentionInDays),
    metricFilters: g.metricFilterCount ?? 0,
    storedBytes: g.storedBytes ?? null,
    kms: g.kmsKeyId ?? null,
    created: g.creationTime ? new Date(g.creationTime).toISOString() : null,
    arn: g.logGroupArn ?? g.arn ?? null,
  };
}

const RETENTION_OPTIONS: Option[] = [{ value: "0", label: "Never expire" }, ...RETENTION_DAYS.map((d) => ({ value: String(d), label: retentionLabel(d) }))];

export const logGroups: ResourceDef = {
  id: "log-groups",
  name: "Log groups",
  singular: "log group",
  idField: "name",
  nameField: "name",
  detailHref: "log-groups/{id}",
  description: "A log group holds log streams that share retention, monitoring and access settings.",
  emptyText: "No log groups. Create a log group, or let a service such as Lambda create one when it writes logs.",
  columns: [
    { key: "name", label: "Log group", kind: "link" },
    { key: "logClass", label: "Log class", kind: "text" },
    { key: "retention", label: "Retention", kind: "text" },
    { key: "metricFilters", label: "Metric filters", kind: "count" },
    { key: "storedBytes", label: "Stored bytes", kind: "bytes" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "kms", label: "KMS key ID", kind: "arn", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await allLogGroups(ctx)).map(groupRow);
  },

  async get(ctx, name) {
    const g = await findGroup(ctx, name);
    // Secondary reads: a denied one marks its tab unavailable instead of failing the page.
    const [streamsR, metricFiltersR, subsR, tagsR] = await Promise.all([
      secondary(ctx.clients.logs.send(new DescribeLogStreamsCommand({ logGroupName: name, orderBy: "LastEventTime", descending: true, limit: 50 })).then((r) => r.logStreams ?? [])),
      secondary(ctx.clients.logs.send(new DescribeMetricFiltersCommand({ logGroupName: name })).then((r) => r.metricFilters ?? [])),
      secondary(ctx.clients.logs.send(new DescribeSubscriptionFiltersCommand({ logGroupName: name })).then((r) => r.subscriptionFilters ?? [])),
      secondary(g.logGroupArn ? ctx.clients.logs.send(new ListTagsForResourceCommand({ resourceArn: g.logGroupArn })).then((r) => r.tags ?? {}) : Promise.resolve({} as Record<string, string>)),
    ]);
    const streams = streamsR.ok ? streamsR.value : [];
    const metricFilters = metricFiltersR.ok ? metricFiltersR.value : [];
    const subs = subsR.ok ? subsR.value : [];
    const tags = tagsR.ok ? tagsR.value : {};
    const unavailable = (r: { ok: boolean; error?: string }) => (r.ok ? undefined : `Unavailable: ${r.error}`);
    const row = groupRow(g);
    return {
      summary: {
        "Log group name": name,
        "Log class": row.logClass,
        Retention: row.retention,
        "Stored bytes": row.storedBytes,
        "Metric filters": row.metricFilters,
        "Subscription filters": subsR.ok ? subs.length : "Unavailable",
        "KMS key ID": row.kms,
        "Creation time": row.created,
        ARN: row.arn,
      },
      tabs: [
        {
          id: "streams",
          label: "Log streams",
          kind: "table",
          data: streams.map((s) => ({
            name: s.logStreamName ?? "",
            lastEvent: s.lastEventTimestamp ? new Date(s.lastEventTimestamp).toISOString() : null,
            firstEvent: s.firstEventTimestamp ? new Date(s.firstEventTimestamp).toISOString() : null,
            created: s.creationTime ? new Date(s.creationTime).toISOString() : null,
          })),
          columns: [
            { key: "name", label: "Log stream", kind: "text" },
            { key: "lastEvent", label: "Last event time", kind: "date" },
            { key: "firstEvent", label: "First event time", kind: "date" },
            { key: "created", label: "Creation time", kind: "date" },
          ],
          description: unavailable(streamsR) ?? "The 50 streams with the most recent events. Open Log events to read and filter them.",
          emptyText: "No log streams.",
        },
        {
          id: "metric-filters",
          label: "Metric filters",
          kind: "table",
          data: metricFilters.map((f) => ({
            name: f.filterName ?? "",
            pattern: f.filterPattern ?? "",
            metric: (f.metricTransformations ?? []).map((t) => `${t.metricNamespace}/${t.metricName} = ${t.metricValue}`).join(", "),
            created: f.creationTime ? new Date(f.creationTime).toISOString() : null,
          })),
          columns: [
            { key: "name", label: "Filter name", kind: "text" },
            { key: "pattern", label: "Filter pattern", kind: "code" },
            { key: "metric", label: "Metric", kind: "text" },
            { key: "created", label: "Creation time", kind: "date" },
          ],
          emptyText: "No metric filters. Use Actions > Create metric filter to turn log events into a metric.",
          description: unavailable(metricFiltersR),
        },
        {
          id: "subscription-filters",
          label: "Subscription filters",
          kind: "table",
          data: subs.map((f) => ({
            name: f.filterName ?? "",
            pattern: f.filterPattern ?? "",
            destination: f.destinationArn ?? null,
            distribution: f.distribution ?? null,
            role: f.roleArn ?? null,
          })),
          columns: [
            { key: "name", label: "Filter name", kind: "text" },
            { key: "pattern", label: "Filter pattern", kind: "code" },
            { key: "destination", label: "Destination ARN", kind: "arn" },
            { key: "distribution", label: "Distribution", kind: "text" },
            { key: "role", label: "Role ARN", kind: "arn" },
          ],
          emptyText: "No subscription filters. A log group can stream to Lambda, Kinesis or Firehose (two filters at most).",
          description: unavailable(subsR),
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          data: Object.entries(tags).map(([key, value]) => ({ key, value })),
          columns: [
            { key: "key", label: "Key", kind: "text" },
            { key: "value", label: "Value", kind: "text" },
          ],
          emptyText: "No tags.",
          description: unavailable(tagsR),
        },
      ],
    };
  },

  create: {
    title: "Create log group",
    fields: [
      { name: "name", label: "Log group name", kind: "text", required: true, section: "Log group details", placeholder: "/my-app/production", validate: { pattern: LOG_GROUP_NAME, message: "Letters, numbers and _ - / . #, up to 512 characters." } },
      { name: "retention", label: "Retention setting", kind: "select", section: "Log group details", default: "0", options: RETENTION_OPTIONS },
      {
        name: "logClass",
        label: "Log class",
        kind: "select",
        section: "Log group details",
        default: "STANDARD",
        options: [
          { value: "STANDARD", label: "Standard" },
          { value: "INFREQUENT_ACCESS", label: "Infrequent Access" },
        ],
        help: "Infrequent Access costs less to ingest but supports fewer features.",
      },
      { name: "kmsKeyId", label: "KMS key ARN", kind: "select", default: "", section: "Log group details", options: kmsOptions, help: "Encrypt log data with a customer managed key. The key policy must allow CloudWatch Logs." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const tags = Array.isArray(v.tags) ? Object.fromEntries((v.tags as { Key: string; Value: string }[]).map((t) => [t.Key, t.Value])) : undefined;
      await ctx.clients.logs.send(
        new CreateLogGroupCommand({
          logGroupName: name,
          kmsKeyId: typeof v.kmsKeyId === "string" && v.kmsKeyId !== "" ? v.kmsKeyId : undefined,
          logGroupClass: String(v.logClass ?? "STANDARD") as "STANDARD",
          tags: tags && Object.keys(tags).length ? tags : undefined,
        })
      );
      const days = Number(v.retention ?? 0);
      if (days > 0) await ctx.clients.logs.send(new PutRetentionPolicyCommand({ logGroupName: name, retentionInDays: days }));
      return name;
    },
  },

  actions: [
    {
      id: "edit-retention",
      label: "Edit retention setting",
      fields: [{ name: "retention", label: "Expire events after", kind: "select", required: true, default: "0", options: RETENTION_OPTIONS }],
      async initialValues(ctx, name) {
        return { retention: String((await findGroup(ctx, name)).retentionInDays ?? 0) };
      },
      async run(ctx, name, v) {
        const days = Number(v.retention);
        if (days > 0) await ctx.clients.logs.send(new PutRetentionPolicyCommand({ logGroupName: name, retentionInDays: days }));
        else await ctx.clients.logs.send(new DeleteRetentionPolicyCommand({ logGroupName: name }));
        return { message: `Retention for ${name} set to ${retentionLabel(days)}.` };
      },
    },
    {
      id: "create-stream",
      label: "Create log stream",
      fields: [{ name: "stream", label: "Log stream name", kind: "text", required: true, validate: { pattern: "[^:*]{1,512}", message: "Up to 512 characters, no : or *." } }],
      async run(ctx, name, v) {
        await ctx.clients.logs.send(new CreateLogStreamCommand({ logGroupName: name, logStreamName: String(v.stream) }));
        return { message: `Log stream ${String(v.stream)} created.` };
      },
    },
    {
      id: "delete-stream",
      label: "Delete log stream",
      danger: true,
      fields: [{ name: "stream", label: "Log stream name", kind: "text", required: true }],
      async run(ctx, name, v) {
        await ctx.clients.logs.send(new DeleteLogStreamCommand({ logGroupName: name, logStreamName: String(v.stream) }));
        return { message: `Log stream ${String(v.stream)} deleted.` };
      },
    },
    {
      id: "test-pattern",
      label: "Test filter pattern",
      fields: [
        { name: "pattern", label: "Filter pattern", kind: "text", required: true, placeholder: '{ $.level = "ERROR" }', help: "Terms, quoted phrases, JSON selectors or space-delimited patterns." },
        { name: "messages", label: "Log event messages", kind: "textarea", required: true, help: "One log event per line (up to 50)." },
      ],
      async run(ctx, _name, v) {
        const messages = String(v.messages).split("\n").filter((m) => m !== "").slice(0, 50);
        const r = await ctx.clients.logs.send(new TestMetricFilterCommand({ filterPattern: String(v.pattern), logEventMessages: messages }));
        const rows = (r.matches ?? []).map((m) => ({ n: m.eventNumber ?? null, message: m.eventMessage ?? "", values: m.extractedValues ? JSON.stringify(m.extractedValues) : "" }));
        return {
          message: `${rows.length} of ${messages.length} events matched.`,
          table: {
            rowKey: "n",
            emptyText: "No events matched the pattern.",
            columns: [
              { key: "n", label: "Line", kind: "count" },
              { key: "message", label: "Event message", kind: "code" },
              { key: "values", label: "Extracted values", kind: "code" },
            ],
            rows,
          },
        };
      },
    },
    {
      id: "create-metric-filter",
      label: "Create metric filter",
      fields: [
        { name: "pattern", label: "Filter pattern", kind: "text", required: true, placeholder: "ERROR" },
        { name: "filterName", label: "Filter name", kind: "text", required: true, validate: { pattern: FILTER_NAME, message: "Up to 512 characters, no : or *." } },
        { name: "namespace", label: "Metric namespace", kind: "text", required: true, placeholder: "MyApp" },
        { name: "metricName", label: "Metric name", kind: "text", required: true, placeholder: "ErrorCount" },
        { name: "metricValue", label: "Metric value", kind: "text", required: true, default: "1", help: "Published each time the pattern matches: a number, or a field like $.latency." },
        { name: "defaultValue", label: "Default value", kind: "number", help: "Published when no events match during a period." },
        {
          name: "unit",
          label: "Unit",
          kind: "select", default: "",
          options: ["Count", "Seconds", "Milliseconds", "Bytes", "Kilobytes", "Megabytes", "Percent", "None"].map((u) => ({ value: u, label: u })),
        },
      ],
      async run(ctx, name, v) {
        await ctx.clients.logs.send(
          new PutMetricFilterCommand({
            logGroupName: name,
            filterName: String(v.filterName),
            filterPattern: String(v.pattern),
            metricTransformations: [
              {
                metricNamespace: String(v.namespace),
                metricName: String(v.metricName),
                metricValue: String(v.metricValue),
                defaultValue: typeof v.defaultValue === "number" ? v.defaultValue : undefined,
                unit: typeof v.unit === "string" && v.unit !== "" ? (v.unit as "Count") : undefined,
              },
            ],
          })
        );
        return { message: `Metric filter ${String(v.filterName)} created.` };
      },
    },
    {
      id: "delete-metric-filter",
      label: "Delete metric filter",
      danger: true,
      fields: [{ name: "filterName", label: "Filter name", kind: "select", required: true, options: metricFilterOptions }],
      async run(ctx, name, v) {
        await ctx.clients.logs.send(new DeleteMetricFilterCommand({ logGroupName: name, filterName: String(v.filterName) }));
        return { message: `Metric filter ${String(v.filterName)} deleted.` };
      },
    },
    {
      id: "create-subscription-filter",
      label: "Create subscription filter",
      fields: [
        { name: "destination", label: "Destination", kind: "select", required: true, options: destinationOptions, help: "A Lambda function, Kinesis data stream or Firehose stream." },
        { name: "role", label: "IAM role", kind: "select", default: "", options: roleOptions, help: "Required for Kinesis and Firehose destinations: lets CloudWatch Logs put records." },
        { name: "filterName", label: "Subscription filter name", kind: "text", required: true, validate: { pattern: FILTER_NAME, message: "Up to 512 characters, no : or *." } },
        { name: "pattern", label: "Subscription filter pattern", kind: "text", help: "Leave empty to send every event." },
        {
          name: "distribution",
          label: "Distribution",
          kind: "select",
          default: "ByLogStream",
          options: [
            { value: "ByLogStream", label: "By log stream" },
            { value: "Random", label: "Random" },
          ],
          help: "Kinesis destinations only.",
        },
      ],
      async run(ctx, name, v) {
        await ctx.clients.logs.send(
          new PutSubscriptionFilterCommand({
            logGroupName: name,
            filterName: String(v.filterName),
            filterPattern: typeof v.pattern === "string" ? v.pattern : "",
            destinationArn: String(v.destination),
            roleArn: typeof v.role === "string" && v.role !== "" ? v.role : undefined,
            distribution: String(v.distribution ?? "ByLogStream") as "ByLogStream",
          })
        );
        return { message: `Subscription filter ${String(v.filterName)} created.` };
      },
    },
    {
      id: "delete-subscription-filter",
      label: "Delete subscription filter",
      danger: true,
      fields: [{ name: "filterName", label: "Subscription filter name", kind: "select", required: true, options: subscriptionFilterOptions }],
      async run(ctx, name, v) {
        await ctx.clients.logs.send(new DeleteSubscriptionFilterCommand({ logGroupName: name, filterName: String(v.filterName) }));
        return { message: `Subscription filter ${String(v.filterName)} deleted.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.logs.send(new DeleteLogGroupCommand({ logGroupName: name }));
    },
  },
};
