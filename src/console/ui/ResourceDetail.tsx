"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { Detail, ResourceMeta } from "../types.ts";
import { ActionDialog } from "./ActionDialog.tsx";
import { ActionsMenu } from "./ActionsMenu.tsx";
import { DeleteDialog } from "./DeleteDialog.tsx";
import { DetailTabs } from "./DetailTabs.tsx";
import { KeyValue } from "./KeyValue.tsx";
import { Button, Container, ErrorBanner, Flash, PageHeader } from "./primitives.tsx";
import { useHydrated } from "./useHydrated.ts";
import type { ExtraTab } from "./DetailTabs.tsx";
import { DELETE_TARGET } from "../targets.ts";

interface ResourceDetailProps {
  serviceId: string;
  resource: ResourceMeta;
  id: string;
  detail: Detail | null;
  error: string | null;
  flash?: string | null;
  /** Hand-built tabs: first by default, or placed with `after` (see DetailTabs). */
  extraTabs?: ExtraTab[];
  /** Hand-built header controls (e.g. a menu that opens its own wizard), placed before Actions and Delete. */
  headerActions?: ReactNode;
}

export function ResourceDetail({ serviceId, resource, id, detail, error, flash = null, extraTabs = [], headerActions = null }: ResourceDetailProps) {
  const router = useRouter();
  const [dialog, setDialog] = useState<{ kind: "action"; actionId: string } | { kind: "delete" } | null>(null);
  const [notice, setNotice] = useState<string | null>(flash);
  const listHref = `/${serviceId}/${resource.id}`;
  const action = dialog?.kind === "action" ? resource.actions.find((a) => a.id === dialog.actionId) : undefined;
  const title = detail && resource.nameField ? String(detail.summary[resource.nameField] ?? detail.summary.Name ?? id) : id;
  const nameValue = detail && resource.nameField ? detail.summary[resource.nameField] : undefined;
  const hidden = detail?.unavailableActions ?? [];
  const hydrated = useHydrated();

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="break-all">{title}</span>}
        actions={
          <>
            <Button aria-label="Refresh" title="Refresh" onClick={() => router.refresh()} className="px-2.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </Button>
            {headerActions}
            <ActionsMenu items={resource.actions.filter((a) => !a.hidden && !hidden.includes(a.id)).map((a) => ({ id: a.id, label: a.label, danger: a.danger }))} onSelect={(actionId) => setDialog({ kind: "action", actionId })} />
            {resource.canDelete && !hidden.includes(DELETE_TARGET) && (
              <Button disabled={!hydrated} onClick={() => setDialog({ kind: "delete" })}>
                Delete
              </Button>
            )}
          </>
        }
      />
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} />}
      {detail && (
        <>
          <Container title="Summary">
            <KeyValue data={detail.summary} labels={detail.summaryLabels} />
          </Container>
          <DetailTabs tabs={detail.tabs ?? []} extra={extraTabs} />
        </>
      )}
      {!detail && extraTabs.length > 0 && <DetailTabs tabs={[]} extra={extraTabs} />}
      {dialog?.kind === "delete" && (
        <DeleteDialog
          serviceId={serviceId}
          resourceId={resource.id}
          singular={resource.singular}
          id={id}
          name={typeof nameValue === "string" || typeof nameValue === "number" ? String(nameValue) : undefined}
          confirmText={resource.deleteConfirm}
          hasFields={resource.deleteHasFields}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            router.push(`${listHref}?deleted=${encodeURIComponent(id)}`);
            router.refresh();
          }}
        />
      )}
      {action && (
        <ActionDialog
          serviceId={serviceId}
          resourceId={resource.id}
          id={id}
          action={action}
          onClose={() => setDialog(null)}
          onDone={() => {
            setNotice(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
