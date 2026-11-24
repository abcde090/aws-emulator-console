/**
 * ECS account settings: the effective settings (ListAccountSettings with
 * effectiveSettings) and "Update" through PutAccountSettingDefault, as the console's
 * Account settings page does.
 */

import { ListAccountSettingsCommand, PutAccountSettingDefaultCommand, type SettingName } from "@aws-sdk/client-ecs";
import type { Option, ResourceDef, Row } from "../../console/types.ts";

/** Values the console offers per setting. Settings not listed here are shown read-only. */
const SETTING_VALUES: Record<string, { label: string; values: Option[] }> = {
  containerInsights: {
    label: "Container Insights",
    values: [
      { value: "disabled", label: "disabled" },
      { value: "enabled", label: "enabled" },
      { value: "enhanced", label: "enhanced" },
    ],
  },
  awsvpcTrunking: { label: "AWSVPC Trunking", values: [{ value: "enabled", label: "enabled" }, { value: "disabled", label: "disabled" }] },
  fargateTaskRetirementWaitPeriod: { label: "Fargate task retirement wait period (days)", values: ["0", "7", "14"].map((d) => ({ value: d, label: d })) },
  defaultLogDriverMode: { label: "Default log driver mode", values: [{ value: "non-blocking", label: "non-blocking" }, { value: "blocking", label: "blocking" }] },
};

const ALL_VALUES: Option[] = [...new Map(Object.values(SETTING_VALUES).flatMap((s) => s.values).map((o) => [o.value, o])).values()];

export const accountSettings: ResourceDef = {
  id: "account-settings",
  name: "Account settings",
  singular: "account setting",
  idField: "name",
  nameField: "Setting",
  description: "Account-level defaults for Amazon ECS features, such as Container Insights for new clusters and AWSVPC trunking.",
  emptyText: "ListAccountSettings returned no settings.",
  columns: [
    { key: "name", label: "Setting", kind: "link" },
    { key: "label", label: "Description", kind: "text" },
    { key: "value", label: "Value", kind: "text" },
    { key: "type", label: "Set by", kind: "text" },
    { key: "principal", label: "Principal", kind: "arn" },
  ],

  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ecs.send(new ListAccountSettingsCommand({ effectiveSettings: true, nextToken: token, maxResults: 10 }));
      for (const s of r.settings ?? []) {
        rows.push({ name: s.name ?? "", label: SETTING_VALUES[s.name ?? ""]?.label ?? null, value: s.value ?? null, type: s.type === "aws_managed" ? "AWS managed" : "User", principal: s.principalArn ?? null });
      }
      token = r.nextToken;
    } while (token);
    return rows;
  },

  async get(ctx, name) {
    const r = await ctx.clients.ecs.send(new ListAccountSettingsCommand({ effectiveSettings: true, name: name as SettingName }));
    const s = r.settings?.[0];
    if (!s) throw new Error(`Account setting ${name} was not found.`);
    const known = SETTING_VALUES[name];
    return {
      summary: { Setting: s.name ?? name, Description: known?.label ?? null, Value: s.value ?? null, "Set by": s.type === "aws_managed" ? "AWS managed" : "User", Principal: s.principalArn ?? null },
      tabs: [
        {
          id: "values",
          label: "Allowed values",
          kind: "table",
          columns: [{ key: "value", label: "Value", kind: "text" }],
          data: known ? known.values.map((v) => ({ value: v.value })) : [],
          emptyText: "This console doesn't change this setting; it is shown as ECS returned it.",
        },
      ],
    };
  },

  actions: [
    {
      id: "update-default",
      label: "Update account default",
      fields: [
        {
          name: "value", label: "New value", kind: "select", required: true, help: "The values this setting accepts.",
          options: async (_ctx, id) => (id && SETTING_VALUES[id] ? SETTING_VALUES[id].values : ALL_VALUES),
        },
      ],
      availableFor: (row) => String(row.name ?? row.Setting ?? "") in SETTING_VALUES,
      async initialValues(ctx, name) {
        const r = await ctx.clients.ecs.send(new ListAccountSettingsCommand({ effectiveSettings: true, name: name as SettingName }));
        return { value: r.settings?.[0]?.value ?? "" };
      },
      async run(ctx, name, v) {
        const known = SETTING_VALUES[name];
        if (!known) throw new Error(`This console doesn't change ${name}.`);
        const value = String(v.value);
        if (!known.values.some((o) => o.value === value)) throw new Error(`${name} accepts ${known.values.map((o) => o.value).join(", ")}.`);
        const now = await ctx.clients.ecs.send(new ListAccountSettingsCommand({ effectiveSettings: true, name: name as SettingName }));
        if (now.settings?.[0]?.value === value) return { message: "No changes to save." };
        const r = await ctx.clients.ecs.send(new PutAccountSettingDefaultCommand({ name: name as SettingName, value }));
        return { message: `${r.setting?.name ?? name} is now ${r.setting?.value ?? value} for the account.` };
      },
    },
  ],
};
