/** Pure ordering of hand-built tabs among definition tabs (used by DetailTabs; unit tested). */

export interface TabPlacement {
  id: string;
  /**
   * Where a hand-built tab goes: omitted = before all definition tabs (the default);
   * a definition tab id = right after that tab; "$end" (or an id not present) = last.
   */
  after?: string;
}

export const TAB_END = "$end";

/** Tab ids in display order. Hand-built tabs keep their relative order within each slot. */
export function orderTabIds(definitionIds: string[], extra: TabPlacement[]): string[] {
  const first = extra.filter((e) => e.after === undefined).map((e) => e.id);
  const out = [...first];
  for (const id of definitionIds) {
    out.push(id);
    for (const e of extra) if (e.after === id) out.push(e.id);
  }
  for (const e of extra) if (e.after !== undefined && !definitionIds.includes(e.after)) out.push(e.id);
  return out;
}
