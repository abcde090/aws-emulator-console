/** Elastic Beanstalk saved configurations (configuration templates). Id = "<application>/<name>". */

import {
  CreateConfigurationTemplateCommand,
  CreateEnvironmentCommand,
  DeleteConfigurationTemplateCommand,
  DescribeConfigurationSettingsCommand,
  UpdateConfigurationTemplateCommand,
  type ConfigurationSettingsDescription,
} from "@aws-sdk/client-elastic-beanstalk";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { ENV_NAME, joinId, splitId } from "./helpers.ts";
import { applications, environment, environmentOptions } from "./lookups.ts";

async function settings(ctx: Ctx, app: string, name: string): Promise<ConfigurationSettingsDescription> {
  const s = (await ctx.clients.elasticbeanstalk.send(new DescribeConfigurationSettingsCommand({ ApplicationName: app, TemplateName: name }))).ConfigurationSettings?.[0];
  if (!s) throw new Error(`Application ${app} has no saved configuration ${name}.`);
  return s;
}

function row(s: ConfigurationSettingsDescription): Row {
  const app = s.ApplicationName ?? "";
  const name = s.TemplateName ?? "";
  return {
    id: joinId(app, name),
    name,
    application: app,
    platform: s.SolutionStackName ?? s.PlatformArn ?? null,
    description: s.Description ?? null,
    createdAt: s.DateCreated ?? null,
    updatedAt: s.DateUpdated ?? null,
  };
}

export const templatesResource: ResourceDef = {
  id: "saved-configurations",
  name: "Saved configurations",
  singular: "saved configuration",
  idField: "id",
  nameField: "name",
  description: "Saved copies of an environment's configuration (platform and option settings) that you can launch new environments from.",
  emptyText: "No saved configurations. Save one from an environment.",
  columns: [
    { key: "name", label: "Configuration name", kind: "link" },
    { key: "application", label: "Application", kind: "text" },
    { key: "platform", label: "Platform", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "createdAt", label: "Date created", kind: "date" },
  ],

  async list(ctx) {
    const apps = await applications(ctx);
    const pairs = apps.flatMap((a) => (a.ConfigurationTemplates ?? []).map((t) => [a.ApplicationName ?? "", t] as const));
    return Promise.all(pairs.map(async ([app, t]) => row(await settings(ctx, app, t))));
  },

  async get(ctx, id) {
    const { app, child } = splitId(id);
    const s = await settings(ctx, app, child);
    const r = row(s);
    return {
      summary: { name: r.name, application: r.application, platform: s.PlatformArn ?? r.platform, description: r.description, createdAt: r.createdAt, updatedAt: r.updatedAt },
      summaryLabels: { name: "Configuration name", application: "Application", platform: "Platform", description: "Description", createdAt: "Date created", updatedAt: "Last modified" },
      tabs: [
        {
          id: "settings",
          label: "Option settings",
          kind: "table",
          columns: [
            { key: "namespace", label: "Namespace", kind: "code" },
            { key: "option", label: "Option", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
          ],
          data: (s.OptionSettings ?? []).map((o) => ({ namespace: o.Namespace ?? null, option: o.OptionName ?? null, value: o.Value ?? null })),
          emptyText: "No option settings.",
        },
      ],
    };
  },

  create: {
    title: "Save configuration",
    description: "Saves an environment's current configuration with CreateConfigurationTemplate.",
    fields: [
      { name: "environment", label: "Environment", kind: "select", required: true, options: environmentOptions },
      { name: "name", label: "Configuration name", kind: "text", required: true, validate: { pattern: "[^/]{1,100}", message: "1-100 characters, no slash." } },
      { name: "description", label: "Description", kind: "text", validate: { max: 200, message: "At most 200 characters." } },
    ],
    async run(ctx, v) {
      const env = await environment(ctx, String(v.environment));
      const app = env.ApplicationName ?? "";
      const name = String(v.name);
      await ctx.clients.elasticbeanstalk.send(
        new CreateConfigurationTemplateCommand({ ApplicationName: app, TemplateName: name, EnvironmentId: env.EnvironmentId, Description: typeof v.description === "string" && v.description ? v.description : undefined })
      );
      return joinId(app, name);
    },
  },

  actions: [
    {
      id: "launch",
      label: "Launch environment",
      fields: [
        { name: "name", label: "Environment name", kind: "text", required: true, validate: { pattern: ENV_NAME, message: "Use 4-40 letters, numbers or hyphens, not starting or ending with a hyphen." } },
        { name: "cname", label: "Domain", kind: "text", help: "Subdomain prefix. Empty: Beanstalk generates one.", validate: { pattern: "[A-Za-z0-9-]{4,63}", message: "4-63 letters, numbers or hyphens." } },
      ],
      async run(ctx, id, v) {
        const { app, child } = splitId(id);
        const r = await ctx.clients.elasticbeanstalk.send(
          new CreateEnvironmentCommand({ ApplicationName: app, EnvironmentName: String(v.name), TemplateName: child, CNAMEPrefix: typeof v.cname === "string" && v.cname ? v.cname : undefined })
        );
        return { message: `Launching environment ${r.EnvironmentName ?? v.name} (${r.EnvironmentId ?? "no ID returned"}). Status: ${r.Status ?? "Launching"}.` };
      },
    },
    {
      id: "description",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "text", validate: { max: 200, message: "At most 200 characters." } }],
      async initialValues(ctx, id) {
        const { app, child } = splitId(id);
        return { description: (await settings(ctx, app, child)).Description ?? "" };
      },
      async run(ctx, id, v) {
        const { app, child } = splitId(id);
        const description = typeof v.description === "string" ? v.description : "";
        if (description === ((await settings(ctx, app, child)).Description ?? "")) return { message: "No changes to save." };
        await ctx.clients.elasticbeanstalk.send(new UpdateConfigurationTemplateCommand({ ApplicationName: app, TemplateName: child, Description: description }));
        return { message: "Description saved." };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { app, child } = splitId(id);
      await ctx.clients.elasticbeanstalk.send(new DeleteConfigurationTemplateCommand({ ApplicationName: app, TemplateName: child }));
    },
  },
};
