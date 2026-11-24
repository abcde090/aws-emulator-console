/** Pure helpers for the policy simulator screen (parsing input, shaping results). */

export interface SimulationRow {
  action: string;
  resource: string;
  decision: string;
  matched: string;
  missingContext: string;
}

interface EvalLike {
  EvalActionName?: string;
  EvalResourceName?: string;
  EvalDecision?: string;
  MatchedStatements?: { SourcePolicyId?: string; SourcePolicyType?: string }[];
  MissingContextValues?: string[];
}

/** Splits on commas, spaces and new lines; actions must look like service:Action. */
export function parseActionNames(raw: unknown, arns = false): string[] {
  if (typeof raw !== "string") return [];
  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (arns ? !(p === "*" || p.startsWith("arn:")) : !/^[a-zA-Z0-9-]+:[a-zA-Z0-9*?]+$/.test(p)) {
      throw new Error(arns ? `"${p}" is not a resource ARN (or *).` : `"${p}" is not an action like s3:GetObject.`);
    }
  }
  return [...new Set(parts)];
}

const DECISIONS: Record<string, string> = { allowed: "Allowed", explicitDeny: "Denied (explicit deny)", implicitDeny: "Denied (implicit deny)" };

export function simulationRows(results: EvalLike[]): SimulationRow[] {
  return results.map((r) => ({
    action: r.EvalActionName ?? "",
    resource: r.EvalResourceName ?? "*",
    decision: DECISIONS[r.EvalDecision ?? ""] ?? r.EvalDecision ?? "-",
    matched: (r.MatchedStatements ?? []).map((m) => `${m.SourcePolicyId ?? "?"}${m.SourcePolicyType ? ` (${m.SourcePolicyType})` : ""}`).join(", ") || "-",
    missingContext: (r.MissingContextValues ?? []).join(", "),
  }));
}
