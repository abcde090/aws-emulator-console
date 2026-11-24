"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDate } from "@/console/format";
import { KeyValue } from "@/console/ui/KeyValue";
import { Modal } from "@/console/ui/Modal";
import { Button, Container, EmptyState, ErrorBanner, Flash } from "@/console/ui/primitives";
import { FormDialog } from "./FormDialog";
import { deployFields, variablesFields } from "./forms";
import { formatStageVariables } from "./helpers";
import { deleteRestStage, deployRestApi, listRestStages, saveRestStageVariables, type StageView } from "./rest-actions";

interface RestStagesProps {
  apiId: string;
  initial: StageView[] | null;
  initialError: string | null;
}

type Dialog = "deploy" | "variables" | "delete" | null;

export function RestStages({ apiId, initial, initialError }: RestStagesProps) {
  const [stages, setStages] = useState<StageView[]>(initial ?? []);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initial?.[0]?.name ?? null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const stage = stages.find((s) => s.name === selected) ?? null;

  const reload = useCallback(async () => {
    const r = await listRestStages(apiId);
    if (!r.ok) return setError(r.error);
    setStages(r.data);
    setError(null);
    setSelected((s) => (s && r.data.some((x) => x.name === s) ? s : r.data[0]?.name ?? null));
  }, [apiId]);

  // The tab remounts when shown again; reload so a deploy from the Resources tab appears.
  useEffect(() => {
    let live = true;
    listRestStages(apiId).then((r) => {
      if (!live || !r.ok) return;
      setStages(r.data);
      setSelected((s) => (s && r.data.some((x) => x.name === s) ? s : r.data[0]?.name ?? null));
    });
    return () => {
      live = false;
    };
  }, [apiId]);

  const done = (message: string) => {
    setDialog(null);
    setNotice(message);
    void reload();
  };

  async function remove() {
    if (!stage) return;
    const r = await deleteRestStage(apiId, stage.name);
    setDialog(null);
    if (!r.ok) return setError(r.error);
    setNotice(`Deleted stage ${stage.name}.`);
    await reload();
  }

  return (
    <div className="space-y-4" data-testid="rest-stages">
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="grid gap-4 lg:grid-cols-[minmax(14rem,18rem)_1fr]">
        <Container
          title="Stages"
          counter={`(${stages.length})`}
          actions={
            <Button aria-label="Refresh stages" onClick={() => void reload()}>
              ⟳
            </Button>
          }
        >
          <ul className="space-y-0.5" aria-label="Stages">
            {stages.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  className={`block w-full rounded px-2 py-1 text-left ${s.name === selected ? "bg-[#f2f8fd] font-bold text-primary" : "hover:bg-shade"}`}
                  onClick={() => setSelected(s.name)}
                >
                  {s.name}
                </button>
              </li>
            ))}
          </ul>
          {stages.length === 0 && !error && <EmptyState title="No stages">Deploy the API to create a stage.</EmptyState>}
        </Container>
        <Container
          title={stage ? `Stage details: ${stage.name}` : "Stage details"}
          actions={
            <>
              <Button disabled={!stage} onClick={() => setDialog("variables")}>
                Edit stage variables
              </Button>
              <Button disabled={!stage} onClick={() => setDialog("delete")}>
                Delete stage
              </Button>
              <Button variant="primary" onClick={() => setDialog("deploy")}>
                Deploy API
              </Button>
            </>
          }
        >
          {!stage && <EmptyState title="Select a stage" />}
          {stage && (
            <div className="space-y-4">
              <KeyValue
                data={{
                  "Stage name": stage.name,
                  "Invoke URL": stage.invokeUrl ?? (stage.invokeUrlError ? `Could not read: ${stage.invokeUrlError}` : null),
                  "Deployment ID": stage.deploymentId,
                  Description: stage.description,
                  "X-Ray tracing": stage.tracing ? "Active" : "Inactive",
                  Created: stage.created ? formatDate(stage.created) : null,
                  "Last updated": stage.updated ? formatDate(stage.updated) : null,
                }}
              />
              <div>
                <p className="font-bold text-muted">Stage variables</p>
                {Object.keys(stage.variables).length === 0 ? (
                  <p>No stage variables.</p>
                ) : (
                  <pre className="mt-1 rounded bg-shade p-2 font-mono text-[13px]" data-testid="stage-variables">
                    {formatStageVariables(stage.variables)}
                  </pre>
                )}
              </div>
            </div>
          )}
        </Container>
      </div>
      {dialog === "deploy" && (
        <FormDialog
          title="Deploy API"
          submitLabel="Deploy"
          fields={deployFields(stages.map((s) => ({ value: s.name, label: s.name })))}
          onSubmit={(v) => deployRestApi(apiId, v)}
          onClose={() => setDialog(null)}
          onDone={(d) => done((d as { message: string }).message)}
        />
      )}
      {dialog === "variables" && stage && (
        <FormDialog
          title={`Edit stage variables: ${stage.name}`}
          submitLabel="Save"
          fields={variablesFields}
          initial={{ variables: formatStageVariables(stage.variables) }}
          onSubmit={(v) => saveRestStageVariables(apiId, stage.name, v)}
          onClose={() => setDialog(null)}
          onDone={(d) => done((d as { message: string }).message)}
        />
      )}
      {dialog === "delete" && stage && (
        <Modal
          title={`Delete stage ${stage.name}`}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="link" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="danger" data-testid="dialog-submit" onClick={() => void remove()}>
                Delete
              </Button>
            </>
          }
        >
          <p>Clients can no longer call the API through this stage. Its deployments stay in the deployment history.</p>
        </Modal>
      )}
    </div>
  );
}
