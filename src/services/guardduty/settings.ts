/** GuardDuty Settings: the Region's detector (enable, suspend, protection plans, sample findings, disable). */

import {
  CreateDetectorCommand,
  CreateSampleFindingsCommand,
  DeleteDetectorCommand,
  GetDetectorCommand,
  ListDetectorsCommand,
  UpdateDetectorCommand,
  type DetectorFeature,
  type DetectorFeatureConfiguration,
  type FindingPublishingFrequency,
} from "@aws-sdk/client-guardduty";
import type { Ctx, Option, ResourceDef, Row } from "../../console/types.ts";
import { str, tagRecord, tagRows, TAG_COLUMNS } from "./detector.ts";
import { featureLabel } from "./helpers.ts";

const FREQUENCIES: Option[] = [
  { value: "FIFTEEN_MINUTES", label: "Update CloudWatch Events every 15 minutes" },
  { value: "ONE_HOUR", label: "Update CloudWatch Events every 1 hour" },
  { value: "SIX_HOURS", label: "Update CloudWatch Events every 6 hours (default)" },
];

/** Plans you can turn on or off. Foundational sources (CloudTrail, DNS, VPC flow logs) are always on. */
const PLANS: Option[] = [
  { value: "S3_DATA_EVENTS", label: "S3 Protection" },
  { value: "EKS_AUDIT_LOGS", label: "EKS Protection" },
  { value: "EBS_MALWARE_PROTECTION", label: "Malware Protection for EC2" },
  { value: "RDS_LOGIN_EVENTS", label: "RDS Protection" },
  { value: "LAMBDA_NETWORK_LOGS", label: "Lambda Protection" },
  { value: "RUNTIME_MONITORING", label: "Runtime Monitoring (EKS, ECS, EC2)" },
  { value: "EKS_RUNTIME_MONITORING", label: "EKS Runtime Monitoring (legacy; can't be on with Runtime Monitoring)" },
];

function planConfig(selected: unknown): DetectorFeatureConfiguration[] {
  const on = new Set(Array.isArray(selected) ? (selected as string[]) : []);
  return PLANS.map((p) => ({ Name: p.value as DetectorFeature, Status: on.has(p.value) ? "ENABLED" : "DISABLED" }));
}

async function enabledPlans(ctx: Ctx, id: string): Promise<string[]> {
  const d = await ctx.clients.guardduty.send(new GetDetectorCommand({ DetectorId: id }));
  const on = new Set<string>((d.Features ?? []).filter((f) => f.Status === "ENABLED").map((f) => f.Name ?? ""));
  return PLANS.map((p) => p.value).filter((v) => on.has(v));
}

/** The detector's status from a list row ("status") or the detail summary ("Status"). */
const detectorStatus = (row: Row): unknown => row.status ?? row.Status;

const frequency = (v: unknown): FindingPublishingFrequency => (v === "FIFTEEN_MINUTES" || v === "ONE_HOUR" ? v : "SIX_HOURS");

export const settings: ResourceDef = {
  id: "settings",
  name: "Settings",
  singular: "detector",
  idField: "id",
  nameField: "id",
  description: "GuardDuty uses one detector per Region. Enable it here; suspend or disable it from Actions.",
  emptyText: "GuardDuty is not enabled in this Region. Choose Enable GuardDuty to start monitoring.",
  columns: [
    { key: "id", label: "Detector ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "frequency", label: "Findings export frequency", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
    { key: "updated", label: "Updated", kind: "date" },
  ],
  async list(ctx) {
    const ids = (await ctx.clients.guardduty.send(new ListDetectorsCommand({}))).DetectorIds ?? [];
    return Promise.all(
      ids.map(async (id) => {
        const d = await ctx.clients.guardduty.send(new GetDetectorCommand({ DetectorId: id }));
        return { id, status: d.Status ?? null, frequency: d.FindingPublishingFrequency ?? null, created: d.CreatedAt ?? null, updated: d.UpdatedAt ?? null };
      })
    );
  },
  async get(ctx, id) {
    const d = await ctx.clients.guardduty.send(new GetDetectorCommand({ DetectorId: id }));
    return {
      summary: { "Detector ID": id, Status: d.Status, "Service role": d.ServiceRole, "Findings export frequency": d.FindingPublishingFrequency, Created: d.CreatedAt, Updated: d.UpdatedAt },
      tabs: [
        {
          id: "plans", label: "Protection plans", kind: "table",
          columns: [{ key: "plan", label: "Protection plan", kind: "text" }, { key: "name", label: "Feature", kind: "code" }, { key: "status", label: "Status", kind: "status" }, { key: "updated", label: "Updated", kind: "date" }],
          data: (d.Features ?? []).map((f) => ({ plan: featureLabel(f.Name), name: f.Name ?? "", status: f.Status ?? null, updated: f.UpdatedAt ?? null })),
          emptyText: "GetDetector returned no features.",
        },
        { id: "datasources", label: "Data sources", kind: "json", data: d.DataSources ?? null },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(d.Tags), emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Enable GuardDuty",
    description: "Creates this Region's detector with CreateDetector. GuardDuty starts analysing CloudTrail management events, VPC flow logs and DNS logs at once.",
    fields: [
      { name: "frequency", label: "Findings export frequency", kind: "select", default: "SIX_HOURS", options: FREQUENCIES, section: "Settings", help: "How often updates to existing findings are sent to EventBridge and S3. New findings are always sent within 5 minutes." },
      { name: "plans", label: "Protection plans", kind: "multiselect", default: ["S3_DATA_EVENTS", "EKS_AUDIT_LOGS", "EBS_MALWARE_PROTECTION", "RDS_LOGIN_EVENTS", "LAMBDA_NETWORK_LOGS"], options: PLANS, section: "Protection plans" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.guardduty.send(new CreateDetectorCommand({ Enable: true, FindingPublishingFrequency: frequency(v.frequency), Features: planConfig(v.plans), Tags: tagRecord(v.tags) }));
      if (!r.DetectorId) throw new Error("CreateDetector returned no detector ID.");
      return r.DetectorId;
    },
  },
  actions: [
    {
      id: "sample-findings",
      label: "Generate sample findings",
      fields: [{ name: "types", label: "Finding types", kind: "text", placeholder: "Recon:EC2/PortProbeUnprotectedPort", help: "Comma-separated finding types. Leave empty for one sample of every finding type." }],
      async run(ctx, id, v) {
        const types = str(v.types).split(",").map((s) => s.trim()).filter(Boolean);
        await ctx.clients.guardduty.send(new CreateSampleFindingsCommand({ DetectorId: id, FindingTypes: types.length ? types : undefined }));
        return { message: types.length ? `Generated sample findings for ${types.join(", ")}. Their titles start with [SAMPLE].` : "Generated sample findings for every finding type. Their titles start with [SAMPLE]." };
      },
    },
    {
      id: "plans",
      label: "Configure protection plans",
      fields: [{ name: "plans", label: "Enabled protection plans", kind: "multiselect", options: PLANS, help: "Plans not selected are turned off." }],
      async initialValues(ctx, id) {
        return { plans: await enabledPlans(ctx, id) };
      },
      async run(ctx, id, v) {
        await ctx.clients.guardduty.send(new UpdateDetectorCommand({ DetectorId: id, Features: planConfig(v.plans) }));
        return { message: "Protection plans updated." };
      },
    },
    {
      id: "frequency",
      label: "Edit findings export frequency",
      fields: [{ name: "frequency", label: "Findings export frequency", kind: "select", required: true, default: "SIX_HOURS", options: FREQUENCIES }],
      async initialValues(ctx, id) {
        const d = await ctx.clients.guardduty.send(new GetDetectorCommand({ DetectorId: id }));
        return { frequency: frequency(d.FindingPublishingFrequency) };
      },
      async run(ctx, id, v) {
        await ctx.clients.guardduty.send(new UpdateDetectorCommand({ DetectorId: id, FindingPublishingFrequency: frequency(v.frequency) }));
        return { message: `Findings export frequency set to ${frequency(v.frequency)}.` };
      },
    },
    {
      id: "suspend",
      label: "Suspend GuardDuty",
      danger: true,
      confirm: "GuardDuty stops monitoring and generating findings. Existing findings and settings are kept.",
      availableFor: (row) => detectorStatus(row) !== "DISABLED",
      async run(ctx, id) {
        await ctx.clients.guardduty.send(new UpdateDetectorCommand({ DetectorId: id, Enable: false }));
        return { message: "GuardDuty suspended." };
      },
    },
    {
      id: "resume",
      label: "Re-enable GuardDuty",
      availableFor: (row) => detectorStatus(row) !== "ENABLED",
      async run(ctx, id) {
        await ctx.clients.guardduty.send(new UpdateDetectorCommand({ DetectorId: id, Enable: true }));
        return { message: "GuardDuty enabled." };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.guardduty.send(new DeleteDetectorCommand({ DetectorId: id }));
    },
  },
};
