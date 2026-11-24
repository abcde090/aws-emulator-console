/** Pure form state helpers shared by the create form and action dialogs. */

import type { FieldMeta, FieldValue, FieldValues, ShowIf } from "./types.ts";

export function emptyValue(field: FieldMeta): FieldValue {
  switch (field.kind) {
    case "checkbox":
      return false;
    case "multiselect":
    case "tags":
      return [];
    case "number":
      return null;
    case "radio":
      return field.options?.[0]?.value ?? "";
    case "select":
      // An optional select starts at "-" (nothing), exactly what the control shows.
      return field.required ? field.options?.[0]?.value ?? "" : "";
    default:
      return "";
  }
}

/**
 * Whether an optional select shows the engine's "-" (nothing) choice. Not when the
 * definition gives a non-empty `default` (the setting always has a value, SI-2), and not
 * when the options already hold an empty-value choice such as "None" (SI-6). A select
 * prefilled from the resource's current value (`clearable`) keeps "-" so it can be cleared.
 */
export function selectOffersEmpty(field: Pick<FieldMeta, "kind" | "required" | "default" | "options" | "clearable">): boolean {
  if (field.kind !== "select" || field.required) return false;
  if ((field.options ?? []).some((o) => o.value === "")) return false;
  if (field.clearable) return true;
  return !(typeof field.default === "string" && field.default !== "");
}

export function initialValues(fields: FieldMeta[]): FieldValues {
  return Object.fromEntries(fields.map((f) => [f.name, f.default !== undefined ? f.default : emptyValue(f)]));
}

/** `equals` is one value or a list of allowed values. */
export function showIfMatches(showIf: ShowIf, value: unknown): boolean {
  return Array.isArray(showIf.equals) ? showIf.equals.some((e) => e === value) : value === showIf.equals;
}

type ShowIfField = Pick<FieldMeta, "name" | "showIf">;

/**
 * A field is visible when its showIf matches and the field it depends on is itself visible
 * (when `fields` is given). Dependency cycles count as hidden.
 */
export function isFieldVisible(field: ShowIfField, values: Record<string, unknown>, fields: readonly ShowIfField[] = []): boolean {
  let current: ShowIfField | undefined = field;
  const seen = new Set<string>();
  while (current?.showIf) {
    if (seen.has(current.name)) return false;
    seen.add(current.name);
    if (!showIfMatches(current.showIf, values[current.showIf.field])) return false;
    const parentName: string = current.showIf.field;
    current = fields.find((f) => f.name === parentName);
  }
  return true;
}

/** Only the values of visible fields are sent. */
export function visibleValues(fields: FieldMeta[], values: FieldValues): FieldValues {
  return Object.fromEntries(fields.filter((f) => isFieldVisible(f, values, fields)).map((f) => [f.name, values[f.name] ?? emptyValue(f)]));
}

/** Fields grouped by section, in first-seen order. */
export function groupBySection(fields: FieldMeta[]): { section: string; fields: FieldMeta[] }[] {
  const groups: { section: string; fields: FieldMeta[] }[] = [];
  for (const f of fields) {
    const name = f.section ?? "";
    const g = groups.find((x) => x.section === name);
    if (g) g.fields.push(f);
    else groups.push({ section: name, fields: [f] });
  }
  return groups;
}

/** The text a delete asks the user to type: the name (falling back to the id) or "delete". */
export function deleteConfirmation(confirmText: "name" | "delete", id: string, name?: string): string {
  if (confirmText !== "name") return "delete";
  return name !== undefined && name !== "" ? name : id;
}
