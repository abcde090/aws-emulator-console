"use client";

import { isFieldVisible, selectOffersEmpty } from "../form-state.ts";
import type { FieldMeta, FieldValue, FieldValues, Tag } from "../types.ts";
import { inputClass as baseInputClass } from "./primitives.tsx";

const inputClass = `w-full ${baseInputClass}`;

function Help({ field }: { field: FieldMeta }) {
  return field.help ? <p className="text-[12px] text-muted">{field.help}</p> : null;
}

function TagsEditor({ value, onChange, label }: { value: Tag[]; onChange: (v: Tag[]) => void; label: string }) {
  const update = (i: number, patch: Partial<Tag>) => onChange(value.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="text-[13px] text-muted">No tags associated with the resource.</p>}
      {value.map((t, i) => (
        <div key={i} className="flex gap-2">
          <input aria-label={`${label} key ${i + 1}`} className={inputClass} placeholder="Key" value={t.Key} onChange={(e) => update(i, { Key: e.target.value })} />
          <input aria-label={`${label} value ${i + 1}`} className={inputClass} placeholder="Value - optional" value={t.Value} onChange={(e) => update(i, { Value: e.target.value })} />
          <button type="button" className="px-2 text-[13px] font-medium text-link hover:text-link-hover hover:underline" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      {value.length < 50 && (
        <button
          type="button"
          className="rounded-[2px] border border-[#545b64] bg-white px-3 py-1 text-[13px] font-semibold text-ink hover:bg-page"
          onClick={() => onChange([...value, { Key: "", Value: "" }])}
        >
          Add new tag
        </button>
      )}
    </div>
  );
}

function FieldControl({ field, value, onChange }: { field: FieldMeta; value: FieldValue; onChange: (v: FieldValue) => void }) {
  const id = `field-${field.name}`;
  const testId = id;
  if (field.optionsError) return <p className="text-bad" data-testid={testId}>{field.optionsError}</p>;
  switch (field.kind) {
    case "checkbox":
      return (
        <label className="flex items-start gap-2 text-[13px]">
          <input id={id} data-testid={testId} type="checkbox" className="mt-0.5 size-4 accent-[#0073bb]" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>
            <span className="font-semibold text-ink">{field.label}</span>
            <Help field={field} />
          </span>
        </label>
      );
    case "radio":
      return (
        <div role="radiogroup" aria-label={field.label} className="space-y-1.5 text-[13px]" data-testid={testId}>
          {(field.options ?? []).map((o) => (
            <label key={o.value} className="flex items-start gap-2">
              <input type="radio" className="mt-0.5 accent-[#0073bb]" name={id} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    case "select":
      return (
        <select id={id} data-testid={testId} className={inputClass} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          {selectOffersEmpty(field) && <option value="">-</option>}
          {(field.options ?? []).length === 0 && field.required && <option value="">No choices available</option>}
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "multiselect": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <select id={id} data-testid={testId} multiple className={`${inputClass} min-h-24`} value={selected} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    case "textarea":
    case "json":
      return (
        <textarea
          id={id}
          data-testid={testId}
          className={`${inputClass} min-h-32 ${field.kind === "json" ? "font-mono text-[13px]" : ""}`}
          placeholder={field.placeholder}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <input
          id={id}
          data-testid={testId}
          type="number"
          step="any"
          className={`${inputClass} max-w-xs`}
          placeholder={field.placeholder}
          min={field.validate?.min}
          max={field.validate?.max}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "tags":
      return (
        <div data-testid={testId}>
          <TagsEditor label={field.label} value={Array.isArray(value) ? (value as Tag[]) : []} onChange={onChange} />
        </div>
      );
    case "password":
      return (
        <input
          id={id}
          data-testid={testId}
          type="password"
          autoComplete="new-password"
          className={inputClass}
          placeholder={field.placeholder}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return <input id={id} data-testid={testId} type="text" className={inputClass} placeholder={field.placeholder} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function FormFields({ fields, values, onChange }: { fields: FieldMeta[]; values: FieldValues; onChange: (name: string, v: FieldValue) => void }) {
  return (
    <div className="space-y-4">
      {fields
        .filter((f) => isFieldVisible(f, values, fields))
        .map((f) => (
          <div key={f.name} className="space-y-1">
            {f.kind !== "checkbox" && (
              <label htmlFor={`field-${f.name}`} className="block text-[13px] font-semibold text-ink">
                {f.label}
                {!f.required && f.kind !== "tags" && f.kind !== "radio" && <span className="font-normal italic text-muted"> - optional</span>}
              </label>
            )}
            {f.kind !== "checkbox" && <Help field={f} />}
            <FieldControl field={f} value={values[f.name] ?? null} onChange={(v) => onChange(f.name, v)} />
          </div>
        ))}
    </div>
  );
}
