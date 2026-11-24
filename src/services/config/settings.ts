/** AWS Config Settings: the configuration recorder and its delivery channel. */

import {
  DeleteConfigurationRecorderCommand,
  DeleteDeliveryChannelCommand,
  DescribeConfigurationRecordersCommand,
  DescribeConfigurationRecorderStatusCommand,
  DescribeDeliveryChannelsCommand,
  DescribeDeliveryChannelStatusCommand,
  PutConfigurationRecorderCommand,
  PutDeliveryChannelCommand,
  StartConfigurationRecorderCommand,
  StopConfigurationRecorderCommand,
  type ConfigurationRecorder,
  type DeliveryChannel,
  type MaximumExecutionFrequency,
  type RecordingFrequency,
  type ResourceType,
} from "@aws-sdk/client-config-service";
import { ListRolesCommand, type Role } from "@aws-sdk/client-iam";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { ListTopicsCommand } from "@aws-sdk/client-sns";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

const RECORDABLE: string[] = [
  "AWS::S3::Bucket", "AWS::EC2::Instance", "AWS::EC2::SecurityGroup", "AWS::EC2::Volume", "AWS::EC2::VPC", "AWS::EC2::Subnet",
  "AWS::IAM::Role", "AWS::IAM::User", "AWS::IAM::Policy", "AWS::Lambda::Function", "AWS::DynamoDB::Table", "AWS::RDS::DBInstance",
  "AWS::SQS::Queue", "AWS::SNS::Topic", "AWS::KMS::Key", "AWS::CloudTrail::Trail",
];

export async function bucketOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.s3.send(new ListBucketsCommand({}));
  return (r.Buckets ?? []).filter((b) => b.Name).map((b) => ({ value: b.Name as string, label: b.Name as string }));
}

async function topicOptions(ctx: Ctx): Promise<Option[]> {
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.sns.send(new ListTopicsCommand({ NextToken: token }));
    for (const t of r.Topics ?? []) if (t.TopicArn) arns.push(t.TopicArn);
    token = r.NextToken || undefined;
  } while (token);
  return arns.map((arn) => ({ value: arn, label: arn.split(":").pop() ?? arn }));
}

export async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const roles: Role[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ MaxItems: 1000, Marker: marker }));
    roles.push(...(r.Roles ?? []));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return roles.filter((x) => x.Arn).map((x) => ({ value: x.Arn as string, label: x.RoleName ?? (x.Arn as string) }));
}

async function getRecorder(ctx: Ctx, name: string): Promise<ConfigurationRecorder> {
  const r = await ctx.clients.config.send(new DescribeConfigurationRecordersCommand({ ConfigurationRecorderNames: [name] }));
  const rec = r.ConfigurationRecorders?.[0];
  if (!rec) throw new Error(`NoSuchConfigurationRecorderException: no recorder ${name}.`);
  return rec;
}

async function getChannel(ctx: Ctx): Promise<DeliveryChannel | undefined> {
  return (await ctx.clients.config.send(new DescribeDeliveryChannelsCommand({}))).DeliveryChannels?.[0];
}

/** Recording state from a list row ("recording") or the detail summary ("Recording"). */
const recordingState = (row: Row): unknown => row.recording ?? row.Recording;

/** A secondary lookup that may fail on its own (denied, not set up) without failing the page. */
async function optional<T>(p: Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await p };
  } catch (err: unknown) {
    return { error: errorMessage(err) };
  }
}

const slr = (ctx: Ctx) => `arn:aws:iam::${ctx.accountId}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`;

const FREQUENCIES: Option[] = [
  { value: "One_Hour", label: "1 hour" }, { value: "Three_Hours", label: "3 hours" }, { value: "Six_Hours", label: "6 hours" },
  { value: "Twelve_Hours", label: "12 hours" }, { value: "TwentyFour_Hours", label: "24 hours" },
];

export const settings: ResourceDef = {
  id: "settings",
  name: "Settings",
  singular: "configuration recorder",
  idField: "name",
  nameField: "name",
  description: "The configuration recorder records resource changes; the delivery channel sends snapshots and history to S3.",
  emptyText: "AWS Config is not set up in this Region. Choose Set up AWS Config.",
  columns: [
    { key: "name", label: "Recorder name", kind: "link" },
    { key: "recording", label: "Recording", kind: "status" },
    { key: "strategy", label: "Recording strategy", kind: "text" },
    { key: "frequency", label: "Recording frequency", kind: "text" },
    { key: "bucket", label: "S3 bucket", kind: "text" },
    { key: "lastStatus", label: "Last status", kind: "status" },
  ],
  async list(ctx) {
    const [recs, status, channels] = await Promise.all([
      ctx.clients.config.send(new DescribeConfigurationRecordersCommand({})),
      optional(ctx.clients.config.send(new DescribeConfigurationRecorderStatusCommand({}))),
      optional(ctx.clients.config.send(new DescribeDeliveryChannelsCommand({}))),
    ]);
    return (recs.ConfigurationRecorders ?? []).map((r) => {
      const s = status.value?.ConfigurationRecordersStatus?.find((x) => x.name === r.name);
      return {
        name: r.name ?? "", recording: status.error ? "Unavailable" : s?.recording ? "Recording" : "Stopped", strategy: r.recordingGroup?.recordingStrategy?.useOnly ?? null,
        frequency: r.recordingMode?.recordingFrequency ?? null, bucket: channels.error ? "Unavailable" : channels.value?.DeliveryChannels?.[0]?.s3BucketName ?? null, lastStatus: s?.lastStatus ?? null,
      };
    });
  },
  async get(ctx, name) {
    const [recs, status, channels, chStatus] = await Promise.all([
      ctx.clients.config.send(new DescribeConfigurationRecordersCommand({ ConfigurationRecorderNames: [name] })),
      optional(ctx.clients.config.send(new DescribeConfigurationRecorderStatusCommand({ ConfigurationRecorderNames: [name] }))),
      optional(ctx.clients.config.send(new DescribeDeliveryChannelsCommand({}))),
      optional(ctx.clients.config.send(new DescribeDeliveryChannelStatusCommand({}))),
    ]);
    const r = recs.ConfigurationRecorders?.[0];
    const s = status.value?.ConfigurationRecordersStatus?.[0];
    const ch = channels.value?.DeliveryChannels?.[0];
    const chs = chStatus.value?.DeliveryChannelsStatus?.[0];
    return {
      summary: {
        "Recorder name": r?.name, Recording: status.error ? "Unavailable" : s?.recording ? "Recording" : "Stopped", ARN: r?.arn ?? null, "IAM role": r?.roleARN ?? null,
        "Recording strategy": r?.recordingGroup?.recordingStrategy?.useOnly ?? null, "Recording frequency": r?.recordingMode?.recordingFrequency ?? null,
      },
      tabs: [
        {
          id: "status", label: "Recorder status", kind: "keyvalue", emptyText: status.error ? `Unavailable: ${status.error}` : undefined,
          data: status.error ? {} : { Recording: s?.recording ?? null, "Last status": s?.lastStatus ?? null, "Last started": s?.lastStartTime ?? null, "Last stopped": s?.lastStopTime ?? null, "Last error": s?.lastErrorMessage ?? null },
        },
        {
          id: "recording", label: "Recording group", kind: "keyvalue",
          data: {
            "All supported resource types": r?.recordingGroup?.allSupported ?? null, "Include global resource types": r?.recordingGroup?.includeGlobalResourceTypes ?? null,
            "Resource types": (r?.recordingGroup?.resourceTypes ?? []).join(", ") || null, "Excluded resource types": (r?.recordingGroup?.exclusionByResourceTypes?.resourceTypes ?? []).join(", ") || null,
          },
        },
        {
          id: "delivery", label: "Delivery channel", kind: "keyvalue",
          data: ch
            ? {
                Name: ch.name ?? null, "S3 bucket": ch.s3BucketName ?? null, "S3 key prefix": ch.s3KeyPrefix ?? null, "SNS topic": ch.snsTopicARN ?? null, // gitleaks:allow (labels, not a key)
                "Snapshot frequency": ch.configSnapshotDeliveryProperties?.deliveryFrequency ?? null,
                "Next snapshot delivery": chs?.configSnapshotDeliveryInfo?.nextDeliveryTime ?? null, "Next history delivery": chs?.configHistoryDeliveryInfo?.nextDeliveryTime ?? null,
                "Last history delivery status": chs?.configHistoryDeliveryInfo?.lastStatus ?? null,
              }
            : {},
          emptyText: channels.error ? `Unavailable: ${channels.error}` : "No delivery channel. The recorder can't start without one.",
        },
      ],
    };
  },
  create: {
    title: "Set up AWS Config",
    description: "Creates the configuration recorder (PutConfigurationRecorder) and delivery channel (PutDeliveryChannel), then starts recording. The bucket policy must let config.amazonaws.com read the bucket ACL and write objects.",
    fields: [
      { name: "name", label: "Recorder name", kind: "text", default: "default", required: true, section: "Recording method", validate: { pattern: "[\\w.-]{1,256}", message: "Letters, numbers, . _ or -." } },
      { name: "strategy", label: "Recording strategy", kind: "radio", default: "all", section: "Recording method", options: [{ value: "all", label: "All resource types with customizable overrides" }, { value: "specific", label: "Specific resource types" }] },
      { name: "includeGlobal", label: "Include globally recorded resource types (IAM users, groups, roles, policies)", kind: "checkbox", default: true, section: "Recording method", showIf: { field: "strategy", equals: "all" } },
      { name: "types", label: "Resource types", kind: "multiselect", section: "Recording method", options: RECORDABLE.map((t) => ({ value: t, label: t })), showIf: { field: "strategy", equals: "specific" } },
      { name: "frequency", label: "Default recording frequency", kind: "radio", default: "CONTINUOUS", section: "Recording method", options: [{ value: "CONTINUOUS", label: "Continuous recording" }, { value: "DAILY", label: "Daily recording" }] },
      { name: "roleMode", label: "IAM role for AWS Config", kind: "radio", default: "slr", section: "Data governance", options: [{ value: "slr", label: "Use the AWS Config service-linked role" }, { value: "existing", label: "Choose a role from your account" }] },
      { name: "role", label: "Existing role", kind: "select", required: true, section: "Data governance", options: roleOptions, showIf: { field: "roleMode", equals: "existing" } },
      { name: "bucket", label: "S3 bucket", kind: "select", required: true, section: "Delivery method", options: bucketOptions, help: "Config delivers configuration history and snapshots here." },
      { name: "prefix", label: "Prefix", kind: "text", section: "Delivery method" },
      { name: "topic", label: "SNS topic", kind: "select", section: "Delivery method", options: topicOptions, help: "Streams configuration changes and notifications." },
      { name: "snapshot", label: "Snapshot delivery frequency", kind: "select", default: "TwentyFour_Hours", section: "Delivery method", options: FREQUENCIES },
      { name: "start", label: "Start recording now", kind: "checkbox", default: true, section: "Delivery method" },
    ],
    async run(ctx, v) {
      const name = str(v.name);
      const specific = v.strategy === "specific";
      const types = Array.isArray(v.types) ? (v.types as string[]) : [];
      if (specific && types.length === 0) throw new Error("Choose at least one resource type, or record all resource types.");
      await ctx.clients.config.send(
        new PutConfigurationRecorderCommand({
          ConfigurationRecorder: {
            name, roleARN: v.roleMode === "existing" ? str(v.role) : slr(ctx),
            recordingGroup: specific
              ? { allSupported: false, includeGlobalResourceTypes: false, resourceTypes: types as ResourceType[], recordingStrategy: { useOnly: "INCLUSION_BY_RESOURCE_TYPES" } }
              : { allSupported: true, includeGlobalResourceTypes: v.includeGlobal === true, recordingStrategy: { useOnly: "ALL_SUPPORTED_RESOURCE_TYPES" } },
            recordingMode: { recordingFrequency: v.frequency === "DAILY" ? "DAILY" : "CONTINUOUS" },
          },
        })
      );
      await ctx.clients.config.send(
        new PutDeliveryChannelCommand({
          DeliveryChannel: {
            name: "default", s3BucketName: str(v.bucket), s3KeyPrefix: str(v.prefix) || undefined, snsTopicARN: str(v.topic) || undefined,
            configSnapshotDeliveryProperties: { deliveryFrequency: (str(v.snapshot) || "TwentyFour_Hours") as MaximumExecutionFrequency },
          },
        })
      );
      if (v.start === true) await ctx.clients.config.send(new StartConfigurationRecorderCommand({ ConfigurationRecorderName: name }));
      return name;
    },
  },
  actions: [
    {
      id: "start",
      label: "Start recording",
      availableFor: (row) => recordingState(row) !== "Recording",
      async run(ctx, name) {
        await ctx.clients.config.send(new StartConfigurationRecorderCommand({ ConfigurationRecorderName: name }));
        return { message: "Recording started." };
      },
    },
    {
      id: "stop",
      label: "Stop recording",
      danger: true,
      availableFor: (row) => recordingState(row) !== "Stopped",
      confirm: "AWS Config stops recording configuration changes. Rules can't evaluate changes while recording is off.",
      async run(ctx, name) {
        await ctx.clients.config.send(new StopConfigurationRecorderCommand({ ConfigurationRecorderName: name }));
        return { message: "Recording stopped." };
      },
    },
    {
      id: "edit-recording",
      label: "Edit recording frequency",
      fields: [{ name: "frequency", label: "Default recording frequency", kind: "radio", required: true, default: "CONTINUOUS", options: [{ value: "CONTINUOUS", label: "Continuous recording" }, { value: "DAILY", label: "Daily recording" }] }],
      async initialValues(ctx, name) {
        const rec = await getRecorder(ctx, name);
        return { frequency: rec.recordingMode?.recordingFrequency ?? "CONTINUOUS" };
      },
      async run(ctx, name, v) {
        const rec = await getRecorder(ctx, name);
        const frequency: RecordingFrequency = v.frequency === "DAILY" ? "DAILY" : "CONTINUOUS";
        if ((rec.recordingMode?.recordingFrequency ?? "CONTINUOUS") === frequency) return { message: "No changes to save." };
        // PutConfigurationRecorder replaces the recorder: send the current one back with only the frequency changed.
        await ctx.clients.config.send(new PutConfigurationRecorderCommand({ ConfigurationRecorder: { ...rec, arn: undefined, recordingMode: { ...rec.recordingMode, recordingFrequency: frequency } } }));
        return { message: `Recording frequency set to ${frequency}.` };
      },
    },
    {
      id: "edit-delivery",
      label: "Edit delivery channel",
      fields: [
        { name: "bucket", label: "S3 bucket", kind: "select", required: true, options: bucketOptions },
        { name: "prefix", label: "Prefix", kind: "text" },
        { name: "topic", label: "SNS topic", kind: "select", options: topicOptions },
        { name: "snapshot", label: "Snapshot delivery frequency", kind: "select", required: true, default: "TwentyFour_Hours", options: FREQUENCIES },
      ],
      async initialValues(ctx): Promise<FieldValues> {
        const ch = await getChannel(ctx);
        if (!ch) return {};
        return { bucket: ch.s3BucketName ?? "", prefix: ch.s3KeyPrefix ?? "", topic: ch.snsTopicARN ?? "", snapshot: ch.configSnapshotDeliveryProperties?.deliveryFrequency ?? "TwentyFour_Hours" };
      },
      async run(ctx, _name, v) {
        const ch = await getChannel(ctx);
        // PutDeliveryChannel replaces the channel: keep its name and every setting this form doesn't show.
        await ctx.clients.config.send(
          new PutDeliveryChannelCommand({
            DeliveryChannel: {
              ...ch, name: ch?.name ?? "default", s3BucketName: str(v.bucket), s3KeyPrefix: str(v.prefix) || undefined, snsTopicARN: str(v.topic) || undefined,
              configSnapshotDeliveryProperties: { deliveryFrequency: (str(v.snapshot) || "TwentyFour_Hours") as MaximumExecutionFrequency },
            },
          })
        );
        return { message: "Delivery channel saved." };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.config.send(new StopConfigurationRecorderCommand({ ConfigurationRecorderName: name }));
      const channels = await ctx.clients.config.send(new DescribeDeliveryChannelsCommand({}));
      for (const ch of channels.DeliveryChannels ?? []) {
        if (ch.name) await ctx.clients.config.send(new DeleteDeliveryChannelCommand({ DeliveryChannelName: ch.name }));
      }
      await ctx.clients.config.send(new DeleteConfigurationRecorderCommand({ ConfigurationRecorderName: name }));
    },
  },
};
