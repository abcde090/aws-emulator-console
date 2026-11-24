"use client";

/** The Code tab: the handler file in an editor, with Deploy (UpdateFunctionCode). */

import { useRouter } from "next/navigation";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Button, Container, ErrorBanner, Flash, Spinner } from "@/console/ui/primitives";
import { deployFunctionCode, functionUpdateStatus, loadFunctionCode, type FunctionCode } from "./code-actions";

const POLL_MS = 1000;
const POLL_LIMIT = 60;

export function CodeTab({ name }: { name: string }) {
  const router = useRouter();
  const [code, setCode] = useState<FunctionCode | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    loadFunctionCode(name).then((r) => {
      if (!live) return;
      if (r.ok) {
        setCode(r.data);
        setText(r.data.content ?? "");
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [name]);

  const dirty = code !== null && code.content !== null && text !== code.content;

  async function deploy() {
    if (!code?.file) return;
    setBusy(true);
    setError(null);
    const r = await deployFunctionCode(name, code.file, text);
    if (!r.ok) {
      setBusy(false);
      return setError(r.error);
    }
    setCode({ ...code, content: text, codeSha256: r.data.codeSha256 });
    // Like the console, wait until Lambda reports the update finished (LastUpdateStatus).
    let status: string | null = "InProgress";
    let reason: string | null = null;
    for (let i = 0; i < POLL_LIMIT && status === "InProgress"; i++) {
      setNotice(`Updating the function ${name}…`);
      await new Promise((res) => setTimeout(res, POLL_MS));
      const s = await functionUpdateStatus(name);
      if (!s.ok) {
        setBusy(false);
        return setError(s.error);
      }
      status = s.data.status;
      reason = s.data.reason;
    }
    setBusy(false);
    if (status === "Failed") return setError(`The update failed: ${reason ?? "no reason given"}`);
    if (status === "InProgress") return setNotice(`The update of ${name} is still in progress (LastUpdateStatus InProgress). Refresh in a moment.`);
    setNotice(`Successfully updated the function ${name}. Code SHA-256: ${r.data.codeSha256 ?? "-"}`);
    router.refresh();
  }

  /** Tab inserts two spaces instead of leaving the editor, as code editors do. */
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = el;
      const next = `${text.slice(0, s)}  ${text.slice(end)}`;
      setText(next);
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty && code?.editable) void deploy();
    }
  }

  const lines = text.split("\n").length;
  return (
    <div className="space-y-4" data-testid="code-tab">
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Container
        title="Code source"
        description={code ? `Handler ${code.handler} · Runtime ${code.runtime} · Package files: ${code.files.join(", ") || "-"}` : undefined}
        actions={
          <>
            {dirty && <span className="text-warn" data-testid="undeployed">Changes not deployed</span>}
            <Button variant="primary" disabled={!code?.editable || !dirty || busy} onClick={() => void deploy()} data-testid="deploy-code">
              {busy ? "Deploying…" : "Deploy"}
            </Button>
          </>
        }
      >
        {!code && !error && <Spinner label="Loading code" />}
        {code && code.packageType === "Image" && <p>This function is deployed as a container image; its code can&apos;t be edited here.</p>}
        {code && code.packageType !== "Image" && !code.file && <p>No file in the package matches the handler {code.handler}, so there is nothing to edit.</p>}
        {code?.file && (
          <div className="overflow-hidden rounded-lg border border-line">
            <div className="flex items-center justify-between bg-[#232f3e] px-3 py-1.5 text-[13px] text-white">
              <span className="font-mono">{code.file}</span>
              {!code.editable && <span>Read only: the package has more than one file, and Deploy would upload only this one.</span>}
            </div>
            <div className="flex bg-[#1e1e1e] font-mono text-[13px] leading-5">
              <pre aria-hidden className="select-none px-2 py-2 text-right text-[#858585]">
                {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
              </pre>
              <textarea
                aria-label="Code editor"
                data-testid="code-editor"
                spellCheck={false}
                readOnly={!code.editable}
                className="min-h-96 w-full resize-y bg-transparent px-2 py-2 text-[#d4d4d4] outline-none"
                style={{ tabSize: 2 }}
                rows={Math.max(20, lines + 2)}
                wrap="off"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
              />
            </div>
          </div>
        )}
      </Container>
    </div>
  );
}
