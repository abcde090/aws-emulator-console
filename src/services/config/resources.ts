/** AWS Config resource inventory and each resource's configuration timeline. */

import {
  DescribeComplianceByResourceCommand,
  GetDiscoveredResourceCountsCommand,
  GetResourceConfigHistoryCommand,
  ListDiscoveredResourcesCommand,
  type ConfigurationItem,
  type ResourceIdentifier,
  type ResourceType,
} from "@aws-sdk/client-config-service";
import type { Ctx, ResourceDef } from "../../console/types.ts";
import { complianceLabel, resourceKey, splitResourceKey } from "./helpers.ts";

const MAX_RESOURCES = 2000;

async function discovered(ctx: Ctx): Promise<ResourceIdentifier[]> {
  const counts = await ctx.clients.config.send(new GetDiscoveredResourceCountsCommand({}));
  const out: ResourceIdentifier[] = [];
  for (const c of counts.resourceCounts ?? []) {
    if (!c.resourceType) continue;
    let token: string | undefined;
    do {
      const r = await ctx.clients.config.send(new ListDiscoveredResourcesCommand({ resourceType: c.resourceType, limit: 100, nextToken: token }));
      out.push(...(r.resourceIdentifiers ?? []));
      token = r.nextToken || undefined;
    } while (token && out.length < MAX_RESOURCES);
  }
  return out;
}

function parseConfiguration(v: string | undefined): unknown {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export const resources: ResourceDef = {
  id: "resources",
  name: "Resources",
  singular: "resource",
  idField: "key",
  nameField: "resourceId",
  description: "Resources the configuration recorder has discovered. Open one to see its configuration timeline.",
  emptyText: "No resources discovered. Set up AWS Config and start recording on the Settings page.",
  columns: [
    { key: "resourceId", label: "Resource identifier", kind: "link" },
    { key: "resourceType", label: "Type", kind: "text" },
    { key: "resourceName", label: "Name", kind: "text" },
    { key: "deleted", label: "Deleted", kind: "date" },
  ],
  async list(ctx) {
    return (await discovered(ctx)).map((r) => ({
      key: resourceKey(r.resourceType ?? "", r.resourceId ?? ""), resourceId: r.resourceId ?? "", resourceType: r.resourceType ?? "", resourceName: r.resourceName ?? null, deleted: r.resourceDeletionTime ?? null,
    }));
  },
  async get(ctx, key) {
    const { type, id } = splitResourceKey(key);
    const items: ConfigurationItem[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.config.send(new GetResourceConfigHistoryCommand({ resourceType: type as ResourceType, resourceId: id, limit: 100, nextToken: token }));
      items.push(...(r.configurationItems ?? []));
      token = r.nextToken || undefined;
    } while (token && items.length < 500);
    const latest = items[0];
    const compliance = await ctx.clients.config.send(new DescribeComplianceByResourceCommand({ ResourceType: type, ResourceId: id }));
    const c = compliance.ComplianceByResources?.[0]?.Compliance;
    return {
      summary: {
        "Resource identifier": id, "Resource type": type, "Resource name": latest?.resourceName ?? null, ARN: latest?.arn ?? null,
        "Configuration item status": latest?.configurationItemStatus ?? null, "Last captured": latest?.configurationItemCaptureTime ?? null,
        Compliance: complianceLabel(c?.ComplianceType, c?.ComplianceContributorCount?.CappedCount),
      },
      tabs: [
        {
          id: "timeline", label: "Resource timeline", kind: "table",
          columns: [{ key: "captured", label: "Captured", kind: "date" }, { key: "status", label: "Change", kind: "text" }, { key: "stateId", label: "Configuration state ID", kind: "text" }, { key: "hash", label: "MD5 hash", kind: "code" }],
          data: items.map((i) => ({ captured: i.configurationItemCaptureTime ?? null, status: i.configurationItemStatus ?? null, stateId: i.configurationStateId ?? null, hash: i.configurationItemMD5Hash ?? null })),
          emptyText: "No configuration items recorded.",
        },
        { id: "configuration", label: "Configuration", kind: "json", data: parseConfiguration(latest?.configuration), emptyText: "No configuration recorded." },
        {
          id: "supplementary", label: "Supplementary configuration", kind: "table",
          columns: [{ key: "name", label: "Name", kind: "text" }, { key: "value", label: "Value", kind: "code" }],
          data: Object.entries(latest?.supplementaryConfiguration ?? {}).map(([name, value]) => ({ name, value })), emptyText: "None.",
        },
        {
          id: "relationships", label: "Relationships", kind: "table",
          columns: [{ key: "relationship", label: "Relationship", kind: "text" }, { key: "type", label: "Resource type", kind: "text" }, { key: "id", label: "Resource ID", kind: "text" }],
          data: (latest?.relationships ?? []).map((r) => ({ relationship: r.relationshipName ?? "", type: r.resourceType ?? "", id: r.resourceId ?? r.resourceName ?? "" })), emptyText: "No relationships.",
        },
        { id: "history", label: "Configuration items (JSON)", kind: "json", data: items },
      ],
    };
  },
};
