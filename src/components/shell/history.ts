/** Pure command history for CloudShell (up/down arrows). */

export interface History {
  entries: string[];
  /** entries.length means "the new line being typed". */
  cursor: number;
}

export const emptyHistory: History = { entries: [], cursor: 0 };
const MAX_ENTRIES = 200;

export function pushHistory(h: History, line: string): History {
  const trimmed = line.trim();
  if (trimmed === "") return { ...h, cursor: h.entries.length };
  const entries = (h.entries[h.entries.length - 1] === trimmed ? h.entries : [...h.entries, trimmed]).slice(-MAX_ENTRIES);
  return { entries, cursor: entries.length };
}

/** Moves the cursor; returns the line to show ("" past the newest entry). */
export function moveHistory(h: History, direction: "up" | "down"): { history: History; line: string } {
  const cursor = direction === "up" ? Math.max(0, h.cursor - 1) : Math.min(h.entries.length, h.cursor + 1);
  return { history: { ...h, cursor }, line: h.entries[cursor] ?? "" };
}
