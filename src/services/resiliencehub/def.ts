/**
 * AWS Resilience Hub: applications (components, resources, versions), resiliency
 * policies (RTO/RPO per disruption type) and assessments.
 * Ids in URLs are the UUID at the end of each ARN; the ARN is rebuilt from the context.
 */

import {
  CreateAppCommand,
  CreateAppVersionAppComponentCommand,
  CreateAppVersionResourceCommand,
  CreateResiliencyPolicyCommand,
  DeleteAppCommand,
  DeleteResiliencyPolicyCommand,
  DescribeAppAssessmentCommand,
  DescribeAppCommand,
  DescribeAppVersionTemplateCommand,
  DescribeResiliencyPolicyCommand,
  ListAppAssessmentsCommand,
  ListAppsCommand,
  ListAppVersionResourcesCommand,
  ListAppVersionsCommand,
  PublishAppVersionCommand,
  ResolveAppVersionResourcesCommand,
  StartAppAssessmentCommand,
  UpdateAppCommand,
  UpdateResiliencyPolicyCommand,
  type AppAssessmentSummary,
  type DataLocationConstraint,
  type DisruptionType,
  type ResiliencyPolicy,
  type ResiliencyPolicyTier,
} from "@aws-sdk/client-resiliencehub";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { arnId, DISRUPTIONS, policyRows, secondsLabel } from "./helpers.ts";

const NAME = "[A-Za-z0-9][A-Za-z0-9_-]{1,59}";

const arn = (ctx: Ctx, kind: string, id: string) => `arn:aws:resiliencehub:${ctx.region}:${ctx.accountId}:${kind}/${id}`;

const TIERS: Option[] = [
  ["MissionCritical", "Mission critical"],
  ["Critical", "Critical"],
  ["Important", "Important"],
  ["CoreServices", "Core services"],
  ["NonCritical", "Non critical"],
].map(([value, label]) => ({ value, label }));

const COMPONENT_TYPES: Option[] = [
  "AWS::ResilienceHub::ComputeAppComponent",
  "AWS::ResilienceHub::DatabaseAppComponent",
  "AWS::ResilienceHub::StorageAppComponent",
  "AWS::ResilienceHub::NetworkingAppComponent",
  "AWS::ResilienceHub::QueueAppComponent",
  "AWS::ResilienceHub::NotificationAppComponent",
  "AWS::ResilienceHub::ContainerAppComponent",
].map((v) => ({ value: v, label: v.replace("AWS::ResilienceHub::", "").replace("AppComponent", "") }));

const RESOURCE_TYPES: Option[] = [
  "AWS::S3::Bucket",
  "AWS::DynamoDB::Table",
  "AWS::Lambda::Function",
  "AWS::EC2::Instance",
  "AWS::RDS::DBInstance",
  "AWS::SQS::Queue",
  "AWS::SNS::Topic",
  "AWS::ECS::Service",
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::AutoScaling::AutoScalingGroup",
].map((v) => ({ value: v, label: v }));

const LOCATIONS: Option[] = [
  { value: "AnyLocation", label: "Any location" },
  { value: "SameContinent", label: "Same continent" },
  { value: "SameCountry", label: "Same country" },
];

async function getPolicy(ctx: Ctx, id: string): Promise<ResiliencyPolicy> {
  const p = (await ctx.clients.resiliencehub.send(new DescribeResiliencyPolicyCommand({ policyArn: arn(ctx, "resiliency-policy", id) }))).policy;
  if (!p) throw new Error(`ResourceNotFoundException: policy ${id}`);
  return p;
}

async function allApps(ctx: Ctx): Promise<{ arn: string; name: string; status: string | null; compliance: string | null; score: number | null; drift: string | null; created: Date | null; lastAssessment: Date | null; schedule: string | null }[]> {
  const out = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.resiliencehub.send(new ListAppsCommand({ nextToken: token, maxResults: 100 }));
    for (const a of r.appSummaries ?? [])
      out.push({
        arn: a.appArn ?? "",
        name: a.name ?? "",
        status: a.status ?? null,
        compliance: a.complianceStatus ?? null,
        score: a.resiliencyScore ?? null,
        drift: a.driftStatus ?? null,
        created: a.creationTime ?? null,
        lastAssessment: a.lastAppComplianceEvaluationTime ?? null,
        schedule: a.assessmentSchedule ?? null,
      });
    token = r.nextToken;
  } while (token);
  return out;
}

async function allAssessments(ctx: Ctx, appArn?: string): Promise<AppAssessmentSummary[]> {
  const out: AppAssessmentSummary[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.resiliencehub.send(new ListAppAssessmentsCommand({ appArn, nextToken: token, maxResults: 100 }));
    out.push(...(r.assessmentSummaries ?? []));
    token = r.nextToken;
  } while (token);
  return out;
}

function assessmentRow(a: AppAssessmentSummary, apps: { arn: string; name: string }[]): Row {
  return {
    id: arnId(a.assessmentArn ?? ""),
    name: a.assessmentName ?? null,
    app: apps.find((x) => x.arn === a.appArn)?.name ?? (a.appArn ? arnId(a.appArn) : null),
    version: a.appVersion ?? null,
    status: a.assessmentStatus ?? null,
    compliance: a.complianceStatus ?? null,
    score: a.resiliencyScore !== undefined ? Math.round(a.resiliencyScore * 100) : null,
    invoker: a.invoker ?? null,
    start: a.startTime ?? null,
    end: a.endTime ?? null,
  };
}

const ASSESSMENT_COLUMNS = [
  { key: "id", label: "Assessment ID", kind: "link" as const },
  { key: "name", label: "Assessment name", kind: "text" as const },
  { key: "app", label: "Application", kind: "text" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "compliance", label: "Compliance status", kind: "status" as const },
  { key: "score", label: "Resiliency score", kind: "count" as const },
  { key: "version", label: "App version", kind: "text" as const },
  { key: "end", label: "End time", kind: "date" as const },
];

function policyFields(required: boolean): FieldDef[] {
  return DISRUPTIONS.flatMap((d) => [
    { name: `${d.key}Rto`, label: `${d.label} RTO (seconds)`, kind: "number" as const, required, section: "RTO and RPO targets", default: required ? d.rto : undefined, help: d.help, validate: { min: 0, max: 31536000, message: "0 to one year in seconds." } },
    { name: `${d.key}Rpo`, label: `${d.label} RPO (seconds)`, kind: "number" as const, required, section: "RTO and RPO targets", default: required ? d.rpo : undefined, validate: { min: 0, max: 31536000, message: "0 to one year in seconds." } },
  ]);
}

function policyFromValues(v: FieldValues): Partial<Record<DisruptionType, { rtoInSecs: number; rpoInSecs: number }>> {
  const out: Partial<Record<DisruptionType, { rtoInSecs: number; rpoInSecs: number }>> = {};
  for (const d of DISRUPTIONS) {
    const rto = v[`${d.key}Rto`];
    const rpo = v[`${d.key}Rpo`];
    if (typeof rto === "number" && typeof rpo === "number") out[d.key] = { rtoInSecs: rto, rpoInSecs: rpo };
  }
  return out;
}

async function addPolicyIfKnown(ctx: Ctx, seen: Map<string, Row>, policyArn: string | undefined): Promise<void> {
  if (!policyArn || seen.has(policyArn)) return;
  try {
    const p = (await ctx.clients.resiliencehub.send(new DescribeResiliencyPolicyCommand({ policyArn }))).policy;
    if (!p) return;
    seen.set(policyArn, {
      id: arnId(policyArn),
      name: p.policyName ?? "",
      tier: TIERS.find((t) => t.value === p.tier)?.label ?? p.tier ?? null,
      cost: p.estimatedCostTier ?? null,
      location: p.dataLocationConstraint ?? null,
      created: p.creationTime ?? null,
    });
  } catch (err: unknown) {
    if (!(err instanceof Error && err.name === "ResourceNotFoundException")) throw err;
  }
}

const policies: ResourceDef = {
  id: "policies",
  name: "Resiliency policies",
  singular: "resiliency policy",
  idField: "id",
  nameField: "name",
  description:
    "Recovery time (RTO) and recovery point (RPO) objectives per disruption type. AWS Emulator doesn't support ListResiliencyPolicies yet, so this list shows the policies attached to applications or used by assessments; a new policy opens on its own page.",
  emptyText: "No policies attached to applications. Create a resiliency policy, then attach it to an application.",
  columns: [
    { key: "name", label: "Policy name", kind: "link" },
    { key: "tier", label: "Tier", kind: "text" },
    { key: "cost", label: "Estimated cost tier", kind: "text" },
    { key: "location", label: "Data location constraint", kind: "text" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "id", label: "Policy ID", kind: "text", hidden: true },
  ],
  async list(ctx) {
    const seen = new Map<string, Row>();
    for (const a of await allApps(ctx)) {
      const d = (await ctx.clients.resiliencehub.send(new DescribeAppCommand({ appArn: a.arn }))).app;
      await addPolicyIfKnown(ctx, seen, d?.policyArn);
    }
    return [...seen.values()];
  },
  async get(ctx, id) {
    const p = (await ctx.clients.resiliencehub.send(new DescribeResiliencyPolicyCommand({ policyArn: arn(ctx, "resiliency-policy", id) }))).policy;
    if (!p) throw new Error(`ResourceNotFoundException: policy ${id}`);
    return {
      summary: {
        "Policy name": p.policyName ?? null,
        Description: p.policyDescription ?? null,
        Tier: TIERS.find((t) => t.value === p.tier)?.label ?? p.tier ?? null,
        "Estimated cost tier": p.estimatedCostTier ?? null,
        "Data location constraint": p.dataLocationConstraint ?? null,
        Created: p.creationTime ?? null,
        ARN: p.policyArn ?? null,
      },
      tabs: [
        {
          id: "targets",
          label: "RTO and RPO targets",
          kind: "table",
          data: policyRows(p.policy ?? {}).map((r) => ({ ...r, rto: secondsLabel(r.rto), rpo: secondsLabel(r.rpo) })),
          columns: [
            { key: "disruption", label: "Disruption type", kind: "text" },
            { key: "rto", label: "RTO", kind: "text" },
            { key: "rpo", label: "RPO", kind: "text" },
          ],
        },
      ],
    };
  },
  create: {
    title: "Create resiliency policy",
    fields: [
      { name: "name", label: "Policy name", kind: "text", required: true, section: "Policy details", validate: { pattern: NAME, message: "2 to 60 letters, numbers, - and _, starting with a letter or number." } },
      { name: "description", label: "Description", kind: "text", section: "Policy details" },
      { name: "tier", label: "Tier", kind: "select", section: "Policy details", default: "Critical", options: TIERS },
      {
        name: "location",
        label: "Data location constraint",
        kind: "select",
        section: "Policy details",
        default: "AnyLocation",
        options: LOCATIONS,
      },
      ...policyFields(true),
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const tags = Object.fromEntries(((v.tags as { Key: string; Value: string }[] | null) ?? []).map((t) => [t.Key, t.Value]));
      const r = await ctx.clients.resiliencehub.send(
        new CreateResiliencyPolicyCommand({
          policyName: String(v.name),
          policyDescription: typeof v.description === "string" && v.description !== "" ? v.description : undefined,
          tier: String(v.tier) as ResiliencyPolicyTier,
          dataLocationConstraint: String(v.location) as DataLocationConstraint,
          policy: policyFromValues(v) as Record<DisruptionType, { rtoInSecs: number; rpoInSecs: number }>,
          tags: Object.keys(tags).length ? tags : undefined,
        })
      );
      if (!r.policy?.policyArn) throw new Error("Resilience Hub returned no policy ARN.");
      return arnId(r.policy.policyArn);
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit policy",
      fields: [
        { name: "description", label: "Description", kind: "text", section: "Policy details" },
        { name: "tier", label: "Tier", kind: "select", required: true, section: "Policy details", default: "Critical", options: TIERS },
        { name: "location", label: "Data location constraint", kind: "select", required: true, section: "Policy details", default: "AnyLocation", options: LOCATIONS },
        ...policyFields(false).map((f) => ({ ...f, help: f.name.endsWith("Rto") ? `${f.help ?? ""} Leave RTO and RPO empty to keep this disruption type's targets.`.trim() : f.help })),
      ],
      async initialValues(ctx, id) {
        const p = await getPolicy(ctx, id);
        const values: FieldValues = { description: p.policyDescription ?? "", tier: p.tier ?? "Critical", location: p.dataLocationConstraint ?? "AnyLocation" };
        for (const d of DISRUPTIONS) {
          const t = p.policy?.[d.key];
          if (t) {
            values[`${d.key}Rto`] = t.rtoInSecs ?? null;
            values[`${d.key}Rpo`] = t.rpoInSecs ?? null;
          }
        }
        return values;
      },
      async run(ctx, id, v) {
        const p = await getPolicy(ctx, id);
        const current = p.policy ?? {};
        const policy = { ...current, ...policyFromValues(v) };
        const description = typeof v.description === "string" ? v.description : "";
        const tier = String(v.tier) as ResiliencyPolicyTier;
        const location = String(v.location) as DataLocationConstraint;
        const unchanged =
          JSON.stringify(policy) === JSON.stringify(current) && description === (p.policyDescription ?? "") && tier === p.tier && location === (p.dataLocationConstraint ?? "AnyLocation");
        if (unchanged) return { message: "No changes: the resiliency policy is unchanged." };
        await ctx.clients.resiliencehub.send(
          new UpdateResiliencyPolicyCommand({
            policyArn: arn(ctx, "resiliency-policy", id),
            policyDescription: description,
            tier,
            dataLocationConstraint: location,
            policy: policy as Record<DisruptionType, { rtoInSecs: number; rpoInSecs: number }>,
          })
        );
        return { message: "Resiliency policy updated." };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.resiliencehub.send(new DeleteResiliencyPolicyCommand({ policyArn: arn(ctx, "resiliency-policy", id) }));
    },
  },
};

async function safe<T>(fn: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await fn(), error: null };
  } catch (err: unknown) {
    return { data: null, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

const apps: ResourceDef = {
  id: "applications",
  name: "Applications",
  singular: "application",
  idField: "id",
  nameField: "name",
  description: "Applications group the resources Resilience Hub assesses against a resiliency policy.",
  emptyText: "No applications. Add an application to describe its components and resources.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "compliance", label: "Compliance status", kind: "status" },
    { key: "score", label: "Resiliency score", kind: "count" },
    { key: "drift", label: "Application drift status", kind: "text" },
    { key: "schedule", label: "Assessment schedule", kind: "text" },
    { key: "lastAssessment", label: "Last assessed", kind: "date" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "id", label: "ID", kind: "text", hidden: true },
  ],
  async list(ctx) {
    return (await allApps(ctx)).map((a) => ({ id: arnId(a.arn), name: a.name, compliance: a.compliance, score: a.score !== null ? Math.round(a.score * 100) : null, drift: a.drift, schedule: a.schedule, lastAssessment: a.lastAssessment, created: a.created }));
  },
  async get(ctx, id) {
    const appArn = arn(ctx, "app", id);
    const app = (await ctx.clients.resiliencehub.send(new DescribeAppCommand({ appArn }))).app;
    if (!app) throw new Error(`ResourceNotFoundException: application ${id}`);
    const [versions, resources, template, assessments] = await Promise.all([
      safe(() => ctx.clients.resiliencehub.send(new ListAppVersionsCommand({ appArn }))),
      safe(() => ctx.clients.resiliencehub.send(new ListAppVersionResourcesCommand({ appArn, appVersion: "draft" }))),
      safe(() => ctx.clients.resiliencehub.send(new DescribeAppVersionTemplateCommand({ appArn, appVersion: "draft" }))),
      allAssessments(ctx, appArn),
    ]);
    let components: Row[] = [];
    try {
      const body = JSON.parse(template.data?.appTemplateBody ?? "{}") as { appComponents?: { name?: string; type?: string; resourceNames?: string[] }[] };
      components = (body.appComponents ?? []).map((c) => ({ name: c.name ?? "", type: c.type ?? null, resources: (c.resourceNames ?? []).join(", ") }));
    } catch {
      components = [];
    }
    return {
      summary: {
        Name: app.name ?? null,
        Description: app.description ?? null,
        Status: app.status ?? null,
        "Compliance status": app.complianceStatus ?? null,
        "Resiliency score": app.resiliencyScore !== undefined ? Math.round(app.resiliencyScore * 100) : null,
        "Resiliency policy": app.policyArn ?? "None attached",
        "Assessment schedule": app.assessmentSchedule ?? null,
        "Drift status": app.driftStatus ?? null,
        Created: app.creationTime ?? null,
        ARN: app.appArn ?? null,
      },
      tabs: [
        {
          id: "components",
          label: "Application components",
          kind: "table",
          description: "From the draft version's application template.",
          data: components,
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
            { key: "resources", label: "Resources", kind: "text" },
          ],
          emptyText: template.error ?? "No components.",
        },
        {
          id: "resources",
          label: "Resources",
          kind: "table",
          description: "Draft version resources. Use Actions > Resolve resources after adding resources.",
          data: (resources.data?.physicalResources ?? []).map((p) => ({
            name: p.resourceName ?? null,
            logical: p.logicalResourceId?.identifier ?? null,
            physical: p.physicalResourceId?.identifier ?? null,
            type: p.resourceType ?? null,
            components: (p.appComponents ?? []).map((c) => c.name).join(", "),
            source: p.sourceType ?? null,
          })),
          columns: [
            { key: "name", label: "Resource name", kind: "text" },
            { key: "logical", label: "Logical ID", kind: "text" },
            { key: "physical", label: "Physical ID", kind: "text" },
            { key: "type", label: "Resource type", kind: "text" },
            { key: "components", label: "Application component", kind: "text" },
            { key: "source", label: "Source", kind: "text" },
          ],
          emptyText: resources.error ?? "No resources.",
        },
        {
          id: "versions",
          label: "Versions",
          kind: "table",
          data: (versions.data?.appVersions ?? []).map((v) => ({ version: v.appVersion ?? "", label: v.versionName ?? null, identifier: v.identifier ?? null, created: v.creationTime ?? null })),
          columns: [
            { key: "version", label: "Version", kind: "text" },
            { key: "identifier", label: "Identifier", kind: "count" },
            { key: "label", label: "Version name", kind: "text" },
            { key: "created", label: "Creation time", kind: "date" },
          ],
          emptyText: versions.error ?? "No versions.",
        },
        { id: "assessments", label: "Assessments", kind: "table", data: assessments.map((a) => assessmentRow(a, [])), columns: ASSESSMENT_COLUMNS.filter((c) => c.key !== "app").map((c) => (c.kind === "link" ? { ...c, kind: "text" as const } : c)), emptyText: "No assessments. Publish a version, then run an assessment." },
      ],
    };
  },
  create: {
    title: "Add application",
    description: "Describe the application here; add its components and resources from the application's Actions menu.",
    fields: [
      { name: "name", label: "Application name", kind: "text", required: true, validate: { pattern: NAME, message: "2 to 60 letters, numbers, - and _, starting with a letter or number." } },
      { name: "description", label: "Description", kind: "text" },
      { name: "policyArn", label: "Resiliency policy ARN", kind: "text", placeholder: "arn:aws:resiliencehub:…:resiliency-policy/…", help: "Copy it from the policy's page. You can attach one later; an assessment needs it." },
      {
        name: "schedule",
        label: "Assessment schedule",
        kind: "radio",
        default: "Disabled",
        options: [
          { value: "Disabled", label: "Disabled - run assessments yourself" },
          { value: "Daily", label: "Daily - assess the application automatically every day" },
        ],
      },
      { name: "tags", label: "Tags", kind: "tags" },
    ],
    async run(ctx, v) {
      const tags = Object.fromEntries(((v.tags as { Key: string; Value: string }[] | null) ?? []).map((t) => [t.Key, t.Value]));
      const r = await ctx.clients.resiliencehub.send(
        new CreateAppCommand({
          name: String(v.name),
          description: typeof v.description === "string" && v.description !== "" ? v.description : undefined,
          policyArn: typeof v.policyArn === "string" && v.policyArn !== "" ? v.policyArn : undefined,
          assessmentSchedule: String(v.schedule) as "Daily",
          tags: Object.keys(tags).length ? tags : undefined,
        })
      );
      if (!r.app?.appArn) throw new Error("Resilience Hub returned no application ARN.");
      return arnId(r.app.appArn);
    },
  },
  actions: [
    {
      id: "attach-policy",
      label: "Attach resiliency policy",
      fields: [{ name: "policyArn", label: "Resiliency policy ARN", kind: "text", required: true, help: "Copy it from the policy's page." }],
      async initialValues(ctx, id) {
        const app = (await ctx.clients.resiliencehub.send(new DescribeAppCommand({ appArn: arn(ctx, "app", id) }))).app;
        return { policyArn: app?.policyArn ?? "" };
      },
      async run(ctx, id, v) {
        await ctx.clients.resiliencehub.send(new UpdateAppCommand({ appArn: arn(ctx, "app", id), policyArn: String(v.policyArn) }));
        return { message: "Resiliency policy attached." };
      },
    },
    {
      id: "add-component",
      label: "Add application component",
      fields: [
        { name: "name", label: "Component name", kind: "text", required: true, validate: { pattern: NAME, message: "2 to 60 letters, numbers, - and _." } },
        { name: "type", label: "Component type", kind: "select", required: true, options: COMPONENT_TYPES },
      ],
      async run(ctx, id, v) {
        await ctx.clients.resiliencehub.send(new CreateAppVersionAppComponentCommand({ appArn: arn(ctx, "app", id), name: String(v.name), type: String(v.type) }));
        return { message: `Component ${String(v.name)} added to the draft version.` };
      },
    },
    {
      id: "add-resource",
      label: "Add resource",
      fields: [
        { name: "resourceType", label: "Resource type", kind: "select", required: true, options: RESOURCE_TYPES },
        { name: "physicalId", label: "Physical resource ID", kind: "text", required: true, help: "The existing resource's name or ID, e.g. a bucket name or table name." },
        { name: "resourceName", label: "Resource name", kind: "text", required: true, help: "Also used as the logical ID." },
        { name: "component", label: "Application component", kind: "text", required: true, help: "Name of a component added with Add application component." },
      ],
      async run(ctx, id, v) {
        await ctx.clients.resiliencehub.send(
          new CreateAppVersionResourceCommand({
            appArn: arn(ctx, "app", id),
            resourceName: String(v.resourceName),
            logicalResourceId: { identifier: String(v.resourceName) },
            physicalResourceId: String(v.physicalId),
            resourceType: String(v.resourceType),
            appComponents: [String(v.component)],
          })
        );
        return { message: `Resource ${String(v.resourceName)} added. Resolve resources, then publish a version.` };
      },
    },
    {
      id: "resolve",
      label: "Resolve resources",
      async run(ctx, id) {
        const r = await ctx.clients.resiliencehub.send(new ResolveAppVersionResourcesCommand({ appArn: arn(ctx, "app", id), appVersion: "draft" }));
        return { message: `Resolution ${r.resolutionId ?? ""} is ${r.status ?? "pending"}.` };
      },
    },
    {
      id: "publish",
      label: "Publish new version",
      fields: [{ name: "versionName", label: "Version name", kind: "text", help: "A label for the release." }],
      async run(ctx, id, v) {
        const r = await ctx.clients.resiliencehub.send(new PublishAppVersionCommand({ appArn: arn(ctx, "app", id), versionName: typeof v.versionName === "string" && v.versionName !== "" ? v.versionName : undefined }));
        return { message: `Published version ${r.identifier ?? ""} (${r.appVersion ?? "release"}).` };
      },
    },
    {
      id: "assess",
      label: "Run assessment",
      fields: [{ name: "name", label: "Assessment name", kind: "text", required: true, validate: { pattern: NAME, message: "2 to 60 letters, numbers, - and _." } }],
      async run(ctx, id, v) {
        const r = await ctx.clients.resiliencehub.send(new StartAppAssessmentCommand({ appArn: arn(ctx, "app", id), appVersion: "release", assessmentName: String(v.name) }));
        return { message: `Assessment ${r.assessment?.assessmentName ?? ""} is ${r.assessment?.assessmentStatus ?? "pending"}. See Assessments.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.resiliencehub.send(new DeleteAppCommand({ appArn: arn(ctx, "app", id), forceDelete: true }));
    },
  },
};

const assessments: ResourceDef = {
  id: "assessments",
  name: "Assessments",
  singular: "assessment",
  idField: "id",
  nameField: "name",
  description: "Assessment results: whether each application's current RTO and RPO meet its resiliency policy.",
  emptyText: "No assessments. Run an assessment from an application.",
  columns: ASSESSMENT_COLUMNS,
  async list(ctx) {
    const appList = await allApps(ctx);
    return (await allAssessments(ctx)).map((a) => assessmentRow(a, appList));
  },
  async get(ctx, id) {
    const a = (await ctx.clients.resiliencehub.send(new DescribeAppAssessmentCommand({ assessmentArn: arn(ctx, "app-assessment", id) }))).assessment;
    if (!a) throw new Error(`ResourceNotFoundException: assessment ${id}`);
    return {
      summary: {
        "Assessment name": a.assessmentName ?? null,
        Status: a.assessmentStatus ?? null,
        "Compliance status": a.complianceStatus ?? null,
        "Resiliency score": a.resiliencyScore?.score !== undefined ? Math.round(a.resiliencyScore.score * 100) : null,
        "App version": a.appVersion ?? null,
        Invoker: a.invoker ?? null,
        Policy: a.policy?.policyName ?? null,
        "Start time": a.startTime ?? null,
        "End time": a.endTime ?? null,
        Message: a.message ?? null,
        ARN: a.assessmentArn ?? null,
      },
      tabs: [
        {
          id: "compliance",
          label: "Results",
          kind: "table",
          data: Object.entries(a.compliance ?? {}).map(([type, c]) => ({
            disruption: DISRUPTIONS.find((d) => d.key === type)?.label ?? type,
            status: c.complianceStatus ?? null,
            currentRto: secondsLabel(c.currentRtoInSecs),
            targetRto: secondsLabel(a.policy?.policy?.[type as DisruptionType]?.rtoInSecs),
            currentRpo: secondsLabel(c.currentRpoInSecs),
            targetRpo: secondsLabel(a.policy?.policy?.[type as DisruptionType]?.rpoInSecs),
          })),
          columns: [
            { key: "disruption", label: "Disruption type", kind: "text" },
            { key: "status", label: "Compliance", kind: "status" },
            { key: "currentRto", label: "Estimated RTO", kind: "text" },
            { key: "targetRto", label: "Target RTO", kind: "text" },
            { key: "currentRpo", label: "Estimated RPO", kind: "text" },
            { key: "targetRpo", label: "Target RPO", kind: "text" },
          ],
          emptyText: "No results yet.",
        },
      ],
    };
  },
};

export const resiliencehubService: ServiceDef = {
  id: "resiliencehub",
  name: "AWS Resilience Hub",
  category: "Management & Governance",
  description: "Define, validate and track the resilience of your applications against RTO and RPO targets.",
  resources: [apps, policies, assessments],
  notSupported: [
    "Listing all resiliency policies (ListResiliencyPolicies) and suggested policies",
    "Importing resources from CloudFormation stacks or other sources (ImportResourcesToDraftAppVersion, PutDraftAppVersionTemplate, ListAppInputSources)",
    "Assessment recommendations: components, alarms, SOPs and tests (ListAppComponentRecommendations, ListAlarmRecommendations, ListSopRecommendations, ListTestRecommendations)",
    "Deleting assessments (DeleteAppAssessment) and application components (DeleteAppVersionAppComponent)",
  ],
};
