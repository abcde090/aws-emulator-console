/** Elastic Beanstalk applications: the container for environments, versions and saved configurations. */

import {
  CreateApplicationCommand,
  DeleteApplicationCommand,
  UpdateApplicationCommand,
  UpdateApplicationResourceLifecycleCommand,
  type ApplicationDescription,
} from "@aws-sdk/client-elastic-beanstalk";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { ENV_COLUMNS, envRow } from "./environments.ts";
import { tagList } from "./helpers.ts";
import { applications, environments, roleArnOptions, versions } from "./lookups.ts";
import { manageTagsAction, readTags, tagsTab, tolerantTab } from "./tagging.ts";
import { VERSION_COLUMNS, versionRow } from "./versions.ts";

const APP_NAME = "[^/]{1,100}";

async function application(ctx: Ctx, name: string): Promise<ApplicationDescription> {
  const app = (await applications(ctx, [name]))[0];
  if (!app) throw new Error(`No application named ${name}.`);
  return app;
}

function appRow(a: ApplicationDescription, envCount: number | null): Row {
  return {
    name: a.ApplicationName ?? "",
    environments: envCount,
    description: a.Description ?? null,
    createdAt: a.DateCreated ?? null,
    updatedAt: a.DateUpdated ?? null,
    arn: a.ApplicationArn ?? null,
  };
}

export const applicationsResource: ResourceDef = {
  id: "applications",
  name: "Applications",
  singular: "application",
  idField: "name",
  nameField: "name",
  description: "An application is a logical collection of Elastic Beanstalk components: environments, versions and saved configurations.",
  emptyText: "No applications. Create an application to get started.",
  columns: [
    { key: "name", label: "Application name", kind: "link" },
    { key: "environments", label: "Environments", kind: "count" },
    { key: "description", label: "Description", kind: "text" },
    { key: "createdAt", label: "Date created", kind: "date" },
    { key: "updatedAt", label: "Last modified", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    // The environment count is secondary: a denied DescribeEnvironments leaves it empty.
    const [apps, envs] = await Promise.all([applications(ctx), environments(ctx).catch(() => null)]);
    return apps.map((a) => appRow(a, envs ? envs.filter((e) => e.ApplicationName === a.ApplicationName).length : null));
  },

  async get(ctx, name) {
    const a = await application(ctx, name);
    const life = a.ResourceLifecycleConfig;
    const maxCount = life?.VersionLifecycleConfig?.MaxCountRule;
    const maxAge = life?.VersionLifecycleConfig?.MaxAgeRule;
    const [envTab, versionsTab, tags] = await Promise.all([
      tolerantTab(async () => ({
        id: "environments", label: "Environments", kind: "table" as const,
        columns: ENV_COLUMNS.filter((c) => !c.hidden && c.key !== "application").map((c) => ({ ...c, kind: c.kind === "link" ? "text" : c.kind })),
        data: (await environments(ctx, { ApplicationName: name })).map(envRow), emptyText: "This application has no environments.",
      }), { id: "environments", label: "Environments" }),
      tolerantTab(async () => ({
        id: "versions", label: "Application versions", kind: "table" as const,
        columns: VERSION_COLUMNS.filter((c) => c.key !== "application").map((c) => ({ ...c, kind: c.kind === "link" ? "text" : c.kind })),
        data: (await versions(ctx, name)).map((v) => versionRow(v, [])), emptyText: "This application has no versions.",
      }), { id: "versions", label: "Application versions" }),
      tolerantTab(async () => tagsTab(tagList(await readTags(ctx, a.ApplicationArn)), "This application has no tags."), { id: "tags", label: "Tags" }),
    ]);
    return {
      summary: { name: a.ApplicationName ?? name, description: a.Description ?? null, arn: a.ApplicationArn ?? null, createdAt: a.DateCreated ?? null, updatedAt: a.DateUpdated ?? null },
      summaryLabels: { name: "Application name", description: "Description", arn: "Application ARN", createdAt: "Date created", updatedAt: "Last modified" },
      tabs: [
        envTab,
        versionsTab,
        {
          id: "saved",
          label: "Saved configurations",
          kind: "table",
          columns: [{ key: "name", label: "Name", kind: "text" }],
          data: (a.ConfigurationTemplates ?? []).map((t) => ({ name: t })),
          emptyText: "No saved configurations.",
        },
        {
          id: "lifecycle",
          label: "Application version lifecycle settings",
          kind: "keyvalue",
          data: {
            "Lifecycle policy": maxCount?.Enabled ? `Limit by version count: ${maxCount.MaxCount ?? "-"}` : maxAge?.Enabled ? `Limit by version age: ${maxAge.MaxAgeInDays ?? "-"} days` : "Off",
            "Delete source bundle from S3": maxCount?.Enabled ? maxCount.DeleteSourceFromS3 ?? null : maxAge?.Enabled ? maxAge.DeleteSourceFromS3 ?? null : null,
            "Service role": life?.ServiceRole ?? null,
          },
        },
        tags,
      ],
    };
  },

  create: {
    title: "Create application",
    description: "Creates an application with CreateApplication. Then create an environment for it.",
    fields: [
      { name: "name", label: "Application name", kind: "text", required: true, section: "Application information", placeholder: "my-app", help: "Up to 100 characters, no forward slash (/).", validate: { pattern: APP_NAME, message: "1-100 characters, no slash." } },
      { name: "description", label: "Description", kind: "textarea", section: "Application information", validate: { max: 200, message: "At most 200 characters." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const tags = tagList(v.tags);
      await ctx.clients.elasticbeanstalk.send(
        new CreateApplicationCommand({ ApplicationName: name, Description: typeof v.description === "string" && v.description ? v.description : undefined, Tags: tags.length ? tags : undefined })
      );
      return name;
    },
  },

  actions: [
    {
      id: "description",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "textarea", validate: { max: 200, message: "At most 200 characters." } }],
      async initialValues(ctx, name) {
        return { description: (await application(ctx, name)).Description ?? "" };
      },
      async run(ctx, name, v) {
        const description = typeof v.description === "string" ? v.description : "";
        if (description === ((await application(ctx, name)).Description ?? "")) return { message: "No changes to save." };
        await ctx.clients.elasticbeanstalk.send(new UpdateApplicationCommand({ ApplicationName: name, Description: description }));
        return { message: "Description saved." };
      },
    },
    {
      id: "lifecycle",
      label: "Edit application version lifecycle settings",
      fields: [
        { name: "rule", label: "Lifecycle policy", kind: "radio", default: "off", options: [{ value: "off", label: "Off" }, { value: "count", label: "Limit by version count" }, { value: "age", label: "Limit by version age" }] },
        { name: "maxCount", label: "Maximum versions", kind: "number", default: 200, showIf: { field: "rule", equals: "count" }, validate: { min: 1, max: 1000, message: "Between 1 and 1000." } },
        { name: "maxAge", label: "Maximum age (days)", kind: "number", default: 180, showIf: { field: "rule", equals: "age" }, validate: { min: 1, max: 1000, message: "Between 1 and 1000." } },
        { name: "deleteSource", label: "Delete source bundle from S3", kind: "checkbox", default: false },
        {
          name: "serviceRole", label: "Service role", kind: "select", options: roleArnOptions,
          help: "The role Elastic Beanstalk assumes to delete old versions (e.g. aws-elasticbeanstalk-service-role). Needed the first time you turn a policy on; empty keeps the current role.",
        },
      ],
      async initialValues(ctx, name) {
        const life = (await application(ctx, name)).ResourceLifecycleConfig;
        const count = life?.VersionLifecycleConfig?.MaxCountRule;
        const age = life?.VersionLifecycleConfig?.MaxAgeRule;
        return {
          rule: count?.Enabled ? "count" : age?.Enabled ? "age" : "off",
          maxCount: count?.MaxCount ?? 200,
          maxAge: age?.MaxAgeInDays ?? 180,
          deleteSource: (count?.Enabled ? count.DeleteSourceFromS3 : age?.Enabled ? age.DeleteSourceFromS3 : false) === true,
          serviceRole: life?.ServiceRole ?? "",
        };
      },
      async run(ctx, name, v) {
        const del = v.deleteSource === true;
        const role = typeof v.serviceRole === "string" && v.serviceRole ? v.serviceRole : undefined;
        const life = (await application(ctx, name)).ResourceLifecycleConfig;
        const count = life?.VersionLifecycleConfig?.MaxCountRule;
        const age = life?.VersionLifecycleConfig?.MaxAgeRule;
        // The rule the user chose gets the form's values; the other keeps its stored values, turned off.
        const config = {
          ServiceRole: role ?? life?.ServiceRole,
          VersionLifecycleConfig: {
            MaxCountRule: v.rule === "count"
              ? { Enabled: true, MaxCount: typeof v.maxCount === "number" ? v.maxCount : count?.MaxCount ?? 200, DeleteSourceFromS3: del }
              : { Enabled: false, MaxCount: count?.MaxCount ?? 200, DeleteSourceFromS3: count?.DeleteSourceFromS3 ?? false },
            MaxAgeRule: v.rule === "age"
              ? { Enabled: true, MaxAgeInDays: typeof v.maxAge === "number" ? v.maxAge : age?.MaxAgeInDays ?? 180, DeleteSourceFromS3: del }
              : { Enabled: false, MaxAgeInDays: age?.MaxAgeInDays ?? 180, DeleteSourceFromS3: age?.DeleteSourceFromS3 ?? false },
          },
        };
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
        if (life && config.ServiceRole === life.ServiceRole && same(config.VersionLifecycleConfig.MaxCountRule, { Enabled: count?.Enabled ?? false, MaxCount: count?.MaxCount ?? 200, DeleteSourceFromS3: count?.DeleteSourceFromS3 ?? false })
          && same(config.VersionLifecycleConfig.MaxAgeRule, { Enabled: age?.Enabled ?? false, MaxAgeInDays: age?.MaxAgeInDays ?? 180, DeleteSourceFromS3: age?.DeleteSourceFromS3 ?? false })) {
          return { message: "No changes to save." };
        }
        await ctx.clients.elasticbeanstalk.send(new UpdateApplicationResourceLifecycleCommand({ ApplicationName: name, ResourceLifecycleConfig: config }));
        return { message: "Lifecycle settings saved." };
      },
    },
    manageTagsAction(async (ctx, name) => (await application(ctx, name)).ApplicationArn ?? ""),
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.elasticbeanstalk.send(new DeleteApplicationCommand({ ApplicationName: name, TerminateEnvByForce: true }));
    },
  },
};
