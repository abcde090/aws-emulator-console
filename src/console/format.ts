/** Pure formatting for table cells and key-value panels. */

import type { ColumnKind, Row } from "./types.ts";

export function formatBytes(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return "-";
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let n = v;
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(1)} ${units[i]}`;
}

/** "November 23, 2026, 14:05:09 (UTC)" — the console shows UTC with the zone named. */
export function formatDate(v: unknown): string {
  if (typeof v !== "string" && typeof v !== "number") return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const date = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" });
  return `${date}, ${time} (UTC)`;
}

export function formatCount(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : "-";
}

export function formatValue(kind: ColumnKind, v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  switch (kind) {
    case "bytes":
      return formatBytes(v);
    case "date":
      return formatDate(v);
    case "count":
      return formatCount(v);
    case "boolean":
      return v === true ? "Yes" : v === false ? "No" : String(v);
    case "tags":
      return Array.isArray(v) ? v.map((t) => `${(t as { Key?: string }).Key ?? ""}=${(t as { Value?: string }).Value ?? ""}`).join(", ") : String(v);
    default:
      return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

const SUCCESS = /^(active|available|running|enabled|ok|in-use|in_use|healthy|succeeded|successful|success|deployed|inservice|in_service|in-service|complete|completed|on|issued|ready|create_complete|update_complete|import_complete)$/;
const ERROR = /(fail|error|unhealthy|impaired|alarm|rollback)/;
const PENDING = /(pending|creating|updating|deleting|starting|stopping|modifying|in_progress|in-progress|inprogress|provisioning|deploying|rebooting)/;
const WARNING = /(stopped|disabled|suspended|inactive|superseded|abandoned|deleted|cancelled|canceled|off|insufficient|expired)/;

/** Colour of a status dot, from the words AWS uses ("InService", "IN_PROGRESS", "Failed" …). */
export function statusTone(v: unknown): "success" | "error" | "warning" | "pending" | "neutral" {
  const s = String(v ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (SUCCESS.test(s)) return "success";
  if (ERROR.test(s)) return "error";
  if (PENDING.test(s)) return "pending";
  if (WARNING.test(s)) return "warning";
  return "neutral";
}

/**
 * Fills a link template such as "/ecs/services/{cluster}/{serviceName}" from a row, each
 * value URL-encoded. Null when the template is not a local path or a value is missing.
 */
export function fillHref(template: string | undefined, row: Row): string | null {
  if (!template || !template.startsWith("/") || template.startsWith("//")) return null;
  let missing = false;
  const href = template.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    const v = row[key];
    if (v === null || v === undefined || v === "" || typeof v === "object") {
      missing = true;
      return "";
    }
    return encodeURIComponent(String(v));
  });
  return missing ? null : href;
}

/** Case-insensitive match of the filter text against every column value. */
export function rowMatches(row: Row, keys: string[], filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (q === "") return true;
  return keys.some((k) => {
    const v = row[k];
    if (v === null || v === undefined) return false;
    return (typeof v === "object" ? JSON.stringify(v) : String(v)).toLowerCase().includes(q);
  });
}

export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { numeric: true });
}
