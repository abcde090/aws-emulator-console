"use client";

/** The "Secret value" container: Retrieve secret value, Key/value or Plaintext view, Edit (PutSecretValue). */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Container, ErrorBanner, Flash } from "@/console/ui/primitives";
import { retrieveSecretValue, saveSecretValue, type RetrievedSecret } from "./value-actions";

export function SecretValuePanel({ name }: { name: string }) {
  const router = useRouter();
  const [secret, setSecret] = useState<RetrievedSecret | null>(null);
  const [view, setView] = useState<"kv" | "plaintext">("kv");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function retrieve() {
    setBusy(true);
    setError(null);
    const r = await retrieveSecretValue(name);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSecret(r.data);
    setView(r.data.value.kind === "kv" ? "kv" : "plaintext");
  }

  async function save() {
    setBusy(true);
    setError(null);
    const r = await saveSecretValue(name, draft);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setNotice(r.data);
    setEditing(false);
    await retrieve();
    router.refresh();
  }

  return (
    <Container
      title="Secret value"
      description="Retrieve and view the secret value."
      actions={
        !secret ? (
          <Button onClick={retrieve} disabled={busy} data-testid="retrieve-secret">{busy ? "Retrieving…" : "Retrieve secret value"}</Button>
        ) : editing ? (
          <>
            <Button variant="link" onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={busy} data-testid="save-secret">Save</Button>
          </>
        ) : (
          secret.value.kind !== "binary" && <Button onClick={() => { setDraft(secret.raw); setEditing(true); }} data-testid="edit-secret">Edit</Button>
        )
      }
    >
      <div className="space-y-3">
        {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {!secret && !error && <p className="text-muted">The value is only read (GetSecretValue) when you choose Retrieve secret value.</p>}
        {secret && editing && (
          <>
            <p className="text-[13px] text-muted">Edit the SecretString. Key/value secrets are a JSON object. Saving creates a new version labelled AWSCURRENT; the old one becomes AWSPREVIOUS.</p>
            <textarea aria-label="Secret value" className="min-h-40 w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1 font-mono text-[13px]" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          </>
        )}
        {secret && !editing && secret.value.kind === "binary" && <p>Binary secret ({secret.value.bytes} bytes). Binary values can only be read with the API or CLI.</p>}
        {secret && !editing && secret.value.kind !== "binary" && (
          <>
            {secret.value.kind === "kv" && (
              <div role="tablist" className="flex gap-1 border-b border-line">
                {(["kv", "plaintext"] as const).map((v) => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`-mb-px border-b-2 px-3 py-1 font-bold ${view === v ? "border-primary text-primary" : "border-transparent"}`}>
                    {v === "kv" ? "Key/value" : "Plaintext"}
                  </button>
                ))}
              </div>
            )}
            {view === "kv" && secret.value.kind === "kv" ? (
              <table className="w-full border-collapse text-left" data-testid="secret-kv">
                <thead>
                  <tr className="border-b-2 border-line-soft"><th className="px-2 py-1.5">Secret key</th><th className="px-2 py-1.5">Secret value</th></tr>
                </thead>
                <tbody>
                  {secret.value.pairs.map((p) => (
                    <tr key={p.Key} className="border-b border-line-soft"><td className="px-2 py-1.5">{p.Key}</td><td className="px-2 py-1.5 font-mono text-[13px] break-all">{p.Value}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <pre className="overflow-x-auto rounded-lg bg-shade p-3 font-mono text-[13px] whitespace-pre-wrap" data-testid="secret-plaintext">{secret.raw}</pre>
            )}
            <p className="text-[13px] text-muted">Version {secret.versionId ?? "-"} ({secret.stages.join(", ")})</p>
          </>
        )}
      </div>
    </Container>
  );
}
