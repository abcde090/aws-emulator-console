/** Pure helpers for the services menu and search box. */

export interface SearchableService {
  id: string;
  name: string;
  category: string;
  description: string;
}

export function filterServices<T extends SearchableService>(services: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const words = q.split(/\s+/);
  return services
    .filter((s) => words.every((w) => `${s.name} ${s.id} ${s.category} ${s.description}`.toLowerCase().includes(w)))
    .sort((a, b) => Number(b.name.toLowerCase().includes(q)) - Number(a.name.toLowerCase().includes(q)) || a.name.localeCompare(b.name));
}

export function groupByCategory<T extends SearchableService>(services: T[]): { category: string; services: T[] }[] {
  const map = new Map<string, T[]>();
  for (const s of services) map.set(s.category, [...(map.get(s.category) ?? []), s]);
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, list]) => ({ category, services: [...list].sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** The highlighted result after an arrow key: wraps around; 0 when there are no results. */
export function moveActive(index: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}
