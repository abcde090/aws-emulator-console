/**
 * AWS CodeBuild: build projects, build history and report groups. The project screen is
 * hand-built (src/app/codebuild/build-projects/[name]) to link each build run.
 */

import { BatchGetReportGroupsCommand, CreateReportGroupCommand, DeleteReportGroupCommand, ListReportGroupsCommand, type ReportGroup } from "@aws-sdk/client-codebuild";
import type { ResourceDef, ServiceDef, Tag } from "../../console/types.ts";
import { builds } from "./builds.ts";
import { bucketOptions, projects } from "./projects.ts";

async function reportGroupsByArn(ctx: Parameters<ResourceDef["list"]>[0], arns: string[]): Promise<ReportGroup[]> {
  const out: ReportGroup[] = [];
  for (let i = 0; i < arns.length; i += 100) {
    const r = await ctx.clients.codebuild.send(new BatchGetReportGroupsCommand({ reportGroupArns: arns.slice(i, i + 100) }));
    out.push(...(r.reportGroups ?? []));
  }
  return out;
}

const reportArn = (ctx: { region: string; accountId: string }, name: string) => `arn:aws:codebuild:${ctx.region}:${ctx.accountId}:report-group/${name}`;

const reportGroups: ResourceDef = {
  id: "report-groups",
  name: "Report groups",
  singular: "report group",
  idField: "name",
  nameField: "name",
  description: "Report groups collect test and code coverage reports produced by builds.",
  emptyText: "No report groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "export", label: "Export", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "created", label: "Created", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const arns: string[] = [];
    let token: string | undefined;
    do {
      const page = await ctx.clients.codebuild.send(new ListReportGroupsCommand({ nextToken: token }));
      arns.push(...(page.reportGroups ?? []));
      token = page.nextToken;
    } while (token);
    return (await reportGroupsByArn(ctx, arns)).map((g) => ({
      name: g.name ?? "",
      type: g.type === "CODE_COVERAGE" ? "Code coverage" : g.type === "TEST" ? "Test" : g.type ?? null,
      export: g.exportConfig?.exportConfigType === "S3" ? `S3: ${g.exportConfig.s3Destination?.bucket ?? ""}` : "No export",
      status: g.status ?? null,
      created: g.created ?? null,
      arn: g.arn ?? null,
    }));
  },

  async get(ctx, name) {
    const [g] = await reportGroupsByArn(ctx, [reportArn(ctx, name)]);
    if (!g) throw new Error(`Report group ${name} was not found.`);
    const s3 = g.exportConfig?.s3Destination;
    return {
      summary: { name: g.name ?? name, arn: g.arn ?? null, type: g.type ?? null, status: g.status ?? null, created: g.created ?? null, lastModified: g.lastModified ?? null },
      summaryLabels: { name: "Name", arn: "ARN", type: "Report type", status: "Status", created: "Created", lastModified: "Last modified" },
      tabs: [
        {
          id: "export",
          label: "Export configuration",
          kind: "keyvalue",
          data: {
            "Export type": g.exportConfig?.exportConfigType ?? null,
            Bucket: s3?.bucket ?? null,
            "Path prefix": s3?.path ?? null,
            Packaging: s3?.packaging ?? null,
            "Encryption key": s3?.encryptionKey ?? null,
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
          data: (g.tags ?? []).map((t) => ({ Key: t.key ?? "", Value: t.value ?? "" })),
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create report group",
    description: "Creates a report group with CreateReportGroup.",
    fields: [
      { name: "name", label: "Report group name", kind: "text", required: true, section: "Report group configuration", validate: { pattern: "[A-Za-z0-9][A-Za-z0-9_-]{1,127}", message: "2-128 letters, numbers, hyphens or underscores." } },
      {
        name: "type", label: "Report type", kind: "radio", default: "TEST", section: "Report group configuration",
        options: [
          { value: "TEST", label: "Test" },
          { value: "CODE_COVERAGE", label: "Code coverage" },
        ],
      },
      { name: "exportS3", label: "Export to Amazon S3", kind: "checkbox", default: false, section: "Report group export settings" },
      { name: "bucket", label: "Bucket name", kind: "select", options: bucketOptions, section: "Report group export settings", showIf: { field: "exportS3", equals: true } },
      { name: "path", label: "Path prefix", kind: "text", section: "Report group export settings", showIf: { field: "exportS3", equals: true } },
      { name: "zip", label: "Compress test result data in a zip file", kind: "checkbox", default: false, section: "Report group export settings", showIf: { field: "exportS3", equals: true } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const s3 = v.exportS3 === true;
      if (s3 && (typeof v.bucket !== "string" || v.bucket === "")) throw new Error("Choose a bucket to export to.");
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]).map((t) => ({ key: t.Key, value: t.Value })) : [];
      await ctx.clients.codebuild.send(
        new CreateReportGroupCommand({
          name,
          type: v.type === "CODE_COVERAGE" ? "CODE_COVERAGE" : "TEST",
          exportConfig: s3
            ? { exportConfigType: "S3", s3Destination: { bucket: String(v.bucket), path: typeof v.path === "string" && v.path ? v.path : undefined, packaging: v.zip === true ? "ZIP" : "NONE" } }
            : { exportConfigType: "NO_EXPORT" },
          tags: tags.length ? tags : undefined,
        })
      );
      return name;
    },
  },

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.codebuild.send(new DeleteReportGroupCommand({ arn: reportArn(ctx, name), deleteReports: true }));
    },
  },
};

export const codebuildService: ServiceDef = {
  id: "codebuild",
  name: "AWS CodeBuild",
  category: "Developer Tools",
  description: "Build and test code with continuous scaling. Pay only for the build time you use.",
  resources: [projects, builds, reportGroups],
  notSupported: [
    "Report history and test reports (ListReports)",
    "The managed image list (ListCuratedEnvironmentImages); the create form offers the current standard images",
  ],
};
