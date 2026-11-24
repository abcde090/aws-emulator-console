"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Container, ErrorBanner, Flash } from "@/console/ui/primitives";
import { createKeyPairFromForm, importKeyPairFromForm } from "./launch-actions";

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

/** Saves the private key the way the console does: one download, right after creation. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-pem-file" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface KeyPairFormProps {
  /** Called with the new key pair's name after it is created or imported. */
  onDone: (name: string) => void;
  /** Offer "Import key pair" too (the standalone page does; the wizard's modal doesn't). */
  allowImport?: boolean;
  onCancel?: () => void;
}

export function KeyPairForm({ onDone, allowImport = false, onCancel }: KeyPairFormProps) {
  const [mode, setMode] = useState<"create" | "import">("create");
  const [name, setName] = useState("");
  const [type, setType] = useState<"rsa" | "ed25519">("rsa");
  const [format, setFormat] = useState<"pem" | "ppk">("pem");
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ fileName: string; material: string } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    if (mode === "create") {
      const r = await createKeyPairFromForm({ name, type, format });
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setSaved({ fileName: r.data.fileName, material: r.data.material });
      downloadText(r.data.fileName, r.data.material);
      setNotice(`Successfully created key pair ${r.data.name} (${r.data.keyPairId ?? "no ID returned"}). The private key file ${r.data.fileName} was downloaded; this is the only time it is available.`);
      onDone(r.data.name);
    } else {
      const r = await importKeyPairFromForm({ name, publicKey });
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setNotice(`Successfully imported key pair ${r.data.name}. Fingerprint: ${r.data.fingerprint ?? "-"}`);
      onDone(r.data.name);
    }
  }

  return (
    <div className="space-y-4" data-testid="key-pair-form">
      {allowImport && (
        <div role="radiogroup" aria-label="Key pair source" className="flex gap-4">
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "create"} onChange={() => setMode("create")} /> Create key pair
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "import"} onChange={() => setMode("import")} /> Import key pair
          </label>
        </div>
      )}
      <Container title="Key pair">
        <div className="space-y-4">
          <label className="block space-y-1">
            <span className="font-bold">Key pair name</span>
            <span className="block text-[13px] text-muted">The name can include up to 255 ASCII characters. It can&apos;t include leading or trailing spaces.</span>
            <input aria-label="Key pair name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter key pair name" />
          </label>
          {mode === "create" ? (
            <>
              <fieldset className="space-y-1">
                <legend className="font-bold">Key pair type</legend>
                <label className="flex items-center gap-2"><input type="radio" name="kp-type" checked={type === "rsa"} onChange={() => setType("rsa")} /> RSA</label>
                <label className="flex items-center gap-2"><input type="radio" name="kp-type" checked={type === "ed25519"} onChange={() => setType("ed25519")} /> ED25519</label>
              </fieldset>
              <fieldset className="space-y-1">
                <legend className="font-bold">Private key file format</legend>
                <label className="flex items-center gap-2"><input type="radio" name="kp-format" checked={format === "pem"} onChange={() => setFormat("pem")} /> .pem (for use with OpenSSH)</label>
                <label className="flex items-center gap-2"><input type="radio" name="kp-format" checked={format === "ppk"} onChange={() => setFormat("ppk")} /> .ppk (for use with PuTTY)</label>
              </fieldset>
            </>
          ) : (
            <label className="block space-y-1">
              <span className="font-bold">Public key contents</span>
              <span className="block text-[13px] text-muted">Paste an OpenSSH public key (ssh-rsa or ssh-ed25519).</span>
              <textarea aria-label="Public key contents" className={`${inputClass} min-h-28 font-mono text-[13px]`} value={publicKey} onChange={(e) => setPublicKey(e.target.value)} />
            </label>
          )}
        </div>
      </Container>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && <Flash kind="success" message={notice} />}
      {saved && (
        <Button onClick={() => downloadText(saved.fileName, saved.material)}>Download {saved.fileName} again</Button>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="link" onClick={onCancel}>
            {notice ? "Close" : "Cancel"}
          </Button>
        )}
        <Button variant="primary" disabled={busy || name.trim() === ""} onClick={() => void submit()} data-testid="key-pair-submit">
          {busy ? "Working…" : mode === "create" ? "Create key pair" : "Import key pair"}
        </Button>
      </div>
    </div>
  );
}

/** The standalone Create key pair page: the form plus a link back to the list once done. */
export function KeyPairCreate() {
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="max-w-3xl space-y-4">
      <KeyPairForm allowImport onDone={setDone} />
      {done && (
        <Link href={`/ec2/key-pairs/${encodeURIComponent(done)}`} className="font-bold" data-testid="key-pair-link">
          View key pair {done}
        </Link>
      )}
    </div>
  );
}
