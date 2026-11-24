/**
 * AWS Well-Architected Tool: workloads and lenses. The workload detail screen is hand-built
 * (src/app/wellarchitected/workloads/[workload]) so it can link to the lens review screen,
 * where questions are answered; everything else is drawn by the engine from this file.
 */

import { randomUUID } from "node:crypto";
import {
  AssociateLensesCommand,
  CreateMilestoneCommand,
  CreateWorkloadCommand,
  CreateWorkloadShareCommand,
  DeleteWorkloadCommand,
  DeleteWorkloadShareCommand,
  DisassociateLensesCommand,
  GetLensCommand,
  GetWorkloadCommand,
  ListLensesCommand,
  ListLensReviewImprovementsCommand,
  ListLensReviewsCommand,
  ListMilestonesCommand,
  ListWorkloadSharesCommand,
  ListWorkloadsCommand,
  UpdateWorkloadCommand,
  type ImprovementSummary,
  type LensReviewSummary,
  type LensSummary,
  type MilestoneSummary,
  type UpdateWorkloadInput,
  type WorkloadEnvironment,
  type Workload,
  type WorkloadShareSummary,
  type WorkloadSummary,
} from "@aws-sdk/client-wellarchitected";
import { DEFAULT_REGION } from "../../lib/regions.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { ColumnDef, Ctx, DetailTab, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { answeredText, environmentLabel, riskCount, splitList, tagMap, WORKLOAD_ID } from "./helpers.ts";

const DEFAULT_LENS = "wellarchitected";

const INDUSTRY_TYPES = [
  "Agriculture",
  "Automotive",
  "Defense",
  "Design_And_Engineering",
  "Digital_Advertising",
  "Education",
  "Environmental_Protection",
  "Financial_Services",
  "Gaming",
  "General_Public_Services",
  "Healthcare",
  "Hospitality",
  "InfoTech",
  "Justice_And_Public_Safety",
  "Life_Sciences",
  "Manufacturing",
  "Media_Entertainment",
  "Mining_Resources",
  "Oil_Gas",
  "Power_Utilities",
  "Professional_Services",
  "Real_Estate_Construction",
  "Retail_Wholesale",
  "Social_Protection",
  "Telecommunications",
  "Travel_Transportation_Logistics",
  "Other",
].map((v) => ({ value: v, label: v.replace(/_/g, " ") }));

const ENVIRONMENTS: Option[] = [
  { value: "PRODUCTION", label: "Production" },
  { value: "PREPRODUCTION", label: "Pre-production" },
];

const ACCOUNT_IDS_HELP = "Up to 100 AWS account IDs associated with the workload, separated by commas.";
const ACCOUNT_LIST = "(\\d{12}([,\\s]+\\d{12})*)?";
const REGION_LIST = "([a-z]{2}(-[a-z]+)+-\\d([,\\s]+[a-z]{2}(-[a-z]+)+-\\d)*)?";

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

function requireWorkloadId(id: string): string {
  if (!WORKLOAD_ID.test(id)) throw new Error("That is not a valid workload ID (32 hexadecimal characters).");
  return id;
}

async function listAll<T>(fetchPage: (token: string | undefined) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const page = await fetchPage(token);
    out.push(...page.items);
    token = page.next;
  } while (token);
  return out;
}

async function lensOptions(ctx: Ctx): Promise<Option[]> {
  const lenses = await listAll<LensSummary>(async (t) => {
    const r = await ctx.clients.wellarchitected.send(new ListLensesCommand({ NextToken: t, MaxResults: 50 }));
    return { items: r.LensSummaries ?? [], next: r.NextToken };
  });
  return lenses
    .filter((l) => l.LensAlias || l.LensArn)
    .map((l) => ({ value: (l.LensAlias ?? l.LensArn) as string, label: l.LensName ?? l.LensAlias ?? "" }));
}

async function getWorkload(ctx: Ctx, id: string): Promise<Workload> {
  const w = (await ctx.clients.wellarchitected.send(new GetWorkloadCommand({ WorkloadId: requireWorkloadId(id) }))).Workload;
  if (!w) throw new Error(`Workload ${id} was not returned.`);
  return w;
}

/** The Edit properties form values for a workload, as the dialog shows them. */
function workloadFormValues(w: Workload) {
  return {
    description: w.Description ?? "",
    reviewOwner: w.ReviewOwner ?? "",
    environment: w.Environment ?? "PRODUCTION",
    regions: (w.AwsRegions ?? []).join(", "),
    accountIds: (w.AccountIds ?? []).join(", "),
    architecturalDesign: w.ArchitecturalDesign ?? "",
    industryType: w.IndustryType ?? "",
    industry: w.Industry ?? "",
    notes: w.Notes ?? "",
  };
}

/** Lenses applied to the workload, for "Remove lenses" (the Framework lens can't be removed). */
async function appliedLensOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  if (!id) return lensOptions(ctx);
  const applied = new Set((await getWorkload(ctx, id)).Lenses ?? []);
  return (await lensOptions(ctx)).filter((o) => applied.has(o.value) && o.value !== DEFAULT_LENS);
}

/** Lenses not yet applied to the workload, for "Add lenses". */
async function unappliedLensOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  if (!id) return lensOptions(ctx);
  const applied = new Set((await getWorkload(ctx, id)).Lenses ?? []);
  return (await lensOptions(ctx)).filter((o) => !applied.has(o.value));
}

function workloadRow(w: WorkloadSummary): Row {
  return {
    id: w.WorkloadId ?? "",
    name: w.WorkloadName ?? null,
    owner: w.Owner ?? null,
    answered: answeredText(w.RiskCounts),
    high: riskCount(w.RiskCounts, "HIGH"),
    medium: riskCount(w.RiskCounts, "MEDIUM"),
    improvementStatus: w.ImprovementStatus ?? null,
    lenses: (w.Lenses ?? []).join(", "),
    updated: iso(w.UpdatedAt),
    arn: w.WorkloadArn ?? null,
  };
}

const RISK_COLUMNS: ColumnDef[] = [
  { key: "answered", label: "Questions answered", kind: "text" },
  { key: "high", label: "High risks", kind: "count" },
  { key: "medium", label: "Medium risks", kind: "count" },
];

/** A tab whose data could not be read shows the error instead of failing the whole page. */
async function tabData<T>(fn: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await fn(), error: null };
  } catch (err: unknown) {
    return { data: null, error: errorMessage(err) };
  }
}

async function workloadDetail(ctx: Ctx, id: string) {
  const wa = ctx.clients.wellarchitected;
  const w = (await wa.send(new GetWorkloadCommand({ WorkloadId: requireWorkloadId(id) }))).Workload;
  if (!w) throw new Error(`Workload ${id} was not returned.`);
  const [reviews, milestones, shares, improvements] = await Promise.all([
    tabData(() =>
      listAll<LensReviewSummary>(async (t) => {
        const r = await wa.send(new ListLensReviewsCommand({ WorkloadId: id, NextToken: t, MaxResults: 50 }));
        return { items: r.LensReviewSummaries ?? [], next: r.NextToken };
      })
    ),
    tabData(() =>
      listAll<MilestoneSummary>(async (t) => {
        const r = await wa.send(new ListMilestonesCommand({ WorkloadId: id, NextToken: t, MaxResults: 50 }));
        return { items: r.MilestoneSummaries ?? [], next: r.NextToken };
      })
    ),
    tabData(() =>
      listAll<WorkloadShareSummary>(async (t) => {
        const r = await wa.send(new ListWorkloadSharesCommand({ WorkloadId: id, NextToken: t, MaxResults: 50 }));
        return { items: r.WorkloadShareSummaries ?? [], next: r.NextToken };
      })
    ),
    (w.Lenses ?? []).includes(DEFAULT_LENS)
      ? tabData(() =>
          listAll<ImprovementSummary>(async (t) => {
            const r = await wa.send(new ListLensReviewImprovementsCommand({ WorkloadId: id, LensAlias: DEFAULT_LENS, NextToken: t, MaxResults: 100 }));
            return { items: r.ImprovementSummaries ?? [], next: r.NextToken };
          })
        )
      : Promise.resolve({ data: [] as ImprovementSummary[], error: null }),
  ]);
  return { w, reviews, milestones, shares, improvements };
}

const workloads: ResourceDef = {
  id: "workloads",
  name: "Workloads",
  singular: "workload",
  idField: "id",
  nameField: "Name",
  description: "A workload is a set of components that together deliver business value. Review it against the Well-Architected lenses.",
  emptyText: "No workloads. Define a workload to start a review.",
  detailHref: "workloads/{id}",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "owner", label: "Owner", kind: "text" },
    ...RISK_COLUMNS,
    { key: "improvementStatus", label: "Improvement status", kind: "status" },
    { key: "lenses", label: "Lenses", kind: "text" },
    { key: "updated", label: "Last updated", kind: "date" },
    { key: "id", label: "Workload ID", kind: "text", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const all = await listAll<WorkloadSummary>(async (t) => {
      const r = await ctx.clients.wellarchitected.send(new ListWorkloadsCommand({ NextToken: t, MaxResults: 50 }));
      return { items: r.WorkloadSummaries ?? [], next: r.NextToken };
    });
    return all.map(workloadRow);
  },

  async get(ctx, id) {
    const { w, reviews, milestones, shares, improvements } = await workloadDetail(ctx, id);
    const tabs: DetailTab[] = [
      {
        id: "overview",
        label: "Overview",
        kind: "keyvalue",
        data: {
          "Questions answered": answeredText(w.RiskCounts),
          "High risks": riskCount(w.RiskCounts, "HIGH"),
          "Medium risks": riskCount(w.RiskCounts, "MEDIUM"),
          "No improvements identified": riskCount(w.RiskCounts, "NONE"),
          "Not applicable": riskCount(w.RiskCounts, "NOT_APPLICABLE"),
          Unanswered: riskCount(w.RiskCounts, "UNANSWERED"),
          "Improvement status": w.ImprovementStatus ?? null,
          "Pillar priority": (w.PillarPriorities ?? []).join(", "),
        },
      },
      {
        id: "properties",
        label: "Properties",
        kind: "keyvalue",
        data: {
          "Workload name": w.WorkloadName ?? null,
          Description: w.Description ?? null,
          "Review owner": w.ReviewOwner ?? null,
          Environment: environmentLabel(w.Environment),
          "AWS Regions": (w.AwsRegions ?? []).join(", "),
          "Non-AWS Regions": (w.NonAwsRegions ?? []).join(", "),
          "Account IDs": (w.AccountIds ?? []).join(", "),
          "Architectural design": w.ArchitecturalDesign ?? null,
          "Industry type": w.IndustryType ?? null,
          Industry: w.Industry ?? null,
          Notes: w.Notes ?? null,
          Owner: w.Owner ?? null,
          "Share invitation ID": w.ShareInvitationId ?? null,
          Tags: Object.entries(w.Tags ?? {}).map(([k, v]) => `${k}=${v}`).join(", "),
        },
      },
      {
        id: "milestones",
        label: "Milestones",
        kind: "table",
        description: milestones.error ?? "A milestone records the state of the workload at a point in time.",
        emptyText: "No milestones. Save a milestone from Actions.",
        columns: [
          { key: "number", label: "Milestone number", kind: "count" },
          { key: "name", label: "Milestone name", kind: "text" },
          { key: "recorded", label: "Date saved", kind: "date" },
          { key: "high", label: "High risks", kind: "count" },
          { key: "medium", label: "Medium risks", kind: "count" },
        ],
        data: (milestones.data ?? []).map((m) => ({
          number: m.MilestoneNumber ?? null,
          name: m.MilestoneName ?? null,
          recorded: iso(m.RecordedAt),
          high: riskCount(m.WorkloadSummary?.RiskCounts, "HIGH"),
          medium: riskCount(m.WorkloadSummary?.RiskCounts, "MEDIUM"),
        })),
      },
      {
        id: "improvement-plan",
        label: "Improvement plan",
        kind: "table",
        description:
          improvements.error ??
          ((w.Lenses ?? []).includes(DEFAULT_LENS)
            ? "Questions with high or medium risk in the AWS Well-Architected Framework lens, highest risk first."
            : "The AWS Well-Architected Framework lens is not applied to this workload."),
        emptyText: "No improvement items. Answer questions in a lens review to find risks.",
        columns: [
          { key: "risk", label: "Risk", kind: "status" },
          { key: "pillar", label: "Pillar", kind: "text" },
          { key: "question", label: "Question", kind: "text" },
          { key: "url", label: "Improvement plan", kind: "code" },
        ],
        data: (improvements.data ?? []).map((i) => ({ risk: i.Risk ?? null, pillar: i.PillarId ?? null, question: i.QuestionTitle ?? null, url: i.ImprovementPlanUrl ?? null })),
      },
      {
        id: "shares",
        label: "Shares",
        kind: "table",
        description: shares.error ?? "AWS accounts, organizations and OUs this workload is shared with.",
        emptyText: "This workload is not shared.",
        columns: [
          { key: "sharedWith", label: "Shared with", kind: "text" },
          { key: "permission", label: "Permission", kind: "text" },
          { key: "status", label: "Status", kind: "status" },
          { key: "shareId", label: "Share ID", kind: "code" },
        ],
        data: (shares.data ?? []).map((s) => ({ sharedWith: s.SharedWith ?? null, permission: s.PermissionType ?? null, status: s.Status ?? null, shareId: s.ShareId ?? null })),
      },
    ];
    if (reviews.error) tabs.unshift({ id: "lens-error", label: "Lenses", kind: "text", data: reviews.error });
    return {
      summary: {
        Name: w.WorkloadName ?? id,
        "Workload ID": w.WorkloadId ?? id,
        ARN: w.WorkloadArn ?? null,
        "Review owner": w.ReviewOwner ?? null,
        Environment: environmentLabel(w.Environment),
        "Last updated": iso(w.UpdatedAt),
      },
      tabs,
    };
  },

  create: {
    title: "Define workload",
    description: "Enter the workload's properties and choose the lenses to review it against.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Workload properties", help: "A unique name for the workload, 3 to 100 characters.", validate: { min: 3, max: 100, message: "Must be 3 to 100 characters." } },
      { name: "description", label: "Description", kind: "textarea", required: true, section: "Workload properties", help: "What the workload does and its purpose, 3 to 250 characters.", validate: { min: 3, max: 250, message: "Must be 3 to 250 characters." } },
      { name: "reviewOwner", label: "Review owner", kind: "text", required: true, section: "Workload properties", help: "The name, email address or identifier of the person or group that owns the review process.", validate: { min: 3, max: 255, message: "Must be 3 to 255 characters." } },
      { name: "environment", label: "Environment", kind: "radio", required: true, default: "PRODUCTION", options: ENVIRONMENTS, section: "Workload properties" },
      { name: "regions", label: "AWS Regions", kind: "text", default: DEFAULT_REGION, section: "Workload properties", help: "The AWS Regions the workload runs in, separated by commas.", validate: { pattern: REGION_LIST, message: "Enter Region codes such as us-east-1, separated by commas." } },
      { name: "nonAwsRegions", label: "Non-AWS Regions", kind: "text", section: "Workload properties", help: "Locations outside AWS, such as an on-premises data center, separated by commas." },
      { name: "accountIds", label: "Account IDs", kind: "text", section: "Workload properties", help: ACCOUNT_IDS_HELP, validate: { pattern: ACCOUNT_LIST, message: "Enter 12-digit account IDs separated by commas." } },
      { name: "architecturalDesign", label: "Architectural design", kind: "text", section: "Workload properties", help: "A URL for the workload's architectural design, e.g. a diagram.", validate: { pattern: "https?://\\S{1,2040}", message: "Enter a URL starting with http:// or https://." } },
      { name: "industryType", label: "Industry type", kind: "select", options: INDUSTRY_TYPES, section: "Workload properties" },
      { name: "industry", label: "Industry", kind: "text", section: "Workload properties", help: "The industry the workload is associated with, e.g. Retail." },
      { name: "lenses", label: "Lenses", kind: "multiselect", required: true, default: [DEFAULT_LENS], options: lensOptions, section: "Apply lenses", help: "The AWS Well-Architected Framework lens is applied by default. Add lenses for specific technology domains." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const regions = splitList(v.regions);
      const nonAws = splitList(v.nonAwsRegions);
      if (regions.length === 0 && nonAws.length === 0) throw new Error("Enter at least one AWS Region or non-AWS Region.");
      const lenses = splitList(v.lenses);
      const r = await ctx.clients.wellarchitected.send(
        new CreateWorkloadCommand({
          WorkloadName: String(v.name),
          Description: String(v.description),
          ReviewOwner: String(v.reviewOwner),
          Environment: v.environment as WorkloadEnvironment,
          AwsRegions: regions.length ? regions : undefined,
          NonAwsRegions: nonAws.length ? nonAws : undefined,
          AccountIds: splitList(v.accountIds).length ? splitList(v.accountIds) : undefined,
          ArchitecturalDesign: text(v.architecturalDesign),
          IndustryType: text(v.industryType),
          Industry: text(v.industry),
          Lenses: lenses.length ? lenses : [DEFAULT_LENS],
          Tags: tagMap(v.tags),
          ClientRequestToken: randomUUID(),
        })
      );
      if (!r.WorkloadId) throw new Error("Well-Architected returned no workload ID.");
      return r.WorkloadId;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit properties",
      fields: [
        { name: "description", label: "Description", kind: "textarea", required: true, validate: { min: 3, max: 250, message: "Must be 3 to 250 characters." } },
        { name: "reviewOwner", label: "Review owner", kind: "text", required: true, validate: { min: 3, max: 255, message: "Must be 3 to 255 characters." } },
        { name: "environment", label: "Environment", kind: "select", required: true, default: "PRODUCTION", options: ENVIRONMENTS },
        { name: "regions", label: "AWS Regions", kind: "text", help: "Separate Region codes with commas.", validate: { pattern: REGION_LIST, message: "Enter Region codes such as us-east-1, separated by commas." } },
        { name: "accountIds", label: "Account IDs", kind: "text", help: ACCOUNT_IDS_HELP, validate: { pattern: ACCOUNT_LIST, message: "Enter 12-digit account IDs separated by commas." } },
        { name: "architecturalDesign", label: "Architectural design", kind: "text", validate: { pattern: "https?://\\S{1,2040}", message: "Enter a URL starting with http:// or https://." } },
        { name: "industryType", label: "Industry type", kind: "select", options: INDUSTRY_TYPES },
        { name: "industry", label: "Industry", kind: "text" },
        { name: "notes", label: "Notes", kind: "textarea", validate: { max: 2084, message: "At most 2084 characters." } },
      ],
      async initialValues(ctx, id) {
        return workloadFormValues(await getWorkload(ctx, id));
      },
      async run(ctx, id, v) {
        const before = workloadFormValues(await getWorkload(ctx, id));
        const changed = (k: keyof typeof before): boolean => (typeof v[k] === "string" ? String(v[k]).trim() : "") !== before[k];
        const list = (k: "regions" | "accountIds") => (changed(k) ? splitList(v[k]) : undefined);
        const input: UpdateWorkloadInput = {
          WorkloadId: requireWorkloadId(id),
          Description: changed("description") ? text(v.description) : undefined,
          ReviewOwner: changed("reviewOwner") ? text(v.reviewOwner) : undefined,
          Environment: changed("environment") ? (text(v.environment) as WorkloadEnvironment | undefined) : undefined,
          AwsRegions: list("regions"),
          AccountIds: list("accountIds"),
          ArchitecturalDesign: changed("architecturalDesign") ? text(v.architecturalDesign) : undefined,
          IndustryType: changed("industryType") ? text(v.industryType) : undefined,
          Industry: changed("industry") ? text(v.industry) : undefined,
          Notes: changed("notes") ? (typeof v.notes === "string" ? v.notes : "") : undefined,
        };
        const updated = Object.entries(input).filter(([k, val]) => k !== "WorkloadId" && val !== undefined).map(([k]) => k);
        if (updated.length === 0) return { message: "No changes: the workload properties are unchanged." };
        const r = await ctx.clients.wellarchitected.send(new UpdateWorkloadCommand(input));
        return { message: `Updated ${updated.join(", ")} of workload ${r.Workload?.WorkloadName ?? id}.` };
      },
    },
    {
      id: "save-milestone",
      label: "Save milestone",
      fields: [{ name: "name", label: "Milestone name", kind: "text", required: true, help: "A unique name for the milestone, 3 to 100 characters.", validate: { min: 3, max: 100, message: "Must be 3 to 100 characters." } }],
      async run(ctx, id, v) {
        const r = await ctx.clients.wellarchitected.send(
          new CreateMilestoneCommand({ WorkloadId: requireWorkloadId(id), MilestoneName: String(v.name), ClientRequestToken: randomUUID() })
        );
        return { message: `Saved milestone ${r.MilestoneNumber ?? "?"}: ${String(v.name)}.` };
      },
    },
    {
      id: "add-lenses",
      label: "Add lenses",
      fields: [{ name: "lenses", label: "Lenses", kind: "multiselect", required: true, options: unappliedLensOptions, help: "Lenses to apply to this workload." }],
      async run(ctx, id, v) {
        const lenses = splitList(v.lenses);
        await ctx.clients.wellarchitected.send(new AssociateLensesCommand({ WorkloadId: requireWorkloadId(id), LensAliases: lenses }));
        return { message: `Applied ${lenses.join(", ")}.` };
      },
    },
    {
      id: "remove-lenses",
      label: "Remove lenses",
      danger: true,
      confirm: "Removing a lens deletes its answers from the workload. Milestones keep their copy.",
      fields: [{ name: "lenses", label: "Lenses", kind: "multiselect", required: true, options: appliedLensOptions, help: "Lenses to remove. The AWS Well-Architected Framework lens can't be removed." }],
      async run(ctx, id, v) {
        const lenses = splitList(v.lenses);
        await ctx.clients.wellarchitected.send(new DisassociateLensesCommand({ WorkloadId: requireWorkloadId(id), LensAliases: lenses }));
        return { message: `Removed ${lenses.join(", ")}.` };
      },
    },
    {
      id: "share",
      label: "Create share",
      fields: [
        { name: "sharedWith", label: "AWS account ID, organization ARN or OU ARN", kind: "text", required: true, help: "Who to share the workload with.", validate: { pattern: "\\d{12}|arn:aws[a-z-]*:organizations::\\d{12}:(organization|ou)/\\S+", message: "Enter a 12-digit account ID or an organization or OU ARN." } },
        { name: "permission", label: "Permission", kind: "radio", required: true, default: "READONLY", options: [{ value: "READONLY", label: "Read-only" }, { value: "CONTRIBUTOR", label: "Contributor" }] },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.wellarchitected.send(
          new CreateWorkloadShareCommand({ WorkloadId: requireWorkloadId(id), SharedWith: String(v.sharedWith), PermissionType: v.permission === "CONTRIBUTOR" ? "CONTRIBUTOR" : "READONLY", ClientRequestToken: randomUUID() })
        );
        return { message: `Shared with ${String(v.sharedWith)}. Share ID: ${r.ShareId ?? "(none returned)"}` };
      },
    },
    {
      id: "manage-shares",
      label: "Manage shares",
      async run(ctx, id) {
        const shares = await listAll<WorkloadShareSummary>(async (t) => {
          const r = await ctx.clients.wellarchitected.send(new ListWorkloadSharesCommand({ WorkloadId: requireWorkloadId(id), NextToken: t, MaxResults: 50 }));
          return { items: r.WorkloadShareSummaries ?? [], next: r.NextToken };
        });
        return {
          message: `${shares.length} share${shares.length === 1 ? "" : "s"}.`,
          table: {
            rowKey: "shareId",
            emptyText: "This workload is not shared.",
            columns: [
              { key: "sharedWith", label: "Shared with", kind: "text" },
              { key: "permission", label: "Permission", kind: "text" },
              { key: "status", label: "Status", kind: "status" },
              { key: "shareId", label: "Share ID", kind: "code" },
            ],
            rows: shares.map((s) => ({ sharedWith: s.SharedWith ?? null, permission: s.PermissionType ?? null, status: s.Status ?? null, shareId: s.ShareId ?? "" })),
            selectionAction: { actionId: "delete-shares", label: "Delete", danger: true, valuesField: "shareIds" },
          },
        };
      },
    },
    {
      id: "delete-shares",
      label: "Delete shares",
      hidden: true,
      danger: true,
      fields: [{ name: "shareIds", label: "Shares", kind: "multiselect", required: true }],
      async run(ctx, id, v) {
        const ids = splitList(v.shareIds);
        for (const shareId of ids) {
          if (!WORKLOAD_ID.test(shareId)) throw new Error(`"${shareId}" is not a share ID.`);
          await ctx.clients.wellarchitected.send(new DeleteWorkloadShareCommand({ WorkloadId: requireWorkloadId(id), ShareId: shareId, ClientRequestToken: randomUUID() }));
        }
        return { message: `Deleted ${ids.length} share${ids.length === 1 ? "" : "s"}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.wellarchitected.send(new DeleteWorkloadCommand({ WorkloadId: requireWorkloadId(id), ClientRequestToken: randomUUID() }));
    },
  },
};

const lenses: ResourceDef = {
  id: "lenses",
  name: "Lenses",
  singular: "lens",
  idField: "alias",
  nameField: "Name",
  description: "Lenses are sets of questions for reviewing a workload. AWS official lenses are listed here.",
  emptyText: "No lenses.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "owner", label: "Owner", kind: "text" },
    { key: "version", label: "Version", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "updated", label: "Updated", kind: "date" },
    { key: "alias", label: "Alias", kind: "text", hidden: true },
  ],
  async list(ctx) {
    const all = await listAll<LensSummary>(async (t) => {
      const r = await ctx.clients.wellarchitected.send(new ListLensesCommand({ NextToken: t, MaxResults: 50 }));
      return { items: r.LensSummaries ?? [], next: r.NextToken };
    });
    return all.map((l) => ({
      alias: l.LensAlias ?? l.LensArn ?? "",
      name: l.LensName ?? null,
      type: l.LensType ?? null,
      owner: l.Owner ?? null,
      version: l.LensVersion ?? null,
      status: l.LensStatus ?? null,
      updated: iso(l.UpdatedAt),
      description: l.Description ?? null,
    }));
  },
  async get(ctx, alias) {
    const l = (await ctx.clients.wellarchitected.send(new GetLensCommand({ LensAlias: alias }))).Lens;
    if (!l) throw new Error(`Lens ${alias} was not returned.`);
    return {
      summary: { Name: l.Name ?? alias, Alias: alias, ARN: l.LensArn ?? null, Version: l.LensVersion ?? null, Owner: l.Owner ?? null },
      tabs: [{ id: "description", label: "Description", kind: "text", data: l.Description ?? "", emptyText: "No description." }],
    };
  },
};

export const wellarchitectedService: ServiceDef = {
  id: "wellarchitected",
  name: "AWS Well-Architected Tool",
  category: "Management & Governance",
  description: "Review your workloads against AWS architectural best practices and track improvements.",
  resources: [workloads, lenses],
};
