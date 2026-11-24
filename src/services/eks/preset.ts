/** Presets a create form's Cluster field from ?cluster= (pure, so it can be unit tested). */

import type { FieldMeta } from "../../console/types.ts";

/** Presets the cluster field when the requested cluster is one of its choices. */
export function presetCluster(fields: FieldMeta[], cluster: string | null): FieldMeta[] {
  if (!cluster) return fields;
  return fields.map((f) => (f.name === "cluster" && f.options?.some((o) => o.value === cluster) ? { ...f, default: cluster } : f));
}
