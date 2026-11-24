/** GuardDuty has one detector per Region. Every page except Settings needs it. */

import { ListDetectorsCommand } from "@aws-sdk/client-guardduty";
import type { Ctx } from "../../console/types.ts";

export async function findDetectorId(ctx: Ctx): Promise<string | null> {
  const r = await ctx.clients.guardduty.send(new ListDetectorsCommand({}));
  return r.DetectorIds?.[0] ?? null;
}

export async function detectorId(ctx: Ctx): Promise<string> {
  const id = await findDetectorId(ctx);
  if (!id) throw new Error(`GuardDuty is not enabled in ${ctx.region}. Open Settings and choose Enable GuardDuty.`);
  return id;
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function tagRecord(v: unknown): Record<string, string> | undefined {
  const tags = Array.isArray(v) ? (v as { Key: string; Value: string }[]) : [];
  return tags.length ? Object.fromEntries(tags.map((t) => [t.Key, t.Value])) : undefined;
}

export function tagRows(tags: Record<string, string> | undefined): { Key: string; Value: string }[] {
  return Object.entries(tags ?? {}).map(([Key, Value]) => ({ Key, Value }));
}

export const TAG_COLUMNS = [
  { key: "Key", label: "Key", kind: "text" as const },
  { key: "Value", label: "Value", kind: "text" as const },
];
