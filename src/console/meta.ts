/**
 * Strips a ServiceDef down to the plain metadata the browser needs (no functions), and
 * resolves live field options on the server.
 */

import { errorMessage, toPlain } from "./serialize.ts";
import { DELETE_TARGET } from "./targets.ts";
import type { ActionDef, Ctx, DeleteDef, FieldDef, FieldMeta, FieldValue, FieldValues, NavEntry, ResourceDef, ResourceMeta, Row, ServiceDef, ServiceMeta } from "./types.ts";

/** Reserved key the engine adds to list rows: ids of actions whose availableFor() is false ("$delete" for Delete). */
export const UNAVAILABLE_ACTIONS_KEY = "__unavailableActions";

export function toResourceMeta(r: ResourceDef): ResourceMeta {
  return {
    id: r.id,
    name: r.name,
    singular: r.singular,
    idField: r.idField,
    nameField: r.nameField,
    columns: r.columns,
    canGet: typeof r.get === "function",
    canCreate: r.create !== undefined,
    createTitle: r.create?.title,
    createDescription: r.create?.description,
    actions: (r.actions ?? []).map((a) => ({
      id: a.id,
      label: a.label,
      danger: a.danger,
      confirm: a.confirm,
      hasFields: (a.fields ?? []).length > 0,
      hidden: a.hidden,
      // Only a plain read with nothing to fill in or confirm may run without a click.
      ...(a.runOnOpen && !a.confirm && !a.danger && !(a.fields ?? []).length ? { runOnOpen: true } : {}),
      ...(typeof a.availableFor === "function" ? { conditional: true } : {}),
    })),
    pageActions: (r.pageActions ?? []).map((a) => ({ id: a.id, label: a.label, danger: a.danger, confirm: a.confirm, hasFields: (a.fields ?? []).length > 0 })),
    deleteConfirm: r.delete?.confirmText,
    canDelete: r.delete !== undefined,
    deleteHasFields: (r.delete?.fields ?? []).length > 0,
    emptyText: r.emptyText,
    description: r.description,
    detailHref: r.detailHref,
  };
}

/** Left-nav href for an extra entry: absolute paths as given, others under the service. */
export function navHref(serviceId: string, entry: NavEntry): string {
  return entry.href.startsWith("/") ? entry.href : `/${serviceId}/${entry.href}`;
}

export function toServiceMeta(s: ServiceDef): ServiceMeta {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
    resources: s.resources.map(toResourceMeta),
    notSupported: s.notSupported ?? [],
    extraNav: (s.extraNav ?? []).map((e) => ({ label: e.label, href: navHref(s.id, e) })),
  };
}

/**
 * Field specs with options resolved. A failed loader marks the field, never throws.
 * `id` is passed to option loaders of action and delete fields.
 */
export async function resolveFields(ctx: Ctx, fields: FieldDef[], id?: string): Promise<FieldMeta[]> {
  return Promise.all(
    fields.map(async (f): Promise<FieldMeta> => {
      const base: FieldMeta = {
        name: f.name,
        label: f.label,
        help: f.help,
        kind: f.kind,
        required: f.required,
        default: f.default === undefined || f.kind === "password" ? undefined : (toPlain(f.default) as FieldValue),
        placeholder: f.placeholder,
        showIf: f.showIf,
        validate: f.validate,
        section: f.section,
      };
      if (typeof f.options === "function") {
        try {
          return { ...base, options: await f.options(ctx, id) };
        } catch (err: unknown) {
          return { ...base, options: [], optionsError: `choices could not be loaded: ${errorMessage(err)}` };
        }
      }
      return f.options ? { ...base, options: f.options } : base;
    })
  );
}

/** Current values become the fields' defaults (passwords never, unknown names ignored). */
export function applyInitialValues(fields: FieldMeta[], values: FieldValues): FieldMeta[] {
  return fields.map((f) => {
    if (f.kind === "password" || !(f.name in values) || values[f.name] === undefined) return f;
    const clearable = f.kind === "select" && !f.required && (f.default === undefined || f.default === "");
    return { ...f, default: toPlain(values[f.name]) as FieldValue, ...(clearable ? { clearable: true } : {}) };
  });
}

/** False only when `check(row)` says so; a missing or throwing check counts as available. */
function unavailable(check: ((row: Row) => boolean) | undefined, row: Row): boolean {
  if (typeof check !== "function") return false;
  try {
    return !check(row);
  } catch {
    return false;
  }
}

/**
 * Ids of the actions whose availableFor(row) is false, plus DELETE_TARGET ("$delete") when
 * the delete definition's availableFor(row) is false. A throwing check counts as available.
 */
export function unavailableActions(actions: ActionDef[] | undefined, row: Row, del?: Pick<DeleteDef, "availableFor">): string[] {
  const ids = (actions ?? []).filter((a) => unavailable(a.availableFor?.bind(a), row)).map((a) => a.id);
  return unavailable(del?.availableFor?.bind(del), row) ? [...ids, DELETE_TARGET] : ids;
}

/** True when the resource has any per-row availability check (actions or Delete). */
export function hasAvailabilityChecks(r: Pick<ResourceDef, "actions" | "delete">): boolean {
  return (r.actions ?? []).some((a) => typeof a.availableFor === "function") || typeof r.delete?.availableFor === "function";
}

/**
 * Detail URL of a resource. The id is one encoded segment ("/" becomes %2F, so ids like
 * "/aws/lambda/x" never produce empty segments); the generic route also accepts an id
 * spread over several raw segments and joins them (idFromSegments).
 */
export function detailPath(serviceId: string, resource: Pick<ResourceMeta, "id" | "detailHref">, id: string): string {
  const encoded = encodeURIComponent(id);
  return resource.detailHref
    ? `/${serviceId}/${resource.detailHref.replace("{id}", encoded)}`
    : `/${serviceId}/${resource.id}/${encoded}`;
}

/** Next passes dynamic segments still URL-encoded: decode each once, safely. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The resource id from the catch-all segments after the resource: each decoded once, joined by "/". */
export function idFromSegments(segments: string[]): string {
  return segments.map(decodeSegment).join("/");
}
