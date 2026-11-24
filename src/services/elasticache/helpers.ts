/**
 * Pure helpers for the ElastiCache console: cache ids, rows built from DescribeReplicationGroups,
 * DescribeCacheClusters and DescribeServerlessCaches, and small formatting rules.
 * No SDK calls here, so the mapping can be unit tested.
 */

export type CacheEngine = "valkey" | "redis" | "memcached";

/** A cache id in the console URL says which API owns it. Cache names never contain ":". */
export type CacheRef =
  | { kind: "replication-group"; name: string }
  | { kind: "cluster"; name: string }
  | { kind: "serverless"; name: string };

const SERVERLESS = "serverless:";
const CLUSTER = "cluster:";

export function cacheId(ref: CacheRef): string {
  if (ref.kind === "serverless") return `${SERVERLESS}${ref.name}`;
  if (ref.kind === "cluster") return `${CLUSTER}${ref.name}`;
  return ref.name;
}

/** Memcached caches are always cache clusters, so their plain names mean "cluster". */
export function parseCacheId(id: string, engine: CacheEngine): CacheRef {
  if (id.startsWith(SERVERLESS)) return { kind: "serverless", name: id.slice(SERVERLESS.length) };
  if (id.startsWith(CLUSTER)) return { kind: "cluster", name: id.slice(CLUSTER.length) };
  return engine === "memcached" ? { kind: "cluster", name: id } : { kind: "replication-group", name: id };
}

export function rowIdFor(kind: CacheRef["kind"], name: string, engine: CacheEngine): string {
  if (kind === "serverless") return cacheId({ kind, name });
  if (kind === "cluster" && engine !== "memcached") return cacheId({ kind, name });
  return name;
}

export interface Endpoint {
  Address?: string;
  Port?: number;
}

export function endpointText(e: Endpoint | undefined | null): string | null {
  if (!e?.Address) return null;
  return e.Port !== undefined ? `${e.Address}:${e.Port}` : e.Address;
}

export function engineLabel(engine: string | undefined): string {
  if (engine === "valkey") return "Valkey";
  if (engine === "redis") return "Redis OSS";
  if (engine === "memcached") return "Memcached";
  return engine ?? "-";
}

/** "enabled" / "disabled" style flags as the console words them. */
export function enabledText(v: unknown): string | null {
  if (v === true || v === "enabled") return "Enabled";
  if (v === false || v === "disabled") return "Disabled";
  if (typeof v === "string" && v !== "") return v;
  return null;
}

/** Parameter families start with the engine name and a major version, e.g. valkey8, redis7, memcached1.6. */
export function familyMatchesEngine(family: string | undefined, engine: CacheEngine): boolean {
  if (!family) return false;
  return family.startsWith(engine);
}

export function usageLimitsText(limits: { DataStorage?: { Maximum?: number; Minimum?: number; Unit?: string }; ECPUPerSecond?: { Maximum?: number; Minimum?: number } } | undefined): { storage: string | null; ecpu: string | null } {
  const s = limits?.DataStorage;
  const e = limits?.ECPUPerSecond;
  const range = (min: number | undefined, max: number | undefined, unit: string) => {
    if (min === undefined && max === undefined) return null;
    if (min !== undefined && max !== undefined) return `${min}-${max} ${unit}`;
    return max !== undefined ? `Maximum ${max} ${unit}` : `Minimum ${min} ${unit}`;
  };
  return { storage: range(s?.Minimum, s?.Maximum, s?.Unit ?? "GB"), ecpu: range(e?.Minimum, e?.Maximum, "ECPUs/second") };
}

/** Splits "key1, key2" into trimmed, non-empty tag keys. */
export function splitList(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return v.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== "");
}

/** Serverless caches take a major version: "8" for Valkey 8.2, "1.6" for Memcached 1.6.22. */
export function majorVersion(engine: CacheEngine, version: string | undefined): string | undefined {
  if (!version) return undefined;
  const parts = version.split(".");
  return engine === "memcached" ? parts.slice(0, 2).join(".") : parts[0];
}
