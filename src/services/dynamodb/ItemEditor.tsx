"use client";

/**
 * Create or edit one DynamoDB item, in the console's Form view or JSON view (plain JSON or
 * DynamoDB JSON). Saving calls the permission-checked saveItem server action.
 */

import { useState } from "react";
import { Modal } from "@/console/ui/Modal";
import { Button, ErrorBanner } from "@/console/ui/primitives";
import {
  formRowsToItem,
  itemToFormRows,
  itemToPlain,
  needsDynamoJson,
  parseWireItem,
  plainToItem,
  TYPE_LABELS,
  type AttrType,
  type FormRow,
  type Parsed,
  type WireItem,
} from "./attr";
import { saveItem, type TableSchema } from "./item-actions";

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
const ATTR_TYPES = Object.keys(TYPE_LABELS) as AttrType[];

type View = "form" | "json";

interface ItemEditorProps {
  schema: TableSchema;
  /** The item being edited, or null to create one. */
  item: WireItem | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}

function startItem(schema: TableSchema): WireItem {
  const out: WireItem = {};
  for (const k of [schema.partition, ...(schema.sort ? [schema.sort] : [])]) {
    out[k.name] = k.type === "N" ? { N: "" } : k.type === "B" ? { B: "" } : { S: "" };
  }
  return out;
}

function jsonText(item: WireItem, dynamo: boolean): string {
  return JSON.stringify(dynamo ? item : itemToPlain(item), null, 2);
}

function parseJsonText(textValue: string, dynamo: boolean): Parsed<WireItem> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    return { ok: false, error: "The JSON is not valid." };
  }
  return dynamo ? parseWireItem(parsed) : plainToItem(parsed);
}

export function ItemEditor({ schema, item, onClose, onSaved }: ItemEditorProps) {
  const initial = item ?? startItem(schema);
  const keyNames = [schema.partition.name, ...(schema.sort ? [schema.sort.name] : [])];
  const [view, setView] = useState<View>("form");
  const [dynamo, setDynamo] = useState(needsDynamoJson(initial));
  const [rows, setRows] = useState<FormRow[]>(itemToFormRows(initial));
  const [json, setJson] = useState(jsonText(initial, needsDynamoJson(initial)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current = (): Parsed<WireItem> => (view === "form" ? formRowsToItem(rows) : parseJsonText(json, dynamo));

  function switchView(next: View, nextDynamo = dynamo) {
    const c = current();
    if (!c.ok) return setError(c.error);
    setError(null);
    if (next === "json" && !nextDynamo && needsDynamoJson(c.value)) {
      setError("This item has sets or binary values, which plain JSON can't hold. Showing DynamoDB JSON.");
      nextDynamo = true;
    }
    setRows(itemToFormRows(c.value));
    setJson(jsonText(c.value, nextDynamo));
    setDynamo(nextDynamo);
    setView(next);
  }

  async function save() {
    const c = current();
    if (!c.ok) return setError(c.error);
    setBusy(true);
    const originalKey = item ? Object.fromEntries(keyNames.map((k) => [k, item[k]])) : null;
    const r = await saveItem(schema.name, c.value, originalKey as WireItem | null);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onSaved(r.data.created ? "The item has been saved successfully." : "The item has been updated successfully.");
  }

  const setRow = (i: number, patch: Partial<FormRow>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Modal
      title={item ? "Edit item" : "Create item"}
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()} data-testid="save-item">
            {item ? "Save" : "Create item"}
          </Button>
        </>
      }
    >
      <p className="text-muted">
        You can add, remove or edit the attributes of an item. Key attributes ({keyNames.join(", ")}) are required
        {item ? " and can't be changed" : ""}.
      </p>
      <div role="tablist" className="flex gap-1 border-b border-line">
        {(["form", "json"] as View[]).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={`-mb-px border-b-2 px-4 py-1.5 font-bold ${view === v ? "border-primary text-primary" : "border-transparent"}`} onClick={() => view !== v && switchView(v)}>
            {v === "form" ? "Form" : "JSON view"}
          </button>
        ))}
      </div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {view === "form" ? (
        <div className="space-y-2" data-testid="item-form">
          <div className="grid grid-cols-[1fr_10rem_2fr_auto] gap-2 font-bold">
            <span>Attribute name</span>
            <span>Type</span>
            <span>Value</span>
            <span />
          </div>
          {rows.map((r, i) => {
            const isKey = keyNames.includes(r.name) && i < keyNames.length;
            const complex = r.type === "L" || r.type === "M" || r.type === "SS" || r.type === "NS" || r.type === "BS";
            return (
              <div key={i} className="grid grid-cols-[1fr_10rem_2fr_auto] items-start gap-2">
                <input aria-label={`Attribute name ${i + 1}`} className={inputClass} value={r.name} disabled={isKey} onChange={(e) => setRow(i, { name: e.target.value })} />
                <select aria-label={`Attribute type ${i + 1}`} className={inputClass} value={r.type} disabled={isKey} onChange={(e) => setRow(i, { type: e.target.value as AttrType })}>
                  {ATTR_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
                {r.type === "BOOL" ? (
                  <select aria-label={`Attribute value ${i + 1}`} className={inputClass} value={r.value} onChange={(e) => setRow(i, { value: e.target.value })}>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </select>
                ) : r.type === "NULL" ? (
                  <span className="py-1 text-muted">null</span>
                ) : complex ? (
                  <textarea
                    aria-label={`Attribute value ${i + 1}`}
                    className={`${inputClass} min-h-20 font-mono text-[13px]`}
                    placeholder={r.type === "L" ? '{"L": [{"S": "a"}]}' : r.type === "M" ? '{"M": {"k": {"S": "v"}}}' : '["a", "b"]'}
                    value={r.value}
                    onChange={(e) => setRow(i, { value: e.target.value })}
                  />
                ) : (
                  <input aria-label={`Attribute value ${i + 1}`} className={inputClass} value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
                )}
                <Button variant="link" disabled={isKey} onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            );
          })}
          <Button onClick={() => setRows((prev) => [...prev, { name: "", type: "S", value: "" }])}>Add new attribute</Button>
          <p className="text-[13px] text-muted">Lists and maps take DynamoDB JSON; sets take a JSON array of strings.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={dynamo} onChange={(e) => switchView("json", e.target.checked)} />
            <span>View DynamoDB JSON</span>
          </label>
          <textarea aria-label="Item JSON" className={`${inputClass} min-h-72 font-mono text-[13px]`} value={json} onChange={(e) => setJson(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}
