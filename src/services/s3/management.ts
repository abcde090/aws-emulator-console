/**
 * Pure helpers for the S3 bucket Management tab: lifecycle rules, replication rules and
 * inventory configurations <-> form values, the rules AWS enforces before saving, and the
 * text the tables show. No SDK calls and no React, so tests import them directly.
 */

import type { InventoryConfiguration, LifecycleRule, LifecycleRuleFilter, ReplicationRule, Tag } from "@aws-sdk/client-s3";
import type { FieldValue, FieldValues, Option } from "../../console/types.ts";

/** How many transition slots the lifecycle form offers for current and for noncurrent versions. */
export const TRANSITION_SLOTS = 3;

export const TRANSITION_CLASSES: Option[] = [
  { value: "STANDARD_IA", label: "Standard-IA" },
  { value: "INTELLIGENT_TIERING", label: "Intelligent-Tiering" },
  { value: "ONEZONE_IA", label: "One Zone-IA" },
  { value: "GLACIER_IR", label: "Glacier Instant Retrieval" },
  { value: "GLACIER", label: "Glacier Flexible Retrieval (formerly Glacier)" },
  { value: "DEEP_ARCHIVE", label: "Glacier Deep Archive" },
];

export const REPLICATION_CLASSES: Option[] = [
  { value: "STANDARD", label: "Standard" },
  { value: "INTELLIGENT_TIERING", label: "Intelligent-Tiering" },
  { value: "STANDARD_IA", label: "Standard-IA" },
  { value: "ONEZONE_IA", label: "One Zone-IA" },
  { value: "GLACIER_IR", label: "Glacier Instant Retrieval" },
  { value: "GLACIER", label: "Glacier Flexible Retrieval" },
  { value: "DEEP_ARCHIVE", label: "Glacier Deep Archive" },
  { value: "REDUCED_REDUNDANCY", label: "Reduced redundancy" },
];

function classLabel(options: Option[], value: string | undefined): string {
  return options.find((o) => o.value === value)?.label ?? value ?? "-";
}

function txt(v: FieldValue | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: FieldValue | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function wholeNumber(v: FieldValue | undefined, label: string, min: number): number {
  const n = num(v);
  if (n === undefined) throw new Error(`${label} is required.`);
  if (!Number.isInteger(n) || n < min) throw new Error(`${label} must be a whole number of at least ${min}.`);
  return n;
}

function optionalWholeNumber(v: FieldValue | undefined, label: string, min: number): number | undefined {
  return num(v) === undefined ? undefined : wholeNumber(v, label, min);
}

function formTags(v: FieldValue | undefined): Tag[] {
  if (!Array.isArray(v)) return [];
  const out: Tag[] = [];
  for (const t of v) {
    if (t && typeof t === "object" && "Key" in t && typeof t.Key === "string" && t.Key.trim() !== "") out.push({ Key: t.Key.trim(), Value: typeof t.Value === "string" ? t.Value : "" });
  }
  return out;
}

/** JSON with object keys sorted and undefined members dropped, for "did anything change?". */
export function canonicalJson(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object" && !(x instanceof Date)) {
      return Object.fromEntries(
        Object.keys(x as Record<string, unknown>)
          .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => [k, walk((x as Record<string, unknown>)[k])])
      );
    }
    return x instanceof Date ? x.toISOString() : x;
  };
  return JSON.stringify(walk(v));
}

// ---------------------------------------------------------------- filters

export interface RuleScope {
  prefix: string;
  tags: Tag[];
  minSize?: number;
  maxSize?: number;
}

/** The scope a lifecycle or replication rule filter describes (V1 rules use a top-level Prefix). */
export function scopeOf(filter: LifecycleRuleFilter | undefined, legacyPrefix?: string): RuleScope {
  const f = filter ?? {};
  const and = f.And;
  return {
    prefix: and?.Prefix ?? f.Prefix ?? legacyPrefix ?? "",
    tags: and?.Tags ?? (f.Tag ? [f.Tag] : []),
    minSize: and?.ObjectSizeGreaterThan ?? f.ObjectSizeGreaterThan,
    maxSize: and?.ObjectSizeLessThan ?? f.ObjectSizeLessThan,
  };
}

function isEmptyScope(s: RuleScope): boolean {
  return s.prefix === "" && s.tags.length === 0 && s.minSize === undefined && s.maxSize === undefined;
}

/** The filter S3 expects: {} for the whole bucket, one condition alone, several inside And. */
export function filterOf(s: RuleScope): LifecycleRuleFilter {
  const parts = (s.prefix !== "" ? 1 : 0) + s.tags.length + (s.minSize !== undefined ? 1 : 0) + (s.maxSize !== undefined ? 1 : 0);
  if (parts === 0) return {};
  if (parts === 1) {
    if (s.prefix !== "") return { Prefix: s.prefix };
    if (s.tags.length === 1) return { Tag: s.tags[0] };
    if (s.minSize !== undefined) return { ObjectSizeGreaterThan: s.minSize };
    return { ObjectSizeLessThan: s.maxSize };
  }
  return {
    And: {
      ...(s.prefix !== "" ? { Prefix: s.prefix } : {}),
      ...(s.tags.length ? { Tags: s.tags } : {}),
      ...(s.minSize !== undefined ? { ObjectSizeGreaterThan: s.minSize } : {}),
      ...(s.maxSize !== undefined ? { ObjectSizeLessThan: s.maxSize } : {}),
    },
  };
}

/** "Entire bucket", or the filter in words, as the console's Scope column shows it. */
export function scopeText(s: RuleScope): string {
  if (isEmptyScope(s)) return "Entire bucket";
  const parts: string[] = [];
  if (s.prefix !== "") parts.push(`Prefix: ${s.prefix}`);
  for (const t of s.tags) parts.push(`Tag: ${t.Key}=${t.Value ?? ""}`);
  if (s.minSize !== undefined) parts.push(`Object size > ${s.minSize} B`);
  if (s.maxSize !== undefined) parts.push(`Object size < ${s.maxSize} B`);
  return parts.join(", ");
}

function scopeFromValues(v: FieldValues): RuleScope {
  if (v.scope === "all") return { prefix: "", tags: [] };
  const s: RuleScope = {
    prefix: typeof v.prefix === "string" ? v.prefix : "",
    tags: formTags(v.filterTags),
    minSize: optionalWholeNumber(v.minSize, "Minimum object size", 0),
    maxSize: optionalWholeNumber(v.maxSize, "Maximum object size", 1),
  };
  if (isEmptyScope(s)) throw new Error("Add a prefix, a tag or an object size to limit the scope, or choose \"Apply to all objects in the bucket\".");
  if (s.minSize !== undefined && s.maxSize !== undefined && s.maxSize <= s.minSize) throw new Error("The maximum object size must be larger than the minimum object size.");
  return s;
}

function scopeValues(s: RuleScope): FieldValues {
  return {
    scope: isEmptyScope(s) ? "all" : "filter",
    prefix: s.prefix,
    filterTags: s.tags.map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" })),
    minSize: s.minSize ?? null,
    maxSize: s.maxSize ?? null,
  };
}

// ---------------------------------------------------------------- lifecycle

/**
 * Form values for an existing rule ("Edit lifecycle rule"). Throws when the rule uses
 * something the form can't show (date-based actions, more transitions than slots), so
 * an edit never silently drops part of a rule.
 */
export function lifecycleValues(rule: LifecycleRule): FieldValues {
  const transitions = rule.Transitions ?? [];
  const noncurrent = rule.NoncurrentVersionTransitions ?? [];
  if (transitions.some((t) => t.Date !== undefined) || rule.Expiration?.Date !== undefined) {
    throw new Error(`Lifecycle rule "${rule.ID ?? ""}" uses date-based actions, which this form can't edit. Use the AWS CLI (put-bucket-lifecycle-configuration) for it.`);
  }
  if (transitions.length > TRANSITION_SLOTS || noncurrent.length > TRANSITION_SLOTS) {
    throw new Error(`Lifecycle rule "${rule.ID ?? ""}" has more than ${TRANSITION_SLOTS} transitions, which this form can't edit. Use the AWS CLI for it.`);
  }
  const v: FieldValues = {
    ruleId: rule.ID ?? "",
    status: rule.Status === "Disabled" ? "Disabled" : "Enabled",
    ...scopeValues(scopeOf(rule.Filter, rule.Prefix)),
    transitionCurrent: transitions.length > 0,
    expireCurrent: rule.Expiration?.Days !== undefined,
    expireDays: rule.Expiration?.Days ?? null,
    transitionNoncurrent: noncurrent.length > 0,
    expireNoncurrent: rule.NoncurrentVersionExpiration?.NoncurrentDays !== undefined,
    noncurrentExpireDays: rule.NoncurrentVersionExpiration?.NoncurrentDays ?? null,
    noncurrentExpireNewer: rule.NoncurrentVersionExpiration?.NewerNoncurrentVersions ?? null,
    deleteMarkers: rule.Expiration?.ExpiredObjectDeleteMarker === true,
    abortMultipart: rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== undefined,
    abortDays: rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
  };
  for (let i = 0; i < TRANSITION_SLOTS; i++) {
    v[`t${i + 1}Class`] = transitions[i]?.StorageClass ?? "";
    v[`t${i + 1}Days`] = transitions[i]?.Days ?? null;
    v[`n${i + 1}Class`] = noncurrent[i]?.StorageClass ?? "";
    v[`n${i + 1}Days`] = noncurrent[i]?.NoncurrentDays ?? null;
    v[`n${i + 1}Newer`] = noncurrent[i]?.NewerNoncurrentVersions ?? null;
  }
  return v;
}

/** The rule S3 stores for these form values, after the checks the S3 console makes. */
export function lifecycleRuleFromValues(v: FieldValues): LifecycleRule {
  const id = txt(v.ruleId);
  if (id === "") throw new Error("Enter a lifecycle rule name.");
  if (id.length > 255) throw new Error("Lifecycle rule names are at most 255 characters.");
  const scope = scopeFromValues(v);
  const rule: LifecycleRule = { ID: id, Status: v.status === "Disabled" ? "Disabled" : "Enabled", Filter: filterOf(scope) };

  if (v.transitionCurrent === true) {
    const ts: { StorageClass: string; Days: number }[] = [];
    for (let i = 1; i <= TRANSITION_SLOTS; i++) {
      const cls = txt(v[`t${i}Class`]);
      if (cls === "") continue;
      ts.push({ StorageClass: cls, Days: wholeNumber(v[`t${i}Days`], `Days after object creation (transition ${i})`, 0) });
    }
    if (ts.length === 0) throw new Error("Choose a storage class for at least one current-version transition, or clear that action.");
    rule.Transitions = ts.map((t) => ({ StorageClass: t.StorageClass as NonNullable<LifecycleRule["Transitions"]>[number]["StorageClass"], Days: t.Days }));
  }
  if (v.expireCurrent === true) rule.Expiration = { Days: wholeNumber(v.expireDays, "Days after object creation (expiration)", 1) };
  if (v.transitionNoncurrent === true) {
    const ts: NonNullable<LifecycleRule["NoncurrentVersionTransitions"]> = [];
    for (let i = 1; i <= TRANSITION_SLOTS; i++) {
      const cls = txt(v[`n${i}Class`]);
      if (cls === "") continue;
      const newer = optionalWholeNumber(v[`n${i}Newer`], `Number of newer versions to retain (transition ${i})`, 1);
      ts.push({
        StorageClass: cls as NonNullable<LifecycleRule["NoncurrentVersionTransitions"]>[number]["StorageClass"],
        NoncurrentDays: wholeNumber(v[`n${i}Days`], `Days after objects become noncurrent (transition ${i})`, 1),
        ...(newer !== undefined ? { NewerNoncurrentVersions: newer } : {}),
      });
    }
    if (ts.length === 0) throw new Error("Choose a storage class for at least one noncurrent-version transition, or clear that action.");
    rule.NoncurrentVersionTransitions = ts;
  }
  if (v.expireNoncurrent === true) {
    const newer = optionalWholeNumber(v.noncurrentExpireNewer, "Number of newer versions to retain", 1);
    rule.NoncurrentVersionExpiration = { NoncurrentDays: wholeNumber(v.noncurrentExpireDays, "Days after objects become noncurrent (expiration)", 1), ...(newer !== undefined ? { NewerNoncurrentVersions: newer } : {}) };
  }
  const filtered = scope.tags.length > 0 || scope.minSize !== undefined || scope.maxSize !== undefined;
  if (v.deleteMarkers === true) {
    if (v.expireCurrent === true) throw new Error("\"Delete expired object delete markers\" can't be used with \"Expire current versions of objects\".");
    if (filtered) throw new Error("\"Delete expired object delete markers\" can't be used with tag or object size filters.");
    rule.Expiration = { ExpiredObjectDeleteMarker: true };
  }
  if (v.abortMultipart === true) {
    if (filtered) throw new Error("\"Delete incomplete multipart uploads\" can't be used with tag or object size filters.");
    rule.AbortIncompleteMultipartUpload = { DaysAfterInitiation: wholeNumber(v.abortDays, "Number of days (incomplete multipart uploads)", 1) };
  }
  if (!rule.Transitions && !rule.Expiration && !rule.NoncurrentVersionTransitions && !rule.NoncurrentVersionExpiration && !rule.AbortIncompleteMultipartUpload) {
    throw new Error("Choose at least one lifecycle rule action.");
  }
  return rule;
}

/** The comparable form of a stored rule: what saving it back through the form would send. */
export function normalisedLifecycleRule(rule: LifecycleRule): string {
  return canonicalJson(lifecycleRuleFromValues(lifecycleValues(rule)));
}

function dayText(n: number | undefined, unit = "days"): string {
  return `${n ?? "-"} ${n === 1 ? unit.replace(/s$/, "") : unit}`;
}

export interface LifecycleRow {
  id: string;
  status: string;
  scope: string;
  currentActions: string;
  noncurrentActions: string;
  deleteMarkers: string;
  multipart: string;
  [key: string]: unknown;
}

export function lifecycleRow(rule: LifecycleRule): LifecycleRow {
  const current: string[] = [];
  for (const t of rule.Transitions ?? []) current.push(`Transition to ${classLabel(TRANSITION_CLASSES, t.StorageClass)} after ${t.Date ? new Date(t.Date).toISOString().slice(0, 10) : dayText(t.Days)}`);
  if (rule.Expiration?.Days !== undefined) current.push(`Expire after ${dayText(rule.Expiration.Days)}`);
  if (rule.Expiration?.Date) current.push(`Expire on ${new Date(rule.Expiration.Date).toISOString().slice(0, 10)}`);
  const noncurrent: string[] = [];
  for (const t of rule.NoncurrentVersionTransitions ?? []) {
    noncurrent.push(`Transition to ${classLabel(TRANSITION_CLASSES, t.StorageClass)} after ${dayText(t.NoncurrentDays)}${t.NewerNoncurrentVersions ? `, keep ${t.NewerNoncurrentVersions} newer` : ""}`);
  }
  const ne = rule.NoncurrentVersionExpiration;
  if (ne?.NoncurrentDays !== undefined) noncurrent.push(`Permanently delete after ${dayText(ne.NoncurrentDays)}${ne.NewerNoncurrentVersions ? `, keep ${ne.NewerNoncurrentVersions} newer` : ""}`);
  return {
    id: rule.ID ?? "",
    status: rule.Status ?? "-",
    scope: scopeText(scopeOf(rule.Filter, rule.Prefix)),
    currentActions: current.length ? current.join("; ") : "-",
    noncurrentActions: noncurrent.length ? noncurrent.join("; ") : "-",
    deleteMarkers: rule.Expiration?.ExpiredObjectDeleteMarker ? "Delete" : "-",
    multipart: rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== undefined ? `Delete after ${dayText(rule.AbortIncompleteMultipartUpload.DaysAfterInitiation)}` : "-",
  };
}

/**
 * The rule list after saving `rule`: replaces the rule called `originalId` (an edit, which
 * may rename it) or appends it (create). Rule names must stay unique.
 */
export function withRule<T extends { ID?: string }>(rules: T[], rule: T, originalId: string | null): T[] {
  const clash = rules.some((r) => r.ID === rule.ID && r.ID !== originalId);
  if (clash) throw new Error(`A rule named "${rule.ID ?? ""}" already exists in this bucket. Rule names must be unique.`);
  if (originalId === null) return [...rules, rule];
  if (!rules.some((r) => r.ID === originalId)) throw new Error(`Rule "${originalId}" no longer exists. Reload the page.`);
  return rules.map((r) => (r.ID === originalId ? rule : r));
}

// ---------------------------------------------------------------- replication

const bucketOfArn = (arn: string | undefined): string => (arn ?? "").replace(/^arn:aws[a-z-]*:s3:::/, "");

export function replicationValues(rule: ReplicationRule, role: string | undefined): FieldValues {
  const s = scopeOf(rule.Filter, rule.Prefix);
  const values = scopeValues(s);
  return {
    ruleId: rule.ID ?? "",
    status: rule.Status === "Disabled" ? "Disabled" : "Enabled",
    priority: rule.Priority ?? null,
    scope: values.scope,
    prefix: values.prefix,
    filterTags: values.filterTags,
    destBucket: bucketOfArn(rule.Destination?.Bucket),
    role: role ?? "",
    changeStorageClass: rule.Destination?.StorageClass !== undefined,
    storageClass: rule.Destination?.StorageClass ?? "",
    deleteMarkerReplication: rule.DeleteMarkerReplication?.Status === "Enabled",
  };
}

/** The replication rule for these form values (V2 schema: Filter, Priority, DeleteMarkerReplication). */
export function replicationRuleFromValues(v: FieldValues, sourceBucket: string): ReplicationRule {
  const id = txt(v.ruleId);
  if (id === "") throw new Error("Enter a replication rule name.");
  if (id.length > 255) throw new Error("Replication rule names are at most 255 characters.");
  const dest = txt(v.destBucket);
  if (dest === "") throw new Error("Choose a destination bucket.");
  if (dest === sourceBucket) throw new Error("The destination bucket must be a different bucket from the source.");
  const scope = scopeFromValues({ ...v, minSize: null, maxSize: null });
  if (v.deleteMarkerReplication === true && scope.tags.length > 0) throw new Error("Delete marker replication isn't supported for rules with tag filters.");
  const cls = v.changeStorageClass === true ? txt(v.storageClass) : "";
  if (v.changeStorageClass === true && cls === "") throw new Error("Choose a storage class for the replicated objects.");
  return {
    ID: id,
    Priority: wholeNumber(v.priority, "Priority", 0),
    Status: v.status === "Disabled" ? "Disabled" : "Enabled",
    Filter: filterOf(scope),
    DeleteMarkerReplication: { Status: v.deleteMarkerReplication === true ? "Enabled" : "Disabled" },
    Destination: { Bucket: `arn:aws:s3:::${dest}`, ...(cls ? { StorageClass: cls as NonNullable<ReplicationRule["Destination"]>["StorageClass"] } : {}) },
  };
}

/** Each rule's priority must be unique (S3 uses it to settle overlapping rules). */
export function checkPriorities(rules: ReplicationRule[]): void {
  const seen = new Map<number, string>();
  for (const r of rules) {
    if (r.Priority === undefined) continue;
    const other = seen.get(r.Priority);
    if (other !== undefined) throw new Error(`Rules "${other}" and "${r.ID ?? ""}" have the same priority (${r.Priority}). Each rule needs a unique priority.`);
    seen.set(r.Priority, r.ID ?? "");
  }
}

/** The next free priority for a new rule: one more than the highest. */
export function nextPriority(rules: ReplicationRule[]): number {
  return rules.reduce((max, r) => Math.max(max, (r.Priority ?? -1) + 1), 0);
}

export function normalisedReplicationRule(rule: ReplicationRule, source: string): string {
  return canonicalJson(replicationRuleFromValues(replicationValues(rule, undefined), source));
}

export interface ReplicationRow {
  id: string;
  status: string;
  destination: string;
  priority: number | null;
  scope: string;
  storageClass: string;
  deleteMarkers: string;
  [key: string]: unknown;
}

export function replicationRow(rule: ReplicationRule): ReplicationRow {
  return {
    id: rule.ID ?? "",
    status: rule.Status ?? "-",
    destination: bucketOfArn(rule.Destination?.Bucket) || "-",
    priority: rule.Priority ?? null,
    scope: scopeText(scopeOf(rule.Filter, rule.Prefix)),
    storageClass: rule.Destination?.StorageClass ? classLabel(REPLICATION_CLASSES, rule.Destination.StorageClass) : "Same as source",
    deleteMarkers: rule.DeleteMarkerReplication?.Status === "Enabled" ? "Enabled" : "Disabled",
  };
}

// ---------------------------------------------------------------- inventory

export function inventoryValues(c: InventoryConfiguration): FieldValues {
  return {
    inventoryId: c.Id ?? "",
    enabled: c.IsEnabled === true,
    prefix: c.Filter?.Prefix ?? "",
    destBucket: bucketOfArn(c.Destination?.S3BucketDestination?.Bucket),
    destPrefix: c.Destination?.S3BucketDestination?.Prefix ?? "",
    format: c.Destination?.S3BucketDestination?.Format ?? "CSV",
    frequency: c.Schedule?.Frequency ?? "Daily",
    versions: c.IncludedObjectVersions ?? "Current",
    optionalFields: c.OptionalFields ?? [],
  };
}

export function inventoryFromValues(v: FieldValues): InventoryConfiguration {
  const id = txt(v.inventoryId);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error("Inventory configuration names are 1-64 letters, numbers, dots, hyphens or underscores.");
  const dest = txt(v.destBucket);
  if (dest === "") throw new Error("Choose a destination bucket.");
  const prefix = txt(v.prefix);
  const destPrefix = txt(v.destPrefix);
  const optional = Array.isArray(v.optionalFields) ? v.optionalFields.filter((f): f is string => typeof f === "string" && f !== "") : [];
  return {
    Id: id,
    IsEnabled: v.enabled === true,
    ...(prefix ? { Filter: { Prefix: prefix } } : {}),
    Destination: { S3BucketDestination: { Bucket: `arn:aws:s3:::${dest}`, Format: (txt(v.format) || "CSV") as "CSV", ...(destPrefix ? { Prefix: destPrefix } : {}) } },
    Schedule: { Frequency: v.frequency === "Weekly" ? "Weekly" : "Daily" },
    IncludedObjectVersions: v.versions === "All" ? "All" : "Current",
    ...(optional.length ? { OptionalFields: optional as InventoryConfiguration["OptionalFields"] } : {}),
  };
}

export interface InventoryRow {
  id: string;
  status: string;
  scope: string;
  destination: string;
  frequency: string;
  format: string;
  versions: string;
  [key: string]: unknown;
}

export function inventoryRow(c: InventoryConfiguration): InventoryRow {
  const d = c.Destination?.S3BucketDestination;
  return {
    id: c.Id ?? "",
    status: c.IsEnabled ? "Enabled" : "Disabled",
    scope: c.Filter?.Prefix ? `Prefix: ${c.Filter.Prefix}` : "Entire bucket",
    destination: d ? `s3://${bucketOfArn(d.Bucket)}${d.Prefix ? `/${d.Prefix}` : ""}` : "-",
    frequency: c.Schedule?.Frequency ?? "-",
    format: d?.Format ?? "-",
    versions: c.IncludedObjectVersions === "All" ? "Include versions" : "Current version only",
  };
}
