"use client";

/**
 * A policy JSON editor panel (trust policy, managed policy, key policy, resource policy).
 * Checks the document as you type with the same rules the server applies, then calls the
 * given server action. Reused by IAM, KMS and Secrets Manager screens.
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { Result } from "@/console/types";
import { Button, Container, ErrorBanner, Flash } from "@/console/ui/primitives";
import { checkPolicy, type PolicyKind } from "../policy-json";

export interface JsonEditorProps {
  title: string;
  description?: string;
  initial: string;
  kind: PolicyKind;
  saveLabel: string;
  /** Server action bound to the resource; returns a success message. */
  save: (text: string) => Promise<Result<string>>;
  /** Shown instead of the editor when the document can't be edited (e.g. AWS managed). */
  readOnlyReason?: string;
  /** Extra optional action, e.g. "Remove policy". */
  remove?: { label: string; run: () => Promise<Result<string>> };
}

export function JsonEditor({ title, description, initial, kind, saveLabel, save, readOnlyReason, remove }: JsonEditorProps) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const check = useMemo(() => checkPolicy(text, kind), [text, kind]);

  async function submit(fn: () => Promise<Result<string>>) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setNotice(r.data);
    setEditing(false);
    router.refresh();
  }

  return (
    <Container
      title={title}
      description={description}
      actions={
        readOnlyReason ? undefined : editing ? (
          <>
            <Button variant="link" onClick={() => { setText(initial); setEditing(false); }}>Cancel</Button>
            <Button variant="primary" disabled={busy || !check.ok} onClick={() => submit(() => save(text))} data-testid="json-save">
              {busy ? "Saving…" : saveLabel}
            </Button>
          </>
        ) : (
          <>
            {remove && initial.trim() !== "" && (
              <Button variant="danger" disabled={busy} onClick={() => submit(remove.run)}>{remove.label}</Button>
            )}
            <Button onClick={() => { setText(initial); setEditing(true); }} data-testid="json-edit">Edit</Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {readOnlyReason && <p className="text-muted">{readOnlyReason}</p>}
        {editing ? (
          <>
            <textarea
              aria-label={`${title} JSON`}
              className="min-h-80 w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1 font-mono text-[13px] focus:border-primary focus:outline-none"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {check.ok ? (
              <p className="text-ok" data-testid="json-check">No errors. The document is valid JSON with the required policy elements.</p>
            ) : (
              <ul className="list-disc pl-5 text-bad" data-testid="json-check">
                {check.errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
          </>
        ) : initial.trim() === "" ? (
          <p className="text-muted">No policy. Choose Edit to add one.</p>
        ) : (
          <pre className="overflow-x-auto rounded-lg bg-shade p-3 font-mono text-[13px]" data-testid="json-view">{initial}</pre>
        )}
      </div>
    </Container>
  );
}
