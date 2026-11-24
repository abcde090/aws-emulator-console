/**
 * CloudWatch alarms: metric alarms (static threshold or anomaly detection band) and
 * composite alarms, with history, state changes and action toggles.
 */

import {
  type ComparisonOperator,
  DeleteAlarmsCommand,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
  DisableAlarmActionsCommand,
  EnableAlarmActionsCommand,
  ListTagsForResourceCommand,
  PutCompositeAlarmCommand,
  PutMetricAlarmCommand,
  SetAlarmStateCommand,
  type CompositeAlarm,
  type MetricAlarm,
  type PutCompositeAlarmCommandInput,
  type PutMetricAlarmCommandInput,
} from "@aws-sdk/client-cloudwatch";
import { ListTopicsCommand } from "@aws-sdk/client-sns";
import type { Ctx, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { secondary } from "../../console/secondary.ts";
import { arnTail, dimensionsLabel, parseDimensions, PERIODS, STATISTICS } from "./helpers.ts";

const ALARM_NAME = "[^\\u0000-\\u001f]{1,255}";

const COMPARISONS: Option[] = [
  { value: "GreaterThanThreshold", label: "Greater > threshold" },
  { value: "GreaterThanOrEqualToThreshold", label: "Greater/Equal >= threshold" },
  { value: "LessThanOrEqualToThreshold", label: "Lower/Equal <= threshold" },
  { value: "LessThanThreshold", label: "Lower < threshold" },
];

const BAND_COMPARISONS: Option[] = [
  { value: "LessThanLowerOrGreaterThanUpperThreshold", label: "Outside of the band (greater than the band or lower than the band)" },
  { value: "GreaterThanUpperThreshold", label: "Greater than the band" },
  { value: "LessThanLowerThreshold", label: "Lower than the band" },
];

const MISSING: Option[] = [
  { value: "missing", label: "Treat missing data as missing" },
  { value: "notBreaching", label: "Treat missing data as good (not breaching threshold)" },
  { value: "breaching", label: "Treat missing data as bad (breaching threshold)" },
  { value: "ignore", label: "Treat missing data as ignore (maintain the alarm state)" },
];

async function topicOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.sns.send(new ListTopicsCommand({ NextToken: token }));
    for (const t of r.Topics ?? []) if (t.TopicArn) out.push({ value: t.TopicArn, label: arnTail(t.TopicArn) });
    token = r.NextToken;
  } while (token);
  return out;
}

async function allAlarms(ctx: Ctx, names?: string[]): Promise<{ metric: MetricAlarm[]; composite: CompositeAlarm[] }> {
  const metric: MetricAlarm[] = [];
  const composite: CompositeAlarm[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: names, AlarmTypes: ["MetricAlarm", "CompositeAlarm"], NextToken: token }));
    metric.push(...(r.MetricAlarms ?? []));
    composite.push(...(r.CompositeAlarms ?? []));
    token = r.NextToken;
  } while (token);
  return { metric, composite };
}

function metricConditions(a: MetricAlarm): string {
  const op = COMPARISONS.find((c) => c.value === a.ComparisonOperator)?.label.split(" ")[1] ?? a.ComparisonOperator ?? "";
  const subject = a.MetricName ?? (a.Metrics ?? []).find((m) => m.ReturnData !== false && m.Id !== a.ThresholdMetricId)?.Id ?? "metric";
  const what = a.ThresholdMetricId ? `${subject} outside the band (${a.ThresholdMetricId})` : `${subject} ${op} ${a.Threshold ?? ""}`;
  return `${what} for ${a.DatapointsToAlarm ?? a.EvaluationPeriods ?? 1} datapoints within ${a.EvaluationPeriods ?? 1}`;
}

function alarmRow(a: MetricAlarm | CompositeAlarm, type: "Metric alarm" | "Composite alarm"): Row {
  return {
    name: a.AlarmName ?? "",
    state: a.StateValue ?? null,
    lastStateUpdate: a.StateUpdatedTimestamp ?? null,
    conditions: type === "Metric alarm" ? metricConditions(a as MetricAlarm) : (a as CompositeAlarm).AlarmRule ?? null,
    actions: a.ActionsEnabled ? "Actions enabled" : "Actions disabled",
    type,
    arn: a.AlarmArn ?? null,
  };
}

function actionArns(v: FieldValues, key: string): string[] | undefined {
  const t = v[key];
  return typeof t === "string" && t !== "" ? [t] : undefined;
}

function checkName(v: FieldValues): string {
  const name = String(v.name ?? "").trim();
  if (name === "") throw new Error("Alarm name is required.");
  return name;
}

async function createMetricAlarm(ctx: Ctx, v: FieldValues): Promise<string> {
  const name = checkName(v);
  const namespace = String(v.namespace ?? "").trim();
  const metricName = String(v.metricName ?? "").trim();
  if (!namespace || !metricName) throw new Error("Choose the namespace and metric name to watch.");
  const dimensions = parseDimensions(String(v.dimensions ?? ""));
  const period = Number(v.period);
  const stat = String(v.statistic ?? "Average");
  const evaluation = typeof v.evaluationPeriods === "number" ? v.evaluationPeriods : 1;
  const datapoints = typeof v.datapointsToAlarm === "number" ? v.datapointsToAlarm : evaluation;
  if (datapoints > evaluation) throw new Error("Datapoints to alarm can't be more than the evaluation periods.");
  const common = {
    AlarmName: name,
    AlarmDescription: typeof v.description === "string" && v.description !== "" ? v.description : undefined,
    EvaluationPeriods: evaluation,
    DatapointsToAlarm: datapoints,
    TreatMissingData: String(v.missing ?? "missing"),
    AlarmActions: actionArns(v, "alarmTopic"),
    OKActions: actionArns(v, "okTopic"),
    InsufficientDataActions: actionArns(v, "insufficientTopic"),
    ActionsEnabled: true,
    Tags: Array.isArray(v.tags) ? (v.tags as { Key: string; Value: string }[]) : undefined,
  };
  if (v.thresholdType === "anomaly") {
    const width = typeof v.bandWidth === "number" ? v.bandWidth : 2;
    await ctx.clients.cloudwatch.send(
      new PutMetricAlarmCommand({
        ...common,
        ComparisonOperator: String(v.bandComparison ?? "LessThanLowerOrGreaterThanUpperThreshold") as ComparisonOperator,
        ThresholdMetricId: "ad1",
        Metrics: [
          { Id: "m1", ReturnData: true, MetricStat: { Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions }, Period: period, Stat: stat } },
          { Id: "ad1", Expression: `ANOMALY_DETECTION_BAND(m1, ${width})`, Label: `${metricName} (expected)`, ReturnData: true },
        ],
      })
    );
  } else {
    if (typeof v.threshold !== "number") throw new Error("Enter the threshold value.");
    const percentile = /^p\d/.test(stat);
    await ctx.clients.cloudwatch.send(
      new PutMetricAlarmCommand({
        ...common,
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: dimensions,
        Period: period,
        Statistic: percentile ? undefined : (stat as "Average"),
        ExtendedStatistic: percentile ? stat : undefined,
        ComparisonOperator: String(v.comparison ?? "GreaterThanThreshold") as ComparisonOperator,
        Threshold: v.threshold,
      })
    );
  }
  return name;
}

async function createCompositeAlarm(ctx: Ctx, v: FieldValues): Promise<string> {
  const name = checkName(v);
  const rule = String(v.alarmRule ?? "").trim();
  if (!rule) throw new Error('Enter the alarm rule, for example ALARM("cpu-high") AND ALARM("errors-high").');
  await ctx.clients.cloudwatch.send(
    new PutCompositeAlarmCommand({
      AlarmName: name,
      AlarmRule: rule,
      AlarmDescription: typeof v.description === "string" && v.description !== "" ? v.description : undefined,
      AlarmActions: actionArns(v, "alarmTopic"),
      OKActions: actionArns(v, "okTopic"),
      InsufficientDataActions: actionArns(v, "insufficientTopic"),
      ActionsEnabled: true,
      Tags: Array.isArray(v.tags) ? (v.tags as { Key: string; Value: string }[]) : undefined,
    })
  );
  return name;
}

async function oneAlarm(ctx: Ctx, name: string): Promise<{ metric?: MetricAlarm; composite?: CompositeAlarm }> {
  const r = await allAlarms(ctx, [name]);
  const metric = r.metric.find((a) => a.AlarmName === name);
  const composite = r.composite.find((a) => a.AlarmName === name);
  if (!metric && !composite) throw new Error(`ResourceNotFound: alarm ${name} does not exist.`);
  return { metric, composite };
}

const ACTION_KEYS = [
  { field: "alarmTopics", prop: "AlarmActions" },
  { field: "okTopics", prop: "OKActions" },
  { field: "insufficientTopics", prop: "InsufficientDataActions" },
] as const;

const isSnsArn = (arn: string): boolean => arn.startsWith("arn:aws:sns:");

/** SNS topics, plus the topics the alarm already notifies (even if they no longer exist). */
async function alarmTopicOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  const topics = await topicOptions(ctx);
  if (!name) return topics;
  const { metric, composite } = await oneAlarm(ctx, name);
  const a = (metric ?? composite) as MetricAlarm | CompositeAlarm;
  const current = ACTION_KEYS.flatMap((k) => a[k.prop] ?? []).filter(isSnsArn);
  const extra = [...new Set(current)].filter((arn) => !topics.some((t) => t.value === arn)).map((arn) => ({ value: arn, label: arnTail(arn) }));
  return [...topics, ...extra];
}

/** The alarm's own settings as a Put*Alarm request, so an edit changes only what the user edits. */
function metricAlarmInput(a: MetricAlarm) {
  return {
    AlarmName: a.AlarmName,
    AlarmDescription: a.AlarmDescription,
    ActionsEnabled: a.ActionsEnabled,
    OKActions: a.OKActions,
    AlarmActions: a.AlarmActions,
    InsufficientDataActions: a.InsufficientDataActions,
    MetricName: a.MetricName,
    Namespace: a.Namespace,
    Statistic: a.Statistic,
    ExtendedStatistic: a.ExtendedStatistic,
    Dimensions: a.Dimensions,
    Period: a.Period,
    Unit: a.Unit,
    EvaluationPeriods: a.EvaluationPeriods,
    DatapointsToAlarm: a.DatapointsToAlarm,
    Threshold: a.ThresholdMetricId ? undefined : a.Threshold,
    ComparisonOperator: a.ComparisonOperator,
    TreatMissingData: a.TreatMissingData,
    EvaluateLowSampleCountPercentile: a.EvaluateLowSampleCountPercentile,
    Metrics: a.Metrics,
    ThresholdMetricId: a.ThresholdMetricId,
  };
}

function compositeAlarmInput(a: CompositeAlarm) {
  return {
    AlarmName: a.AlarmName,
    AlarmRule: a.AlarmRule,
    AlarmDescription: a.AlarmDescription,
    ActionsEnabled: a.ActionsEnabled,
    OKActions: a.OKActions,
    AlarmActions: a.AlarmActions,
    InsufficientDataActions: a.InsufficientDataActions,
    ActionsSuppressor: a.ActionsSuppressor,
    ActionsSuppressorWaitPeriod: a.ActionsSuppressorWaitPeriod,
    ActionsSuppressorExtensionPeriod: a.ActionsSuppressorExtensionPeriod,
  };
}

/** The edited SNS topics for one state; the alarm's other (non-SNS) actions are kept. */
function editedActions(current: string[] | undefined, v: FieldValues, field: string): string[] {
  const topics = Array.isArray(v[field]) ? (v[field] as string[]) : [];
  return [...(current ?? []).filter((arn) => !isSnsArn(arn)), ...topics];
}

const isMetric = { field: "alarmType", equals: "metric" };
const isComposite = { field: "alarmType", equals: "composite" };
const isStatic = { field: "thresholdType", equals: "static" };
const isBand = { field: "thresholdType", equals: "anomaly" };

export const alarms: ResourceDef = {
  id: "alarms",
  name: "All alarms",
  singular: "alarm",
  idField: "name",
  nameField: "name",
  description: "Alarms watch a metric or other alarms and change state when a condition is met; each state change can notify an SNS topic.",
  emptyText: "No alarms. Create an alarm to watch a metric.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "state", label: "State", kind: "status" },
    { key: "lastStateUpdate", label: "Last state update (UTC)", kind: "date" },
    { key: "conditions", label: "Conditions", kind: "text" },
    { key: "actions", label: "Actions", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const r = await allAlarms(ctx);
    return [...r.metric.map((a) => alarmRow(a, "Metric alarm")), ...r.composite.map((a) => alarmRow(a, "Composite alarm"))];
  },

  async get(ctx, name) {
    const { metric, composite } = await oneAlarm(ctx, name);
    const a = (metric ?? composite) as MetricAlarm | CompositeAlarm;
    // Secondary reads: a denied one marks its tab unavailable instead of failing the page.
    const [historyR, tagsR] = await Promise.all([
      secondary(ctx.clients.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: name, AlarmTypes: ["CompositeAlarm", "MetricAlarm"], MaxRecords: 100, ScanBy: "TimestampDescending" })).then((r) => r.AlarmHistoryItems ?? [])),
      secondary(a.AlarmArn ? ctx.clients.cloudwatch.send(new ListTagsForResourceCommand({ ResourceARN: a.AlarmArn })).then((r) => r.Tags ?? []) : Promise.resolve([])),
    ]);
    const historyItems = historyR.ok ? historyR.value : [];
    const tagList = tagsR.ok ? tagsR.value : [];
    const actionRows = [
      ...(a.AlarmActions ?? []).map((arn) => ({ state: "In alarm", action: arn })),
      ...(a.OKActions ?? []).map((arn) => ({ state: "OK", action: arn })),
      ...(a.InsufficientDataActions ?? []).map((arn) => ({ state: "Insufficient data", action: arn })),
    ];
    const details: Row = metric
      ? {
          Namespace: metric.Namespace ?? null,
          "Metric name": metric.MetricName ?? null,
          Dimensions: metric.Dimensions ? dimensionsLabel(metric.Dimensions.map((d) => ({ Name: d.Name ?? "", Value: d.Value ?? "" }))) : null,
          Statistic: metric.Statistic ?? metric.ExtendedStatistic ?? null,
          "Period (seconds)": metric.Period ?? null,
          "Threshold type": metric.ThresholdMetricId ? "Anomaly detection" : "Static",
          Threshold: metric.ThresholdMetricId ? `Band ${metric.ThresholdMetricId}` : metric.Threshold ?? null,
          "Comparison operator": metric.ComparisonOperator ?? null,
          "Evaluation periods": metric.EvaluationPeriods ?? null,
          "Datapoints to alarm": metric.DatapointsToAlarm ?? metric.EvaluationPeriods ?? null,
          "Missing data treatment": metric.TreatMissingData ?? "missing",
          Description: metric.AlarmDescription ?? null,
        }
      : { "Alarm rule": composite?.AlarmRule ?? null, Description: composite?.AlarmDescription ?? null, "Actions suppressor": composite?.ActionsSuppressor ?? null,
          "Actions suppressed by": composite?.ActionsSuppressedBy ?? null,
          "Actions suppressed reason": composite?.ActionsSuppressedReason ?? null,
        };
    return {
      summary: {
        Name: a.AlarmName ?? name,
        Type: metric ? "Metric alarm" : "Composite alarm",
        State: a.StateValue ?? null,
        "State reason": a.StateReason ?? null,
        "Last state update": a.StateUpdatedTimestamp ?? null,
        Actions: a.ActionsEnabled ? "Enabled" : "Disabled",
        ARN: a.AlarmArn ?? null,
      },
      tabs: [
        { id: "details", label: "Details", kind: "keyvalue", data: details },
        ...(metric?.Metrics?.length ? [{ id: "math", label: "Metrics and expressions", kind: "json" as const, data: metric.Metrics }] : []),
        {
          id: "actions",
          label: "Actions",
          kind: "table",
          data: actionRows,
          columns: [
            { key: "state", label: "Alarm state trigger", kind: "text" },
            { key: "action", label: "Action", kind: "arn" },
          ],
          emptyText: "No actions. Add an SNS topic notification with Actions > Edit actions.",
        },
        {
          id: "history",
          label: "History",
          kind: "table",
          description: historyR.ok ? undefined : `Unavailable: ${historyR.error}`,
          data: historyItems.map((h) => ({ date: h.Timestamp ?? null, type: h.HistoryItemType ?? null, description: h.HistorySummary ?? null })),
          columns: [
            { key: "date", label: "Date", kind: "date" },
            { key: "type", label: "Type", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
          ],
          emptyText: "No history for this alarm.",
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          description: tagsR.ok ? undefined : `Unavailable: ${tagsR.error}`,
          data: tagList.map((t) => ({ key: t.Key ?? "", value: t.Value ?? "" })),
          columns: [
            { key: "key", label: "Key", kind: "text" },
            { key: "value", label: "Value", kind: "text" },
          ],
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create alarm",
    description: "Watch one metric against a threshold or an anomaly detection band, or combine other alarms into a composite alarm.",
    fields: [
      {
        name: "alarmType",
        label: "Alarm type",
        kind: "radio",
        section: "Alarm type",
        default: "metric",
        options: [
          { value: "metric", label: "Metric alarm - watches one metric or metric math expression" },
          { value: "composite", label: "Composite alarm - combines the states of other alarms with a rule" },
        ],
      },
      { name: "namespace", label: "Namespace", kind: "text", section: "Metric", required: true, showIf: isMetric, placeholder: "AWS/EC2", help: "For example AWS/EC2, AWS/Lambda, or a custom namespace." },
      { name: "metricName", label: "Metric name", kind: "text", section: "Metric", required: true, showIf: isMetric, placeholder: "CPUUtilization" },
      { name: "dimensions", label: "Dimensions", kind: "textarea", section: "Metric", showIf: isMetric, placeholder: "InstanceId=i-0123456789abcdef0", help: "One Name=Value per line. Must match the metric's dimensions exactly." },
      { name: "statistic", label: "Statistic", kind: "select", section: "Metric", showIf: isMetric, default: "Average", options: STATISTICS.map((s) => ({ value: s, label: s })) },
      { name: "period", label: "Period", kind: "select", section: "Metric", showIf: isMetric, default: "300", options: PERIODS.map((p) => ({ value: String(p.value), label: p.label })) },
      {
        name: "thresholdType",
        label: "Threshold type",
        kind: "radio",
        section: "Conditions",
        showIf: isMetric,
        default: "static",
        options: [
          { value: "static", label: "Static - use a value as a threshold" },
          { value: "anomaly", label: "Anomaly detection - use a band as a threshold" },
        ],
      },
      { name: "comparison", label: "Whenever the metric is...", kind: "select", section: "Conditions", showIf: isStatic, default: "GreaterThanThreshold", options: COMPARISONS },
      { name: "threshold", label: "than...", kind: "number", section: "Conditions", showIf: isStatic, help: "Define the threshold value." },
      { name: "bandComparison", label: "Whenever the metric is...", kind: "select", section: "Conditions", showIf: isBand, default: "LessThanLowerOrGreaterThanUpperThreshold", options: BAND_COMPARISONS },
      { name: "bandWidth", label: "Anomaly detection threshold", kind: "number", section: "Conditions", showIf: isBand, default: 2, help: "Standard deviations: a higher number makes a thicker band.", validate: { min: 0.1, max: 100, message: "Between 0.1 and 100." } },
      { name: "evaluationPeriods", label: "Evaluation periods", kind: "number", section: "Additional configuration", showIf: isMetric, default: 1, validate: { min: 1, max: 100, message: "Between 1 and 100." } },
      { name: "datapointsToAlarm", label: "Datapoints to alarm", kind: "number", section: "Additional configuration", showIf: isMetric, default: 1, help: "How many of the evaluation periods must breach to go to ALARM (M out of N).", validate: { min: 1, max: 100, message: "Between 1 and 100." } },
      { name: "missing", label: "Missing data treatment", kind: "select", section: "Additional configuration", showIf: isMetric, default: "missing", options: MISSING },
      { name: "alarmRule", label: "Conditions (alarm rule)", kind: "textarea", section: "Composite alarm conditions", showIf: isComposite, required: true, placeholder: 'ALARM("cpu-high") OR ALARM("errors-high")', help: "Use ALARM(), OK(), INSUFFICIENT_DATA() with AND, OR, NOT and parentheses." },
      { name: "alarmTopic", label: "In alarm: send a notification to", kind: "select", default: "", section: "Notification", options: topicOptions, help: "SNS topic notified when the alarm goes to ALARM." },
      { name: "okTopic", label: "OK: send a notification to", kind: "select", default: "", section: "Notification", options: topicOptions },
      { name: "insufficientTopic", label: "Insufficient data: send a notification to", kind: "select", default: "", section: "Notification", options: topicOptions },
      { name: "name", label: "Alarm name", kind: "text", section: "Name and description", required: true, validate: { pattern: ALARM_NAME, message: "Up to 255 printable characters." } },
      { name: "description", label: "Alarm description", kind: "textarea", section: "Name and description" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    run(ctx, v) {
      return v.alarmType === "composite" ? createCompositeAlarm(ctx, v) : createMetricAlarm(ctx, v);
    },
  },

  actions: [
    {
      id: "set-state",
      label: "Set alarm state",
      fields: [
        {
          name: "state",
          label: "State",
          kind: "radio",
          default: "ALARM",
          options: [
            { value: "OK", label: "OK" },
            { value: "ALARM", label: "In alarm" },
            { value: "INSUFFICIENT_DATA", label: "Insufficient data" },
          ],
        },
        { name: "reason", label: "State reason", kind: "text", required: true, default: "Set from the console to test actions", validate: { max: 1023, message: "At most 1,023 characters." } },
      ],
      async run(ctx, name, v) {
        await ctx.clients.cloudwatch.send(new SetAlarmStateCommand({ AlarmName: name, StateValue: String(v.state) as "OK", StateReason: String(v.reason) }));
        return { message: `Alarm ${name} set to ${String(v.state)}. It returns to its real state at the next evaluation.` };
      },
    },
    {
      id: "edit-actions",
      label: "Edit actions",
      fields: [
        { name: "alarmTopics", label: "In alarm: send a notification to", kind: "multiselect", options: alarmTopicOptions, help: "SNS topics notified when the alarm goes to ALARM." },
        { name: "okTopics", label: "OK: send a notification to", kind: "multiselect", options: alarmTopicOptions },
        { name: "insufficientTopics", label: "Insufficient data: send a notification to", kind: "multiselect", options: alarmTopicOptions },
        { name: "description", label: "Alarm description", kind: "textarea", validate: { max: 1024, message: "At most 1,024 characters." } },
      ],
      async initialValues(ctx, name) {
        const { metric, composite } = await oneAlarm(ctx, name);
        const a = (metric ?? composite) as MetricAlarm | CompositeAlarm;
        return {
          alarmTopics: (a.AlarmActions ?? []).filter(isSnsArn),
          okTopics: (a.OKActions ?? []).filter(isSnsArn),
          insufficientTopics: (a.InsufficientDataActions ?? []).filter(isSnsArn),
          description: a.AlarmDescription ?? "",
        };
      },
      async run(ctx, name, v) {
        const { metric, composite } = await oneAlarm(ctx, name);
        const a = (metric ?? composite) as MetricAlarm | CompositeAlarm;
        const edits = {
          AlarmActions: editedActions(a.AlarmActions, v, "alarmTopics"),
          OKActions: editedActions(a.OKActions, v, "okTopics"),
          InsufficientDataActions: editedActions(a.InsufficientDataActions, v, "insufficientTopics"),
          AlarmDescription: typeof v.description === "string" ? v.description : a.AlarmDescription,
        };
        if (metric) await ctx.clients.cloudwatch.send(new PutMetricAlarmCommand({ ...metricAlarmInput(metric), ...edits } as PutMetricAlarmCommandInput));
        else if (composite) await ctx.clients.cloudwatch.send(new PutCompositeAlarmCommand({ ...compositeAlarmInput(composite), ...edits } as PutCompositeAlarmCommandInput));
        return { message: `Actions saved for ${name}.` };
      },
    },
    {
      id: "disable-actions",
      label: "Disable actions",
      availableFor: (row) => row.actions !== "Actions disabled" && row.Actions !== "Disabled",
      async run(ctx, name) {
        await ctx.clients.cloudwatch.send(new DisableAlarmActionsCommand({ AlarmNames: [name] }));
        return { message: `Actions disabled for ${name}.` };
      },
    },
    {
      id: "enable-actions",
      label: "Enable actions",
      availableFor: (row) => row.actions !== "Actions enabled" && row.Actions !== "Enabled",
      async run(ctx, name) {
        await ctx.clients.cloudwatch.send(new EnableAlarmActionsCommand({ AlarmNames: [name] }));
        return { message: `Actions enabled for ${name}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: [name] }));
    },
  },
};
