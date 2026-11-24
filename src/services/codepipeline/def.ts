/**
 * AWS CodePipeline: pipelines. The pipeline screen is hand-built
 * (src/app/codepipeline/pipelines/[name]) to draw stages, transitions, approvals and the
 * execution history; its buttons call the hidden actions below through the engine.
 */

import {
  CreatePipelineCommand,
  DeletePipelineCommand,
  DisableStageTransitionCommand,
  EnableStageTransitionCommand,
  GetPipelineCommand,
  ListPipelineExecutionsCommand,
  ListPipelinesCommand,
  ListTagsForResourceCommand,
  PutApprovalResultCommand,
  RetryStageExecutionCommand,
  StartPipelineExecutionCommand,
  StopPipelineExecutionCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdatePipelineCommand,
  type ExecutionMode,
  type PipelineDeclaration,
  type PipelineType,
} from "@aws-sdk/client-codepipeline";
import { CreateRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import type { Ctx, Option, ResourceDef, Row, ServiceDef, Tag } from "../../console/types.ts";
import { bucketOptions, projectOptions, roleOptions } from "../codebuild/projects.ts";
import { listRepositoryNames } from "../codecommit/repo-read.ts";
import { secondary } from "../../console/secondary.ts";
import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import {
  buildStages,
  CODEPIPELINE_BASE_POLICY,
  CODEPIPELINE_TRUST_POLICY,
  defaultArtifactBucket,
  defaultPipelineRoleName,
  PIPELINE_NAME,
  statusText,
} from "./helpers.ts";

const optional = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

async function repoOptions(ctx: Ctx): Promise<Option[]> {
  return (await listRepositoryNames(ctx.clients.codecommit)).map((n) => ({ value: n, label: n }));
}

export async function getPipeline(ctx: Ctx, name: string): Promise<{ pipeline: PipelineDeclaration; arn: string | null; created: Date | null; updated: Date | null }> {
  const r = await ctx.clients.codepipeline.send(new GetPipelineCommand({ name }));
  if (!r.pipeline) throw new Error(`CodePipeline returned no pipeline ${name}.`);
  return { pipeline: r.pipeline, arn: r.metadata?.pipelineArn ?? null, created: r.metadata?.created ?? null, updated: r.metadata?.updated ?? null };
}

async function pipelineTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const out: Tag[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.codepipeline.send(new ListTagsForResourceCommand({ resourceArn: arn, nextToken: token }));
    for (const t of r.tags ?? []) if (t.key) out.push({ Key: t.key, Value: t.value ?? "" });
    token = r.nextToken;
  } while (token);
  return out;
}

async function ensureDefaultBucket(ctx: Ctx): Promise<string> {
  const bucket = defaultArtifactBucket(ctx.region, ctx.accountId);
  try {
    await ctx.clients.s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "";
    if (name !== "NotFound" && name !== "NoSuchBucket") throw err;
    await ctx.clients.s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  return bucket;
}

async function createRole(ctx: Ctx, pipeline: string, requested: string | undefined): Promise<string> {
  const roleName = requested ?? defaultPipelineRoleName(ctx.region, pipeline);
  const r = await ctx.clients.iam.send(new CreateRoleCommand({ RoleName: roleName, Path: "/service-role/", AssumeRolePolicyDocument: CODEPIPELINE_TRUST_POLICY, Description: `Service role for CodePipeline ${pipeline}` }));
  await ctx.clients.iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: `AWSCodePipelineServiceRole-${pipeline}`.slice(0, 128), PolicyDocument: CODEPIPELINE_BASE_POLICY }));
  if (!r.Role?.Arn) throw new Error("IAM returned no ARN for the new service role.");
  return r.Role.Arn;
}

function sourceRevisions(revs: { actionName?: string; revisionId?: string; revisionSummary?: string }[] | undefined): string | null {
  if (!revs || revs.length === 0) return null;
  return revs.map((r) => `${r.actionName ?? "Source"}: ${(r.revisionId ?? "").slice(0, 8)}${r.revisionSummary ? ` ${r.revisionSummary}` : ""}`).join(", ");
}

const pipelines: ResourceDef = {
  id: "pipelines",
  name: "Pipelines",
  singular: "pipeline",
  idField: "name",
  nameField: "name",
  description: "Pipelines model, visualize and automate the steps to release software.",
  emptyText: "No pipelines. Create a pipeline to get started.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "latestStatus", label: "Latest execution status", kind: "status" },
    { key: "sourceRevisions", label: "Latest source revisions", kind: "text" },
    { key: "latestStarted", label: "Latest execution started", kind: "date" },
    { key: "type", label: "Pipeline type", kind: "text" },
    { key: "executionMode", label: "Execution mode", kind: "text" },
    { key: "updated", label: "Updated", kind: "date", hidden: true },
  ],

  async list(ctx) {
    const cp = ctx.clients.codepipeline;
    const summaries = [];
    let token: string | undefined;
    do {
      const page = await cp.send(new ListPipelinesCommand({ nextToken: token }));
      summaries.push(...(page.pipelines ?? []));
      token = page.nextToken;
    } while (token);
    return Promise.all(
      summaries.map(async (p): Promise<Row> => {
        // The latest execution is secondary: a denied lookup leaves those columns empty.
        const exR = await secondary(cp.send(new ListPipelineExecutionsCommand({ pipelineName: p.name, maxResults: 1 })));
        const ex = exR.ok ? exR.value.pipelineExecutionSummaries?.[0] : undefined;
        return {
          name: p.name ?? "",
          latestStatus: ex ? statusText(ex.status) : null,
          sourceRevisions: sourceRevisions(ex?.sourceRevisions),
          latestStarted: ex?.startTime ?? null,
          type: p.pipelineType ?? "V1",
          executionMode: p.executionMode ?? null,
          updated: p.updated ?? null,
        };
      })
    );
  },

  async get(ctx, name) {
    const { pipeline: p, arn, created, updated } = await getPipeline(ctx, name);
    const tagsR = await secondary(arn ? pipelineTags(ctx, arn) : Promise.resolve([]));
    const tags = tagsR.ok ? tagsR.value : [];
    return {
      summary: { name: p.name ?? name, type: p.pipelineType ?? "V1", executionMode: p.executionMode ?? null, version: p.version ?? null, arn, roleArn: p.roleArn ?? null },
      summaryLabels: { name: "Pipeline name", type: "Pipeline type", executionMode: "Execution mode", version: "Version", arn: "ARN", roleArn: "Service role ARN" },
      tabs: [
        {
          id: "settings",
          label: "Settings",
          kind: "keyvalue",
          data: {
            "Artifact store": p.artifactStore ? `${p.artifactStore.type ?? "S3"}: ${p.artifactStore.location ?? "-"}` : p.artifactStores ? "Per-Region artifact stores" : null,
            "Encryption key": p.artifactStore?.encryptionKey?.id ?? "Default AWS managed key",
            Stages: (p.stages ?? []).map((s) => s.name).join(" → "),
            Variables: (p.variables ?? []).map((v) => v.name).join(", ") || "None",
            Triggers: (p.triggers ?? []).map((t) => t.providerType).join(", ") || "None",
            Created: created,
            Updated: updated,
          },
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tags,
          emptyText: "No tags.",
          description: tagsR.ok ? undefined : `Tags are unavailable: ${tagsR.error}`,
        },
        { id: "structure", label: "Pipeline structure (JSON)", kind: "json", data: p, description: "The declaration GetPipeline returned." },
      ],
    };
  },

  create: {
    title: "Create pipeline",
    description: "Builds the stages below and calls CreatePipeline. CodePipeline starts the first execution as soon as the pipeline is created.",
    fields: [
      { name: "name", label: "Pipeline name", kind: "text", required: true, section: "Step 1: Pipeline settings", help: "Up to 100 letters, numbers, periods, @, underscores and hyphens.", validate: { pattern: PIPELINE_NAME, message: "Use up to 100 letters, numbers, . @ _ or - characters." } },
      {
        name: "pipelineType", label: "Pipeline type", kind: "radio", default: "V2", section: "Step 1: Pipeline settings",
        options: [
          { value: "V2", label: "V2: triggers, variables and more execution modes" },
          { value: "V1", label: "V1" },
        ],
      },
      {
        name: "executionMode", label: "Execution mode", kind: "radio", default: "QUEUED", section: "Step 1: Pipeline settings",
        options: [
          { value: "QUEUED", label: "Queued: executions are processed one by one in order" },
          { value: "SUPERSEDED", label: "Superseded: a newer execution can overtake an older one" },
          { value: "PARALLEL", label: "Parallel: executions run independently (V2 only)" },
        ],
      },
      {
        name: "roleMode", label: "Service role", kind: "radio", default: "new", section: "Step 1: Pipeline settings",
        options: [
          { value: "new", label: "New service role" },
          { value: "existing", label: "Existing service role" },
        ],
      },
      { name: "roleName", label: "Role name", kind: "text", section: "Step 1: Pipeline settings", showIf: { field: "roleMode", equals: "new" }, help: "Leave empty for AWSCodePipelineServiceRole-<Region>-<pipeline name>.", validate: { pattern: "[\\w+=,.@-]{1,64}", message: "Up to 64 letters, numbers and +=,.@_- characters." } },
      { name: "roleArn", label: "Role ARN", kind: "select", options: roleOptions("codepipeline.amazonaws.com"), section: "Step 1: Pipeline settings", showIf: { field: "roleMode", equals: "existing" }, help: "Roles whose trust policy allows codepipeline.amazonaws.com." },
      {
        name: "artifactStore", label: "Artifact store", kind: "radio", default: "default", section: "Step 1: Pipeline settings",
        options: [
          { value: "default", label: "Default location: an S3 bucket CodePipeline creates for this Region" },
          { value: "custom", label: "Custom location: an existing S3 bucket" },
        ],
      },
      { name: "artifactBucket", label: "Bucket", kind: "select", options: bucketOptions, section: "Step 1: Pipeline settings", showIf: { field: "artifactStore", equals: "custom" } },
      {
        name: "sourceProvider", label: "Source provider", kind: "select", default: "CodeCommit", section: "Step 2: Source",
        options: [
          { value: "CodeCommit", label: "AWS CodeCommit" },
          { value: "S3", label: "Amazon S3" },
        ],
      },
      { name: "repository", label: "Repository name", kind: "select", options: repoOptions, section: "Step 2: Source", showIf: { field: "sourceProvider", equals: "CodeCommit" } },
      { name: "branch", label: "Branch name", kind: "text", default: "main", section: "Step 2: Source", showIf: { field: "sourceProvider", equals: "CodeCommit" } },
      { name: "sourceBucket", label: "Bucket", kind: "select", options: bucketOptions, section: "Step 2: Source", showIf: { field: "sourceProvider", equals: "S3" } },
      { name: "sourceKey", label: "S3 object key", kind: "text", section: "Step 2: Source", showIf: { field: "sourceProvider", equals: "S3" }, placeholder: "source/app.zip" },
      {
        name: "buildProvider", label: "Build provider", kind: "select", default: "skip", section: "Step 3: Build - optional",
        options: [
          { value: "skip", label: "Skip build stage" },
          { value: "CodeBuild", label: "AWS CodeBuild" },
        ],
      },
      { name: "buildProject", label: "Project name", kind: "select", options: projectOptions, section: "Step 3: Build - optional", showIf: { field: "buildProvider", equals: "CodeBuild" } },
      { name: "approval", label: "Add a manual approval stage", kind: "checkbox", default: false, section: "Step 4: Approval - optional", help: "The pipeline waits at this stage until someone approves or rejects it." },
      { name: "approvalMessage", label: "Comments for the reviewer", kind: "text", section: "Step 4: Approval - optional", showIf: { field: "approval", equals: true } },
      {
        name: "deployProvider", label: "Deploy provider", kind: "select", default: "skip", section: "Step 5: Deploy - optional",
        options: [
          { value: "skip", label: "Skip deploy stage" },
          { value: "S3", label: "Amazon S3" },
        ],
      },
      { name: "deployBucket", label: "Bucket", kind: "select", options: bucketOptions, section: "Step 5: Deploy - optional", showIf: { field: "deployProvider", equals: "S3" } },
      { name: "deployExtract", label: "Extract file before deploy", kind: "checkbox", default: true, section: "Step 5: Deploy - optional", showIf: { field: "deployProvider", equals: "S3" } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      if (v.buildProvider === "CodeBuild" && !optional(v.buildProject)) throw new Error("Choose a CodeBuild project, or skip the build stage.");
      if (v.deployProvider === "S3" && !optional(v.deployBucket)) throw new Error("Choose a deploy bucket, or skip the deploy stage.");
      if (v.pipelineType === "V1" && v.executionMode === "PARALLEL") throw new Error("Parallel execution mode needs a V2 pipeline.");
      const stages = buildStages({
        sourceProvider: v.sourceProvider === "S3" ? "S3" : "CodeCommit",
        repository: optional(v.repository),
        branch: optional(v.branch),
        sourceBucket: optional(v.sourceBucket),
        sourceKey: optional(v.sourceKey),
        buildProject: v.buildProvider === "CodeBuild" ? optional(v.buildProject) : undefined,
        approval: v.approval === true,
        approvalMessage: optional(v.approvalMessage),
        deployBucket: v.deployProvider === "S3" ? optional(v.deployBucket) : undefined,
        deployExtract: v.deployExtract !== false,
      });
      let bucket: string;
      if (v.artifactStore === "custom") {
        if (!optional(v.artifactBucket)) throw new Error("Choose the artifact store bucket.");
        bucket = String(v.artifactBucket);
      } else bucket = await ensureDefaultBucket(ctx);
      let role: string;
      if (v.roleMode === "existing") {
        if (!optional(v.roleArn)) throw new Error("Choose an existing service role.");
        role = String(v.roleArn);
      } else role = await createRole(ctx, name, optional(v.roleName));
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]).map((t) => ({ key: t.Key, value: t.Value })) : [];
      await ctx.clients.codepipeline.send(
        new CreatePipelineCommand({
          pipeline: {
            name,
            roleArn: role,
            artifactStore: { type: "S3", location: bucket },
            stages,
            pipelineType: (v.pipelineType === "V1" ? "V1" : "V2") as PipelineType,
            executionMode: String(v.executionMode ?? "QUEUED") as ExecutionMode,
          },
          tags: tags.length ? tags : undefined,
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "release",
      label: "Release change",
      confirm: "Starts a new execution with the most recent change from each source.",
      async run(ctx, name) {
        const r = await ctx.clients.codepipeline.send(new StartPipelineExecutionCommand({ name }));
        return { message: `Started execution ${r.pipelineExecutionId ?? "(no ID returned)"}.` };
      },
    },
    {
      id: "edit-tags",
      label: "Edit tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags" }],
      async initialValues(ctx, name) {
        const { arn } = await getPipeline(ctx, name);
        return { tags: arn ? await pipelineTags(ctx, arn) : [] };
      },
      async run(ctx, name, v) {
        const cp = ctx.clients.codepipeline;
        const { arn } = await getPipeline(ctx, name);
        if (!arn) throw new Error("CodePipeline returned no ARN for this pipeline.");
        const d = tagDiff(await pipelineTags(ctx, arn), fieldTags(v.tags));
        if (d.remove.length) await cp.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: d.remove }));
        if (d.set.length) await cp.send(new TagResourceCommand({ resourceArn: arn, tags: d.set.map((t) => ({ key: t.Key, value: t.Value })) }));
        return { message: tagDiffMessage(d) };
      },
    },
    {
      id: "update-structure",
      label: "Edit pipeline structure",
      hidden: true,
      fields: [{ name: "pipeline", label: "Pipeline structure (JSON)", kind: "json", required: true }],
      async initialValues(ctx, name) {
        return { pipeline: JSON.stringify((await getPipeline(ctx, name)).pipeline, null, 2) };
      },
      async run(ctx, name, v) {
        const parsed = JSON.parse(String(v.pipeline)) as PipelineDeclaration;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The structure must be a JSON object.");
        if (parsed.name !== name) throw new Error(`The structure's "name" must stay ${name}.`);
        const r = await ctx.clients.codepipeline.send(new UpdatePipelineCommand({ pipeline: parsed }));
        return { message: `Saved. The pipeline is now at version ${r.pipeline?.version ?? "?"}.` };
      },
    },
    {
      id: "approve",
      label: "Review approval",
      hidden: true,
      fields: [
        { name: "stage", label: "Stage", kind: "text", required: true },
        { name: "action", label: "Action", kind: "text", required: true },
        { name: "token", label: "Token", kind: "text", required: true },
        { name: "status", label: "Decision", kind: "radio", required: true, options: [{ value: "Approved", label: "Approve" }, { value: "Rejected", label: "Reject" }] },
        { name: "summary", label: "Comments", kind: "textarea", validate: { max: 512, message: "At most 512 characters." } },
      ],
      async run(ctx, name, v) {
        const status = v.status === "Rejected" ? "Rejected" : "Approved";
        await ctx.clients.codepipeline.send(
          new PutApprovalResultCommand({ pipelineName: name, stageName: String(v.stage), actionName: String(v.action), token: String(v.token), result: { status, summary: typeof v.summary === "string" ? v.summary : "" } })
        );
        return { message: `${String(v.action)} ${status === "Approved" ? "approved" : "rejected"}.` };
      },
    },
    {
      id: "transition",
      label: "Change transition",
      hidden: true,
      fields: [
        { name: "stage", label: "Stage", kind: "text", required: true },
        { name: "enable", label: "Transition", kind: "radio", required: true, options: [{ value: "enable", label: "Enable" }, { value: "disable", label: "Disable" }] },
        { name: "reason", label: "Reason", kind: "text", validate: { max: 300, message: "At most 300 characters." } },
      ],
      async run(ctx, name, v) {
        const cp = ctx.clients.codepipeline;
        const stage = String(v.stage);
        if (v.enable === "enable") await cp.send(new EnableStageTransitionCommand({ pipelineName: name, stageName: stage, transitionType: "Inbound" }));
        else await cp.send(new DisableStageTransitionCommand({ pipelineName: name, stageName: stage, transitionType: "Inbound", reason: optional(v.reason) ?? "Disabled from the console" }));
        return { message: `Transition into ${stage} ${v.enable === "enable" ? "enabled" : "disabled"}.` };
      },
    },
    {
      id: "retry-stage",
      label: "Retry stage",
      hidden: true,
      fields: [
        { name: "stage", label: "Stage", kind: "text", required: true },
        { name: "executionId", label: "Execution ID", kind: "text", required: true },
        { name: "mode", label: "Retry", kind: "radio", required: true, options: [{ value: "FAILED_ACTIONS", label: "Failed actions" }, { value: "ALL_ACTIONS", label: "All actions" }] },
      ],
      async run(ctx, name, v) {
        await ctx.clients.codepipeline.send(
          new RetryStageExecutionCommand({ pipelineName: name, stageName: String(v.stage), pipelineExecutionId: String(v.executionId), retryMode: v.mode === "ALL_ACTIONS" ? "ALL_ACTIONS" : "FAILED_ACTIONS" })
        );
        return { message: `Retrying ${String(v.stage)}.` };
      },
    },
    {
      id: "stop-execution",
      label: "Stop execution",
      hidden: true,
      danger: true,
      fields: [
        { name: "executionId", label: "Execution ID", kind: "text", required: true },
        { name: "mode", label: "Stop mode", kind: "radio", required: true, options: [{ value: "stop", label: "Stop and wait" }, { value: "abandon", label: "Stop and abandon" }] },
        { name: "reason", label: "Comments", kind: "text", validate: { max: 200, message: "At most 200 characters." } },
      ],
      async run(ctx, name, v) {
        await ctx.clients.codepipeline.send(
          new StopPipelineExecutionCommand({ pipelineName: name, pipelineExecutionId: String(v.executionId), abandon: v.mode === "abandon", reason: optional(v.reason) })
        );
        return { message: `Stopping execution ${String(v.executionId)}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.codepipeline.send(new DeletePipelineCommand({ name }));
    },
  },
  detailHref: "pipelines/{id}",
};

export const codepipelineService: ServiceDef = {
  id: "codepipeline",
  name: "AWS CodePipeline",
  category: "Developer Tools",
  description: "Automate continuous delivery pipelines for fast and reliable application updates.",
  resources: [pipelines],
  notSupported: ["Stage conditions and rule types (ListRuleTypes)"],
};
