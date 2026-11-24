"use client";

/** IAM policy simulator: SimulatePrincipalPolicy for a user, group or role, or SimulateCustomPolicy for a pasted policy. */

import { useState } from "react";
import { Button, Container, EmptyState, ErrorBanner } from "@/console/ui/primitives";
import { runSimulation } from "../editor-actions";
import { EMPTY_IDENTITY_POLICY } from "../policy-json";
import type { SimulationRow } from "../simulator-rows";

export interface PrincipalChoice {
  name: string;
  type: string;
  arn: string;
}

interface SimulatorProps {
  principals: PrincipalChoice[];
  initialPrincipal: string | null;
}

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

function decisionClass(d: string): string {
  if (d.startsWith("Allowed")) return "font-bold text-ok";
  if (d.startsWith("Denied")) return "font-bold text-bad";
  return "";
}

export function Simulator({ principals, initialPrincipal }: SimulatorProps) {
  const [mode, setMode] = useState<"principal" | "custom">("principal");
  const [principal, setPrincipal] = useState(initialPrincipal ?? principals[0]?.arn ?? "");
  const [policy, setPolicy] = useState(EMPTY_IDENTITY_POLICY);
  const [actions, setActions] = useState("");
  const [resources, setResources] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SimulationRow[] | null>(null);

  async function simulate() {
    setBusy(true);
    setError(null);
    const r = await runSimulation({ mode, principalArn: principal, policy, actions, resources });
    setBusy(false);
    if (!r.ok) {
      setRows(null);
      return setError(r.error);
    }
    setRows(r.data);
  }

  return (
    <div className="space-y-5">
      <Container title="Policies to simulate" description="The simulator evaluates the policies with IAM's own logic in the emulator. It does not make the requests.">
        <div className="space-y-4">
          <div role="radiogroup" aria-label="Mode" className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2"><input type="radio" checked={mode === "principal"} onChange={() => setMode("principal")} /> Existing user, group or role</label>
            <label className="flex items-center gap-2"><input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} /> New policy (custom JSON)</label>
          </div>
          {mode === "principal" ? (
            <div className="space-y-1">
              <label htmlFor="sim-principal" className="block font-bold">Principal</label>
              {principals.length === 0 ? (
                <p className="text-muted">No users, groups or roles in this account.</p>
              ) : (
                <select id="sim-principal" className={inputClass} value={principal} onChange={(e) => setPrincipal(e.target.value)}>
                  {principals.map((p) => (
                    <option key={p.arn} value={p.arn}>{`${p.name} (${p.type})`}</option>
                  ))}
                </select>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <label htmlFor="sim-policy" className="block font-bold">Policy document</label>
              <textarea id="sim-policy" className={`${inputClass} min-h-48 font-mono text-[13px]`} value={policy} onChange={(e) => setPolicy(e.target.value)} spellCheck={false} />
            </div>
          )}
        </div>
      </Container>
      <Container title="Action settings and results">
        <div className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="sim-actions" className="block font-bold">Actions</label>
            <p className="text-[13px] text-muted">One or more actions, separated by commas or new lines, for example s3:GetObject, ec2:RunInstances.</p>
            <textarea id="sim-actions" className={`${inputClass} min-h-20 font-mono text-[13px]`} value={actions} onChange={(e) => setActions(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="sim-resources" className="block font-bold">Resource ARNs <span className="font-normal italic text-muted">- optional</span></label>
            <p className="text-[13px] text-muted">Leave empty to simulate against all resources (*).</p>
            <textarea id="sim-resources" className={`${inputClass} min-h-16 font-mono text-[13px]`} value={resources} onChange={(e) => setResources(e.target.value)} />
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={simulate} disabled={busy || (mode === "principal" && !principal)} data-testid="simulate">
              {busy ? "Running…" : "Run simulation"}
            </Button>
          </div>
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
          {rows && rows.length === 0 && <EmptyState title="The simulator returned no results." />}
          {rows && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left" data-testid="simulation-results">
                <thead>
                  <tr className="border-b-2 border-line-soft">
                    <th className="px-2 py-1.5">Action</th>
                    <th className="px-2 py-1.5">Resource</th>
                    <th className="px-2 py-1.5">Permission</th>
                    <th className="px-2 py-1.5">Matched statements</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.action}|${r.resource}`} className="border-b border-line-soft align-top">
                      <td className="px-2 py-1.5 font-mono text-[13px]">{r.action}</td>
                      <td className="px-2 py-1.5 font-mono text-[13px] break-all">{r.resource}</td>
                      <td className={`px-2 py-1.5 ${decisionClass(r.decision)}`}>{r.decision}</td>
                      <td className="px-2 py-1.5">{r.matched}{r.missingContext ? ` (missing context: ${r.missingContext})` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}
