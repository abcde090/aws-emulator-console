"use client";

/**
 * The S3 bucket Management tab: lifecycle rules, replication rules and inventory
 * configurations, each a table with Create, Edit and Delete like the S3 console. The forms
 * are the bucket definition's hidden actions (management-actions.ts), so the engine loads
 * the fields, prefills Edit dialogs and validates every value on the server.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { loadFields, runAction } from "@/console/actions";
import { callServer } from "@/console/call";
import { initialValues, isFieldVisible, visibleValues } from "@/console/form-state";
import type { FieldMeta, FieldValues, Row } from "@/console/types";
import { joinId } from "@/console/values";
import { FormFields } from "@/console/ui/FormFields";
import { Modal } from "@/console/ui/Modal";
import { Button, Container, inputClass, EmptyState, ErrorBanner, Flash, Spinner, StatusBadge } from "@/console/ui/primitives";
import type { ManagementData, Section } from "./management-data";

interface Column {
  key: string;
  label: string;
  status?: boolean;
}

interface SectionSpec {
  kind: "lifecycle" | "replication" | "inventory";
  title: string;
  singular: string;
  description: string;
  emptyTitle: string;
  emptyText: string;
  columns: Column[];
}

const LIFECYCLE: SectionSpec = {
  kind: "lifecycle",
  title: "Lifecycle rules",
  singular: "lifecycle rule",
  description: "Use lifecycle rules to define actions you want Amazon S3 to take during an object's lifetime, such as transitioning objects to another storage class, archiving them, or deleting them after a specified period of time.",
  emptyTitle: "No lifecycle rules",
  emptyText: "There are no lifecycle rules for this bucket.",
  columns: [
    { key: "id", label: "Lifecycle rule name" },
    { key: "status", label: "Status", status: true },
    { key: "scope", label: "Scope" },
    { key: "currentActions", label: "Current version actions" },
    { key: "noncurrentActions", label: "Noncurrent versions actions" },
    { key: "deleteMarkers", label: "Expired object delete markers" },
    { key: "multipart", label: "Incomplete multipart uploads" },
  ],
};

const REPLICATION: SectionSpec = {
  kind: "replication",
  title: "Replication rules",
  singular: "replication rule",
  description: "Use replication rules to define options you want Amazon S3 to apply during replication, such as server-side encryption, replica ownership, transitioning replicas to another storage class, and more.",
  emptyTitle: "No replication rules",
  emptyText: "You don't have any replication rules.",
  columns: [
    { key: "id", label: "Replication rule name" },
    { key: "status", label: "Status", status: true },
    { key: "destination", label: "Destination bucket" },
    { key: "priority", label: "Priority" },
    { key: "scope", label: "Scope" },
    { key: "storageClass", label: "Storage class" },
    { key: "deleteMarkers", label: "Delete marker replication" },
  ],
};

const INVENTORY: SectionSpec = {
  kind: "inventory",
  title: "Inventory configurations",
  singular: "inventory configuration",
  description: "Inventory configurations list your objects and their metadata on a daily or weekly schedule, delivered to a destination bucket.",
  emptyTitle: "No inventory configurations",
  emptyText: "You don't have any inventory configurations.",
  columns: [
    { key: "id", label: "Name" },
    { key: "status", label: "Status", status: true },
    { key: "scope", label: "Scope" },
    { key: "destination", label: "Destination" },
    { key: "frequency", label: "Frequency" },
    { key: "format", label: "Format" },
    { key: "versions", label: "Object versions" },
  ],
};

type Dialog = { kind: "form"; spec: SectionSpec; ruleId: string | null } | { kind: "delete"; spec: SectionSpec; ruleId: string };

function RuleFormDialog({ bucket, spec, ruleId, onClose, onSaved }: { bucket: string; spec: SectionSpec; ruleId: string | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const target = ruleId === null ? bucket : joinId(bucket, ruleId);
  const [fields, setFields] = useState<FieldMeta[] | null>(null);
  const [values, setValues] = useState<FieldValues>({});
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void callServer(() => loadFields("s3", "buckets", `${spec.kind}-save`, target)).then((r) => {
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
  }, [spec.kind, target]);

  const blocked = loadFailed || (fields ?? []).some((f) => f.optionsError && isFieldVisible(f, values, fields ?? []));
  async function save() {
    if (!fields || blocked) return;
    setBusy(true);
    setError(null);
    const r = await callServer(() => runAction("s3", "buckets", target, `${spec.kind}-save`, visibleValues(fields, values)));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onSaved(r.data.message ?? "Saved.");
  }

  const title = ruleId === null ? `Create ${spec.singular}` : `Edit ${spec.singular}: ${ruleId}`;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="link" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || fields === null || blocked} data-testid="rule-save">
            {busy ? "Saving…" : ruleId === null ? `Create ${spec.singular}` : "Save changes"}
          </Button>
        </>
      }
    >
      {fields === null && <Spinner />}
      {fields && fields.length > 0 && <FormFields fields={fields} values={values} onChange={(n, v) => setValues((p) => ({ ...p, [n]: v }))} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
    </Modal>
  );
}

function DeleteRuleDialog({ bucket, spec, ruleId, onClose, onDeleted }: { bucket: string; spec: SectionSpec; ruleId: string; onClose: () => void; onDeleted: (msg: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  async function remove() {
    setBusy(true);
    setError(null);
    const r = await callServer(() => runAction("s3", "buckets", joinId(bucket, ruleId), `${spec.kind}-delete`, { confirm }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDeleted(r.data.message ?? "Deleted.");
  }
  return (
    <Modal
      title={`Delete ${spec.singular}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="link" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={remove} disabled={busy || confirm !== ruleId} data-testid="rule-delete-confirm">{busy ? "Deleting…" : "Delete"}</Button>
        </>
      }
    >
      <p>
        Delete {spec.singular} <strong>{ruleId}</strong>? This can&apos;t be undone.
      </p>
      <label className="block space-y-1 text-[13px]">
        <span className="font-semibold">To confirm deletion, enter <span className="font-mono">{ruleId}</span></span>
        <input className={`w-full ${inputClass}`} aria-label="Confirm rule deletion" data-testid="field-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
    </Modal>
  );
}

function RulesTable({ spec, rows, selected, onSelect }: { spec: SectionSpec; rows: Row[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]" data-testid={`${spec.kind}-table`}>
        <thead>
          <tr className="border-b border-line bg-shade text-muted">
            <th className="w-8" />
            {spec.columns.map((c) => (
              <th key={c.key} className="px-2.5 py-2 font-bold">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const id = String(r.id ?? "");
            return (
              <tr key={id} className={`border-b border-line-soft align-top ${selected === id ? "bg-info-bg" : "hover:bg-shade"}`} onClick={() => onSelect(id)}>
                <td className="px-2 py-1.5">
                  <input type="radio" name={`${spec.kind}-rule`} aria-label={`Select ${id}`} checked={selected === id} onChange={() => onSelect(id)} />
                </td>
                {spec.columns.map((c) => (
                  <td key={c.key} className="max-w-xs px-2.5 py-1.5 break-words">
                    {c.status ? <StatusBadge value={r[c.key]} /> : r[c.key] === null || r[c.key] === undefined ? "-" : String(r[c.key])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RulesSection({ spec, section, note, onOpen }: { spec: SectionSpec; section: Section<Row[]>; note?: ReactNode; onOpen: (d: Dialog) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const rows = section.ok ? section.data : [];
  const selected = picked !== null && rows.some((r) => r.id === picked) ? picked : null;
  return (
    <Container
      title={spec.title}
      counter={section.ok ? `(${rows.length})` : undefined}
      description={spec.description}
      actions={
        section.ok ? (
          <>
            <Button disabled={selected === null} onClick={() => selected !== null && onOpen({ kind: "delete", spec, ruleId: selected })} data-testid={`${spec.kind}-delete`}>Delete</Button>
            <Button disabled={selected === null} onClick={() => selected !== null && onOpen({ kind: "form", spec, ruleId: selected })} data-testid={`${spec.kind}-edit`}>Edit</Button>
            <Button variant="primary" onClick={() => onOpen({ kind: "form", spec, ruleId: null })} data-testid={`${spec.kind}-create`}>Create {spec.singular}</Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {note}
        {!section.ok ? (
          <ErrorBanner title={`Could not load ${spec.title.toLowerCase()}`} message={section.error} />
        ) : rows.length === 0 ? (
          <EmptyState title={spec.emptyTitle}>{spec.emptyText}</EmptyState>
        ) : (
          <RulesTable spec={spec} rows={rows} selected={selected} onSelect={setPicked} />
        )}
      </div>
    </Container>
  );
}

export function ManagementTab({ bucket, data, versioning }: { bucket: string; data: ManagementData; versioning: string | null }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const close = useCallback(() => setDialog(null), []);
  const done = useCallback(
    (msg: string) => {
      setDialog(null);
      setFlash(msg);
      router.refresh();
    },
    [router]
  );
  const open = useCallback((d: Dialog) => {
    setFlash(null);
    setDialog(d);
  }, []);

  const replication: Section<Row[]> = data.replication.ok ? { ok: true, data: data.replication.data.rules } : data.replication;
  const role = data.replication.ok ? data.replication.data.role : null;
  const replicationNote = (
    <>
      {versioning !== null && versioning !== "Enabled" && (
        <Flash kind="info" message={`Replication requires Bucket Versioning on the source and destination buckets. This bucket's versioning is ${versioning}.`} />
      )}
      {role && (
        <p className="text-[13px]" data-testid="replication-role">
          <span className="font-semibold">IAM role:</span> <span className="font-mono">{role}</span>
        </p>
      )}
    </>
  );

  return (
    <div className="space-y-4" data-testid="management-tab">
      {flash && <Flash kind="success" message={flash} onDismiss={() => setFlash(null)} />}
      <RulesSection spec={LIFECYCLE} section={data.lifecycle} onOpen={open} />
      <RulesSection spec={REPLICATION} section={replication} note={replicationNote} onOpen={open} />
      <RulesSection spec={INVENTORY} section={data.inventory} onOpen={open} />
      {dialog?.kind === "form" && <RuleFormDialog bucket={bucket} spec={dialog.spec} ruleId={dialog.ruleId} onClose={close} onSaved={done} />}
      {dialog?.kind === "delete" && <DeleteRuleDialog bucket={bucket} spec={dialog.spec} ruleId={dialog.ruleId} onClose={close} onDeleted={done} />}
    </div>
  );
}
