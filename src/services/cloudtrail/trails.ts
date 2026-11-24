/** CloudTrail trails: create (storage, encryption, validation, CloudWatch Logs, event types), start/stop logging, status, edit. */

import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import {
  AddTagsCommand,
  CreateTrailCommand,
  DeleteTrailCommand,
  DescribeTrailsCommand,
  GetEventSelectorsCommand,
  GetInsightSelectorsCommand,
  GetTrailStatusCommand,
  ListTagsCommand,
  PutEventSelectorsCommand,
  RemoveTagsCommand,
  PutInsightSelectorsCommand,
  StartLoggingCommand,
  StopLoggingCommand,
  UpdateTrailCommand,
  type AdvancedEventSelector,
  type EventSelector,
  type InsightType,
  type Trail,
} from "@aws-sdk/client-cloudtrail";
import { CreateLogGroupCommand, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { LogGroup } from "@aws-sdk/client-cloudwatch-logs";
import { ListRolesCommand, type Role } from "@aws-sdk/client-iam";
import { ListAliasesCommand, ListKeysCommand, type AliasListEntry, type KeyListEntry } from "@aws-sdk/client-kms";
import { CreateBucketCommand, ListBucketsCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";
import { ListTopicsCommand } from "@aws-sdk/client-sns";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { buildSelectors, DATA_RESOURCE_TYPES, selectorInput, selectorRows, trailBucketPolicy, trailChanges, type ReadWrite, type TrailSettings } from "./selectors.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const yesNo = (v: boolean | undefined) => (v ? "Yes" : "No");

async function bucketOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.s3.send(new ListBucketsCommand({}));
  return (r.Buckets ?? []).filter((b) => b.Name).map((b) => ({ value: b.Name as string, label: b.Name as string }));
}
/** Follows a paginated list call to the last page. */
async function allPages<T>(page: (token: string | undefined) => Promise<{ items?: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await page(token);
    out.push(...(r.items ?? []));
    token = r.next || undefined;
  } while (token);
  return out;
}

async function kmsOptions(ctx: Ctx): Promise<Option[]> {
  const [keys, aliases] = await Promise.all([
    allPages<KeyListEntry>(async (Marker) => {
      const r = await ctx.clients.kms.send(new ListKeysCommand({ Limit: 1000, Marker }));
      return { items: r.Keys, next: r.Truncated ? r.NextMarker : undefined };
    }),
    allPages<AliasListEntry>(async (Marker) => {
      const r = await ctx.clients.kms.send(new ListAliasesCommand({ Limit: 100, Marker }));
      return { items: r.Aliases, next: r.Truncated ? r.NextMarker : undefined };
    }),
  ]);
  const alias = new Map(aliases.filter((a) => a.TargetKeyId).map((a) => [a.TargetKeyId as string, a.AliasName ?? ""]));
  return keys.filter((k) => k.KeyArn && k.KeyId).map((k) => ({ value: k.KeyArn as string, label: alias.get(k.KeyId as string) ? `${alias.get(k.KeyId as string)} (${k.KeyId})` : (k.KeyId as string) }));
}
async function topicOptions(ctx: Ctx): Promise<Option[]> {
  const arns = await allPages<string>(async (NextToken) => {
    const r = await ctx.clients.sns.send(new ListTopicsCommand({ NextToken }));
    return { items: (r.Topics ?? []).map((t) => t.TopicArn ?? "").filter(Boolean), next: r.NextToken };
  });
  return arns.map((arn) => ({ value: arn, label: arn.split(":").pop() ?? "" }));
}
async function logGroupOptions(ctx: Ctx): Promise<Option[]> {
  const groups = await allPages<LogGroup>(async (nextToken) => {
    const r = await ctx.clients.logs.send(new DescribeLogGroupsCommand({ limit: 50, nextToken }));
    return { items: r.logGroups, next: r.nextToken };
  });
  return groups.filter((g) => g.logGroupName).map((g) => ({ value: g.logGroupName as string, label: g.logGroupName as string }));
}
async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const roles = await allPages<Role>(async (Marker) => {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ MaxItems: 1000, Marker }));
    return { items: r.Roles, next: r.IsTruncated ? r.Marker : undefined };
  });
  return roles.filter((x) => x.Arn).map((x) => ({ value: x.Arn as string, label: x.RoleName ?? (x.Arn as string) }));
}

/** Trail logging state from a list row ("status") or the detail summary ("Trail logging"). */
const loggingState = (row: Row): unknown => row.status ?? row["Trail logging"];

const logGroupName = (arn: string | undefined): string => arn?.split(":log-group:")[1]?.replace(/:\*$/, "") ?? "";

function currentSettings(t: Trail): TrailSettings {
  return { validation: t.LogFileValidationEnabled === true, multiRegion: t.IsMultiRegionTrail === true, kmsKey: t.KmsKeyId ?? "", sns: t.SnsTopicARN ?? "" };
}

async function trailTags(ctx: Ctx, t: Trail): Promise<Tag[]> {
  const r = await ctx.clients.cloudtrail.send(new ListTagsCommand({ ResourceIdList: [t.TrailARN ?? ""] }));
  return (r.ResourceTagList?.[0]?.TagsList ?? []).map((x) => ({ Key: x.Key ?? "", Value: x.Value ?? "" }));
}

async function eventValues(ctx: Ctx, name: string): Promise<FieldValues> {
  const r = await ctx.clients.cloudtrail.send(new GetEventSelectorsCommand({ TrailName: name }));
  const i = selectorInput(r.AdvancedEventSelectors, r.EventSelectors);
  return { management: i.management, readWrite: i.readWrite, excludeKms: i.excludeKms, excludeRdsData: i.excludeRdsData, dataTypes: i.dataTypes };
}

const logGroupArn = (ctx: Ctx, name: string) => `arn:aws:logs:${ctx.region}:${ctx.accountId}:log-group:${name}:*`;

async function getTrail(ctx: Ctx, name: string): Promise<Trail> {
  const r = await ctx.clients.cloudtrail.send(new DescribeTrailsCommand({ trailNameList: [name], includeShadowTrails: false }));
  const t = r.trailList?.[0];
  if (!t) throw new Error(`TrailNotFoundException: no trail named ${name}.`);
  return t;
}

const INSIGHT_OPTIONS: Option[] = [
  { value: "ApiCallRateInsight", label: "API call rate" },
  { value: "ApiErrorRateInsight", label: "API error rate" },
];

const eventFields = (section: string): FieldDef[] => [
  { name: "management", label: "Management events", kind: "checkbox", default: true, section, help: "Control plane operations, such as creating or deleting resources." },
  { name: "readWrite", label: "API activity", kind: "radio", default: "All", section, showIf: { field: "management", equals: true }, options: [{ value: "All", label: "Read and Write" }, { value: "ReadOnly", label: "Read" }, { value: "WriteOnly", label: "Write" }] },
  { name: "excludeKms", label: "Exclude AWS KMS events", kind: "checkbox", default: false, section, showIf: { field: "management", equals: true } },
  { name: "excludeRdsData", label: "Exclude Amazon RDS Data API events", kind: "checkbox", default: false, section, showIf: { field: "management", equals: true } },
  { name: "dataTypes", label: "Data events - resource types", kind: "multiselect", section, options: DATA_RESOURCE_TYPES, help: "Logs all data plane operations on these resource types (additional charges apply in AWS)." },
];

export const trails: ResourceDef = {
  id: "trails",
  name: "Trails",
  singular: "trail",
  idField: "name",
  nameField: "name",
  description: "Trails deliver CloudTrail events to an S3 bucket and, optionally, to CloudWatch Logs.",
  emptyText: "No trails. Create a trail to keep a record of events beyond the 90-day event history.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "homeRegion", label: "Home Region", kind: "text" },
    { key: "multiRegion", label: "Multi-Region trail", kind: "text" },
    { key: "insights", label: "Insights", kind: "text" },
    { key: "organization", label: "Organization trail", kind: "text" },
    { key: "bucket", label: "S3 bucket", kind: "text" },
    { key: "prefix", label: "Log file prefix", kind: "text" },
    { key: "logGroup", label: "CloudWatch Logs log group", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
  ],
  async list(ctx) {
    const r = await ctx.clients.cloudtrail.send(new DescribeTrailsCommand({ includeShadowTrails: true }));
    return Promise.all(
      (r.trailList ?? []).map(async (t) => {
        // Status is a secondary lookup: a denied call shows "Unavailable" for this trail only.
        const s = await ctx.clients.cloudtrail.send(new GetTrailStatusCommand({ Name: t.TrailARN ?? t.Name })).catch(() => null);
        return {
          name: t.Name ?? "", homeRegion: t.HomeRegion ?? null, multiRegion: yesNo(t.IsMultiRegionTrail), insights: t.HasInsightSelectors ? "Enabled" : "Disabled",
          organization: yesNo(t.IsOrganizationTrail), bucket: t.S3BucketName ?? null, prefix: t.S3KeyPrefix ?? null,
          logGroup: logGroupName(t.CloudWatchLogsLogGroupArn) || null, status: !s ? "Unavailable" : s.IsLogging ? "Logging" : "Stopped",
        };
      })
    );
  },
  async get(ctx, name) {
    const t = await getTrail(ctx, name);
    // Secondary lookups: a denied call marks its own tab unavailable instead of failing the page.
    const [statusR, selectorsR, tagsR, insightsR] = await Promise.allSettled([
      ctx.clients.cloudtrail.send(new GetTrailStatusCommand({ Name: name })),
      ctx.clients.cloudtrail.send(new GetEventSelectorsCommand({ TrailName: name })),
      trailTags(ctx, t),
      t.HasInsightSelectors ? ctx.clients.cloudtrail.send(new GetInsightSelectorsCommand({ TrailName: name })) : Promise.resolve(null),
    ]);
    const failed = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? `Unavailable: ${errorMessage(r.reason)}` : undefined);
    const status = statusR.status === "fulfilled" ? statusR.value : null;
    const selectors: { AdvancedEventSelectors?: AdvancedEventSelector[]; EventSelectors?: EventSelector[] } = selectorsR.status === "fulfilled" ? selectorsR.value : {};
    const insights = insightsR.status === "fulfilled" ? insightsR.value : null;
    return {
      summary: {
        "Trail name": t.Name, "Trail logging": !status ? "Unavailable" : status.IsLogging ? "Logging" : "Stopped", "Trail ARN": t.TrailARN, "Multi-Region trail": yesNo(t.IsMultiRegionTrail),
        "Apply trail to my organization": yesNo(t.IsOrganizationTrail), "Trail log location": `${t.S3BucketName ?? "-"}/${t.S3KeyPrefix ? `${t.S3KeyPrefix}/` : ""}AWSLogs/${ctx.accountId}`,
        "Log file validation": t.LogFileValidationEnabled ? "Enabled" : "Disabled", "Log file SSE-KMS encryption": t.KmsKeyId ? "Enabled" : "Disabled",
        "AWS KMS key": t.KmsKeyId ?? null, "SNS notification delivery": t.SnsTopicARN ?? "Disabled", "Include global service events": yesNo(t.IncludeGlobalServiceEvents),
      },
      tabs: [
        {
          id: "status", label: "Logging status", kind: "keyvalue", emptyText: failed(statusR),
          data: !status ? {} : {
            "Is logging": status.IsLogging ?? false, "Logging started": status.StartLoggingTime ?? null, "Logging stopped": status.StopLoggingTime ?? null,
            "Last log file delivered": status.LatestDeliveryTime ?? null, "Last delivery error": status.LatestDeliveryError || null,
            "Last digest delivered": status.LatestDigestDeliveryTime ?? null, "Last CloudWatch Logs delivery": status.LatestCloudWatchLogsDeliveryTime ?? null,
            "Last CloudWatch Logs error": status.LatestCloudWatchLogsDeliveryError || null,
          },
        },
        {
          id: "cloudwatch", label: "CloudWatch Logs", kind: "keyvalue",
          data: t.CloudWatchLogsLogGroupArn ? { "Log group": t.CloudWatchLogsLogGroupArn, "IAM role": t.CloudWatchLogsRoleArn ?? null } : {},
          emptyText: "CloudWatch Logs is not configured. Use Actions > Edit CloudWatch Logs.",
        },
        {
          id: "events", label: "Event selectors", kind: "table",
          columns: [{ key: "name", label: "Selector", kind: "text" }, { key: "conditions", label: "Conditions", kind: "code" }],
          data: selectors.AdvancedEventSelectors?.length
            ? selectorRows(selectors.AdvancedEventSelectors)
            : (selectors.EventSelectors ?? []).map((s, i) => ({ name: `Basic selector ${i + 1}`, conditions: `Management events: ${s.IncludeManagementEvents ? "yes" : "no"}; read/write: ${s.ReadWriteType ?? "All"}; data resources: ${(s.DataResources ?? []).map((d) => `${d.Type}`).join(", ") || "none"}` })),
          emptyText: failed(selectorsR) ?? "No event selectors.",
        },
        { id: "insights", label: "Insights events", kind: "table", columns: [{ key: "InsightType", label: "Insight type", kind: "text" }], data: insights?.InsightSelectors ?? [], emptyText: failed(insightsR) ?? "Insights events are not enabled." },
        {
          id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }],
          data: tagsR.status === "fulfilled" ? tagsR.value : [], emptyText: failed(tagsR) ?? "No tags.",
        },
      ],
    };
  },
  create: {
    title: "Create trail",
    description: "Creates the trail with CreateTrail, sets its event selectors, and starts logging, as the CloudTrail console does.",
    fields: [
      { name: "name", label: "Trail name", kind: "text", required: true, section: "General details", help: "3-128 characters: letters, numbers, periods, underscores and dashes.", validate: { pattern: "[A-Za-z0-9][A-Za-z0-9._-]{1,126}[A-Za-z0-9]", message: "3-128 letters, numbers, . _ or -, starting and ending with a letter or number." } },
      { name: "multiRegion", label: "Enable for all Regions (multi-Region trail)", kind: "checkbox", default: true, section: "General details" },
      { name: "storage", label: "Storage location", kind: "radio", default: "new", section: "General details", options: [{ value: "new", label: "Create new S3 bucket" }, { value: "existing", label: "Use existing S3 bucket" }] },
      { name: "newBucket", label: "Trail log bucket name", kind: "text", required: true, section: "General details", showIf: { field: "storage", equals: "new" }, help: "The console creates the bucket and adds the policy CloudTrail needs.", validate: { pattern: "[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", message: "3-63 lowercase letters, numbers, dots and hyphens." } },
      { name: "bucket", label: "Trail log bucket", kind: "select", required: true, section: "General details", options: bucketOptions, showIf: { field: "storage", equals: "existing" }, help: "Its bucket policy must allow cloudtrail.amazonaws.com to check the ACL and write logs." },
      { name: "prefix", label: "Prefix", kind: "text", section: "General details" },
      { name: "kmsKey", label: "Log file SSE-KMS encryption: AWS KMS key", kind: "select", section: "General details", options: kmsOptions, help: "Leave empty to use SSE-S3." },
      { name: "validation", label: "Log file validation", kind: "checkbox", default: true, section: "General details", help: "Writes signed digest files so you can prove logs weren't changed." },
      { name: "sns", label: "SNS notification delivery", kind: "select", section: "General details", options: topicOptions },
      { name: "cwl", label: "CloudWatch Logs", kind: "checkbox", default: false, section: "CloudWatch Logs" },
      { name: "logGroupMode", label: "Log group", kind: "radio", default: "new", section: "CloudWatch Logs", showIf: { field: "cwl", equals: true }, options: [{ value: "new", label: "New" }, { value: "existing", label: "Existing" }] },
      { name: "newLogGroup", label: "Log group name", kind: "text", section: "CloudWatch Logs", showIf: { field: "logGroupMode", equals: "new" }, placeholder: "aws-cloudtrail-logs" },
      { name: "logGroup", label: "Existing log group", kind: "select", section: "CloudWatch Logs", options: logGroupOptions, showIf: { field: "logGroupMode", equals: "existing" } },
      { name: "cwlRole", label: "IAM role", kind: "select", section: "CloudWatch Logs", options: roleOptions, showIf: { field: "cwl", equals: true }, help: "CloudTrail assumes this role to call CreateLogStream and PutLogEvents." },
      ...eventFields("Events"),
      { name: "insights", label: "Insights events", kind: "multiselect", section: "Events", options: INSIGHT_OPTIONS, help: "Detects unusual API call or error rates in write management events." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = str(v.name);
      const prefix = str(v.prefix) || undefined;
      const selectors = buildSelectors({ management: v.management === true, readWrite: (str(v.readWrite) || "All") as ReadWrite, excludeKms: v.excludeKms === true, excludeRdsData: v.excludeRdsData === true, dataTypes: Array.isArray(v.dataTypes) ? (v.dataTypes as string[]) : [] });
      let bucket = str(v.bucket);
      if (v.storage !== "existing") {
        bucket = str(v.newBucket);
        await ctx.clients.s3.send(new CreateBucketCommand({ Bucket: bucket }));
        await ctx.clients.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: trailBucketPolicy(bucket, ctx.accountId, ctx.region, name, prefix ?? "") }));
      }
      let cwlGroup: string | undefined;
      if (v.cwl === true) {
        if (!str(v.cwlRole)) throw new Error("Choose an IAM role for CloudWatch Logs.");
        if (v.logGroupMode === "existing") cwlGroup = str(v.logGroup);
        else {
          cwlGroup = str(v.newLogGroup) || `aws-cloudtrail-logs-${ctx.accountId}`;
          await ctx.clients.logs.send(new CreateLogGroupCommand({ logGroupName: cwlGroup }));
        }
        if (!cwlGroup) throw new Error("Choose a log group.");
      }
      const tags = Array.isArray(v.tags) ? (v.tags as { Key: string; Value: string }[]) : [];
      await ctx.clients.cloudtrail.send(
        new CreateTrailCommand({
          Name: name, S3BucketName: bucket, S3KeyPrefix: prefix, IsMultiRegionTrail: v.multiRegion === true, IncludeGlobalServiceEvents: true,
          EnableLogFileValidation: v.validation === true, KmsKeyId: str(v.kmsKey) || undefined, SnsTopicName: str(v.sns) || undefined,
          CloudWatchLogsLogGroupArn: cwlGroup ? logGroupArn(ctx, cwlGroup) : undefined, CloudWatchLogsRoleArn: cwlGroup ? str(v.cwlRole) : undefined,
          TagsList: tags.length ? tags : undefined,
        })
      );
      await ctx.clients.cloudtrail.send(new PutEventSelectorsCommand({ TrailName: name, AdvancedEventSelectors: selectors }));
      const insights = Array.isArray(v.insights) ? (v.insights as string[]) : [];
      if (insights.length) await ctx.clients.cloudtrail.send(new PutInsightSelectorsCommand({ TrailName: name, InsightSelectors: insights.map((i) => ({ InsightType: i as InsightType })) }));
      await ctx.clients.cloudtrail.send(new StartLoggingCommand({ Name: name }));
      return name;
    },
  },
  actions: [
    {
      id: "start",
      label: "Start logging",
      availableFor: (row) => loggingState(row) !== "Logging",
      async run(ctx, name) {
        await ctx.clients.cloudtrail.send(new StartLoggingCommand({ Name: name }));
        return { message: "Logging started." };
      },
    },
    {
      id: "stop",
      label: "Stop logging",
      danger: true,
      availableFor: (row) => loggingState(row) !== "Stopped",
      confirm: "CloudTrail stops delivering this trail's events. Event history still records management events.",
      async run(ctx, name) {
        await ctx.clients.cloudtrail.send(new StopLoggingCommand({ Name: name }));
        return { message: "Logging stopped." };
      },
    },
    {
      id: "general",
      label: "Edit general details",
      fields: [
        { name: "validation", label: "Log file validation", kind: "checkbox", default: false },
        { name: "kmsKey", label: "Log file SSE-KMS encryption: AWS KMS key", kind: "select", options: kmsOptions, help: "Empty means SSE-S3 (no KMS key)." },
        { name: "sns", label: "SNS notification delivery", kind: "select", options: topicOptions, help: "Empty means no SNS notifications." },
        { name: "multiRegion", label: "Multi-Region trail", kind: "checkbox", default: false },
      ],
      async initialValues(ctx, name) {
        const c = currentSettings(await getTrail(ctx, name));
        return { validation: c.validation, kmsKey: c.kmsKey, sns: c.sns, multiRegion: c.multiRegion };
      },
      async run(ctx, name, v) {
        const t = await getTrail(ctx, name);
        const change = trailChanges(currentSettings(t), { validation: v.validation === true, multiRegion: v.multiRegion === true, kmsKey: str(v.kmsKey), sns: str(v.sns) });
        if (Object.keys(change).length === 0) return { message: "No changes to save." };
        await ctx.clients.cloudtrail.send(new UpdateTrailCommand({ Name: name, ...change }));
        return { message: "Trail updated." };
      },
    },
    {
      id: "cloudwatch",
      label: "Edit CloudWatch Logs",
      fields: [
        { name: "enabled", label: "CloudWatch Logs", kind: "checkbox", default: false, help: "Also send this trail's events to a CloudWatch Logs log group." },
        { name: "logGroup", label: "Log group", kind: "select", required: true, options: logGroupOptions, showIf: { field: "enabled", equals: true } },
        { name: "role", label: "IAM role", kind: "select", required: true, options: roleOptions, showIf: { field: "enabled", equals: true }, help: "CloudTrail assumes this role to write to the log group." },
      ],
      async initialValues(ctx, name): Promise<FieldValues> {
        const t = await getTrail(ctx, name);
        return t.CloudWatchLogsLogGroupArn ? { enabled: true, logGroup: logGroupName(t.CloudWatchLogsLogGroupArn), role: t.CloudWatchLogsRoleArn ?? "" } : { enabled: false };
      },
      async run(ctx, name, v) {
        const t = await getTrail(ctx, name);
        const wasOn = Boolean(t.CloudWatchLogsLogGroupArn);
        if (v.enabled !== true) {
          if (!wasOn) return { message: "No changes to save." };
          // Empty values remove the CloudWatch Logs delivery (UpdateTrail).
          await ctx.clients.cloudtrail.send(new UpdateTrailCommand({ Name: name, CloudWatchLogsLogGroupArn: "", CloudWatchLogsRoleArn: "" }));
          return { message: "CloudWatch Logs delivery turned off." };
        }
        if (wasOn && logGroupName(t.CloudWatchLogsLogGroupArn ?? "") === str(v.logGroup) && (t.CloudWatchLogsRoleArn ?? "") === str(v.role)) return { message: "No changes to save." };
        await ctx.clients.cloudtrail.send(new UpdateTrailCommand({ Name: name, CloudWatchLogsLogGroupArn: logGroupArn(ctx, str(v.logGroup)), CloudWatchLogsRoleArn: str(v.role) }));
        return { message: `Events now also go to CloudWatch Logs log group ${str(v.logGroup)}.` };
      },
    },
    {
      id: "events",
      label: "Edit event types",
      fields: eventFields(""),
      initialValues: eventValues,
      async run(ctx, name, v) {
        const selectors = buildSelectors({ management: v.management === true, readWrite: (str(v.readWrite) || "All") as ReadWrite, excludeKms: v.excludeKms === true, excludeRdsData: v.excludeRdsData === true, dataTypes: Array.isArray(v.dataTypes) ? (v.dataTypes as string[]) : [] });
        await ctx.clients.cloudtrail.send(new PutEventSelectorsCommand({ TrailName: name, AdvancedEventSelectors: selectors }));
        return { message: `Saved ${selectors.length} event selector${selectors.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "insights",
      label: "Edit Insights events",
      fields: [{ name: "insights", label: "Insights types", kind: "multiselect", options: INSIGHT_OPTIONS, help: "Choose none to turn Insights off." }],
      async initialValues(ctx, name) {
        const t = await getTrail(ctx, name);
        if (!t.HasInsightSelectors) return { insights: [] };
        const r = await ctx.clients.cloudtrail.send(new GetInsightSelectorsCommand({ TrailName: name }));
        return { insights: (r.InsightSelectors ?? []).map((i) => i.InsightType ?? "").filter(Boolean) };
      },
      async run(ctx, name, v) {
        const types = Array.isArray(v.insights) ? (v.insights as string[]) : [];
        await ctx.clients.cloudtrail.send(new PutInsightSelectorsCommand({ TrailName: name, InsightSelectors: types.map((i) => ({ InsightType: i as InsightType })) }));
        return { message: types.length ? `Insights enabled: ${types.join(", ")}.` : "Insights disabled." };
      },
    },
    {
      id: "tag",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags" }],
      async initialValues(ctx, name) {
        return { tags: await trailTags(ctx, await getTrail(ctx, name)) };
      },
      async run(ctx, name, v) {
        const t = await getTrail(ctx, name);
        const current = await trailTags(ctx, t);
        const diff = tagDiff(current, fieldTags(v.tags));
        if (diff.remove.length) await ctx.clients.cloudtrail.send(new RemoveTagsCommand({ ResourceId: t.TrailARN, TagsList: diff.remove.map((Key) => ({ Key })) }));
        if (diff.set.length) await ctx.clients.cloudtrail.send(new AddTagsCommand({ ResourceId: t.TrailARN, TagsList: diff.set }));
        return { message: tagDiffMessage(diff) };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.cloudtrail.send(new DeleteTrailCommand({ Name: name }));
    },
  },
};
