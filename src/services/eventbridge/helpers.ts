/** Pure helpers for Amazon EventBridge and EventBridge Scheduler screens. */

export function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function isoOrNull(d: Date | string | undefined | null): string | null {
  if (d === undefined || d === null) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** arn:aws:events:region:account:rule/[bus/]name -> bus and rule name. */
export function parseRuleArn(arn: string): { bus: string; name: string } | null {
  const i = arn.indexOf(":rule/");
  if (!arn.startsWith("arn:") || i === -1) return null;
  const path = arn.slice(i + ":rule/".length);
  const slash = path.lastIndexOf("/");
  if (slash === -1) return path ? { bus: "default", name: path } : null;
  const bus = path.slice(0, slash);
  const name = path.slice(slash + 1);
  return bus && name ? { bus, name } : null;
}

/** The service a target ARN points at, worded as the console's target types. */
export function targetType(arn: string): string {
  const service = arn.split(":")[2] ?? "";
  const names: Record<string, string> = {
    sqs: "SQS queue",
    sns: "SNS topic",
    lambda: "Lambda function",
    states: "Step Functions state machine",
    events: "EventBridge event bus",
    logs: "CloudWatch log group",
    kinesis: "Kinesis stream",
    firehose: "Firehose stream",
    ecs: "ECS task",
    "execute-api": "API Gateway",
  };
  return names[service] ?? (service || "Unknown");
}

export function parseJsonText(v: string | undefined | null): unknown {
  if (v === undefined || v === null || v.trim() === "") return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** JSON text that must be an object (event patterns, policies); returned compact, or undefined when empty. */
export function jsonObjectText(label: string, input: unknown): string | undefined {
  if (typeof input !== "string" || input.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(`${label}: not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}: must be a JSON object.`);
  return JSON.stringify(parsed);
}

/** Builds an event pattern from the console's form fields: event source and detail types. */
export function patternFromForm(source: string, detailTypes: string): string {
  const pattern: Record<string, string[]> = {};
  const src = source.split(",").map((s) => s.trim()).filter(Boolean);
  const types = detailTypes.split(",").map((s) => s.trim()).filter(Boolean);
  if (src.length) pattern.source = src;
  if (types.length) pattern["detail-type"] = types;
  if (!Object.keys(pattern).length) throw new Error("Enter an event source or a detail type for the event pattern.");
  return JSON.stringify(pattern);
}

/** InputPathsMap is a JSON object of name -> JSONPath strings. */
export function parseInputPaths(input: unknown): Record<string, string> {
  const t = jsonObjectText("Input paths", input);
  if (!t) return {};
  const parsed = JSON.parse(t) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string") throw new Error(`Input paths: "${k}" must be a JSONPath string such as "$.detail.id".`);
    out[k] = v;
  }
  return out;
}

export type ScheduleKind = "at" | "rate" | "cron";

/** at(yyyy-mm-ddThh:mm:ss), rate(n unit) or cron(six fields), from the Scheduler form. */
export function scheduleExpression(kind: string, v: { at?: unknown; rateValue?: unknown; rateUnit?: unknown; cron?: unknown }): string {
  if (kind === "at") {
    const at = text(v.at).replace(/Z$/, "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(at)) throw new Error("Date and time: use yyyy-mm-ddThh:mm:ss, for example 2026-12-31T09:00:00.");
    return `at(${at.length === 16 ? `${at}:00` : at})`;
  }
  if (kind === "rate") {
    const n = typeof v.rateValue === "number" ? v.rateValue : Number(text(v.rateValue));
    if (!Number.isInteger(n) || n < 1) throw new Error("Rate: enter a whole number of 1 or more.");
    const unit = text(v.rateUnit) || "minutes";
    if (!["minutes", "hours", "days"].includes(unit)) throw new Error("Rate: choose minutes, hours or days.");
    return `rate(${n} ${n === 1 ? unit.replace(/s$/, "") : unit})`;
  }
  if (kind === "cron") {
    const c = text(v.cron).replace(/^cron\(/, "").replace(/\)$/, "");
    if (c.split(/\s+/).length !== 6) throw new Error("Cron expression: use six fields: minutes hours day-of-month month day-of-week year, for example 0 12 * * ? *");
    return `cron(${c})`;
  }
  throw new Error("Choose a schedule type.");
}

/** Schedules are identified by group and name; the console uses "group/name". */
export function scheduleId(group: string, name: string): string {
  return `${group}/${name}`;
}

export function parseScheduleId(id: string): { group: string; name: string } {
  const i = id.indexOf("/");
  return i === -1 ? { group: "default", name: id } : { group: id.slice(0, i), name: id.slice(i + 1) };
}

/** A rule's or schedule's state from a list row ("state") or a detail summary ("Status"). */
export function rowState(row: Record<string, unknown>): string {
  const v = row.state ?? row.Status;
  return typeof v === "string" ? v : "";
}

/** Enable is offered unless the resource is already enabled; unknown state offers it. */
export function canEnable(row: Record<string, unknown>): boolean {
  return !rowState(row).startsWith("ENABLED");
}

/** Disable is offered unless the resource is already disabled; unknown state offers it. */
export function canDisable(row: Record<string, unknown>): boolean {
  return rowState(row) !== "DISABLED";
}

export interface ScheduleParts {
  kind: ScheduleKind;
  at: string;
  rateValue: number | null;
  rateUnit: string;
  cron: string;
}

/** Splits at(...), rate(n unit) or cron(...) into the Scheduler form's fields (the reverse of scheduleExpression). */
export function parseScheduleExpression(expr: string): ScheduleParts {
  const e = expr.trim();
  const at = /^at\((.+)\)$/.exec(e);
  if (at) return { kind: "at", at: at[1].trim(), rateValue: null, rateUnit: "minutes", cron: "" };
  const rate = /^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/.exec(e);
  if (rate) return { kind: "rate", at: "", rateValue: Number(rate[1]), rateUnit: rate[2].endsWith("s") ? rate[2] : `${rate[2]}s`, cron: "" };
  const cron = /^cron\((.+)\)$/.exec(e);
  if (cron) return { kind: "cron", at: "", rateValue: null, rateUnit: "minutes", cron: cron[1].trim() };
  throw new Error(`Unrecognised schedule expression: ${expr}`);
}
