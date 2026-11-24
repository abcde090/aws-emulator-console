"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Option, Result } from "@/console/types";
import { CellValue } from "@/console/ui/CellValue";
import { Modal } from "@/console/ui/Modal";
import { Button, Container, EmptyState, ErrorBanner, Flash } from "@/console/ui/primitives";
import { FormDialog } from "./FormDialog";
import { attachFields, integrationFields, routeFields, v2StageFields, variablesFields } from "./forms";
import { formatStageVariables, functionName } from "./helpers";
import {
  attachV2Integration,
  createV2Integration,
  createV2Route,
  createV2Stage,
  deleteV2Integration,
  deleteV2Route,
  deleteV2Stage,
  deployV2Stage,
  loadV2Api,
  saveV2StageVariables,
  type V2ApiView,
} from "./http-actions";

export type V2Panel = "routes" | "integrations" | "stages";

interface HttpApiPanelProps {
  apiId: string;
  panel: V2Panel;
  initial: V2ApiView | null;
  initialError: string | null;
  lambda: Option[];
  lambdaError: string | null;
}

type Dialog =
  | { kind: "create" }
  | { kind: "attach"; id: string }
  | { kind: "variables"; id: string }
  | { kind: "delete"; id: string; label: string }
  | null;

interface Col {
  key: string;
  label: string;
  kind: "text" | "code" | "status" | "boolean" | "date";
}

const integrationLabel = (i: V2ApiView["integrations"][number]): string =>
  `${i.id} - ${i.lambdaFunction ? `Lambda ${functionName(i.lambdaFunction)}` : `${i.type ?? ""} ${i.uri ?? ""}`}`.trim();

/** One of the HTTP/WebSocket API tabs: Routes, Integrations or Stages. */
export function HttpApiPanel({ apiId, panel, initial, initialError, lambda, lambdaError }: HttpApiPanelProps) {
  const [api, setApi] = useState<V2ApiView | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const reload = useCallback(async () => {
    const r = await loadV2Api(apiId);
    if (!r.ok) return setError(r.error);
    setApi(r.data);
    setError(null);
  }, [apiId]);

  // The tab remounts when shown again; reload so changes made on other tabs appear.
  useEffect(() => {
    let live = true;
    loadV2Api(apiId).then((r) => {
      if (live && r.ok) setApi(r.data);
    });
    return () => {
      live = false;
    };
  }, [apiId]);

  const finish = (message: string) => {
    setDialog(null);
    setNotice(message);
    void reload();
  };
  const run = async (fn: () => Promise<Result<unknown>>, message: string) => {
    const r = await fn();
    setDialog(null);
    if (!r.ok) return setError(r.error);
    setNotice(message);
    setSelected(null);
    await reload();
  };

  const protocol = api?.protocol ?? "HTTP";
  const integrationOptions: Option[] = (api?.integrations ?? []).map((i) => ({ value: i.id, label: integrationLabel(i) }));
  let title = "";
  let columns: Col[] = [];
  let rows: Record<string, unknown>[] = [];
  let idKey = "id";
  let createLabel = "";
  let description: ReactNode = null;
  if (panel === "routes") {
    title = "Routes";
    createLabel = "Create route";
    description = protocol === "WEBSOCKET" ? "Routes match messages by the route selection expression." : "A route sends requests that match METHOD /path to an integration.";
    columns = [
      { key: "key", label: "Route", kind: "code" },
      { key: "integration", label: "Integration", kind: "text" },
      { key: "authorization", label: "Authorization", kind: "text" },
      { key: "id", label: "Route ID", kind: "text" },
    ];
    rows = (api?.routes ?? []).map((r) => {
      const integ = api?.integrations.find((i) => r.target === `integrations/${i.id}`);
      return { ...r, integration: integ ? integrationLabel(integ) : r.target ?? "No integration attached" };
    });
  } else if (panel === "integrations") {
    title = "Integrations";
    createLabel = "Create integration";
    description = "Integrations are the back ends routes send requests to.";
    columns = [
      { key: "id", label: "Integration ID", kind: "text" },
      { key: "type", label: "Type", kind: "text" },
      { key: "target", label: "Target", kind: "code" },
      { key: "method", label: "Method", kind: "text" },
      { key: "payload", label: "Payload format", kind: "text" },
      { key: "timeoutMs", label: "Timeout (ms)", kind: "text" },
    ];
    rows = (api?.integrations ?? []).map((i) => ({ ...i, target: i.lambdaFunction ?? i.uri ?? "-" }));
  } else {
    title = "Stages";
    createLabel = "Create stage";
    description = "A stage is a named reference to a deployment, with its own invoke URL.";
    idKey = "name";
    columns = [
      { key: "name", label: "Stage name", kind: "text" },
      { key: "invokeUrl", label: "Invoke URL", kind: "code" },
      { key: "autoDeploy", label: "Automatic deployment", kind: "boolean" },
      { key: "deploymentId", label: "Deployment ID", kind: "text" },
      { key: "vars", label: "Stage variables", kind: "code" },
      { key: "updated", label: "Last updated", kind: "date" },
    ];
    rows = (api?.stages ?? []).map((s) => ({ ...s, vars: formatStageVariables(s.variables) || "-" }));
  }
  const sel = rows.find((r) => String(r[idKey]) === selected) ?? null;
  const selStage = panel === "stages" ? api?.stages.find((s) => s.name === selected) ?? null : null;

  return (
    <div className="space-y-4" data-testid={`v2-${panel}`}>
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Container
        title={title}
        counter={`(${rows.length})`}
        description={description}
        actions={
          <>
            <Button aria-label={`Refresh ${title.toLowerCase()}`} onClick={() => void reload()}>
              ⟳
            </Button>
            {panel === "routes" && (
              <Button disabled={!sel} onClick={() => sel && setDialog({ kind: "attach", id: String(sel.id) })}>
                Attach integration
              </Button>
            )}
            {panel === "stages" && (
              <>
                <Button disabled={!selStage} onClick={() => selStage && setDialog({ kind: "variables", id: selStage.name })}>
                  Edit stage variables
                </Button>
                <Button disabled={!selStage || selStage.autoDeploy} onClick={() => selStage && void run(() => deployV2Stage(apiId, selStage.name), `Deployed to stage ${selStage.name}.`)}>
                  Deploy
                </Button>
              </>
            )}
            <Button disabled={!sel} onClick={() => sel && setDialog({ kind: "delete", id: String(sel[idKey]), label: String(panel === "routes" ? sel.key : sel[idKey]) })}>
              Delete
            </Button>
            <Button variant="primary" onClick={() => setDialog({ kind: "create" })}>
              {createLabel}
            </Button>
          </>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid={`${panel}-table`}>
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="w-8" />
                {columns.map((c) => (
                  <th key={c.key} className="px-2 py-1.5 font-bold">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const id = String(r[idKey]);
                return (
                  <tr key={id} className={`border-b border-line-soft ${selected === id ? "bg-[#f2f8fd]" : "hover:bg-shade"}`} onClick={() => setSelected(id)}>
                    <td className="px-2 py-1.5">
                      <input type="radio" name={`${panel}-row`} aria-label={`Select ${id}`} checked={selected === id} onChange={() => setSelected(id)} />
                    </td>
                    {columns.map((c) => (
                      <td key={c.key} className="max-w-md px-2 py-1.5">
                        <CellValue kind={c.kind} value={r[c.key]} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && !error && <EmptyState title={`No ${title.toLowerCase()}`} />}
        </div>
      </Container>

      {dialog?.kind === "create" && panel === "routes" && (
        <FormDialog title="Create route" submitLabel="Create" fields={routeFields(protocol, integrationOptions)} onSubmit={(v) => createV2Route(apiId, v)} onClose={() => setDialog(null)} onDone={(d) => finish((d as { message: string }).message)} />
      )}
      {dialog?.kind === "create" && panel === "integrations" && (
        <FormDialog
          title="Create integration"
          submitLabel="Create"
          fields={integrationFields(protocol, lambda, lambdaError ?? undefined)}
          onSubmit={(v) => createV2Integration(apiId, v)}
          onClose={() => setDialog(null)}
          onDone={(d) => finish((d as { message: string }).message)}
        />
      )}
      {dialog?.kind === "create" && panel === "stages" && (
        <FormDialog title="Create stage" submitLabel="Create" fields={v2StageFields} onSubmit={(v) => createV2Stage(apiId, v)} onClose={() => setDialog(null)} onDone={(d) => finish((d as { message: string }).message)} />
      )}
      {dialog?.kind === "attach" && (
        <FormDialog
          title="Attach integration"
          submitLabel="Attach"
          fields={attachFields(integrationOptions)}
          onSubmit={(v) => attachV2Integration(apiId, dialog.id, v)}
          onClose={() => setDialog(null)}
          onDone={(d) => finish((d as { message: string }).message)}
        />
      )}
      {dialog?.kind === "variables" && selStage && (
        <FormDialog
          title={`Edit stage variables: ${selStage.name}`}
          submitLabel="Save"
          fields={variablesFields}
          initial={{ variables: formatStageVariables(selStage.variables) }}
          onSubmit={(v) => saveV2StageVariables(apiId, selStage.name, v)}
          onClose={() => setDialog(null)}
          onDone={(d) => finish((d as { message: string }).message)}
        />
      )}
      {dialog?.kind === "delete" && (
        <Modal
          title={`Delete ${dialog.label}`}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="link" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                data-testid="dialog-submit"
                onClick={() =>
                  void run(
                    () => (panel === "routes" ? deleteV2Route(apiId, dialog.id) : panel === "integrations" ? deleteV2Integration(apiId, dialog.id) : deleteV2Stage(apiId, dialog.id)),
                    `Deleted ${dialog.label}.`
                  )
                }
              >
                Delete
              </Button>
            </>
          }
        >
          <p>This can&apos;t be undone.</p>
        </Modal>
      )}
    </div>
  );
}
