/** Small, pure helpers for CodePipeline: building stage declarations and wording statuses. */

import type { StageDeclaration } from "@aws-sdk/client-codepipeline";

export const PIPELINE_NAME = "[A-Za-z0-9.@_-]{1,100}";

export interface StageChoices {
  sourceProvider: "CodeCommit" | "S3";
  repository?: string;
  branch?: string;
  sourceBucket?: string;
  sourceKey?: string;
  buildProject?: string;
  approval: boolean;
  approvalMessage?: string;
  deployBucket?: string;
  deployExtract?: boolean;
}

/** The stages the console's create wizard produces: Source, then optional Build, Approval and Deploy. */
export function buildStages(c: StageChoices): StageDeclaration[] {
  const stages: StageDeclaration[] = [];
  if (c.sourceProvider === "CodeCommit") {
    if (!c.repository) throw new Error("Choose a CodeCommit repository.");
    stages.push({
      name: "Source",
      actions: [
        {
          name: "Source",
          actionTypeId: { category: "Source", owner: "AWS", provider: "CodeCommit", version: "1" },
          configuration: { RepositoryName: c.repository, BranchName: c.branch || "main", PollForSourceChanges: "false", OutputArtifactFormat: "CODE_ZIP" },
          outputArtifacts: [{ name: "SourceArtifact" }],
          runOrder: 1,
        },
      ],
    });
  } else {
    if (!c.sourceBucket || !c.sourceKey) throw new Error("Choose a source bucket and enter the S3 object key.");
    stages.push({
      name: "Source",
      actions: [
        {
          name: "Source",
          actionTypeId: { category: "Source", owner: "AWS", provider: "S3", version: "1" },
          configuration: { S3Bucket: c.sourceBucket, S3ObjectKey: c.sourceKey, PollForSourceChanges: "false" },
          outputArtifacts: [{ name: "SourceArtifact" }],
          runOrder: 1,
        },
      ],
    });
  }
  let latest = "SourceArtifact";
  if (c.buildProject) {
    stages.push({
      name: "Build",
      actions: [
        {
          name: "Build",
          actionTypeId: { category: "Build", owner: "AWS", provider: "CodeBuild", version: "1" },
          configuration: { ProjectName: c.buildProject },
          inputArtifacts: [{ name: "SourceArtifact" }],
          outputArtifacts: [{ name: "BuildArtifact" }],
          runOrder: 1,
        },
      ],
    });
    latest = "BuildArtifact";
  }
  if (c.approval) {
    stages.push({
      name: "Approval",
      actions: [
        {
          name: "ManualApproval",
          actionTypeId: { category: "Approval", owner: "AWS", provider: "Manual", version: "1" },
          configuration: c.approvalMessage ? { CustomData: c.approvalMessage } : undefined,
          runOrder: 1,
        },
      ],
    });
  }
  if (c.deployBucket) {
    stages.push({
      name: "Deploy",
      actions: [
        {
          name: "Deploy",
          actionTypeId: { category: "Deploy", owner: "AWS", provider: "S3", version: "1" },
          configuration: { BucketName: c.deployBucket, Extract: c.deployExtract === false ? "false" : "true", ...(c.deployExtract === false ? { ObjectKey: "artifact.zip" } : {}) },
          inputArtifacts: [{ name: latest }],
          runOrder: 1,
        },
      ],
    });
  }
  if (stages.length < 2) throw new Error("A pipeline needs at least two stages: add a build, approval or deploy stage.");
  return stages;
}

/** "InProgress" -> "In progress", the console's wording. */
export function statusText(s: unknown): string {
  if (typeof s !== "string" || s === "") return "-";
  return s === "InProgress" ? "In progress" : s;
}

export type Tone = "success" | "error" | "pending" | "warning" | "neutral";

export function pipelineTone(s: unknown): Tone {
  switch (s) {
    case "Succeeded":
      return "success";
    case "Failed":
    case "Abandoned":
      return "error";
    case "InProgress":
    case "Stopping":
      return "pending";
    case "Stopped":
    case "Superseded":
    case "Cancelled":
      return "warning";
    default:
      return "neutral";
  }
}

export function defaultArtifactBucket(region: string, account: string): string {
  return `codepipeline-${region}-${account}`;
}

export function defaultPipelineRoleName(region: string, pipeline: string): string {
  return `AWSCodePipelineServiceRole-${region}-${pipeline}`.slice(0, 64);
}

export const CODEPIPELINE_TRUST_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "codepipeline.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

/** Permissions the console's new pipeline role needs for the providers this form offers. */
export const CODEPIPELINE_BASE_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    { Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion", "s3:GetBucketVersioning", "s3:GetBucketAcl", "s3:GetBucketLocation", "s3:PutObject", "s3:PutObjectAcl"], Resource: "*" },
    { Effect: "Allow", Action: ["codecommit:GetBranch", "codecommit:GetCommit", "codecommit:GetRepository", "codecommit:UploadArchive", "codecommit:GetUploadArchiveStatus", "codecommit:CancelUploadArchive"], Resource: "*" },
    { Effect: "Allow", Action: ["codebuild:BatchGetBuilds", "codebuild:StartBuild", "codebuild:BatchGetBuildBatches", "codebuild:StartBuildBatch"], Resource: "*" },
  ],
});
