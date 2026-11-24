"use client";

/** The Test tab: invoke the function with a JSON event and show the result, summary and log output. */

import { useState } from "react";
import { KeyValue } from "@/console/ui/KeyValue";
import { Button, Container, ErrorBanner } from "@/console/ui/primitives";
import { testFunction, type TestResult } from "./code-actions";

/** The console's "hello-world" event template. */
const HELLO_WORLD = JSON.stringify({ key1: "value1", key2: "value2", key3: "value3" }, null, 2);

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export function TestTab({ name }: { name: string }) {
  const [event, setEvent] = useState(HELLO_WORLD);
  const [qualifier, setQualifier] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    const r = await testFunction(name, event, qualifier || undefined);
    setBusy(false);
    if (!r.ok) {
      setResult(null);
      return setError(r.error);
    }
    setResult(r.data);
  }

  function format() {
    try {
      setEvent(JSON.stringify(JSON.parse(event), null, 2));
      setError(null);
    } catch {
      setError("The event is not valid JSON.");
    }
  }

  return (
    <div className="space-y-4" data-testid="test-tab">
      {result && (
        <div role="status" className={`rounded-[6px] border px-4 py-3 ${result.status === "succeeded" ? "border-ok bg-ok-bg" : "border-bad bg-bad-bg"}`} data-testid="test-result">
          <p className="font-bold">Executing function: {result.status}{result.functionError ? ` (${result.functionError})` : ""}</p>
          <details open className="mt-2">
            <summary className="cursor-pointer font-bold">Details</summary>
            <p className="mt-2 font-bold">Response</p>
            <pre className="max-h-80 overflow-auto rounded bg-white p-2 font-mono text-[13px] whitespace-pre-wrap" data-testid="test-response">{result.response || "null"}</pre>
            <p className="mt-3 font-bold">Summary</p>
            <div className="rounded bg-white p-2">
              <KeyValue
                data={{
                  "Request ID": result.requestId,
                  "Executed version": result.executedVersion,
                  "Status code": result.statusCode,
                  "Init duration": result.initDurationMs !== null ? `${result.initDurationMs} ms` : null,
                  Duration: result.report.durationMs !== null ? `${result.report.durationMs} ms` : null,
                  "Billed duration": result.report.billedDurationMs !== null ? `${result.report.billedDurationMs} ms` : null,
                  "Resources configured": result.report.memorySizeMb !== null ? `${result.report.memorySizeMb} MB` : null,
                  "Max memory used": result.report.maxMemoryUsedMb !== null ? `${result.report.maxMemoryUsedMb} MB` : null,
                }}
              />
            </div>
            <p className="mt-3 font-bold">Log output</p>
            <p className="text-[13px] text-muted">The last 4 KB of the execution log (LogType Tail).</p>
            <pre className="max-h-80 overflow-auto rounded bg-white p-2 font-mono text-[13px] whitespace-pre-wrap" data-testid="test-log">{result.log || "(no log output)"}</pre>
          </details>
        </div>
      )}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Container
        title="Test event"
        description="Invoke the function synchronously (RequestResponse) with this event. Test events are not saved."
        actions={
          <>
            <Button onClick={format}>Format JSON</Button>
            <Button variant="primary" disabled={busy} onClick={() => void run()} data-testid="test-invoke">
              {busy ? "Invoking…" : "Test"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="font-bold">Version or alias</span> <span className="italic text-muted">- optional</span>
            <input aria-label="Qualifier" className={`${inputClass} max-w-xs`} placeholder="$LATEST" value={qualifier} onChange={(e) => setQualifier(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="font-bold">Event JSON</span>
            <textarea aria-label="Event JSON" spellCheck={false} className={`${inputClass} min-h-48 font-mono text-[13px]`} value={event} onChange={(e) => setEvent(e.target.value)} />
          </label>
        </div>
      </Container>
    </div>
  );
}
