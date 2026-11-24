/** Pure helpers for the DMS console: table mappings, task settings and labels. Unit tested. */

export type RuleAction = "include" | "exclude";

/** The selection rule the console's guided UI builds: one schema/table pattern, include or exclude. */
export function selectionRules(schema: string, table: string, action: RuleAction): string {
  const s = schema.trim() || "%";
  const t = table.trim() || "%";
  return JSON.stringify({
    rules: [{ "rule-type": "selection", "rule-id": "1", "rule-name": "1", "object-locator": { "schema-name": s, "table-name": t }, "rule-action": action }],
  });
}

/** Checks a table-mapping JSON document has a non-empty rules array with at least one selection rule. */
export function tableMappingProblem(text: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return "Table mappings must be valid JSON.";
  }
  const rules = (doc as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules) || rules.length === 0) return 'Table mappings need a "rules" array with at least one rule.';
  const hasSelection = rules.some((r) => (r as { "rule-type"?: unknown } | null)?.["rule-type"] === "selection");
  return hasSelection ? null : "Table mappings need at least one selection rule.";
}

/** Task settings the guided form sets: target table preparation mode and LOB handling. */
export function taskSettings(prepMode: string, lobMode: string, validation: boolean): string {
  const lob = lobMode === "none"
    ? { SupportLobs: false }
    : lobMode === "full"
      ? { SupportLobs: true, FullLobMode: true, LimitedSizeLobMode: false }
      : { SupportLobs: true, FullLobMode: false, LimitedSizeLobMode: true, LobMaxSize: 32 };
  return JSON.stringify({ FullLoadSettings: { TargetTablePrepMode: prepMode }, TargetMetadata: lob, ValidationSettings: { EnableValidation: validation } });
}

export function migrationTypeLabel(v: string | undefined): string | null {
  if (v === "full-load") return "Migrate existing data";
  if (v === "cdc") return "Replicate data changes only";
  if (v === "full-load-and-cdc") return "Migrate existing data and replicate ongoing changes";
  return v ?? null;
}

/** Pretty-prints a JSON string from the API; text that is not JSON is returned unchanged. */
export function prettyJson(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function endpointTypeLabel(v: string | undefined): string | null {
  if (!v) return null;
  return v.toUpperCase() === "SOURCE" ? "Source" : v.toUpperCase() === "TARGET" ? "Target" : v;
}

const DEFAULT_PORTS: Record<string, number> = {
  mysql: 3306,
  mariadb: 3306,
  aurora: 3306,
  postgres: 5432,
  "aurora-postgresql": 5432,
  oracle: 1521,
  sqlserver: 1433,
};

/** The engine's default port, as the console fills it in; undefined for an unknown engine. */
export function defaultPort(engine: string): number | undefined {
  return DEFAULT_PORTS[engine];
}

/** Task states StartReplicationTask accepts; while starting, running, stopping or deleting it is refused. */
const STARTABLE = new Set(["ready", "stopped", "failed"]);

export function canStartTask(status: unknown): boolean {
  return typeof status !== "string" || status === "" || STARTABLE.has(status.toLowerCase());
}

/** The start option the console proposes: a first start for a new task, resume for a stopped or failed one. */
export function defaultStartType(status: string | undefined): "start-replication" | "resume-processing" {
  return status === "stopped" || status === "failed" ? "resume-processing" : "start-replication";
}
