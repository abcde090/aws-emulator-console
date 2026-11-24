/** Security Hub CSPM subscription: Settings (enable / disable), and the "not subscribed" check every page uses. */

import { DescribeHubCommand, DisableSecurityHubCommand, EnableSecurityHubCommand, GetEnabledStandardsCommand, ListTagsForResourceCommand, type StandardsSubscription } from "@aws-sdk/client-securityhub";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, ResourceDef } from "../../console/types.ts";

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

function isNotSubscribed(err: unknown): boolean {
  return err instanceof Error && (err.name === "InvalidAccessException" || /not subscribed/i.test(err.message));
}

/** Runs a call that needs the hub; turns "not subscribed" into a clear next step, keeping the API's own words. */
export async function needHub<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isNotSubscribed(err)) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}. Open Settings and choose Enable Security Hub CSPM.`);
    }
    throw err;
  }
}

export async function enabledStandards(ctx: Ctx): Promise<StandardsSubscription[]> {
  const out: StandardsSubscription[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.securityhub.send(new GetEnabledStandardsCommand({ MaxResults: 100, NextToken: token }));
    out.push(...(r.StandardsSubscriptions ?? []));
    token = r.NextToken || undefined;
  } while (token);
  return out;
}

export const hub: ResourceDef = {
  id: "settings",
  name: "Settings",
  singular: "hub",
  idField: "arn",
  nameField: "arn",
  description: "Your Security Hub CSPM subscription in this account and Region.",
  emptyText: "Security Hub CSPM is not enabled.",
  columns: [
    { key: "arn", label: "Hub ARN", kind: "link" },
    { key: "subscribedAt", label: "Subscribed", kind: "date" },
    { key: "autoEnableControls", label: "Auto-enable new controls", kind: "boolean" },
    { key: "generator", label: "Consolidated control findings", kind: "text" },
  ],
  async list(ctx) {
    try {
      const h = await ctx.clients.securityhub.send(new DescribeHubCommand({}));
      return [{ arn: h.HubArn ?? "", subscribedAt: h.SubscribedAt ?? null, autoEnableControls: h.AutoEnableControls ?? null, generator: h.ControlFindingGenerator === "SECURITY_CONTROL" ? "On (SECURITY_CONTROL)" : h.ControlFindingGenerator === "STANDARD_CONTROL" ? "Off (STANDARD_CONTROL)" : h.ControlFindingGenerator ?? null }];
    } catch (err: unknown) {
      if (isNotSubscribed(err)) throw new Error(`Not enabled. DescribeHub says: ${err instanceof Error ? err.message : String(err)}. Choose Enable Security Hub CSPM to subscribe.`);
      throw err;
    }
  },
  async get(ctx, arn) {
    const h = await needHub(() => ctx.clients.securityhub.send(new DescribeHubCommand({ HubArn: arn })));
    // Secondary lookups: a denied or failed call marks only its tab unavailable.
    const [standards, tags] = await Promise.allSettled([enabledStandards(ctx), ctx.clients.securityhub.send(new ListTagsForResourceCommand({ ResourceArn: arn }))]);
    const unavailable = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? `Unavailable: ${errorMessage(r.reason)}` : undefined);
    return {
      summary: { "Hub ARN": h.HubArn, Subscribed: h.SubscribedAt, "Auto-enable new controls": h.AutoEnableControls ?? null, "Control finding generator": h.ControlFindingGenerator ?? null },
      tabs: [
        {
          id: "standards", label: "Enabled standards", kind: "table",
          columns: [{ key: "arn", label: "Standard ARN", kind: "arn" }, { key: "status", label: "Status", kind: "status" }],
          data: standards.status === "fulfilled" ? standards.value.map((s) => ({ arn: s.StandardsArn ?? "", status: s.StandardsStatus ?? null })) : [],
          emptyText: unavailable(standards) ?? "No standards are enabled.",
        },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: tags.status === "fulfilled" ? Object.entries(tags.value.Tags ?? {}).map(([Key, Value]) => ({ Key, Value })) : [], emptyText: unavailable(tags) ?? "No tags." },
      ],
    };
  },
  create: {
    title: "Enable Security Hub CSPM",
    description: "Subscribes this account to Security Hub CSPM in this Region with EnableSecurityHub.",
    fields: [
      { name: "defaultStandards", label: "Enable AWS Foundational Security Best Practices v1.0.0 and CIS AWS Foundations Benchmark v1.2.0", kind: "checkbox", default: true, section: "Security standards", help: "The default standards. You can enable or disable standards later on the Security standards page." },
      {
        name: "generator", label: "Consolidated control findings", kind: "radio", default: "SECURITY_CONTROL", section: "Settings",
        options: [{ value: "SECURITY_CONTROL", label: "On: one finding per control check, across standards" }, { value: "STANDARD_CONTROL", label: "Off: a separate finding for each standard" }],
      },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const tags = Array.isArray(v.tags) ? Object.fromEntries((v.tags as { Key: string; Value: string }[]).map((t) => [t.Key, t.Value])) : {};
      await ctx.clients.securityhub.send(
        new EnableSecurityHubCommand({ EnableDefaultStandards: v.defaultStandards === true, ControlFindingGenerator: v.generator === "STANDARD_CONTROL" ? "STANDARD_CONTROL" : "SECURITY_CONTROL", Tags: Object.keys(tags).length ? tags : undefined })
      );
      const h = await ctx.clients.securityhub.send(new DescribeHubCommand({}));
      if (!h.HubArn) throw new Error("DescribeHub returned no hub ARN after enabling.");
      return h.HubArn;
    },
  },
  delete: {
    confirmText: "delete",
    async run(ctx) {
      await ctx.clients.securityhub.send(new DisableSecurityHubCommand({}));
    },
  },
};
