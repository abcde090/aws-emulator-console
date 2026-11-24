"use client";

import { useState, type ReactNode } from "react";
import { initialValues, visibleValues } from "@/console/form-state";
import type { FieldMeta, FieldValues, Result } from "@/console/types";
import { FormFields } from "@/console/ui/FormFields";
import { Modal } from "@/console/ui/Modal";
import { Button, ErrorBanner } from "@/console/ui/primitives";

interface FormDialogProps {
  title: string;
  submitLabel: string;
  fields: FieldMeta[];
  initial?: FieldValues;
  danger?: boolean;
  intro?: ReactNode;
  onSubmit: (values: FieldValues) => Promise<Result<unknown>>;
  onClose: () => void;
  /** Called with the server's result after a successful submit; the dialog then closes. */
  onDone: (data: unknown) => void;
}

/** A modal form drawn from field specs; the server action re-validates the same specs. */
export function FormDialog({ title, submitLabel, fields, initial, danger, intro, onSubmit, onClose, onDone }: FormDialogProps) {
  const [values, setValues] = useState<FieldValues>(() => ({ ...initialValues(fields), ...(initial ?? {}) }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const r = await onSubmit(visibleValues(fields, values));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone(r.data);
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={() => void submit()} disabled={busy} data-testid="dialog-submit">
            {busy ? "Working…" : submitLabel}
          </Button>
        </>
      }
    >
      {intro}
      {fields.length > 0 && <FormFields fields={fields} values={values} onChange={(n, v) => setValues((p) => ({ ...p, [n]: v }))} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
    </Modal>
  );
}
