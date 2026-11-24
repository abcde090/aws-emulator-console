"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadFields, runAction, runPageAction } from "../actions.ts";
import { callServer } from "../call.ts";
import { initialValues, isFieldVisible, visibleValues } from "../form-state.ts";
import { pageActionTarget } from "../targets.ts";
import type { ActionResult, FieldMeta, FieldValues, PageActionMeta } from "../types.ts";
import { FormFields } from "./FormFields.tsx";
import { JsonView } from "./JsonView.tsx";
import { Modal } from "./Modal.tsx";
import { ResultTable } from "./ResultTable.tsx";
import { Button, ErrorBanner, Flash, Spinner } from "./primitives.tsx";

interface ActionDialogProps {
  serviceId: string;
  resourceId: string;
  /** The selected resource; null for a page action (ResourceDef.pageActions). */
  id: string | null;
  action: PageActionMeta;
  onClose: () => void;
  /** Called after any successful run, so the page can reload its data. */
  onDone: () => void;
}

export function ActionDialog({ serviceId, resourceId, id, action, onClose, onDone }: ActionDialogProps) {
  const [fields, setFields] = useState<FieldMeta[] | null>(action.hasFields ? null : []);
  const [values, setValues] = useState<FieldValues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [followUp, setFollowUp] = useState<string | null>(null);
  /** CQ-5: the fields (current values, option lists) failed to load, so the action cannot run. */
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!action.hasFields) return;
    let live = true;
    const request = callServer(() => (id === null ? loadFields(serviceId, resourceId, pageActionTarget(action.id)) : loadFields(serviceId, resourceId, action.id, id)));
    request.then((r) => {
      if (!live) return;
      if (r.ok) {
        setFields(r.data);
        setValues(initialValues(r.data));
      } else {
        setError(r.error);
        setLoadFailed(true);
        setFields([]);
      }
    });
    return () => {
      live = false;
    };
  }, [serviceId, resourceId, id, action.id, action.hasFields]);

  const run = useCallback(async () => {
    if (!fields || loadFailed) return;
    setBusy(true);
    setError(null);
    setFollowUp(null);
    const sent = visibleValues(fields, values);
    const r = await callServer(() => (id === null ? runPageAction(serviceId, resourceId, action.id, sent) : runAction(serviceId, resourceId, id, action.id, sent)));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setResult(r.data);
    onDone();
  }, [fields, loadFailed, values, serviceId, resourceId, id, action.id, onDone]);

  async function runSelection(keys: string[]) {
    const sel = result?.table?.selectionAction;
    if (!sel || id === null) return;
    setBusy(true);
    setError(null);
    const r = await callServer(() => runAction(serviceId, resourceId, id, sel.actionId, { [sel.valuesField]: keys }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setFollowUp(r.data.message ?? "Done.");
    setResult((prev) => (prev?.table ? { ...prev, table: { ...prev.table, rows: prev.table.rows.filter((row) => !keys.includes(String(row[prev.table!.rowKey]))) } } : prev));
    onDone();
  }

  // ActionDef.runOnOpen: a read-only action with no fields runs as the dialog opens.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!action.runOnOpen || autoRan.current || fields === null) return;
    autoRan.current = true;
    void run();
  }, [action.runOnOpen, fields, run]);

  const canRepeat = result !== null && (fields?.length ?? 0) > 0;
  // A visible field whose options failed to load (it shows the reason) blocks the run too.
  const optionsFailed = (fields ?? []).some((f) => f.optionsError && isFieldVisible(f, values, fields ?? []));
  const blocked = loadFailed || optionsFailed;
  return (
    <Modal
      title={id === null ? action.label : `${action.label}: ${id}`}
      onClose={onClose}
      wide={Boolean(result?.table)}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {(!result || canRepeat) && (
            <Button variant={action.danger ? "danger" : "primary"} onClick={run} disabled={busy || fields === null || blocked} data-testid="action-submit">
              {busy ? "Working…" : result ? `${action.label} again` : action.label}
            </Button>
          )}
        </>
      }
    >
      {action.confirm && !result && <p>{action.confirm}</p>}
      {(fields === null || (action.runOnOpen && busy && !result)) && <Spinner />}
      {fields && fields.length > 0 && <FormFields fields={fields} values={values} onChange={(n, v) => setValues((p) => ({ ...p, [n]: v }))} />}
      {optionsFailed && !loadFailed && <p className="text-[13px] text-muted" data-testid="action-blocked">This action cannot run until the choices above load. Close the dialog and try again.</p>}
      {loadFailed && <p className="text-[13px] text-muted" data-testid="action-blocked">This action cannot run because its form could not be loaded (see the error). Close the dialog and try again.</p>}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {result?.message && <Flash kind="success" message={result.message} />}
      {followUp && <Flash kind="success" message={followUp} />}
      {result?.table && <ResultTable table={result.table} busy={busy} onSelectionAction={runSelection} />}
      {result?.json !== undefined && result.json !== null && !result.table && <JsonView value={result.json} />}
    </Modal>
  );
}
