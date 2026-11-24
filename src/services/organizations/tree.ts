/**
 * Pure helpers for the AWS Organizations hierarchy: a root, then organizational units
 * nested under it. Built from ListRoots and ListOrganizationalUnitsForParent results.
 */

export interface OrgNode {
  id: string;
  name: string;
  arn: string | null;
  type: "Root" | "Organizational unit";
  parentId: string | null;
  depth: number;
  /** Names from the root down, e.g. "Root / Workloads / Prod". */
  hierarchy: string;
}

export interface RawUnit {
  Id?: string;
  Name?: string;
  Arn?: string;
}

/** Orders nodes depth-first (parents before children, siblings by name) for a tree view. */
export function depthFirst(nodes: readonly OrgNode[]): OrgNode[] {
  const children = new Map<string | null, OrgNode[]>();
  for (const n of nodes) {
    const list = children.get(n.parentId) ?? [];
    children.set(n.parentId, [...list, n]);
  }
  const ids = new Set(nodes.map((n) => n.id));
  const out: OrgNode[] = [];
  const visit = (n: OrgNode) => {
    out.push(n);
    const kids = [...(children.get(n.id) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    kids.forEach(visit);
  };
  // Tops are nodes whose parent is unknown (normally just the roots).
  nodes.filter((n) => n.parentId === null || !ids.has(n.parentId)).forEach(visit);
  return out;
}

/** Turns one level of ListOrganizationalUnitsForParent output into nodes. */
export function unitNodes(parent: OrgNode, units: readonly RawUnit[]): OrgNode[] {
  return units
    .filter((u): u is RawUnit & { Id: string } => typeof u.Id === "string" && u.Id !== "")
    .map((u) => {
      const name = u.Name ?? u.Id;
      return { id: u.Id, name, arn: u.Arn ?? null, type: "Organizational unit", parentId: parent.id, depth: parent.depth + 1, hierarchy: `${parent.hierarchy} / ${name}` };
    });
}

/**
 * The parent of an OU from its Path ("o-x/r-y/ou-a/ou-b/" -> "ou-a"). Returns null when the
 * path is missing or has no parent segment.
 */
export function parentFromPath(path: string | undefined, id: string): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  const i = parts.lastIndexOf(id);
  if (i <= 0) return null;
  const parent = parts[i - 1];
  return parent.startsWith("r-") || parent.startsWith("ou-") ? parent : null;
}

export const isOuId = (id: string): boolean => /^ou-[0-9a-z]{4,32}-[a-z0-9]{8,32}$/.test(id);
export const isRootId = (id: string): boolean => /^r-[0-9a-z]{4,32}$/.test(id);
