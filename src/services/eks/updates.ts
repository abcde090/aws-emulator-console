/** Update history rows (ListUpdates + DescribeUpdate) for a cluster, node group or add-on. */

import { DescribeUpdateCommand, ListUpdatesCommand } from "@aws-sdk/client-eks";
import type { ColumnDef, Ctx, DetailTab, Row } from "../../console/types.ts";

/**
 * A secondary tab that must not take the whole page down: when its call fails (for example
 * an AccessDenied for the acting identity) the tab shows the error instead.
 */
export async function tolerantTab(load: () => Promise<DetailTab>, fallback: Pick<DetailTab, "id" | "label">): Promise<DetailTab> {
  try {
    return await load();
  } catch (err: unknown) {
    return { ...fallback, kind: "text", data: `Unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const UPDATE_COLUMNS: ColumnDef[] = [
  { key: "id", label: "Update ID", kind: "code" },
  { key: "type", label: "Type", kind: "text" },
  { key: "status", label: "Status", kind: "status" },
  { key: "createdAt", label: "Created", kind: "date" },
  { key: "params", label: "Parameters", kind: "code" },
  { key: "errors", label: "Errors", kind: "text" },
];

export async function updateRows(ctx: Ctx, cluster: string, scope: { nodegroupName?: string; addonName?: string } = {}): Promise<Row[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.eks.send(new ListUpdatesCommand({ name: cluster, ...scope, nextToken: token, maxResults: 100 }));
    ids.push(...(r.updateIds ?? []));
    token = r.nextToken;
  } while (token);
  const rows = await Promise.all(
    ids.map(async (updateId) => {
      const u = (await ctx.clients.eks.send(new DescribeUpdateCommand({ name: cluster, updateId, ...scope }))).update;
      return {
        id: u?.id ?? updateId,
        type: u?.type ?? null,
        status: u?.status ?? null,
        createdAt: u?.createdAt ?? null,
        params: (u?.params ?? []).map((p) => `${p.type ?? ""}=${p.value ?? ""}`).join("; ") || null,
        errors: (u?.errors ?? []).map((e) => `${e.errorCode ?? ""}: ${e.errorMessage ?? ""}`).join("; ") || null,
      };
    })
  );
  return rows.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

export async function updateTab(ctx: Ctx, cluster: string, scope: { nodegroupName?: string; addonName?: string } = {}): Promise<DetailTab> {
  return {
    id: "updates",
    label: "Update history",
    kind: "table",
    columns: UPDATE_COLUMNS,
    data: await updateRows(ctx, cluster, scope),
    emptyText: "No updates.",
  };
}

export function tagsTab(tags: Record<string, string> | undefined, emptyText = "No tags."): DetailTab {
  return {
    id: "tags",
    label: "Tags",
    kind: "table",
    columns: [
      { key: "Key", label: "Key", kind: "text" },
      { key: "Value", label: "Value", kind: "text" },
    ],
    data: Object.entries(tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
    emptyText,
  };
}
