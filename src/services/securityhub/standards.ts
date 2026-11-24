/** Security Hub CSPM security standards and controls. */

import {
  BatchDisableStandardsCommand,
  BatchEnableStandardsCommand,
  DescribeStandardsCommand,
  DescribeStandardsControlsCommand,
  GetSecurityControlDefinitionCommand,
  ListSecurityControlDefinitionsCommand,
  UpdateStandardsControlCommand,
  type Standard,
  type StandardsControl,
  type SecurityControlDefinition,
} from "@aws-sdk/client-securityhub";
import type { Ctx, Option, ResourceDef, Row } from "../../console/types.ts";
import { enabledStandards, needHub, str } from "./hub.ts";
import type { StandardsSubscription } from "@aws-sdk/client-securityhub";

const isDenied = (err: unknown) => err instanceof Error && (err.name === "AccessDeniedError" || err.message.startsWith("AccessDenied"));

/** Enabled standards, or null when the caller may not read them (the list still shows the catalogue). */
async function subscriptionsOrNull(ctx: Ctx): Promise<StandardsSubscription[] | null> {
  try {
    return await needHub(() => enabledStandards(ctx));
  } catch (err: unknown) {
    if (isDenied(err)) return null;
    throw err;
  }
}

async function allStandards(ctx: Ctx): Promise<Standard[]> {
  const out: Standard[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.securityhub.send(new DescribeStandardsCommand({ MaxResults: 100, NextToken: token }));
    out.push(...(r.Standards ?? []));
    token = r.NextToken || undefined;
  } while (token);
  return out;
}

async function standardControls(ctx: Ctx, subscriptionArn: string): Promise<StandardsControl[]> {
  const out: StandardsControl[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.securityhub.send(new DescribeStandardsControlsCommand({ StandardsSubscriptionArn: subscriptionArn, MaxResults: 100, NextToken: token }));
    out.push(...(r.Controls ?? []));
    token = r.NextToken || undefined;
  } while (token);
  return out;
}

const CONTROL_COLUMNS = [
  { key: "id", label: "ID", kind: "text" as const },
  { key: "title", label: "Title", kind: "text" as const },
  { key: "severity", label: "Severity", kind: "text" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "reason", label: "Disabled reason", kind: "text" as const },
];

const controlRow = (c: StandardsControl): Row => ({ id: c.ControlId ?? "", title: c.Title ?? "", severity: c.SeverityRating ?? null, status: c.ControlStatus ?? null, reason: c.DisabledReason ?? null, arn: c.StandardsControlArn ?? "" });

export const standards: ResourceDef = {
  id: "standards",
  name: "Security standards",
  singular: "standard",
  idField: "arn",
  nameField: "name",
  description: "Collections of controls that check your resources against best practices and compliance frameworks.",
  emptyText: "DescribeStandards returned no standards.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "description", label: "Description", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    const [all, enabled] = await Promise.all([allStandards(ctx), subscriptionsOrNull(ctx)]);
    return all.map((s) => {
      const sub = enabled?.find((e) => e.StandardsArn === s.StandardsArn);
      const status = !enabled ? "Unavailable" : sub?.StandardsStatus === "READY" ? "Enabled" : sub?.StandardsStatus ?? "Disabled";
      return { arn: s.StandardsArn ?? "", name: s.Name ?? s.StandardsArn ?? "", description: s.Description ?? null, status };
    });
  },
  async get(ctx, arn) {
    const [all, enabled] = await Promise.all([allStandards(ctx), needHub(() => enabledStandards(ctx))]);
    const s = all.find((x) => x.StandardsArn === arn);
    if (!s) throw new Error(`No standard with ARN ${arn}.`);
    const sub = enabled.find((e) => e.StandardsArn === arn);
    const controls = sub?.StandardsSubscriptionArn ? await standardControls(ctx, sub.StandardsSubscriptionArn) : [];
    return {
      summary: { Name: s.Name, Status: sub ? sub.StandardsStatus : "Disabled", ARN: s.StandardsArn, "Subscription ARN": sub?.StandardsSubscriptionArn ?? null, "Enabled by default": s.EnabledByDefault ?? null, Description: s.Description ?? null },
      tabs: [
        {
          id: "controls", label: "Controls", kind: "table", columns: CONTROL_COLUMNS, data: controls.map(controlRow),
          description: sub ? `${controls.filter((c) => c.ControlStatus === "ENABLED").length} of ${controls.length} controls enabled.` : undefined,
          emptyText: sub ? "No controls returned." : "Enable this standard to see its controls.",
        },
      ],
    };
  },
  actions: [
    {
      id: "enable",
      label: "Enable standard",
      availableFor: (row) => !["Enabled", "READY", "PENDING"].includes(String(row.status ?? row.Status)),
      async run(ctx, arn) {
        const r = await needHub(() => ctx.clients.securityhub.send(new BatchEnableStandardsCommand({ StandardsSubscriptionRequests: [{ StandardsArn: arn }] })));
        return { message: `Standard ${r.StandardsSubscriptions?.[0]?.StandardsStatus ?? "requested"}.` };
      },
    },
    {
      id: "disable",
      label: "Disable standard",
      availableFor: (row) => (row.status ?? row.Status) !== "Disabled",
      danger: true,
      confirm: "Disabling a standard stops its control checks and archives its control findings.",
      async run(ctx, arn) {
        const sub = (await needHub(() => enabledStandards(ctx))).find((e) => e.StandardsArn === arn);
        if (!sub?.StandardsSubscriptionArn) throw new Error("This standard isn't enabled.");
        const r = await ctx.clients.securityhub.send(new BatchDisableStandardsCommand({ StandardsSubscriptionArns: [sub.StandardsSubscriptionArn] }));
        return { message: `Standard ${r.StandardsSubscriptions?.[0]?.StandardsStatus ?? "disable requested"}.` };
      },
    },
  ],
};

async function allDefinitions(ctx: Ctx): Promise<SecurityControlDefinition[]> {
  const out: SecurityControlDefinition[] = [];
  let token: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.clients.securityhub.send(new ListSecurityControlDefinitionsCommand({ MaxResults: 100, NextToken: token }));
    out.push(...(r.SecurityControlDefinitions ?? []));
    token = r.NextToken || undefined;
    if (!token) break;
  }
  return out;
}

/** Per enabled standard, the matching control (ControlId equals the security control ID). */
async function controlInStandards(ctx: Ctx, controlId: string): Promise<{ standardArn: string; control: StandardsControl }[]> {
  const subs = await needHub(() => enabledStandards(ctx));
  const found: { standardArn: string; control: StandardsControl }[] = [];
  for (const s of subs) {
    if (!s.StandardsSubscriptionArn || s.StandardsStatus !== "READY") continue;
    const c = (await standardControls(ctx, s.StandardsSubscriptionArn)).find((x) => x.ControlId === controlId);
    if (c) found.push({ standardArn: s.StandardsArn ?? "", control: c });
  }
  return found;
}

async function standardOptions(ctx: Ctx): Promise<Option[]> {
  const subs = await needHub(() => enabledStandards(ctx));
  return subs.filter((s) => s.StandardsArn).map((s) => ({ value: s.StandardsArn as string, label: s.StandardsArn as string }));
}

async function setControl(ctx: Ctx, controlId: string, standardArn: string, enable: boolean, reason: string): Promise<string> {
  const match = (await controlInStandards(ctx, controlId)).filter((m) => standardArn === "" || m.standardArn === standardArn);
  if (match.length === 0) throw new Error(`Control ${controlId} is not part of ${standardArn ? "that standard" : "any enabled standard"}.`);
  for (const m of match) {
    await ctx.clients.securityhub.send(new UpdateStandardsControlCommand({ StandardsControlArn: m.control.StandardsControlArn, ControlStatus: enable ? "ENABLED" : "DISABLED", DisabledReason: enable ? undefined : reason }));
  }
  return `${enable ? "Enabled" : "Disabled"} ${controlId} in ${match.length} standard${match.length === 1 ? "" : "s"}.`;
}

export const controls: ResourceDef = {
  id: "controls",
  name: "Controls",
  singular: "control",
  idField: "id",
  nameField: "id",
  description: "Every security control Security Hub CSPM offers. Open a control to see its status in each enabled standard.",
  emptyText: "ListSecurityControlDefinitions returned no controls.",
  columns: [
    { key: "id", label: "ID", kind: "link" },
    { key: "title", label: "Title", kind: "text" },
    { key: "severity", label: "Severity", kind: "text" },
    { key: "availability", label: "Availability", kind: "text" },
    { key: "parameters", label: "Custom parameters", kind: "boolean" },
  ],
  async list(ctx) {
    return (await allDefinitions(ctx)).map((d) => ({
      id: d.SecurityControlId ?? "", title: d.Title ?? "", severity: d.SeverityRating ?? null, availability: d.CurrentRegionAvailability ?? null,
      parameters: (d.CustomizableProperties ?? []).includes("Parameters"),
    }));
  },
  async get(ctx, id) {
    const r = await ctx.clients.securityhub.send(new GetSecurityControlDefinitionCommand({ SecurityControlId: id }));
    const d = r.SecurityControlDefinition;
    const inStandards = await controlInStandards(ctx, id);
    return {
      summary: { ID: d?.SecurityControlId, Title: d?.Title, Severity: d?.SeverityRating, Availability: d?.CurrentRegionAvailability, Remediation: d?.RemediationUrl ?? null },
      tabs: [
        { id: "description", label: "Description", kind: "text", data: d?.Description ?? "" },
        {
          id: "standards", label: "Standards", kind: "table",
          columns: [{ key: "standard", label: "Standard", kind: "arn" }, { key: "status", label: "Status", kind: "status" }, { key: "reason", label: "Disabled reason", kind: "text" }, { key: "updated", label: "Status updated", kind: "date" }],
          data: inStandards.map((m) => ({ standard: m.standardArn, status: m.control.ControlStatus ?? null, reason: m.control.DisabledReason ?? null, updated: m.control.ControlStatusUpdatedAt ?? null })),
          emptyText: "This control isn't in any enabled standard.",
        },
        { id: "parameters", label: "Parameters", kind: "json", data: d?.ParameterDefinitions ?? null, emptyText: "This control has no parameters." },
      ],
    };
  },
  actions: [
    {
      id: "disable-control",
      label: "Disable control",
      danger: true,
      fields: [
        { name: "standard", label: "Standard", kind: "select", options: standardOptions, help: "Leave empty to disable it in every enabled standard." },
        { name: "reason", label: "Reason for disabling", kind: "textarea", required: true },
      ],
      async run(ctx, id, v) {
        return { message: await setControl(ctx, id, str(v.standard), false, str(v.reason)) };
      },
    },
    {
      id: "enable-control",
      label: "Enable control",
      fields: [{ name: "standard", label: "Standard", kind: "select", options: standardOptions, help: "Leave empty to enable it in every enabled standard." }],
      async run(ctx, id, v) {
        return { message: await setControl(ctx, id, str(v.standard), true, "") };
      },
    },
  ],
};
