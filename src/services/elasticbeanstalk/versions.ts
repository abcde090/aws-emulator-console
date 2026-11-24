/** Elastic Beanstalk application versions. Id = "<application>/<version label>". */

import {
  CreateApplicationVersionCommand,
  DeleteApplicationVersionCommand,
  UpdateApplicationVersionCommand,
  UpdateEnvironmentCommand,
  type ApplicationVersionDescription,
  type EnvironmentDescription,
} from "@aws-sdk/client-elastic-beanstalk";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { joinId, splitId, tagList } from "./helpers.ts";
import { applicationOptions, bucketOptions, environment, environmentOptions, environments, versions } from "./lookups.ts";
import { manageTagsAction, readTags, tagsTab, tolerantTab } from "./tagging.ts";

async function version(ctx: Ctx, id: string): Promise<ApplicationVersionDescription> {
  const { app, child } = splitId(id);
  const v = (await versions(ctx, app)).find((x) => x.VersionLabel === child);
  if (!v) throw new Error(`Application ${app} has no version ${child}.`);
  return v;
}

export function versionRow(v: ApplicationVersionDescription, envs: EnvironmentDescription[]): Row {
  const app = v.ApplicationName ?? "";
  const label = v.VersionLabel ?? "";
  return {
    id: joinId(app, label),
    label,
    application: app,
    description: v.Description ?? null,
    createdAt: v.DateCreated ?? null,
    source: v.SourceBundle?.S3Bucket ? `s3://${v.SourceBundle.S3Bucket}/${v.SourceBundle.S3Key ?? ""}` : null,
    status: v.Status ?? null,
    deployedTo: envs.filter((e) => e.ApplicationName === app && e.VersionLabel === label).map((e) => e.EnvironmentName ?? "").join(", ") || null,
    arn: v.ApplicationVersionArn ?? null,
  };
}

export const VERSION_COLUMNS = [
  { key: "label", label: "Version label", kind: "link" as const },
  { key: "application", label: "Application", kind: "text" as const },
  { key: "description", label: "Description", kind: "text" as const },
  { key: "createdAt", label: "Date created", kind: "date" as const },
  { key: "source", label: "Source", kind: "code" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "deployedTo", label: "Deployed to", kind: "text" as const },
];

export const versionsResource: ResourceDef = {
  id: "application-versions",
  name: "Application versions",
  singular: "application version",
  idField: "id",
  nameField: "label",
  description: "Labelled iterations of an application's deployable code (a source bundle in S3). Deploy a version to an environment.",
  emptyText: "No application versions. Create one, or create an environment with the sample application.",
  columns: VERSION_COLUMNS,

  async list(ctx) {
    // "Deployed to" is secondary: a denied DescribeEnvironments leaves it empty.
    const [vers, envs] = await Promise.all([versions(ctx), environments(ctx).catch(() => [])]);
    return vers.map((v) => versionRow(v, envs));
  },

  async get(ctx, id) {
    const v = await version(ctx, id);
    const [envs, tags] = await Promise.all([
      environments(ctx, { ApplicationName: v.ApplicationName }).catch(() => []),
      tolerantTab(async () => tagsTab(tagList(await readTags(ctx, v.ApplicationVersionArn)), "This version has no tags."), { id: "tags", label: "Tags" }),
    ]);
    const r = versionRow(v, envs);
    return {
      summary: { label: r.label, application: r.application, description: r.description, status: r.status, source: r.source, deployedTo: r.deployedTo, createdAt: r.createdAt, updatedAt: v.DateUpdated ?? null, arn: r.arn },
      summaryLabels: { label: "Version label", application: "Application", description: "Description", status: "Status", source: "Source bundle", deployedTo: "Deployed to", createdAt: "Date created", updatedAt: "Last modified", arn: "ARN" },
      tabs: [
        {
          id: "build",
          label: "Build",
          kind: "keyvalue",
          data: {
            "Source build (CodeBuild ARN)": v.BuildArn ?? "None",
            "Source repository": v.SourceBuildInformation ? `${v.SourceBuildInformation.SourceRepository ?? ""} ${v.SourceBuildInformation.SourceLocation ?? ""}` : "None (S3 bundle)",
          },
        },
        tags,
      ],
    };
  },

  create: {
    title: "Create application version",
    description: "Creates an application version with CreateApplicationVersion. With no source bundle, Elastic Beanstalk uses its sample application.",
    fields: [
      { name: "application", label: "Application", kind: "select", required: true, options: applicationOptions, section: "Application version" },
      { name: "label", label: "Version label", kind: "text", required: true, placeholder: "v1", section: "Application version", help: "Unique within the application. Up to 100 characters, no slash.", validate: { pattern: "[^/]{1,100}", message: "1-100 characters, no slash." } },
      { name: "description", label: "Description", kind: "text", section: "Application version", validate: { max: 200, message: "At most 200 characters." } },
      {
        name: "source", label: "Source", kind: "radio", default: "sample", section: "Source bundle",
        options: [{ value: "sample", label: "Sample application" }, { value: "s3", label: "Amazon S3 object (a .zip or .war in a bucket)" }],
      },
      { name: "bucket", label: "S3 bucket", kind: "select", required: true, options: bucketOptions, section: "Source bundle", showIf: { field: "source", equals: "s3" } },
      { name: "key", label: "S3 key", kind: "text", required: true, placeholder: "app.zip", section: "Source bundle", showIf: { field: "source", equals: "s3" } },
      { name: "process", label: "Process (validate) the source bundle", kind: "checkbox", default: false, section: "Source bundle", help: "Validates the bundle now. A version must be processed before ComposeEnvironments can use it." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const app = String(v.application);
      const label = String(v.label);
      const tags = tagList(v.tags);
      await ctx.clients.elasticbeanstalk.send(
        new CreateApplicationVersionCommand({
          ApplicationName: app,
          VersionLabel: label,
          Description: typeof v.description === "string" && v.description ? v.description : undefined,
          SourceBundle: v.source === "s3" ? { S3Bucket: String(v.bucket), S3Key: String(v.key) } : undefined,
          Process: v.process === true,
          Tags: tags.length ? tags : undefined,
        })
      );
      return joinId(app, label);
    },
  },

  actions: [
    {
      id: "deploy",
      label: "Deploy",
      fields: [{ name: "environment", label: "Environment", kind: "select", required: true, options: environmentOptions, help: "An environment of the same application." }],
      async run(ctx, id, v) {
        const { app, child } = splitId(id);
        const env = await environment(ctx, String(v.environment));
        if (env.ApplicationName !== app) throw new Error(`${env.EnvironmentName ?? "That environment"} belongs to application ${env.ApplicationName ?? "?"}, not ${app}.`);
        const r = await ctx.clients.elasticbeanstalk.send(new UpdateEnvironmentCommand({ EnvironmentId: env.EnvironmentId, VersionLabel: child }));
        return { message: `Deploying ${child} to ${env.EnvironmentName ?? ""}. Environment status: ${r.Status ?? "Updating"}.` };
      },
    },
    {
      id: "description",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "text", validate: { max: 200, message: "At most 200 characters." } }],
      async initialValues(ctx, id) {
        return { description: (await version(ctx, id)).Description ?? "" };
      },
      async run(ctx, id, v) {
        const { app, child } = splitId(id);
        const description = typeof v.description === "string" ? v.description : "";
        if (description === ((await version(ctx, id)).Description ?? "")) return { message: "No changes to save." };
        await ctx.clients.elasticbeanstalk.send(new UpdateApplicationVersionCommand({ ApplicationName: app, VersionLabel: child, Description: description }));
        return { message: "Description saved." };
      },
    },
    manageTagsAction(async (ctx, id) => (await version(ctx, id)).ApplicationVersionArn ?? ""),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { app, child } = splitId(id);
      await ctx.clients.elasticbeanstalk.send(new DeleteApplicationVersionCommand({ ApplicationName: app, VersionLabel: child }));
    },
  },
};
