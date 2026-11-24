/**
 * Pure helpers for the CloudFormation screens: name rules, template sources, parameter
 * lists, and the rows drawn for change sets, drift and events. No SDK calls here.
 */

import type { FieldMeta, FieldValues, Row } from "../../console/types.ts";

/** Stack and stack set names: a letter first, then letters, numbers and hyphens, at most 128. */
export const STACK_NAME = "[A-Za-z][A-Za-z0-9-]{0,127}";
export const CHANGE_SET_NAME = "[A-Za-z][A-Za-z0-9-]{0,127}";
const NAME_RE = new RegExp(`^${STACK_NAME}$`);

export const CAPABILITIES = ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_TEXT: Record<Capability, string> = {
  CAPABILITY_IAM: "I acknowledge that AWS CloudFormation might create IAM resources.",
  CAPABILITY_NAMED_IAM: "I acknowledge that AWS CloudFormation might create IAM resources with custom names.",
  CAPABILITY_AUTO_EXPAND: "I acknowledge that AWS CloudFormation might require the following capability: CAPABILITY_AUTO_EXPAND",
};

export function isStackName(v: unknown): v is string {
  return typeof v === "string" && NAME_RE.test(v);
}

export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);
}

export type TemplateSource = { TemplateBody: string } | { TemplateURL: string } | { UsePreviousTemplate: true };

/**
 * The template the user chose: pasted text, an Amazon S3 URL, or (for change sets) the
 * stack's current template. Throws a message the form shows when something is missing.
 */
export function templateSource(source: unknown, body: unknown, url: unknown, allowCurrent = false): TemplateSource {
  if (source === "current") {
    if (!allowCurrent) throw new Error("Choose a template.");
    return { UsePreviousTemplate: true };
  }
  if (source === "url") {
    const u = typeof url === "string" ? url.trim() : "";
    if (!/^https:\/\/\S+$/.test(u)) throw new Error("Enter the Amazon S3 URL of the template, starting with https://.");
    return { TemplateURL: u };
  }
  if (source === "body") {
    const b = typeof body === "string" ? body : "";
    if (b.trim() === "") throw new Error("Paste a template in JSON or YAML.");
    if (b.length > 51200) throw new Error("A template passed as text can be at most 51,200 bytes. Upload it to Amazon S3 and use its URL instead.");
    return { TemplateBody: b };
  }
  throw new Error("Choose a template source.");
}

export interface ParameterValue {
  ParameterKey: string;
  ParameterValue?: string;
  UsePreviousValue?: boolean;
}

/**
 * Parameters arrive as JSON: either {"Key": "Value"} or the API's list form
 * [{"ParameterKey": "...", "ParameterValue": "..."} | {"ParameterKey": "...", "UsePreviousValue": true}].
 */
export function parseParameters(raw: unknown): ParameterValue[] {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return [];
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("Parameters must be valid JSON.");
    }
  }
  if (Array.isArray(data)) {
    return data.map((p, i) => {
      const e = p as Record<string, unknown> | null;
      if (!e || typeof e.ParameterKey !== "string" || e.ParameterKey === "") throw new Error(`Parameter ${i + 1} needs a ParameterKey.`);
      if (e.UsePreviousValue === true) return { ParameterKey: e.ParameterKey, UsePreviousValue: true };
      if (typeof e.ParameterValue !== "string") throw new Error(`Parameter ${e.ParameterKey} needs a ParameterValue (text) or UsePreviousValue: true.`);
      return { ParameterKey: e.ParameterKey, ParameterValue: e.ParameterValue };
    });
  }
  if (data && typeof data === "object") {
    return Object.entries(data as Record<string, unknown>).map(([k, v]) => {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new Error(`Parameter ${k} must be text.`);
      return { ParameterKey: k, ParameterValue: String(v) };
    });
  }
  throw new Error("Parameters must be a JSON object of key/value pairs.");
}

/** Comma, space or newline separated 12-digit account IDs. */
export function parseAccounts(raw: unknown): string[] {
  const parts = (typeof raw === "string" ? raw : "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const bad = parts.find((p) => !/^\d{12}$/.test(p));
  if (bad !== undefined) throw new Error(`"${bad}" is not a 12-digit AWS account ID.`);
  if (parts.length === 0) throw new Error("Enter at least one AWS account ID.");
  return [...new Set(parts)];
}

/** "arn:aws:cloudformation:us-east-1:111:stack/name/uuid" -> "name". */
export function stackNameFromId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const m = /:stack\/([^/]+)\//.exec(id);
  return m ? m[1] : id;
}

/** Templates come back as text (JSON or YAML) or, from some tools, as an object. */
export function formatTemplate(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body !== "string") return JSON.stringify(body, null, 2);
  const t = body.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}

/** "{\"a\":1}" (a JSON string property bag) -> pretty text; anything else as given. */
export function prettyJsonText(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

interface ChangeLike {
  Type?: string;
  ResourceChange?: {
    Action?: string;
    LogicalResourceId?: string;
    PhysicalResourceId?: string;
    ResourceType?: string;
    Replacement?: string;
    Scope?: string[];
    PolicyAction?: string;
    Details?: {
      Target?: { Attribute?: string; Name?: string; RequiresRecreation?: string };
      Evaluation?: string;
      ChangeSource?: string;
      CausingEntity?: string;
    }[];
  };
}

/** The console's Changes table: one row per resource. */
export function changeRows(changes: unknown): Row[] {
  if (!Array.isArray(changes)) return [];
  return (changes as ChangeLike[])
    .filter((c) => c && c.ResourceChange)
    .map((c, i) => {
      const r = c.ResourceChange ?? {};
      return {
        key: `${r.LogicalResourceId ?? "resource"}-${i}`,
        action: r.Action ?? null,
        logicalId: r.LogicalResourceId ?? null,
        physicalId: r.PhysicalResourceId ?? null,
        resourceType: r.ResourceType ?? null,
        replacement: r.Replacement ?? (r.Action === "Modify" ? null : "-"),
        scope: Array.isArray(r.Scope) && r.Scope.length ? r.Scope.join(", ") : null,
        policyAction: r.PolicyAction ?? null,
      };
    });
}

/** One row per property that changes, as in the change set's JSON changes view. */
export function changeDetailRows(changes: unknown): Row[] {
  if (!Array.isArray(changes)) return [];
  const rows: Row[] = [];
  for (const c of changes as ChangeLike[]) {
    const r = c?.ResourceChange;
    if (!r) continue;
    (r.Details ?? []).forEach((d, i) => {
      rows.push({
        key: `${r.LogicalResourceId ?? "resource"}-${i}`,
        logicalId: r.LogicalResourceId ?? null,
        attribute: d.Target?.Attribute ?? null,
        name: d.Target?.Name ?? null,
        requiresRecreation: d.Target?.RequiresRecreation ?? null,
        evaluation: d.Evaluation ?? null,
        changeSource: d.ChangeSource ?? null,
        causingEntity: d.CausingEntity ?? null,
      });
    });
  }
  return rows;
}

interface DriftLike {
  LogicalResourceId?: string;
  PhysicalResourceId?: string;
  ResourceType?: string;
  StackResourceDriftStatus?: string;
  Timestamp?: unknown;
  PropertyDifferences?: { PropertyPath?: string; ExpectedValue?: string; ActualValue?: string; DifferenceType?: string }[];
}

/** Resource drift table: one row per resource, differences summarised. */
export function driftRows(drifts: unknown): Row[] {
  if (!Array.isArray(drifts)) return [];
  return (drifts as DriftLike[]).map((d) => ({
    logicalId: d.LogicalResourceId ?? null,
    physicalId: d.PhysicalResourceId ?? null,
    resourceType: d.ResourceType ?? null,
    driftStatus: d.StackResourceDriftStatus ?? null,
    lastCheck: d.Timestamp ?? null,
    differences: (d.PropertyDifferences ?? [])
      .map((p) => `${p.PropertyPath ?? "?"} ${p.DifferenceType ?? ""}: expected ${p.ExpectedValue ?? "-"}, actual ${p.ActualValue ?? "-"}`.replace("  ", " "))
      .join("; ") || null,
  }));
}

/** One parameter as GetTemplateSummary describes it. */
export interface TemplateParameter {
  key: string;
  type: string | null;
  defaultValue: string | null;
  description: string | null;
  noEcho: boolean;
  allowedValues: string[];
}

export interface CurrentParameter {
  key: string;
  value: string | null;
}

/**
 * Form fields for a template's parameters. Allowed values become a select. On a change set,
 * the current value is the default; a NoEcho value can't be read back, so leaving it empty
 * keeps the existing value.
 */
export function parameterFields(params: TemplateParameter[], current: CurrentParameter[] = []): FieldMeta[] {
  return params.map((p) => {
    const existing = current.find((c) => c.key === p.key);
    const keepsSecret = Boolean(existing) && p.noEcho;
    const help = [p.description, p.type ? `Type: ${p.type}` : null, keepsSecret ? "Leave empty to keep the existing value." : null].filter(Boolean).join(" · ");
    const start = existing && !p.noEcho ? existing.value ?? "" : p.defaultValue ?? "";
    if (p.allowedValues.length > 0) {
      return {
        name: `param:${p.key}`,
        label: p.key,
        kind: "select",
        help: help || undefined,
        required: !p.allowedValues.includes(""),
        default: p.allowedValues.includes(start) ? start : p.allowedValues[0],
        options: p.allowedValues.map((v) => ({ value: v, label: v })),
      };
    }
    return {
      name: `param:${p.key}`,
      label: p.key,
      kind: "text",
      help: help || undefined,
      default: start,
      placeholder: p.noEcho ? "NoEcho: the value is hidden after you submit it" : "Enter a value",
    };
  });
}

/** The API parameter list from the wizard's values. */
export function parameterList(params: TemplateParameter[], values: FieldValues, current: CurrentParameter[] = []): ParameterValue[] {
  return params.map((p) => {
    const v = values[`param:${p.key}`];
    const text = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
    const exists = current.some((c) => c.key === p.key);
    if (exists && p.noEcho && text === "") return { ParameterKey: p.key, UsePreviousValue: true };
    return { ParameterKey: p.key, ParameterValue: text };
  });
}

/** Stack statuses the console's "Active" filter shows (everything but deleted stacks). */
export const ACTIVE_STACK_STATUSES = [
  "CREATE_IN_PROGRESS", "CREATE_FAILED", "CREATE_COMPLETE",
  "ROLLBACK_IN_PROGRESS", "ROLLBACK_FAILED", "ROLLBACK_COMPLETE",
  "DELETE_IN_PROGRESS", "DELETE_FAILED",
  "UPDATE_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS", "UPDATE_COMPLETE",
  "UPDATE_FAILED", "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_ROLLBACK_FAILED",
  "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS", "UPDATE_ROLLBACK_COMPLETE",
  "REVIEW_IN_PROGRESS",
  "IMPORT_IN_PROGRESS", "IMPORT_COMPLETE", "IMPORT_ROLLBACK_IN_PROGRESS", "IMPORT_ROLLBACK_FAILED", "IMPORT_ROLLBACK_COMPLETE",
] as const;

/** "stack|changeset" ids are never used: change set pages live under the stack's URL. */
export function changeSetHref(stack: string, changeSet: string): string {
  return `/cloudformation/stacks/${encodeURIComponent(stack)}/changesets/${encodeURIComponent(changeSet)}`;
}
