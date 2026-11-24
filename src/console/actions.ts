"use server";

/**
 * The only server actions the engine needs. Each takes plain ids and values from the
 * browser, runs the service definition through server.ts and returns {ok, data} or
 * {ok: false, error}. They never throw to the client.
 */

import { revalidatePath } from "next/cache";
import { engineCreate, engineDelete, engineFields, engineGet, engineList, engineRunAction, engineRunPageAction } from "./server.ts";
import type { ActionResult, Detail, FieldMeta, Result, Row } from "./types.ts";

function refresh(serviceId: string): void {
  try {
    revalidatePath(`/${serviceId}`, "layout");
  } catch {
    // Revalidation only refreshes cached pages; the call itself already succeeded.
  }
}

export async function listResources(serviceId: string, resourceId: string): Promise<Result<Row[]>> {
  return engineList(serviceId, resourceId);
}

export async function getResourceDetail(serviceId: string, resourceId: string, id: string): Promise<Result<Detail>> {
  return engineGet(serviceId, resourceId, id);
}

/** target: "create", an action id, "$delete" or "$page:<id>"; id: the resource, for actions. */
export async function loadFields(serviceId: string, resourceId: string, target: string, id?: string): Promise<Result<FieldMeta[]>> {
  return engineFields(serviceId, resourceId, target, id);
}

export async function createResource(serviceId: string, resourceId: string, values: unknown): Promise<Result<{ id: string }>> {
  const r = await engineCreate(serviceId, resourceId, values);
  if (r.ok) refresh(serviceId);
  return r;
}

export async function runAction(serviceId: string, resourceId: string, id: string, actionId: string, values: unknown): Promise<Result<ActionResult>> {
  const r = await engineRunAction(serviceId, resourceId, id, actionId, values);
  if (r.ok) refresh(serviceId);
  return r;
}

export async function runPageAction(serviceId: string, resourceId: string, actionId: string, values: unknown): Promise<Result<ActionResult>> {
  const r = await engineRunPageAction(serviceId, resourceId, actionId, values);
  if (r.ok) refresh(serviceId);
  return r;
}

export async function deleteResource(serviceId: string, resourceId: string, id: string, values: unknown = {}): Promise<Result<null>> {
  const r = await engineDelete(serviceId, resourceId, id, values);
  if (r.ok) refresh(serviceId);
  return r;
}
