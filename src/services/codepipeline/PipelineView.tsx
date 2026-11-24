"use client";

/**
 * The pipeline diagram: stages top to bottom with their actions, the transitions between
 * them, approvals, retries and stop. Every button runs one of the pipeline definition's
 * hidden actions through the engine (runAction), so values are validated on the server.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { runAction } from "@/console/actions";
import { formatDate } from "@/console/format";
import { Modal } from "@/console/ui/Modal";
import { Button, Container, ErrorBanner, Flash } from "@/console/ui/primitives";
import { pipelineTone, statusText, type Tone } from "./helpers";
import type { ActionView, PipelineView as View, StageView } from "./read";

const TONE_CLASS: Record<Tone, string> = { success: "text-ok", error: "text-bad", pending: "text-primary", warning: "text-warn", neutral: "text-muted" };
const TONE_ICON: Record<Tone, string> = { success: "●", error: "✕", pending: "◌", warning: "▲", neutral: "○" };
const BORDER: Record<Tone, string> = { success: "border-ok", error: "border-bad", pending: "border-primary", warning: "border-warn", neutral: "border-line-soft" };

function PipelineStatus({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted">Didn&apos;t run</span>;
  const tone = pipelineTone(value);
  return (
    <span className={`inline-flex items-center gap-1 ${TONE_CLASS[tone]}`} data-testid="pipeline-status">
      <span aria-hidden>{TONE_ICON[tone]}</span>
      {statusText(value)}
    </span>
  );
}

type Dialog =
  | { kind: "approve"; stage: string; action: ActionView }
  | { kind: "disable"; stage: string }
  | { kind: "stop"; executionId: string }
  | { kind: "json" }
  | null;

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export function PipelineView({ view }: { view: View }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState("Approved");
  const [comment, setComment] = useState("");
  const [stopMode, setStopMode] = useState("stop");
  const [json, setJson] = useState(view.structureJson);

  const running = view.stages.some((s) => s.status === "InProgress" || s.actions.some((a) => a.status === "InProgress"));
  const runningExecution = view.stages.find((s) => s.status === "InProgress")?.executionId ?? null;

  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => router.refresh(), 3000);
    return () => clearTimeout(t);
  }, [running, router, view]);

  async function run(actionId: string, values: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const r = await runAction("codepipeline", "pipelines", view.name, actionId, values);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDialog(null);
    setComment("");
    setNotice(r.data.message ?? null);
    router.refresh();
  }

  function closeDialog() {
    setDialog(null);
    setError(null);
  }

  return (
    <div className="space-y-4" data-testid="pipeline-view">
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && !dialog && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Container
        title="Pipeline"
        description={`Version ${view.version ?? "-"}${running ? " · refreshing every 3 seconds while an execution runs" : ""}`}
        actions={
          <>
            <Button aria-label="Refresh pipeline" onClick={() => router.refresh()}>
              ⟳
            </Button>
            {runningExecution && (
              <Button disabled={busy} onClick={() => setDialog({ kind: "stop", executionId: runningExecution })}>
                Stop execution
              </Button>
            )}
            <Button disabled={busy} onClick={() => setDialog({ kind: "json" })}>
              Edit
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void run("release", {})}>
              Release change
            </Button>
          </>
        }
      >
        <ol className="mx-auto max-w-3xl space-y-0">
          {view.stages.map((s, i) => (
            <li key={s.name}>
              {i > 0 && <Transition stage={s} busy={busy} onEnable={() => void run("transition", { stage: s.name, enable: "enable", reason: "" })} onDisable={() => setDialog({ kind: "disable", stage: s.name })} />}
              <Stage stage={s} busy={busy} onApprove={(a) => setDialog({ kind: "approve", stage: s.name, action: a })} onRetry={() => s.executionId && void run("retry-stage", { stage: s.name, executionId: s.executionId, mode: "FAILED_ACTIONS" })} />
            </li>
          ))}
        </ol>
      </Container>

      {dialog?.kind === "approve" && (
        <Modal
          title={`Review: ${dialog.action.name}`}
          onClose={closeDialog}
          footer={
            <>
              <Button variant="link" onClick={closeDialog}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} data-testid="submit-approval" onClick={() => void run("approve", { stage: dialog.stage, action: dialog.action.name, token: dialog.action.token ?? "", status: decision, summary: comment })}>
                Submit
              </Button>
            </>
          }
        >
          {error && <ErrorBanner message={error} />}
          {dialog.action.summary && <p className="rounded-lg bg-shade p-3">{dialog.action.summary}</p>}
          <fieldset className="space-y-1">
            {["Approved", "Rejected"].map((d) => (
              <label key={d} className="flex items-center gap-2">
                <input type="radio" name="decision" value={d} checked={decision === d} onChange={() => setDecision(d)} />
                {d === "Approved" ? "Approve" : "Reject"}
              </label>
            ))}
          </fieldset>
          <label className="block space-y-1">
            <span className="font-bold">Comments - optional</span>
            <textarea aria-label="Comments" rows={3} className={inputClass} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </Modal>
      )}
      {dialog?.kind === "disable" && (
        <Modal
          title={`Disable transition into ${dialog.stage}`}
          onClose={closeDialog}
          footer={
            <>
              <Button variant="link" onClick={closeDialog}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void run("transition", { stage: dialog.stage, enable: "disable", reason: comment })}>
                Disable
              </Button>
            </>
          }
        >
          {error && <ErrorBanner message={error} />}
          <p>Executions stop before this stage until you enable the transition again.</p>
          <label className="block space-y-1">
            <span className="font-bold">Reason</span>
            <input aria-label="Reason" className={inputClass} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </Modal>
      )}
      {dialog?.kind === "stop" && (
        <Modal
          title="Stop execution"
          onClose={closeDialog}
          footer={
            <>
              <Button variant="link" onClick={closeDialog}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void run("stop-execution", { executionId: dialog.executionId, mode: stopMode, reason: comment })}>
                Stop
              </Button>
            </>
          }
        >
          {error && <ErrorBanner message={error} />}
          <p className="font-mono text-[13px]">{dialog.executionId}</p>
          <fieldset className="space-y-1">
            <label className="flex items-center gap-2">
              <input type="radio" name="stopMode" checked={stopMode === "stop"} onChange={() => setStopMode("stop")} />
              Stop and wait: let in-progress actions finish
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="stopMode" checked={stopMode === "abandon"} onChange={() => setStopMode("abandon")} />
              Stop and abandon: don&apos;t wait for in-progress actions
            </label>
          </fieldset>
          <label className="block space-y-1">
            <span className="font-bold">Comments - optional</span>
            <input aria-label="Stop comments" className={inputClass} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </Modal>
      )}
      {dialog?.kind === "json" && (
        <Modal
          title="Edit pipeline structure"
          wide
          onClose={closeDialog}
          footer={
            <>
              <Button variant="link" onClick={closeDialog}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void run("update-structure", { pipeline: json })}>
                Save
              </Button>
            </>
          }
        >
          {error && <ErrorBanner message={error} />}
          <p className="text-muted">The pipeline declaration from GetPipeline. Saving calls UpdatePipeline and raises the version by one.</p>
          <textarea aria-label="Pipeline structure (JSON)" rows={24} className={`${inputClass} font-mono text-[13px]`} value={json} onChange={(e) => setJson(e.target.value)} />
        </Modal>
      )}
    </div>
  );
}

function Transition({ stage, busy, onEnable, onDisable }: { stage: StageView; busy: boolean; onEnable: () => void; onDisable: () => void }) {
  return (
    <div className="flex items-center justify-center gap-3 py-2 text-muted">
      <span aria-hidden className="text-xl">↓</span>
      {stage.transitionEnabled ? (
        <Button variant="link" disabled={busy} onClick={onDisable} aria-label={`Disable transition into ${stage.name}`}>
          Disable transition
        </Button>
      ) : (
        <>
          <span className="text-warn">Transition disabled{stage.disabledReason ? `: ${stage.disabledReason}` : ""}</span>
          <Button variant="link" disabled={busy} onClick={onEnable} aria-label={`Enable transition into ${stage.name}`}>
            Enable transition
          </Button>
        </>
      )}
    </div>
  );
}

function Stage({ stage, busy, onApprove, onRetry }: { stage: StageView; busy: boolean; onApprove: (a: ActionView) => void; onRetry: () => void }) {
  const tone = pipelineTone(stage.status);
  return (
    <section className={`rounded-[6px] border ${BORDER[tone]} bg-white p-4`} data-testid={`stage-${stage.name}`} aria-label={`Stage ${stage.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold">{stage.name}</h3>
        <div className="flex items-center gap-3">
          <PipelineStatus value={stage.status} />
          {stage.status === "Failed" && stage.executionId && (
            <Button disabled={busy} onClick={onRetry}>
              Retry stage
            </Button>
          )}
        </div>
      </div>
      {stage.executionId && (
        <p className="text-[13px] text-muted">
          Execution <Link href={`?execution=${encodeURIComponent(stage.executionId)}`}>{stage.executionId}</Link>
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {stage.actions.map((a) => (
          <li key={a.name} className="rounded-lg border border-line-soft p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold">
                {a.name} <span className="font-normal text-muted">({a.provider})</span>
              </span>
              <PipelineStatus value={a.status} />
            </div>
            {a.summary && a.summary !== a.error && <p className="mt-1 break-words">{a.summary}</p>}
            {a.error && <p className="mt-1 text-bad break-words">{a.error}</p>}
            <div className="mt-1 flex flex-wrap items-center gap-3 text-[13px] text-muted">
              {a.lastChange && <span>{formatDate(a.lastChange)}</span>}
              {a.provider === "CodeBuild" && a.externalId && <Link href={`/codebuild/build-history/${encodeURIComponent(a.externalId)}`}>View build {a.externalId}</Link>}
              {a.provider === "CodeCommit" && a.externalId && <span className="font-mono">Commit {a.externalId.slice(0, 8)}</span>}
            </div>
            {a.category === "Approval" && a.status === "InProgress" && a.token && (
              <div className="mt-2">
                <Button variant="primary" disabled={busy} onClick={() => onApprove(a)}>
                  Review
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
