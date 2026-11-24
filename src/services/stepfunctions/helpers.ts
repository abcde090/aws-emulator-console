/** Pure helpers for AWS Step Functions screens: execution history rows and definition parsing. */

export const STATE_MACHINE_ARN = /^arn:aws[a-z-]*:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}$/;

export function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function isoOrNull(d: Date | string | undefined | null): string | null {
  if (d === undefined || d === null) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseJsonText(v: string | undefined | null): unknown {
  if (v === undefined || v === null || v.trim() === "") return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** arn:...:execution:<machine>:<name> -> arn:...:stateMachine:<machine>. */
export function stateMachineArnOfExecution(arn: string): string | null {
  const m = /^(arn:aws[a-z-]*:states:[a-z0-9-]+:\d{12}):(?:execution|express):([^:]+):/.exec(arn);
  return m ? `${m[1]}:stateMachine:${m[2]}` : null;
}

export const HELLO_WORLD = `{
  "Comment": "A Hello World example using a Pass state, a Wait state and a Choice state",
  "StartAt": "Pass",
  "States": {
    "Pass": {
      "Type": "Pass",
      "Result": { "IsHelloWorldExample": true },
      "ResultPath": "$.example",
      "Next": "Wait 3 sec"
    },
    "Wait 3 sec": { "Type": "Wait", "Seconds": 3, "Next": "Is Hello World Example?" },
    "Is Hello World Example?": {
      "Type": "Choice",
      "Choices": [{ "Variable": "$.example.IsHelloWorldExample", "BooleanEquals": true, "Next": "Hello World" }],
      "Default": "Fail"
    },
    "Hello World": { "Type": "Succeed" },
    "Fail": { "Type": "Fail", "Error": "NotHelloWorld", "Cause": "The input was not the Hello World example" }
  }
}`;

export interface StateRow {
  name: string;
  type: string;
  next: string;
  [key: string]: unknown;
}

/** Top-level states of an ASL definition, in order, with where each goes next. */
export function statesOf(definition: string | undefined): StateRow[] {
  const def = parseJsonText(definition);
  if (!def || typeof def !== "object") return [];
  const states = (def as { States?: unknown }).States;
  if (!states || typeof states !== "object") return [];
  return Object.entries(states as Record<string, unknown>).map(([name, raw]) => {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const choices = Array.isArray(s.Choices) ? s.Choices.map((c) => (c && typeof c === "object" ? (c as { Next?: unknown }).Next : undefined)) : [];
    const nexts = [typeof s.Next === "string" ? s.Next : null, ...choices.filter((c): c is string => typeof c === "string"), typeof s.Default === "string" ? s.Default : null]
      .filter((n): n is string => n !== null);
    const end = s.End === true || s.Type === "Succeed" || s.Type === "Fail";
    return { name, type: typeof s.Type === "string" ? s.Type : "-", next: end ? "End" : nexts.length ? [...new Set(nexts)].join(", ") : "-" };
  });
}

/** One history event, as GetExecutionHistory returns it (only the fields the table reads). */
export interface HistoryEventLike {
  id?: number;
  previousEventId?: number;
  type?: string;
  timestamp?: Date | string;
  [details: string]: unknown;
}

export interface HistoryRow {
  id: number | null;
  type: string;
  step: string | null;
  resource: string | null;
  elapsedMs: number | null;
  timestamp: string | null;
  details: string | null;
  [key: string]: unknown;
}

function detailsObject(e: HistoryEventLike): Record<string, unknown> | null {
  for (const [k, v] of Object.entries(e)) {
    if (k.endsWith("EventDetails") && v && typeof v === "object") return v as Record<string, unknown>;
  }
  return null;
}

/**
 * Event history rows like the console's table: step name (carried from the last state that
 * was entered), elapsed time since the execution started, and the event's key details.
 */
export function historyRows(events: HistoryEventLike[]): HistoryRow[] {
  const start = events.length ? new Date(events[0].timestamp ?? "").getTime() : NaN;
  let currentStep: string | null = null;
  return events.map((e) => {
    const d = detailsObject(e);
    const name = d && typeof d.name === "string" ? d.name : null;
    if (e.type?.endsWith("StateEntered") && name) currentStep = name;
    const step = name ?? (e.type?.startsWith("Execution") ? null : currentStep);
    if (e.type?.endsWith("StateExited")) currentStep = null;
    const ts = new Date(e.timestamp ?? "").getTime();
    const parts: string[] = [];
    if (d) {
      for (const key of ["error", "cause", "input", "output", "resource", "resourceType"]) {
        const v = d[key];
        if (typeof v === "string" && v !== "") parts.push(`${key}: ${v.length > 300 ? `${v.slice(0, 300)}…` : v}`);
      }
    }
    return {
      id: typeof e.id === "number" ? e.id : null,
      type: e.type ?? "-",
      step,
      resource: d && typeof d.resource === "string" ? d.resource : null,
      elapsedMs: Number.isFinite(ts) && Number.isFinite(start) ? ts - start : null,
      timestamp: isoOrNull(e.timestamp ?? null),
      details: parts.length ? parts.join("\n") : null,
    };
  });
}

/** An execution's status from a list row ("status") or a detail summary ("Execution status"). */
function executionStatus(row: Record<string, unknown>): string {
  const v = row.status ?? row["Execution status"];
  return typeof v === "string" ? v : "";
}

/** Stop applies only to running executions; unknown status offers it. */
export function canStop(row: Record<string, unknown>): boolean {
  const status = executionStatus(row);
  return status === "" || status === "RUNNING" || status === "PENDING_REDRIVE";
}

/** Redrive applies to failed, timed-out or aborted executions that Step Functions says are redrivable. */
export function canRedrive(row: Record<string, unknown>): boolean {
  const status = executionStatus(row);
  if (status !== "" && !["FAILED", "TIMED_OUT", "ABORTED"].includes(status)) return false;
  const redrive = row["Redrive status"];
  return redrive !== "NOT_REDRIVABLE";
}
