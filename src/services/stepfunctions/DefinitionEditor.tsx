"use client";

/**
 * Amazon States Language editor for a state machine: format, validate
 * (ValidateStateMachineDefinition) and save (UpdateStateMachine) through the engine's
 * hidden actions, so every call is permission-checked like the rest of the console.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { runAction } from "@/console/actions";
import { Button, Container, ErrorBanner, Flash } from "@/console/ui/primitives";

interface DefinitionEditorProps {
  arn: string;
  initial: string;
}

function pretty(definition: string): string {
  try {
    return JSON.stringify(JSON.parse(definition), null, 2);
  } catch {
    return definition;
  }
}

export function DefinitionEditor({ arn, initial }: DefinitionEditorProps) {
  const router = useRouter();
  const [value, setValue] = useState(() => pretty(initial));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = value !== pretty(initial);

  async function call(actionId: "validate-definition" | "update-definition") {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await runAction("stepfunctions", "state-machines", arn, actionId, { definition: value });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setNotice(r.data.message ?? "Done.");
    if (actionId === "update-definition") router.refresh();
  }

  function format() {
    try {
      setValue(JSON.stringify(JSON.parse(value), null, 2));
      setError(null);
    } catch (err: unknown) {
      setError(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <Container
      title="Definition"
      description="Amazon States Language (JSON). Saving validates the definition first, then calls UpdateStateMachine."
      actions={
        <>
          <Button onClick={format} disabled={busy}>Format</Button>
          <Button onClick={() => call("validate-definition")} disabled={busy} data-testid="sfn-validate">Validate</Button>
          <Button variant="primary" onClick={() => call("update-definition")} disabled={busy || !dirty} data-testid="sfn-save">Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        <textarea
          aria-label="State machine definition"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-h-[28rem] w-full rounded-lg border border-line p-3 font-mono text-[13px]"
        />
      </div>
    </Container>
  );
}
