"use client";

/**
 * A change set's page: summary, the Changes table (with Replacement), property-level
 * details, parameters and the raw JSON changes. Execute and Delete run the stacks
 * definition's hidden actions through the engine.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { runAction } from "@/console/actions";
import { TabBody } from "@/console/ui/DetailTabs";
import { KeyValue } from "@/console/ui/KeyValue";
import { Modal } from "@/console/ui/Modal";
import { Button, buttonClass, Container, ErrorBanner, Flash, PageHeader } from "@/console/ui/primitives";
import type { ChangeSetView } from "./stack-actions";

interface ChangeSetPanelProps {
  stack: string;
  changeSet: string;
  view: ChangeSetView | null;
  error: string | null;
  flash: string | null;
}

type Pending = "execute" | "delete" | null;

export function ChangeSetPanel({ stack, changeSet, view, error, flash }: ChangeSetPanelProps) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(flash);
  const [failure, setFailure] = useState<string | null>(null);
  const stackHref = `/cloudformation/stacks/${encodeURIComponent(stack)}`;
  const canExecute = view?.executionStatus === "AVAILABLE";

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setFailure(null);
    const actionId = pending === "execute" ? "execute-change-set" : "delete-change-set";
    const r = await runAction("cloudformation", "stacks", stack, actionId, { changeSetName: changeSet });
    setBusy(false);
    setPending(null);
    if (!r.ok) return setFailure(r.error);
    if (pending === "delete") {
      router.push(stackHref);
      router.refresh();
      return;
    }
    setNotice(r.data.message ?? "Change set executed.");
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="break-all">{changeSet}</span>}
        actions={
          <>
            <Button aria-label="Refresh" onClick={() => router.refresh()}>
              ⟳
            </Button>
            <Link href={stackHref} className={buttonClass("normal")}>
              View stack
            </Link>
            {view && <Button onClick={() => setPending("delete")}>Delete</Button>}
            {view && (
              <Button variant="primary" disabled={!canExecute} onClick={() => setPending("execute")} title={canExecute ? undefined : `Execution status is ${view.executionStatus ?? "unknown"}`}>
                Execute change set
              </Button>
            )}
          </>
        }
      />
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} />}
      {failure && <ErrorBanner message={failure} onDismiss={() => setFailure(null)} />}
      {view && (
        <>
          <Container title="Overview">
            <KeyValue data={view.summary} />
          </Container>
          <Container title="Changes" counter={`(${view.changes.length})`} description="Replacement True means CloudFormation creates a new resource and deletes the old one.">
            <div data-testid="changes-table">
              <TabBody
                tab={{
                  id: "changes",
                  label: "Changes",
                  kind: "table",
                  emptyText: "No changes. The change set doesn't change any resources.",
                  data: view.changes,
                  columns: [
                    { key: "action", label: "Action", kind: "text" },
                    { key: "logicalId", label: "Logical ID", kind: "text" },
                    { key: "physicalId", label: "Physical ID", kind: "code" },
                    { key: "resourceType", label: "Resource type", kind: "text" },
                    { key: "replacement", label: "Replacement", kind: "text" },
                    { key: "scope", label: "Scope", kind: "text" },
                  ],
                }}
              />
            </div>
          </Container>
          <Container title="Property-level changes">
            <TabBody
              tab={{
                id: "details",
                label: "Details",
                kind: "table",
                emptyText: "No property-level details.",
                data: view.details,
                columns: [
                  { key: "logicalId", label: "Logical ID", kind: "text" },
                  { key: "attribute", label: "Attribute", kind: "text" },
                  { key: "name", label: "Property", kind: "text" },
                  { key: "requiresRecreation", label: "Requires recreation", kind: "text" },
                  { key: "evaluation", label: "Evaluation", kind: "text" },
                  { key: "changeSource", label: "Change source", kind: "text" },
                  { key: "causingEntity", label: "Causing entity", kind: "text" },
                ],
              }}
            />
          </Container>
          <Container title="Parameters">
            <TabBody
              tab={{
                id: "parameters",
                label: "Parameters",
                kind: "table",
                emptyText: "No parameters.",
                data: view.parameters,
                columns: [
                  { key: "key", label: "Key", kind: "text" },
                  { key: "value", label: "Value", kind: "code" },
                ],
              }}
            />
          </Container>
          <Container title="JSON changes">
            <TabBody tab={{ id: "json", label: "JSON changes", kind: "json", data: view.raw, emptyText: "No changes." }} />
          </Container>
        </>
      )}
      {pending && (
        <Modal
          title={pending === "execute" ? "Execute change set?" : "Delete change set?"}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="link" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={confirm} data-testid="confirm-change-set">
                {busy ? "Working…" : pending === "execute" ? "Execute change set" : "Delete"}
              </Button>
            </>
          }
        >
          <p>
            {pending === "execute"
              ? `Updates stack ${stack} with the changes listed. Resources marked for replacement are recreated.`
              : `Deletes change set ${changeSet}. The stack is not changed.`}
          </p>
        </Modal>
      )}
    </div>
  );
}
