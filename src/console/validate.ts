/**
 * Server-side validation of form values against the field specs. Runs on every create and
 * action before a service definition sees the values: the browser is never trusted.
 */

import { isFieldVisible, selectOffersEmpty } from "./form-state.ts";
import type { FieldMeta, FieldValue, FieldValues, Result, Tag } from "./types.ts";

const MAX_TEXT = 400_000;
const MAX_TAGS = 50;

function isEmpty(v: FieldValue): boolean {
  return v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

type Coerced = { ok: true; value: FieldValue } | { ok: false; error: string };

function coerce(field: FieldMeta, input: unknown): Coerced {
  const bad = (what: string): Coerced => ({ ok: false, error: `${field.label}: ${what}` });
  if (input === undefined || input === null) return { ok: true, value: field.kind === "checkbox" ? false : null };
  switch (field.kind) {
    case "password": {
      // The value is never quoted back, in this or any other message.
      if (typeof input !== "string") return bad("must be text");
      if (input.length > MAX_TEXT) return bad("is too long");
      return { ok: true, value: input };
    }
    case "text":
    case "textarea":
    case "select":
    case "radio":
    case "json": {
      if (typeof input !== "string") return bad("must be text");
      if (input.length > MAX_TEXT) return bad("is too long");
      return { ok: true, value: field.kind === "text" ? input.trim() : input };
    }
    case "number": {
      if (input === "") return { ok: true, value: null };
      const n = typeof input === "number" ? input : typeof input === "string" && /^-?\d+(\.\d+)?$/.test(input.trim()) ? Number(input) : NaN;
      return Number.isFinite(n) ? { ok: true, value: n } : bad("must be a number");
    }
    case "checkbox":
      return typeof input === "boolean" ? { ok: true, value: input } : bad("must be true or false");
    case "multiselect":
      return Array.isArray(input) && input.every((v) => typeof v === "string") ? { ok: true, value: input as string[] } : bad("must be a list");
    case "tags": {
      if (!Array.isArray(input)) return bad("must be a list of tags");
      if (input.length > MAX_TAGS) return bad(`at most ${MAX_TAGS} tags`);
      const tags: Tag[] = [];
      for (const t of input as unknown[]) {
        const tag = t as { Key?: unknown; Value?: unknown } | null;
        if (!tag || typeof tag.Key !== "string" || typeof (tag.Value ?? "") !== "string") return bad("each tag needs a key and a value");
        const key = tag.Key.trim();
        if (key === "") continue;
        if (key.length > 128 || String(tag.Value ?? "").length > 256) return bad("tag keys are at most 128 characters, values 256");
        tags.push({ Key: key, Value: String(tag.Value ?? "") });
      }
      return { ok: true, value: tags };
    }
  }
}

function checkRules(field: FieldMeta, value: FieldValue): string | null {
  const optionValues = field.options?.map((o) => o.value);
  if ((field.kind === "select" || field.kind === "radio") && typeof value === "string" && value !== "" && optionValues && !optionValues.includes(value)) {
    return `${field.label}: "${value}" is not one of the choices`;
  }
  if (field.kind === "multiselect" && Array.isArray(value) && optionValues) {
    const unknown = (value as string[]).find((v) => !optionValues.includes(v));
    if (unknown !== undefined) return `${field.label}: "${unknown}" is not one of the choices`;
  }
  if (field.kind === "json" && typeof value === "string" && value.trim() !== "") {
    try {
      JSON.parse(value);
    } catch {
      return `${field.label}: not valid JSON`;
    }
  }
  const rule = field.validate;
  if (!rule) return null;
  if (typeof value === "string" && value !== "" && rule.pattern && !new RegExp(`^(?:${rule.pattern})$`).test(value)) return `${field.label}: ${rule.message}`;
  if (typeof value === "number" && ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max))) return `${field.label}: ${rule.message}`;
  if (typeof value === "string" && value !== "" && field.kind !== "number") {
    if ((rule.min !== undefined && value.length < rule.min) || (rule.max !== undefined && value.length > rule.max)) return `${field.label}: ${rule.message}`;
  }
  return null;
}

/** Returns only the visible, known fields, coerced to their kinds, or the first error. */
export function validateValues(fields: FieldMeta[], raw: unknown): Result<FieldValues> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Form values are missing." };
  const input = raw as Record<string, unknown>;
  const values: FieldValues = {};
  for (const field of fields) {
    if (!isFieldVisible(field, input, fields)) continue;
    if (field.optionsError) return { ok: false, error: `${field.label}: ${field.optionsError}` };
    // An optional select with a non-empty default never sends "" (SI-2): "" means the default.
    const rawValue = field.kind === "select" && input[field.name] === "" && !selectOffersEmpty(field) && typeof field.default === "string" && field.default !== "" ? field.default : input[field.name];
    const coerced = coerce(field, rawValue);
    if (!coerced.ok) return coerced;
    if (field.required && (isEmpty(coerced.value) || (field.kind === "json" && typeof coerced.value === "string" && coerced.value.trim() === ""))) {
      return { ok: false, error: `${field.label} is required.` };
    }
    const ruleError = checkRules(field, coerced.value);
    if (ruleError) return { ok: false, error: ruleError };
    values[field.name] = coerced.value;
  }
  return { ok: true, data: values };
}
