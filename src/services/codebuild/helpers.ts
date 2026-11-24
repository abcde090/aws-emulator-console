/** Small, pure helpers for CodeBuild values. */

import type { Option, Tag } from "../../console/types.ts";

export const PROJECT_NAME = "[A-Za-z0-9][A-Za-z0-9_-]{1,254}";

export const DEFAULT_BUILDSPEC = `version: 0.2

phases:
  build:
    commands:
      - echo "Hello from CodeBuild"
`;

/** The managed images the console offers today (the emulator doesn't implement ListCuratedEnvironmentImages). */
export const MANAGED_IMAGES: Option[] = [
  { value: "aws/codebuild/amazonlinux-x86_64-standard:5.0", label: "Amazon Linux x86_64 standard:5.0" },
  { value: "aws/codebuild/amazonlinux-aarch64-standard:3.0", label: "Amazon Linux aarch64 standard:3.0" },
  { value: "aws/codebuild/standard:7.0", label: "Ubuntu standard:7.0" },
  { value: "aws/codebuild/standard:6.0", label: "Ubuntu standard:6.0" },
];

export const COMPUTE_TYPES: Option[] = [
  { value: "BUILD_GENERAL1_SMALL", label: "3 GB memory, 2 vCPUs (BUILD_GENERAL1_SMALL)" },
  { value: "BUILD_GENERAL1_MEDIUM", label: "7 GB memory, 4 vCPUs (BUILD_GENERAL1_MEDIUM)" },
  { value: "BUILD_GENERAL1_LARGE", label: "15 GB memory, 8 vCPUs (BUILD_GENERAL1_LARGE)" },
];

const SOURCE_LABELS: Record<string, string> = {
  NO_SOURCE: "No source",
  CODECOMMIT: "AWS CodeCommit",
  S3: "Amazon S3",
  CODEPIPELINE: "AWS CodePipeline",
  GITHUB: "GitHub",
  GITHUB_ENTERPRISE: "GitHub Enterprise",
  BITBUCKET: "Bitbucket",
  GITLAB: "GitLab",
};

export function sourceLabel(type: unknown): string {
  return typeof type === "string" ? SOURCE_LABELS[type] ?? type : "-";
}

export function codecommitUrl(region: string, repo: string): string {
  return `https://git-codecommit.${region}.amazonaws.com/v1/repos/${repo}`;
}

/** The repository or bucket a source location names, for the list's Repository column. */
export function sourceRepository(type: unknown, location: unknown): string | null {
  if (typeof location !== "string" || location === "") return null;
  if (type === "CODECOMMIT") return location.slice(location.lastIndexOf("/") + 1);
  return location;
}

/** "project:uuid" -> the project name and the build's UUID. */
export function splitBuildId(id: string): { project: string; uuid: string } | null {
  const i = id.lastIndexOf(":");
  if (i <= 0 || i === id.length - 1) return null;
  return { project: id.slice(0, i), uuid: id.slice(i + 1) };
}

export function durationSeconds(start: unknown, end: unknown): number | null {
  const s = start instanceof Date ? start.getTime() : typeof start === "string" ? Date.parse(start) : NaN;
  const e = end instanceof Date ? end.getTime() : typeof end === "string" ? Date.parse(end) : NaN;
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
  return Math.round((e - s) / 1000);
}

/** 75 -> "1 minute 15 seconds", the way the console writes durations. */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const sec = `${s} second${s === 1 ? "" : "s"}`;
  return m > 0 ? `${m} minute${m === 1 ? "" : "s"} ${sec}` : sec;
}

/** The console's environment-variable editor rows -> PLAINTEXT variables. */
export function envVarsFromTags(v: unknown): { name: string; value: string; type: "PLAINTEXT" }[] {
  return (Array.isArray(v) ? (v as Tag[]) : []).filter((t) => t.Key !== "").map((t) => ({ name: t.Key, value: t.Value, type: "PLAINTEXT" as const }));
}

export function defaultRoleName(project: string): string {
  return `codebuild-${project}-service-role`.slice(0, 64);
}

export const CODEBUILD_TRUST_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "codebuild.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

/** The base permissions the console gives a new CodeBuild service role. */
export function codebuildBasePolicy(region: string, account: string, project: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: [`arn:aws:logs:${region}:${account}:log-group:/aws/codebuild/${project}`, `arn:aws:logs:${region}:${account}:log-group:/aws/codebuild/${project}:*`],
      },
      { Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:GetBucketAcl", "s3:GetBucketLocation"], Resource: ["arn:aws:s3:::*"] },
      { Effect: "Allow", Action: ["codecommit:GitPull"], Resource: [`arn:aws:codecommit:${region}:${account}:*`] },
      {
        Effect: "Allow",
        Action: ["codebuild:CreateReportGroup", "codebuild:CreateReport", "codebuild:UpdateReport", "codebuild:BatchPutTestCases", "codebuild:BatchPutCodeCoverages"],
        Resource: [`arn:aws:codebuild:${region}:${account}:report-group/${project}-*`],
      },
    ],
  });
}
