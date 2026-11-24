/** API Gateway API keys and usage plans (REST APIs only, as in the console). */

import { secondary, unavailableText } from "../../console/secondary.ts";
import {
  CreateApiKeyCommand,
  CreateUsagePlanCommand,
  CreateUsagePlanKeyCommand,
  DeleteApiKeyCommand,
  DeleteUsagePlanCommand,
  DeleteUsagePlanKeyCommand,
  GetApiKeyCommand,
  GetApiKeysCommand,
  GetUsagePlanCommand,
  GetUsagePlanKeysCommand,
  GetUsagePlansCommand,
  UpdateApiKeyCommand,
  UpdateUsagePlanCommand,
  type ApiKey,
  type PatchOperation,
  type QuotaPeriodType,
  type UsagePlan,
  type UsagePlanKey,
} from "@aws-sdk/client-api-gateway";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { optText, restPages, restStageOptions, splitApiStage, tagRows, tagsRecord, TAG_COLUMNS } from "./common.ts";

async function allKeys(ctx: Ctx): Promise<ApiKey[]> {
  const out: ApiKey[] = [];
  let position: string | undefined;
  do {
    const r = await ctx.clients.apigateway.send(new GetApiKeysCommand({ limit: 500, position, includeValues: false }));
    out.push(...(r.items ?? []));
    position = r.position;
  } while (position);
  return out;
}

async function allPlans(ctx: Ctx): Promise<UsagePlan[]> {
  const out: UsagePlan[] = [];
  let position: string | undefined;
  do {
    const r = await ctx.clients.apigateway.send(new GetUsagePlansCommand({ limit: 500, position }));
    out.push(...(r.items ?? []));
    position = r.position;
  } while (position);
  return out;
}

const planKeys = (ctx: Ctx, usagePlanId: string): Promise<UsagePlanKey[]> =>
  restPages((position) => ctx.clients.apigateway.send(new GetUsagePlanKeysCommand({ usagePlanId, limit: 500, position })));

const keyOptions = async (ctx: Ctx): Promise<Option[]> => (await allKeys(ctx)).filter((k) => k.id).map((k) => ({ value: k.id as string, label: `${k.name ?? k.id} (${k.id})` }));
const planOptions = async (ctx: Ctx): Promise<Option[]> => (await allPlans(ctx)).filter((p) => p.id).map((p) => ({ value: p.id as string, label: `${p.name ?? p.id} (${p.id})` }));

export const apiKeys: ResourceDef = {
  id: "api-keys",
  name: "API keys",
  singular: "API key",
  idField: "id",
  nameField: "Name",
  description: "API keys identify callers of REST API methods that require a key. Add a key to a usage plan to throttle and meter it.",
  emptyText: "You don't have any API keys.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "id", label: "API key ID", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "description", label: "Description", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
  ],

  async list(ctx) {
    return (await allKeys(ctx)).map((k) => ({ id: k.id ?? "", name: k.name ?? k.id ?? "", status: k.enabled ? "Active" : "Inactive", description: k.description ?? null, created: k.createdDate ?? null }));
  },

  async get(ctx, id) {
    const k = await ctx.clients.apigateway.send(new GetApiKeyCommand({ apiKey: id, includeValue: true }));
    // Which plans hold this key: a secondary lookup that may be denied without failing the page.
    const inPlansR = await secondary(
      allPlans(ctx).then((plans) =>
        Promise.all(plans.map(async (p) => ((await planKeys(ctx, p.id ?? "")).some((x) => x.id === id) ? p : null)))
      )
    );
    return {
      summary: { Name: k.name ?? id, "API key ID": id, Status: k.enabled ? "Active" : "Inactive", Description: k.description ?? null, Created: k.createdDate ?? null, "Last updated": k.lastUpdatedDate ?? null },
      tabs: [
        { id: "key", label: "API key", kind: "keyvalue", data: { "API key": k.value ?? null, "Customer ID": k.customerId ?? null }, description: "Callers send this value in the x-api-key header." },
        {
          id: "plans",
          label: "Associated usage plans",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "id", label: "Usage plan ID", kind: "text" },
          ],
          data: inPlansR.ok ? inPlansR.value.filter((p): p is UsagePlan => p !== null).map((p) => ({ name: p.name ?? "", id: p.id ?? "" })) : [],
          emptyText: unavailableText(inPlansR, "This key is not in any usage plan."),
        },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(k.tags), emptyText: "No tags." },
      ],
    };
  },

  create: {
    title: "Create API key",
    description: "Creates an API key with CreateApiKey.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "API key details", validate: { pattern: "[^\\s].{0,127}", message: "1-128 characters." } },
      { name: "description", label: "Description", kind: "text", section: "API key details" },
      {
        name: "generate", label: "API key", kind: "radio", default: "auto", section: "API key details",
        options: [
          { value: "auto", label: "Auto generate" },
          { value: "custom", label: "Custom" },
        ],
      },
      { name: "value", label: "Custom API key value", kind: "text", required: true, section: "API key details", showIf: { field: "generate", equals: "custom" }, validate: { pattern: "[A-Za-z0-9]{20,128}", message: "20-128 letters and numbers." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.apigateway.send(
        new CreateApiKeyCommand({ name: String(v.name), description: optText(v.description), enabled: true, value: v.generate === "custom" ? String(v.value) : undefined, tags: tagsRecord(v.tags) })
      );
      if (!r.id) throw new Error("CreateApiKey returned no ID.");
      return r.id;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit",
      fields: [
        { name: "name", label: "Name", kind: "text", required: true },
        { name: "description", label: "Description", kind: "text" },
        { name: "enabled", label: "Active", kind: "checkbox", default: true, help: "Inactive keys are refused by every API." },
      ],
      async initialValues(ctx, id) {
        const k = await ctx.clients.apigateway.send(new GetApiKeyCommand({ apiKey: id, includeValue: false }));
        return { name: k.name ?? "", description: k.description ?? "", enabled: k.enabled === true };
      },
      async run(ctx, id, v) {
        await ctx.clients.apigateway.send(
          new UpdateApiKeyCommand({
            apiKey: id,
            patchOperations: [
              { op: "replace", path: "/name", value: String(v.name) },
              { op: "replace", path: "/description", value: optText(v.description) ?? "" },
              { op: "replace", path: "/enabled", value: v.enabled === true ? "true" : "false" },
            ],
          })
        );
        return { message: `Saved API key ${String(v.name)}.` };
      },
    },
    {
      id: "add-to-plan",
      label: "Add to usage plan",
      fields: [{ name: "planId", label: "Usage plan", kind: "select", required: true, options: planOptions }],
      async run(ctx, id, v) {
        await ctx.clients.apigateway.send(new CreateUsagePlanKeyCommand({ usagePlanId: String(v.planId), keyId: id, keyType: "API_KEY" }));
        return { message: `Added the key to usage plan ${String(v.planId)}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.apigateway.send(new DeleteApiKeyCommand({ apiKey: id }));
    },
  },
};

const limitFields: FieldDef[] = [
  { name: "throttling", label: "Enable throttling", kind: "checkbox", default: true, section: "Throttling" },
  { name: "rate", label: "Rate", kind: "number", default: 10, required: true, section: "Throttling", showIf: { field: "throttling", equals: true }, help: "Requests per second.", validate: { min: 0, max: 1000000, message: "A rate of 0 or more." } },
  { name: "burst", label: "Burst", kind: "number", default: 20, required: true, section: "Throttling", showIf: { field: "throttling", equals: true }, help: "Most concurrent requests.", validate: { min: 0, max: 1000000, message: "A burst of 0 or more." } },
  { name: "quota", label: "Enable quota", kind: "checkbox", default: true, section: "Quota" },
  { name: "limit", label: "Requests", kind: "number", default: 1000, required: true, section: "Quota", showIf: { field: "quota", equals: true }, validate: { min: 1, max: 1000000000, message: "At least 1 request." } },
  {
    name: "period", label: "Per", kind: "select", default: "MONTH", required: true, section: "Quota", showIf: { field: "quota", equals: true },
    options: [
      { value: "DAY", label: "Day" },
      { value: "WEEK", label: "Week" },
      { value: "MONTH", label: "Month" },
    ],
  },
];

const period = (v: unknown): QuotaPeriodType => (v === "DAY" ? "DAY" : v === "WEEK" ? "WEEK" : "MONTH");

/** Patch operations for only what changed between the plan and the submitted limits. */
function limitPatch(p: UsagePlan, v: FieldValues): PatchOperation[] {
  const ops: PatchOperation[] = [];
  const hasThrottle = p.throttle?.rateLimit !== undefined || p.throttle?.burstLimit !== undefined;
  if (v.throttling === true) {
    if (p.throttle?.rateLimit !== Number(v.rate)) ops.push({ op: "replace", path: "/throttle/rateLimit", value: String(v.rate) });
    if (p.throttle?.burstLimit !== Number(v.burst)) ops.push({ op: "replace", path: "/throttle/burstLimit", value: String(v.burst) });
  } else if (hasThrottle) ops.push({ op: "remove", path: "/throttle" });
  if (v.quota === true) {
    if (p.quota?.limit !== Number(v.limit)) ops.push({ op: "replace", path: "/quota/limit", value: String(v.limit) });
    if (p.quota?.period !== period(v.period)) ops.push({ op: "replace", path: "/quota/period", value: period(v.period) });
  } else if (p.quota?.limit !== undefined) ops.push({ op: "remove", path: "/quota" });
  return ops;
}

/** This plan's associated stages, as "apiId/stage" choices. */
async function planStageOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  if (!id) return [];
  const p = await ctx.clients.apigateway.send(new GetUsagePlanCommand({ usagePlanId: id }));
  return (p.apiStages ?? []).filter((s) => s.apiId && s.stage).map((s) => ({ value: `${s.apiId}/${s.stage}`, label: `${s.apiId} / ${s.stage}` }));
}

/** Every API key in this plan. */
async function planKeyOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  if (!id) return [];
  return (await planKeys(ctx, id)).filter((k) => k.id).map((k) => ({ value: k.id as string, label: `${k.name ?? k.id} (${k.id})` }));
}

export const usagePlans: ResourceDef = {
  id: "usage-plans",
  name: "Usage plans",
  singular: "usage plan",
  idField: "id",
  nameField: "Name",
  description: "Usage plans set throttling and quota limits for API keys on REST API stages.",
  emptyText: "You don't have any usage plans.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "id", label: "ID", kind: "text" },
    { key: "rate", label: "Rate", kind: "text" },
    { key: "burst", label: "Burst", kind: "text" },
    { key: "quota", label: "Quota", kind: "text" },
    { key: "stages", label: "Associated stages", kind: "count" },
  ],

  async list(ctx) {
    return (await allPlans(ctx)).map((p): Row => ({
      id: p.id ?? "",
      name: p.name ?? p.id ?? "",
      rate: p.throttle?.rateLimit !== undefined ? `${p.throttle.rateLimit} requests per second` : "Off",
      burst: p.throttle?.burstLimit !== undefined ? `${p.throttle.burstLimit} requests` : "Off",
      quota: p.quota?.limit !== undefined ? `${p.quota.limit} requests per ${(p.quota.period ?? "").toLowerCase()}` : "Off",
      stages: p.apiStages?.length ?? 0,
    }));
  },

  async get(ctx, id) {
    const p = await ctx.clients.apigateway.send(new GetUsagePlanCommand({ usagePlanId: id }));
    const keysR = await secondary(planKeys(ctx, id));
    return {
      summary: { Name: p.name ?? id, ID: id, Description: p.description ?? null, "Product code": p.productCode ?? null },
      tabs: [
        {
          id: "limits",
          label: "Throttling and quota",
          kind: "keyvalue",
          data: {
            Rate: p.throttle?.rateLimit ?? "Off",
            Burst: p.throttle?.burstLimit ?? "Off",
            "Quota requests": p.quota?.limit ?? "Off",
            "Quota period": p.quota?.period ?? null,
          },
        },
        {
          id: "stages",
          label: "Associated stages",
          kind: "table",
          columns: [
            { key: "apiId", label: "API ID", kind: "text" },
            { key: "stage", label: "Stage", kind: "text" },
          ],
          data: (p.apiStages ?? []).map((s) => ({ apiId: s.apiId ?? "", stage: s.stage ?? "" })),
          emptyText: "No API stages are associated. Use Add API stage.",
        },
        {
          id: "keys",
          label: "Associated API keys",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "id", label: "API key ID", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
          ],
          data: keysR.ok ? keysR.value.map((k) => ({ name: k.name ?? "", id: k.id ?? "", type: k.type ?? null })) : [],
          emptyText: unavailableText(keysR, "No API keys are associated. Use Add API key."),
        },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(p.tags), emptyText: "No tags." },
      ],
    };
  },

  create: {
    title: "Create usage plan",
    description: "Creates a usage plan with CreateUsagePlan. Add API stages and keys from its page.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Usage plan details", validate: { pattern: "[^\\s].{0,127}", message: "1-128 characters." } },
      { name: "description", label: "Description", kind: "text", section: "Usage plan details" },
      ...limitFields,
      { name: "stage", label: "API stage", kind: "select", default: "", options: (ctx) => restStageOptions(ctx.clients), section: "Associated stages - optional", help: "Only deployed REST API stages can be added." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const stage = optText(v.stage) ? splitApiStage(v.stage) : null;
      const r = await ctx.clients.apigateway.send(
        new CreateUsagePlanCommand({
          name: String(v.name),
          description: optText(v.description),
          throttle: v.throttling === true ? { rateLimit: Number(v.rate), burstLimit: Number(v.burst) } : undefined,
          quota: v.quota === true ? { limit: Number(v.limit), period: period(v.period) } : undefined,
          apiStages: stage ? [stage] : undefined,
          tags: tagsRecord(v.tags),
        })
      );
      if (!r.id) throw new Error("CreateUsagePlan returned no ID.");
      return r.id;
    },
  },

  actions: [
    {
      id: "edit-limits",
      label: "Edit throttling and quota",
      fields: limitFields.map((f) => ({ ...f, section: undefined })),
      async initialValues(ctx, id) {
        const p = await ctx.clients.apigateway.send(new GetUsagePlanCommand({ usagePlanId: id }));
        const t = p.throttle;
        const q = p.quota;
        return {
          throttling: t?.rateLimit !== undefined || t?.burstLimit !== undefined,
          ...(t?.rateLimit !== undefined ? { rate: t.rateLimit } : {}),
          ...(t?.burstLimit !== undefined ? { burst: t.burstLimit } : {}),
          quota: q?.limit !== undefined,
          ...(q?.limit !== undefined ? { limit: q.limit } : {}),
          ...(q?.period ? { period: q.period } : {}),
        };
      },
      async run(ctx, id, v) {
        const p = await ctx.clients.apigateway.send(new GetUsagePlanCommand({ usagePlanId: id }));
        const ops = limitPatch(p, v);
        if (ops.length === 0) return { message: "No changes to save." };
        await ctx.clients.apigateway.send(new UpdateUsagePlanCommand({ usagePlanId: id, patchOperations: ops }));
        return { message: "Saved throttling and quota." };
      },
    },
    {
      id: "add-stage",
      label: "Add API stage",
      fields: [{ name: "stage", label: "API stage", kind: "select", required: true, options: (ctx) => restStageOptions(ctx.clients) }],
      async run(ctx, id, v) {
        const { apiId, stage } = splitApiStage(v.stage);
        await ctx.clients.apigateway.send(new UpdateUsagePlanCommand({ usagePlanId: id, patchOperations: [{ op: "add", path: "/apiStages", value: `${apiId}:${stage}` }] }));
        return { message: `Added stage ${stage} of API ${apiId}.` };
      },
    },
    {
      id: "remove-stage",
      label: "Remove API stage",
      danger: true,
      fields: [{ name: "stage", label: "API stage", kind: "select", required: true, options: planStageOptions, help: "One of this plan's associated stages." }],
      async run(ctx, id, v) {
        const { apiId, stage } = splitApiStage(v.stage);
        await ctx.clients.apigateway.send(new UpdateUsagePlanCommand({ usagePlanId: id, patchOperations: [{ op: "remove", path: "/apiStages", value: `${apiId}:${stage}` }] }));
        return { message: `Removed stage ${stage} of API ${apiId}.` };
      },
    },
    {
      id: "add-key",
      label: "Add API key",
      fields: [{ name: "keyId", label: "API key", kind: "select", required: true, options: keyOptions }],
      async run(ctx, id, v) {
        await ctx.clients.apigateway.send(new CreateUsagePlanKeyCommand({ usagePlanId: id, keyId: String(v.keyId), keyType: "API_KEY" }));
        return { message: `Added API key ${String(v.keyId)}.` };
      },
    },
    {
      id: "remove-key",
      label: "Remove API key",
      danger: true,
      fields: [{ name: "keyId", label: "API key", kind: "select", required: true, options: planKeyOptions, help: "One of this plan's associated keys." }],
      async run(ctx, id, v) {
        await ctx.clients.apigateway.send(new DeleteUsagePlanKeyCommand({ usagePlanId: id, keyId: String(v.keyId) }));
        return { message: `Removed API key ${String(v.keyId)}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.apigateway.send(new DeleteUsagePlanCommand({ usagePlanId: id }));
    },
  },
};
