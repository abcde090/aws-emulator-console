/** "Recently visited" services, kept in the browser's localStorage. */

export const RECENT_KEY = "console.recentServices";
const MAX_RECENT = 8;

export interface RecentEntry {
  id: string;
  name: string;
}

/** Pure: puts a visit first and keeps the list short and unique. */
export function addRecent(list: RecentEntry[], entry: RecentEntry, max = MAX_RECENT): RecentEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, max);
}

export function parseRecent(raw: string | null): RecentEntry[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is RecentEntry => !!e && typeof e === "object" && typeof (e as RecentEntry).id === "string" && typeof (e as RecentEntry).name === "string");
  } catch {
    return [];
  }
}

export function readRecent(): RecentEntry[] {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

export function recordRecent(id: string, name: string): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(addRecent(readRecent(), { id, name })));
  } catch {
    // Storage may be off (private mode); recently visited is then simply not kept.
  }
}
