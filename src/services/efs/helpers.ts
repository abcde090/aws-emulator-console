/** Pure EFS helpers: lifecycle policies <-> form values, and display text. */

import type { Option } from "../../console/types.ts";

export interface LifecycleValues {
  toIA: string;
  toArchive: string;
  toPrimary: string;
}

export interface LifecyclePolicyLike {
  TransitionToIA?: string;
  TransitionToArchive?: string;
  TransitionToPrimaryStorageClass?: string;
}

const NONE = "NONE";
const DAYS = [1, 7, 14, 30, 60, 90, 180, 270, 365];

export const IA_OPTIONS: Option[] = [{ value: NONE, label: "None" }, ...DAYS.map((d) => ({ value: `AFTER_${d}_DAY${d === 1 ? "" : "S"}`, label: `${d} day${d === 1 ? "" : "s"} since last access` }))];
export const ARCHIVE_OPTIONS: Option[] = IA_OPTIONS;
export const PRIMARY_OPTIONS: Option[] = [
  { value: NONE, label: "None" },
  { value: "AFTER_1_ACCESS", label: "On first access" },
];

/** The three lifecycle selects -> the LifecyclePolicies array (one transition per entry, as the API requires). */
export function lifecyclePolicies(v: LifecycleValues): LifecyclePolicyLike[] {
  const out: LifecyclePolicyLike[] = [];
  if (v.toIA && v.toIA !== NONE) out.push({ TransitionToIA: v.toIA });
  if (v.toArchive && v.toArchive !== NONE) out.push({ TransitionToArchive: v.toArchive });
  if (v.toPrimary && v.toPrimary !== NONE) out.push({ TransitionToPrimaryStorageClass: v.toPrimary });
  return out;
}

/** The LifecyclePolicies array -> one value per transition ("NONE" when unset). */
export function lifecycleValues(policies: LifecyclePolicyLike[] | undefined): LifecycleValues {
  const find = (k: keyof LifecyclePolicyLike) => policies?.find((p) => p[k])?.[k] ?? NONE;
  return { toIA: find("TransitionToIA"), toArchive: find("TransitionToArchive"), toPrimary: find("TransitionToPrimaryStorageClass") };
}

/** "AFTER_30_DAYS" -> "30 days since last access"; "AFTER_1_ACCESS" -> "On first access". */
export function lifecycleLabel(v: string): string {
  if (v === NONE) return "None";
  if (v === "AFTER_1_ACCESS") return "On first access";
  const m = /^AFTER_(\d+)_DAYS?$/.exec(v);
  return m ? `${m[1]} day${m[1] === "1" ? "" : "s"} since last access` : v;
}

export function performanceLabel(v: string | undefined): string | null {
  if (v === "generalPurpose") return "General Purpose";
  if (v === "maxIO") return "Max I/O";
  return v ?? null;
}

export function throughputLabel(mode: string | undefined, mibps: number | undefined): string | null {
  if (mode === "elastic") return "Elastic";
  if (mode === "bursting") return "Bursting";
  if (mode === "provisioned") return `Provisioned${mibps !== undefined ? ` (${mibps} MiB/s)` : ""}`;
  return mode ?? null;
}

export function posixUserLabel(u: { Uid?: number; Gid?: number; SecondaryGids?: number[] } | undefined): string | null {
  if (!u || u.Uid === undefined) return null;
  const extra = u.SecondaryGids?.length ? `, secondary ${u.SecondaryGids.join(",")}` : "";
  return `${u.Uid}:${u.Gid ?? "-"}${extra}`;
}

/** "1001, 1002" -> [1001, 1002]; throws on anything that isn't a whole number. */
export function parseGidList(v: string | undefined): number[] | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  return v.split(",").map((p) => {
    const t = p.trim();
    if (!/^\d+$/.test(t)) throw new Error(`Secondary group IDs: "${t}" is not a whole number.`);
    return Number(t);
  });
}
