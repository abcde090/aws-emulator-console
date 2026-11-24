/**
 * The engine's server side: finds a definition, builds the context, runs the definition
 * and turns every outcome into a Result. Used by the pages (first render) and by
 * actions.ts (calls from the browser). Nothing here throws to the caller.
 */

import { clientsIn, consoleClients } from "../lib/aws.ts";
import { ACCOUNT_ID } from "../lib/emulator-files.ts";
import { getActiveIdentity } from "../lib/identity.ts";
import { pageRegion } from "../lib/regions.ts";
import { selectedRegion } from "../lib/selected-region.ts";
import { applyInitialValues, hasAvailabilityChecks, resolveFields, UNAVAILABLE_ACTIONS_KEY, unavailableActions } from "./meta.ts";
import { getResource } from "./registry.ts";
import { errorMessage, toPlain } from "./serialize.ts";
import { validateValues } from "./validate.ts";
import type { ActionDef, ActionResult, Ctx, Detail, FieldDef, FieldMeta, FieldValues, PageActionDef, ResourceDef, Result, Row } from "./types.ts";
import { DELETE_TARGET, PAGE_ACTION_PREFIX } from "./targets.ts";

/**
 * The context a definition runs with. `region` is the Region chosen in the top bar, or the
 * home Region (us-east-1) on a global service's pages (IAM, Route 53, CloudFront, S3 …);
 * ctx.clients sign for it, except global services' clients, which always use their home Region.
 */
export async function makeCtx(serviceId?: string, resourceId?: string): Promise<Ctx> {
  const [identity, selected] = await Promise.all([getActiveIdentity(), selectedRegion()]);
  const region = pageRegion(serviceId, resourceId, selected);
  return { clients: consoleClients(region), clientsIn, region, accountId: ACCOUNT_ID, identity };
}

const notFound = (what: string): Result<never> => ({ ok: false, error: `${what} is not part of this console.` });

async function guarded<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function lookup(serviceId: string, resourceId: string): ResourceDef | null {
  if (typeof serviceId !== "string" || typeof resourceId !== "string") return null;
  return getResource(serviceId, resourceId);
}

function findAction(resource: ResourceDef, actionId: string): ActionDef | null {
  return resource.actions?.find((a) => a.id === actionId) ?? null;
}

function findPageAction(resource: ResourceDef, actionId: string): PageActionDef | null {
  return resource.pageActions?.find((a) => a.id === actionId) ?? null;
}

const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 2048;

export async function engineList(serviceId: string, resourceId: string): Promise<Result<Row[]>> {
  const r = lookup(serviceId, resourceId);
  if (!r) return notFound(`${serviceId}/${resourceId}`);
  return guarded(async () => {
    const rows = toPlain(await r.list(await makeCtx(serviceId, resourceId))) as Row[];
    if (!hasAvailabilityChecks(r)) return rows;
    return rows.map((row) => ({ ...row, [UNAVAILABLE_ACTIONS_KEY]: unavailableActions(r.actions, row, r.delete) }));
  });
}

export async function engineGet(serviceId: string, resourceId: string, id: string): Promise<Result<Detail>> {
  const r = lookup(serviceId, resourceId);
  if (!r?.get) return notFound(`Details for ${serviceId}/${resourceId}`);
  if (!validId(id)) return { ok: false, error: "Missing resource id." };
  const get = r.get;
  return guarded(async () => {
    const detail = toPlain(await get(await makeCtx(serviceId, resourceId), id)) as Detail;
    const hidden = unavailableActions(r.actions, detail.summary ?? {}, r.delete);
    return hidden.length > 0 ? { ...detail, unavailableActions: hidden } : detail;
  });
}

/**
 * Field specs (with live options) for the create form ("create"), one action (its id),
 * the delete dialog (DELETE_TARGET) or a page action (PAGE_ACTION_PREFIX + id). For an
 * action, `id` is the resource: option loaders get it and initialValues() prefills.
 */
export async function engineFields(serviceId: string, resourceId: string, target: string, id?: string): Promise<Result<FieldMeta[]>> {
  const r = lookup(serviceId, resourceId);
  if (!r || typeof target !== "string") return notFound(`${serviceId}/${resourceId}`);
  if (id !== undefined && !validId(id)) return { ok: false, error: "Missing resource id." };
  let fields: FieldDef[] | undefined;
  let action: ActionDef | null = null;
  if (target === "create") fields = r.create?.fields;
  else if (target === DELETE_TARGET) fields = r.delete ? r.delete.fields ?? [] : undefined;
  else if (target.startsWith(PAGE_ACTION_PREFIX)) {
    const page = findPageAction(r, target.slice(PAGE_ACTION_PREFIX.length));
    fields = page ? page.fields ?? [] : undefined;
  } else {
    action = findAction(r, target);
    fields = action ? action.fields ?? [] : undefined;
  }
  if (!fields) return notFound(`${target} on ${serviceId}/${resourceId}`);
  const f = fields;
  const prefill = action?.initialValues;
  return guarded(async () => {
    const ctx = await makeCtx(serviceId, resourceId);
    const resolved = await resolveFields(ctx, f, id);
    if (!prefill || id === undefined) return resolved;
    return applyInitialValues(resolved, (await prefill(ctx, id)) ?? {});
  });
}

export async function engineCreate(serviceId: string, resourceId: string, rawValues: unknown): Promise<Result<{ id: string }>> {
  const r = lookup(serviceId, resourceId);
  if (!r?.create) return notFound(`Creating in ${serviceId}/${resourceId}`);
  const create = r.create;
  return guarded(async () => {
    const ctx = await makeCtx(serviceId, resourceId);
    const checked = validateValues(await resolveFields(ctx, create.fields), rawValues);
    if (!checked.ok) throw new Error(checked.error);
    return { id: await create.run(ctx, checked.data) };
  });
}

export async function engineRunAction(serviceId: string, resourceId: string, id: string, actionId: string, rawValues: unknown): Promise<Result<ActionResult>> {
  const r = lookup(serviceId, resourceId);
  const action = r ? findAction(r, actionId) : null;
  if (!action) return notFound(`Action ${actionId} on ${serviceId}/${resourceId}`);
  if (!validId(id)) return { ok: false, error: "Missing resource id." };
  return guarded(async () => {
    const ctx = await makeCtx(serviceId, resourceId);
    // Every action's values are checked against its fields; an action without fields gets none.
    const checked = validateValues(await resolveFields(ctx, action.fields ?? [], id), rawValues ?? {});
    if (!checked.ok) throw new Error(checked.error);
    const values = checked.data;
    return (toPlain((await action.run(ctx, id, values)) ?? {}) as ActionResult);
  });
}

export async function engineRunPageAction(serviceId: string, resourceId: string, actionId: string, rawValues: unknown): Promise<Result<ActionResult>> {
  const r = lookup(serviceId, resourceId);
  const action = r && typeof actionId === "string" ? findPageAction(r, actionId) : null;
  if (!action) return notFound(`Action ${actionId} on ${serviceId}/${resourceId}`);
  return guarded(async () => {
    const ctx = await makeCtx(serviceId, resourceId);
    const checked = validateValues(await resolveFields(ctx, action.fields ?? []), rawValues ?? {});
    if (!checked.ok) throw new Error(checked.error);
    return toPlain((await action.run(ctx, checked.data)) ?? {}) as ActionResult;
  });
}

export async function engineDelete(serviceId: string, resourceId: string, id: string, rawValues: unknown = {}): Promise<Result<null>> {
  const r = lookup(serviceId, resourceId);
  if (!r?.delete) return notFound(`Deleting ${serviceId}/${resourceId}`);
  if (!validId(id)) return { ok: false, error: "Missing resource id." };
  const del = r.delete;
  return guarded(async () => {
    const ctx = await makeCtx(serviceId, resourceId);
    let values: FieldValues = {};
    if ((del.fields ?? []).length > 0) {
      const checked = validateValues(await resolveFields(ctx, del.fields ?? [], id), rawValues ?? {});
      if (!checked.ok) throw new Error(checked.error);
      values = checked.data;
    }
    await del.run(ctx, id, values);
    return null;
  });
}
