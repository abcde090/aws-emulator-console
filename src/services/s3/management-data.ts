/**
 * Server-side data for the S3 bucket Management tab, through the permission-checked
 * clients. Each section loads on its own, so one denied read only empties that section.
 */

import { ListBucketInventoryConfigurationsCommand, type InventoryConfiguration } from "@aws-sdk/client-s3";
import { makeCtx } from "../../console/server.ts";
import { secondary, type Secondary } from "../../console/secondary.ts";
import type { Ctx } from "../../console/types.ts";
import { readLifecycle, readReplication } from "./management-actions.ts";
import { inventoryRow, lifecycleRow, replicationRow, type InventoryRow, type LifecycleRow, type ReplicationRow } from "./management.ts";

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ManagementData {
  lifecycle: Section<LifecycleRow[]>;
  replication: Section<{ role: string | null; rules: ReplicationRow[] }>;
  inventory: Section<InventoryRow[]>;
}

async function listInventory(ctx: Ctx, bucket: string): Promise<InventoryConfiguration[]> {
  const out: InventoryConfiguration[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.s3.send(new ListBucketInventoryConfigurationsCommand({ Bucket: bucket, ContinuationToken: token }));
    out.push(...(r.InventoryConfigurationList ?? []));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function section<T>(s: Secondary<T>): Section<T> {
  return s.ok ? { ok: true, data: s.value } : { ok: false, error: s.error };
}

export async function loadManagement(bucket: string): Promise<ManagementData> {
  const ctx = await makeCtx();
  const [lifecycle, replication, inventory] = await Promise.all([
    secondary(async () => (await readLifecycle(ctx, bucket)).rules.map(lifecycleRow)),
    secondary(async () => {
      const c = await readReplication(ctx, bucket);
      return { role: c?.Role ?? null, rules: (c?.Rules ?? []).map(replicationRow).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)) };
    }),
    secondary(async () => (await listInventory(ctx, bucket)).map(inventoryRow)),
  ]);
  return { lifecycle: section(lifecycle), replication: section(replication), inventory: section(inventory) };
}
