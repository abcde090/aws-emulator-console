"use client";

import { useEffect, useState } from "react";
import { deleteResource, loadFields } from "../actions.ts";
import { callServer } from "../call.ts";
import { deleteConfirmation, initialValues, visibleValues } from "../form-state.ts";
import { DELETE_TARGET } from "../targets.ts";
import type { FieldMeta, FieldValues } from "../types.ts";
import { FormFields } from "./FormFields.tsx";
import { Modal } from "./Modal.tsx";
import { Button, ErrorBanner, Spinner } from "./primitives.tsx";

interface DeleteDialogProps {
  serviceId: string;
  resourceId: string;
  singular: string;
  id: string;
  /** The resource's name (its nameField value); typed to confirm when confirmText is "name". */
  name?: string;
  confirmText?: "name" | "delete";
  /** The definition's delete has fields (e.g. "Create final snapshot"). */
  hasFields?: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

/** Asks the user to type the name (or "delete") before deleting, as the console does. */
export function DeleteDialog({ serviceId, resourceId, singular, id, name, confirmText = "delete", hasFields = false, onClose, onDeleted }: DeleteDialogProps) {
  const expected = deleteConfirmation(confirmText, id, name);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<FieldMeta[] | null>(hasFields ? null : []);
  const [values, setValues] = useState<FieldValues>({});
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!hasFields) return;
    let live = true;
    callServer(() => loadFields(serviceId, resourceId, DELETE_TARGET, id)).then((r) => {
      if (!live) return;
      if (r.ok) {
        setFields(r.data);
        setValues(initialValues(r.data));
      } else {
        // CQ-5: without its fields the delete cannot run; keep the button disabled.
        setError(r.error);
        setLoadFailed(true);
        setFields([]);
      }
    });
    return () => {
      live = false;
    };
  }, [serviceId, resourceId, id, hasFields]);

  async function confirm() {
    if (!fields || loadFailed) return;
    setBusy(true);
    setError(null);
    const r = await callServer(() => deleteResource(serviceId, resourceId, id, visibleValues(fields, values)));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDeleted();
  }

  return (
    <Modal
      title={`Delete ${singular}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || fields === null || loadFailed || typed !== expected} onClick={confirm} data-testid="confirm-delete">
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </>
      }
    >
      <p>
        Delete {singular} <strong className="break-all">{name && name !== id ? `${name} (${id})` : id}</strong>? This can&apos;t be undone.
      </p>
      {fields === null && <Spinner />}
      {fields && fields.length > 0 && <FormFields fields={fields} values={values} onChange={(n, v) => setValues((p) => ({ ...p, [n]: v }))} />}
      <label className="block space-y-1">
        <span>
          To confirm, type <strong>{expected}</strong> in the field.
        </span>
        <input
          aria-label="Confirm deletion"
          className="w-full rounded-[2px] border border-[#aab7b8] bg-white px-2.5 py-1.5 text-[13px] text-ink placeholder:text-[#879596] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder={expected}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </label>
      {error && <ErrorBanner message={error} />}
    </Modal>
  );
}
