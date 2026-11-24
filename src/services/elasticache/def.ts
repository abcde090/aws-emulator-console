/**
 * Amazon ElastiCache: Valkey, Redis OSS and Memcached caches (serverless and node-based),
 * backups, subnet groups, parameter groups and events.
 */

import type { ServiceDef } from "../../console/types.ts";
import { backupResource, eventResource } from "./backups.ts";
import { cacheResource } from "./caches.ts";
import { parameterGroupResource, subnetGroupResource } from "./groups.ts";

export const elasticacheService: ServiceDef = {
  id: "elasticache",
  name: "Amazon ElastiCache",
  category: "Database",
  description: "Fully managed Valkey, Redis OSS and Memcached caches with microsecond latency.",
  resources: [
    cacheResource("valkey"),
    cacheResource("redis"),
    cacheResource("memcached"),
    backupResource,
    subnetGroupResource,
    parameterGroupResource,
    eventResource,
  ],
  notSupported: [
    "Copying or deleting serverless backups (CopyServerlessCacheSnapshot, DeleteServerlessCacheSnapshot).",
    "Cache security groups (EC2-Classic): AWS Emulator answers that they aren't permitted.",
    "Backups by replication group ID: CreateSnapshot needs the primary node's cluster ID here, so Backup snapshots the primary node.",
  ],
};
