/**
 * Pure helpers for the EKS console: composite ids for resources that belong to a cluster,
 * tag and label conversions, and the text the console shows for support periods and logging.
 */

import type { Row, Tag } from "../../console/types.ts";

/**
 * Node groups, add-ons, access entries and Pod Identity associations belong to a cluster.
 * Their console id is "<cluster>/<child>". Cluster names never contain "/", so the first
 * "/" separates them (a child such as an IAM principal ARN may contain more).
 */
export function joinId(cluster: string, child: string): string {
  return `${cluster}/${child}`;
}

export function splitId(id: string): { cluster: string; child: string } {
  const i = id.indexOf("/");
  if (i <= 0 || i === id.length - 1) throw new Error(`"${id}" is not a valid id: expected <cluster name>/<name>.`);
  return { cluster: id.slice(0, i), child: id.slice(i + 1) };
}

export function tagsToRecord(tags: unknown): Record<string, string> {
  if (!Array.isArray(tags)) return {};
  return Object.fromEntries((tags as Tag[]).filter((t) => t && typeof t.Key === "string" && t.Key !== "").map((t) => [t.Key, String(t.Value ?? "")]));
}

export function recordToRows(record: Record<string, string> | undefined | null): Row[] {
  return Object.entries(record ?? {}).map(([Key, Value]) => ({ Key, Value }));
}

/** "a, b ,c" -> ["a","b","c"]; empty entries are dropped. */
export function csv(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return v.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

export interface VersionInfo {
  clusterVersion?: string;
  status?: string;
  versionStatus?: string;
  endOfStandardSupportDate?: Date | string;
  endOfExtendedSupportDate?: Date | string;
}

function day(d: Date | string | undefined): string | null {
  if (d === undefined) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** "Standard support until December 1, 2027", as the console's Support period column. */
export function supportPeriod(version: string | undefined, versions: VersionInfo[]): string | null {
  if (!version) return null;
  const v = versions.find((x) => x.clusterVersion === version);
  if (!v) return null;
  const status = v.versionStatus ?? v.status;
  if (status === "STANDARD_SUPPORT") {
    const until = day(v.endOfStandardSupportDate);
    return until ? `Standard support until ${until}` : "Standard support";
  }
  if (status === "EXTENDED_SUPPORT") {
    const until = day(v.endOfExtendedSupportDate);
    return until ? `Extended support until ${until}` : "Extended support";
  }
  return status === "UNSUPPORTED" ? "Unsupported" : status ?? null;
}

export const LOG_TYPES: { value: string; label: string }[] = [
  { value: "api", label: "API server" },
  { value: "audit", label: "Audit" },
  { value: "authenticator", label: "Authenticator" },
  { value: "controllerManager", label: "Controller manager" },
  { value: "scheduler", label: "Scheduler" },
];

interface LogSetup {
  types?: string[];
  enabled?: boolean;
}

/** One row per control plane log type with its On/Off state. */
export function loggingRows(setups: LogSetup[] | undefined): Row[] {
  const enabled = new Set<string>();
  for (const s of setups ?? []) if (s.enabled) for (const t of s.types ?? []) enabled.add(t);
  return LOG_TYPES.map((t) => ({ type: t.label, status: enabled.has(t.value) ? "On" : "Off" }));
}

export function enabledLogTypes(setups: LogSetup[] | undefined): string[] {
  return loggingRows(setups).filter((r) => r.status === "On").map((r) => LOG_TYPES.find((t) => t.label === r.type)?.value ?? "").filter(Boolean);
}

/** Endpoint access as the console words it. */
export function endpointAccess(publicAccess: boolean | undefined, privateAccess: boolean | undefined): string {
  if (publicAccess && privateAccess) return "Public and private";
  if (publicAccess) return "Public";
  if (privateAccess) return "Private";
  return "-";
}

export const AUTH_MODES: { value: string; label: string }[] = [
  { value: "API", label: "EKS API" },
  { value: "API_AND_CONFIG_MAP", label: "EKS API and ConfigMap" },
  { value: "CONFIG_MAP", label: "ConfigMap" },
];

export function authModeLabel(mode: string | undefined): string | null {
  return AUTH_MODES.find((m) => m.value === mode)?.label ?? mode ?? null;
}
