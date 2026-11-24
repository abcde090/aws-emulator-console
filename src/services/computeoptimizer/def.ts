/**
 * AWS Compute Optimizer: dashboard (recommendation summaries), recommendation pages per
 * resource type, export jobs to S3, recommendation preferences and the account's opt-in
 * status. Every value comes from a Compute Optimizer response.
 */

import {
  DescribeRecommendationExportJobsCommand,
  ExportAutoScalingGroupRecommendationsCommand,
  ExportEBSVolumeRecommendationsCommand,
  ExportEC2InstanceRecommendationsCommand,
  ExportECSServiceRecommendationsCommand,
  ExportIdleRecommendationsCommand,
  ExportLambdaFunctionRecommendationsCommand,
  ExportLicenseRecommendationsCommand,
  ExportRDSDatabaseRecommendationsCommand,
  GetEnrollmentStatusCommand,
  GetRecommendationSummariesCommand,
  UpdateEnrollmentStatusCommand,
  type RecommendationExportJob,
  type RecommendationSummary,
  type S3DestinationConfig,
} from "@aws-sdk/client-compute-optimizer";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import type { Ctx, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { findingLabel, formatPercent, formatSavings, iso, summarizeFindings, type NameValue, type Savings } from "./helpers.ts";
import { preferences } from "./preferences.ts";
import { co, recommendationResources } from "./recommendations.ts";

// ---- Dashboard ----

async function summaries(ctx: Ctx): Promise<RecommendationSummary[]> {
  const out: RecommendationSummary[] = [];
  let token: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await co(() => ctx.clients.computeoptimizer.send(new GetRecommendationSummariesCommand({ nextToken: token })));
    out.push(...(r.recommendationSummaries ?? []));
    token = r.nextToken;
    if (!token) break;
  }
  return out;
}

function summaryRow(s: RecommendationSummary): Row {
  const risk = s.currentPerformanceRiskRatings;
  return {
    resourceType: s.recommendationResourceType ?? "",
    findings: summarizeFindings(s.summaries as NameValue[] | undefined),
    idle: summarizeFindings(s.idleSummaries as NameValue[] | undefined),
    savings: formatSavings((s.aggregatedSavingsOpportunity ?? s.savingsOpportunity) as Savings | undefined),
    savingsPercent: formatPercent((s.aggregatedSavingsOpportunity ?? s.savingsOpportunity) as Savings | undefined),
    performanceRisk: risk ? `High ${risk.high ?? 0}, Medium ${risk.medium ?? 0}, Low ${risk.low ?? 0}, Very low ${risk.veryLow ?? 0}` : null,
  };
}

const dashboard: ResourceDef = {
  id: "dashboard",
  name: "Dashboard",
  singular: "resource type",
  idField: "resourceType",
  nameField: "resourceType",
  description: "Findings and savings opportunity across the resource types Compute Optimizer analyses for this account.",
  emptyText: "Compute Optimizer returned no recommendation summaries.",
  columns: [
    { key: "resourceType", label: "Resource type", kind: "link" },
    { key: "findings", label: "Findings", kind: "text" },
    { key: "idle", label: "Idle findings", kind: "text" },
    { key: "savings", label: "Estimated monthly savings", kind: "text" },
    { key: "savingsPercent", label: "Savings opportunity (%)", kind: "text" },
    { key: "performanceRisk", label: "Current performance risk ratings", kind: "text" },
  ],
  async list(ctx) {
    return (await summaries(ctx)).map(summaryRow);
  },
  async get(ctx, id) {
    const s = (await summaries(ctx)).find((x) => x.recommendationResourceType === id);
    if (!s) throw new Error(`Compute Optimizer returned no summary for ${id}.`);
    const row = summaryRow(s);
    const reasons = (s.summaries ?? []).flatMap((f) => (f.reasonCodeSummaries ?? []).map((rc) => ({ finding: findingLabel(f.name), reason: rc.name ?? null, count: rc.value ?? 0 })));
    return {
      summary: {
        "Resource type": row.resourceType,
        "Account ID": s.accountId ?? null,
        "Estimated monthly savings": row.savings,
        "Savings opportunity (%)": row.savingsPercent,
        "Idle savings": formatSavings(s.idleSavingsOpportunity as Savings | undefined),
        "Current performance risk ratings": row.performanceRisk,
      },
      tabs: [
        {
          id: "findings",
          label: "Findings",
          kind: "table",
          columns: [
            { key: "finding", label: "Finding", kind: "status" },
            { key: "count", label: "Resources", kind: "count" },
          ],
          data: [...(s.summaries ?? []), ...(s.idleSummaries ?? [])].map((f) => ({ finding: findingLabel(f.name), count: f.value ?? 0 })),
          emptyText: "No findings.",
        },
        {
          id: "reasons",
          label: "Finding reasons",
          kind: "table",
          columns: [
            { key: "finding", label: "Finding", kind: "text" },
            { key: "reason", label: "Reason", kind: "text" },
            { key: "count", label: "Resources", kind: "count" },
          ],
          data: reasons,
          emptyText: "No finding reasons for this resource type.",
        },
        {
          id: "workloads",
          label: "Inferred workload savings",
          kind: "table",
          columns: [
            { key: "workloads", label: "Inferred workload types", kind: "text" },
            { key: "savings", label: "Estimated monthly savings", kind: "text" },
          ],
          data: (s.inferredWorkloadSavings ?? []).map((w) => ({ workloads: (w.inferredWorkloadTypes ?? []).join(", "), savings: formatSavings({ estimatedMonthlySavings: w.estimatedMonthlySavings }) })),
          emptyText: "No inferred workload savings.",
        },
      ],
    };
  },
};

// ---- Export jobs ----

const EXPORT_TYPES: Option[] = [
  { value: "Ec2Instance", label: "EC2 instances" },
  { value: "AutoScalingGroup", label: "Auto Scaling groups" },
  { value: "EbsVolume", label: "EBS volumes" },
  { value: "LambdaFunction", label: "Lambda functions" },
  { value: "EcsService", label: "ECS services on Fargate" },
  { value: "RdsDBInstance", label: "RDS DB instances" },
  { value: "Idle", label: "Idle resources" },
  { value: "License", label: "Licenses" },
];

async function runExport(ctx: Ctx, type: string, dest: S3DestinationConfig): Promise<string | undefined> {
  const c = ctx.clients.computeoptimizer;
  const input = { s3DestinationConfig: dest };
  switch (type) {
    case "Ec2Instance":
      return (await c.send(new ExportEC2InstanceRecommendationsCommand(input))).jobId;
    case "AutoScalingGroup":
      return (await c.send(new ExportAutoScalingGroupRecommendationsCommand(input))).jobId;
    case "EbsVolume":
      return (await c.send(new ExportEBSVolumeRecommendationsCommand(input))).jobId;
    case "LambdaFunction":
      return (await c.send(new ExportLambdaFunctionRecommendationsCommand(input))).jobId;
    case "EcsService":
      return (await c.send(new ExportECSServiceRecommendationsCommand(input))).jobId;
    case "RdsDBInstance":
      return (await c.send(new ExportRDSDatabaseRecommendationsCommand(input))).jobId;
    case "Idle":
      return (await c.send(new ExportIdleRecommendationsCommand(input))).jobId;
    case "License":
      return (await c.send(new ExportLicenseRecommendationsCommand(input))).jobId;
    default:
      throw new Error(`Unknown resource type ${type}.`);
  }
}

function jobRow(j: RecommendationExportJob): Row {
  return {
    jobId: j.jobId ?? "",
    resourceType: j.resourceType ?? null,
    status: j.status ?? null,
    bucket: j.destination?.s3?.bucket ?? null,
    key: j.destination?.s3?.key ?? null,
    metadataKey: j.destination?.s3?.metadataKey ?? null,
    failureReason: j.failureReason ?? null,
    created: iso(j.creationTimestamp),
    updated: iso(j.lastUpdatedTimestamp),
  };
}

async function bucketOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.s3.send(new ListBucketsCommand({}));
  return (r.Buckets ?? []).filter((b) => b.Name).map((b) => ({ value: b.Name as string, label: b.Name as string }));
}

const exportsResource: ResourceDef = {
  id: "exports",
  name: "Export jobs",
  singular: "export job",
  idField: "jobId",
  nameField: "jobId",
  description: "Recommendation exports to Amazon S3 (CSV plus a metadata JSON file). Export jobs can't be deleted; delete the files in S3 instead.",
  emptyText: "No export jobs. Export recommendations to an S3 bucket to see them here.",
  columns: [
    { key: "jobId", label: "Job ID", kind: "link" },
    { key: "resourceType", label: "Resource type", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "bucket", label: "S3 bucket", kind: "text" },
    { key: "key", label: "Object key", kind: "code" },
    { key: "created", label: "Created", kind: "date" },
    { key: "updated", label: "Last updated", kind: "date", hidden: true },
  ],
  async list(ctx) {
    const out: Row[] = [];
    let token: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await co(() => ctx.clients.computeoptimizer.send(new DescribeRecommendationExportJobsCommand({ nextToken: token })));
      out.push(...(r.recommendationExportJobs ?? []).map(jobRow));
      token = r.nextToken;
      if (!token) break;
    }
    return out;
  },
  async get(ctx, id) {
    const r = await co(() => ctx.clients.computeoptimizer.send(new DescribeRecommendationExportJobsCommand({ jobIds: [id] })));
    const j = r.recommendationExportJobs?.[0];
    if (!j) throw new Error(`Export job ${id} was not found.`);
    const row = jobRow(j);
    return {
      summary: {
        "Job ID": row.jobId,
        "Resource type": row.resourceType,
        Status: row.status,
        "Failure reason": row.failureReason,
        "S3 bucket": row.bucket,
        "Object key": row.key,
        "Metadata key": row.metadataKey,
        Created: row.created,
        "Last updated": row.updated,
      },
    };
  },
  create: {
    title: "Export recommendations",
    description: "Compute Optimizer writes the recommendations for one resource type to an S3 bucket in this Region. The bucket policy must let Compute Optimizer write to it.",
    fields: [
      { name: "resourceType", label: "Resource type", kind: "select", required: true, options: EXPORT_TYPES, default: "Ec2Instance", section: "Export settings" },
      { name: "bucket", label: "S3 bucket", kind: "select", required: true, options: bucketOptions, section: "S3 destination", help: "Exports go to <prefix>/<account ID>/ComputeOptimizer/<resource type>/<job ID>.csv." },
      { name: "keyPrefix", label: "Key prefix", kind: "text", section: "S3 destination", placeholder: "compute-optimizer", validate: { pattern: "[A-Za-z0-9!_.*'()/-]{1,512}", message: "Use letters, digits and ! _ . * ' ( ) / -" } },
    ],
    async run(ctx, v) {
      const prefix = typeof v.keyPrefix === "string" && v.keyPrefix !== "" ? v.keyPrefix : undefined;
      const jobId = await co(() => runExport(ctx, String(v.resourceType), { bucket: String(v.bucket), keyPrefix: prefix }));
      if (!jobId) throw new Error("Compute Optimizer returned no job ID.");
      return jobId;
    },
  },
};

// ---- Account (opt-in) ----

async function enrollmentRows(ctx: Ctx): Promise<Row[]> {
  const r = await ctx.clients.computeoptimizer.send(new GetEnrollmentStatusCommand({}));
  return [
    {
      accountId: ctx.accountId,
      status: r.status ?? null,
      statusReason: r.statusReason ?? null,
      memberAccountsEnrolled: r.memberAccountsEnrolled ?? null,
      memberCount: r.numberOfMemberAccountsOptedIn ?? null,
      updated: iso(r.lastUpdatedTimestamp),
    },
  ];
}

const account: ResourceDef = {
  id: "account",
  name: "Account",
  singular: "account",
  idField: "accountId",
  nameField: "accountId",
  description: "Whether this account is opted in to Compute Optimizer. Recommendations, exports and preferences need the account opted in.",
  emptyText: "No enrollment status returned.",
  columns: [
    { key: "accountId", label: "Account ID", kind: "link" },
    { key: "status", label: "Opt-in status", kind: "status" },
    { key: "statusReason", label: "Status reason", kind: "text" },
    { key: "memberAccountsEnrolled", label: "Member accounts enrolled", kind: "boolean" },
    { key: "memberCount", label: "Member accounts opted in", kind: "count" },
    { key: "updated", label: "Last updated", kind: "date" },
  ],
  list: enrollmentRows,
  async get(ctx, id) {
    const [row] = await enrollmentRows(ctx);
    if (id !== ctx.accountId) throw new Error(`Only this account (${ctx.accountId}) can be shown here.`);
    return {
      summary: {
        "Account ID": row.accountId,
        "Opt-in status": row.status,
        "Status reason": row.statusReason,
        "Member accounts enrolled": row.memberAccountsEnrolled,
        "Member accounts opted in": row.memberCount,
        "Last updated": row.updated,
      },
    };
  },
  actions: [
    {
      id: "opt-in",
      label: "Opt in",
      confirm: "Compute Optimizer starts analysing this account's resources and generating recommendations.",
      async run(ctx) {
        const r = await ctx.clients.computeoptimizer.send(new UpdateEnrollmentStatusCommand({ status: "Active" }));
        return { message: `Opt-in status: ${r.status ?? "(none returned)"}. ${r.statusReason ?? ""}`.trim() };
      },
    },
    {
      id: "opt-out",
      label: "Opt out",
      danger: true,
      confirm: "Opting out deletes this account's recommendations and recommendation preferences from Compute Optimizer.",
      async run(ctx) {
        const r = await ctx.clients.computeoptimizer.send(new UpdateEnrollmentStatusCommand({ status: "Inactive" }));
        return { message: `Opt-in status: ${r.status ?? "(none returned)"}. ${r.statusReason ?? ""}`.trim() };
      },
    },
  ],
};

export const computeoptimizerService: ServiceDef = {
  id: "computeoptimizer",
  name: "AWS Compute Optimizer",
  category: "Management & Governance",
  description: "Rightsizing and idle-resource recommendations for EC2, Auto Scaling, EBS, Lambda and more, based on utilization metrics.",
  resources: [dashboard, ...recommendationResources, exportsResource, preferences, account],
  notSupported: [
    "Opting in the organization's member accounts (UpdateEnrollmentStatus with includeMemberAccounts is rejected for this organization)",
  ],
};
