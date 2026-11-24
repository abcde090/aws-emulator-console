/** Pure helpers for Resilience Hub. */

export type DisruptionKey = "Software" | "Hardware" | "AZ" | "Region";

export const DISRUPTIONS: readonly { key: DisruptionKey; label: string; rto: number; rpo: number; help: string }[] = [
  { key: "Software", label: "Customer application", rto: 3600, rpo: 3600, help: "Recovery from a software or configuration failure." },
  { key: "Hardware", label: "Cloud infrastructure", rto: 3600, rpo: 3600, help: "Recovery from a failed host or volume." },
  { key: "AZ", label: "Cloud infrastructure Availability Zone", rto: 3600, rpo: 3600, help: "Recovery from the loss of an Availability Zone." },
  { key: "Region", label: "Region", rto: 86400, rpo: 86400, help: "Recovery from the loss of a Region (optional in AWS; required here for a complete policy)." },
];

/** The id at the end of an ARN: ".../app/1234" -> "1234". */
export function arnId(arn: string): string {
  const i = arn.lastIndexOf("/");
  return i >= 0 ? arn.slice(i + 1) : arn;
}

/** 90 -> "1m 30s", 3600 -> "1h", 86400 -> "1d". */
export function secondsLabel(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "-";
  if (v === 0) return "0s";
  const parts: string[] = [];
  let rest = Math.round(v);
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return parts.join(" ");
}

export function policyRows(policy: Partial<Record<string, { rtoInSecs?: number; rpoInSecs?: number }>>): { disruption: string; rto: number | null; rpo: number | null }[] {
  return DISRUPTIONS.filter((d) => policy[d.key]).map((d) => ({ disruption: d.label, rto: policy[d.key]?.rtoInSecs ?? null, rpo: policy[d.key]?.rpoInSecs ?? null }));
}
