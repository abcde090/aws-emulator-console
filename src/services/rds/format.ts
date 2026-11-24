/**
 * Pure mapping from RDS API shapes to the rows and words the RDS console shows.
 * Only `import type` from the SDK, so unit tests can load this file directly.
 */

import type { DBCluster, DBInstance } from "@aws-sdk/client-rds";

/** Databases list ids: "db:<instance id>" or "cluster:<cluster id>" (the two namespaces are separate in RDS). */
export type DbKey = { kind: "db" | "cluster"; id: string };

export const IDENTIFIER = "[a-zA-Z](?!.*--)[a-zA-Z0-9-]{0,62}(?<!-)";
const IDENTIFIER_RE = new RegExp(`^${IDENTIFIER}$`);

export function isIdentifier(v: unknown): v is string {
  return typeof v === "string" && IDENTIFIER_RE.test(v);
}

export function dbKey(kind: DbKey["kind"], id: string): string {
  return `${kind}:${id}`;
}

export function parseDbKey(key: string): DbKey {
  const i = key.indexOf(":");
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (i < 0 || (kind !== "db" && kind !== "cluster") || id === "") throw new Error(`"${key}" is not a database id this console made.`);
  return { kind, id };
}

export const ENGINES: { value: string; label: string }[] = [
  { value: "aurora-mysql", label: "Aurora (MySQL Compatible)" },
  { value: "aurora-postgresql", label: "Aurora (PostgreSQL Compatible)" },
  { value: "mysql", label: "MySQL" },
  { value: "mariadb", label: "MariaDB" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "oracle-ee", label: "Oracle Enterprise Edition" },
  { value: "oracle-se2", label: "Oracle Standard Edition Two" },
  { value: "sqlserver-ex", label: "Microsoft SQL Server Express Edition" },
  { value: "sqlserver-se", label: "Microsoft SQL Server Standard Edition" },
  { value: "db2-se", label: "IBM Db2 Standard Edition" },
];

const ENGINE_NAMES: Record<string, string> = {
  "aurora-mysql": "Aurora MySQL",
  "aurora-postgresql": "Aurora PostgreSQL",
  mysql: "MySQL Community",
  mariadb: "MariaDB",
  postgres: "PostgreSQL",
  "oracle-ee": "Oracle Enterprise Edition",
  "oracle-se2": "Oracle Standard Edition Two",
  "sqlserver-ex": "SQL Server Express Edition",
  "sqlserver-se": "SQL Server Standard Edition",
  "sqlserver-ee": "SQL Server Enterprise Edition",
  "sqlserver-web": "SQL Server Web Edition",
  "db2-se": "Db2 Standard Edition",
  "db2-ae": "Db2 Advanced Edition",
};

export function engineName(engine: string | undefined): string | null {
  if (!engine) return null;
  return ENGINE_NAMES[engine] ?? engine;
}

export const isAurora = (engine: string | undefined): boolean => typeof engine === "string" && engine.startsWith("aurora");

/** Real DB instance classes (a representative set; the emulator accepts any orderable class). */
export const INSTANCE_CLASSES = [
  "db.t3.micro", "db.t3.small", "db.t3.medium", "db.t3.large", "db.t4g.micro", "db.t4g.small", "db.t4g.medium", "db.t4g.large",
  "db.m5.large", "db.m5.xlarge", "db.m6g.large", "db.m6g.xlarge", "db.m6i.large", "db.m7g.large", "db.m7g.xlarge",
  "db.r5.large", "db.r5.xlarge", "db.r6g.large", "db.r6g.xlarge", "db.r6i.large", "db.r7g.large", "db.r7g.xlarge",
];

export function instanceRole(i: DBInstance, clusters: DBCluster[]): string {
  if (i.DBClusterIdentifier) {
    const c = clusters.find((x) => x.DBClusterIdentifier === i.DBClusterIdentifier);
    const m = c?.DBClusterMembers?.find((x) => x.DBInstanceIdentifier === i.DBInstanceIdentifier);
    if (m) return m.IsClusterWriter ? "Writer instance" : "Reader instance";
    return "Instance";
  }
  if (i.ReadReplicaSourceDBInstanceIdentifier) return "Replica";
  if ((i.ReadReplicaDBInstanceIdentifiers ?? []).length > 0) return "Primary";
  return "Instance";
}

export function clusterRole(c: DBCluster): string {
  return c.EngineMode === "serverless" ? "Serverless" : isAurora(c.Engine) ? "Regional cluster" : "Multi-AZ DB cluster";
}

export function regionAz(region: string, az: string | undefined, multiAz: boolean | undefined): string {
  if (!az) return region;
  return multiAz ? `${az} (Multi-AZ)` : az;
}

export interface DatabaseRow {
  key: string;
  identifier: string;
  status: string | null;
  role: string;
  engine: string | null;
  engineVersion: string | null;
  regionAz: string;
  size: string | null;
  vpc: string | null;
  multiAz: string;
  parent: string | null;
  arn: string | null;
  [k: string]: unknown;
}

export function instanceRow(i: DBInstance, clusters: DBCluster[], region: string): DatabaseRow {
  return {
    key: dbKey("db", i.DBInstanceIdentifier ?? ""),
    identifier: i.DBInstanceIdentifier ?? "",
    status: i.DBInstanceStatus ?? null,
    role: instanceRole(i, clusters),
    engine: engineName(i.Engine),
    engineVersion: i.EngineVersion ?? null,
    regionAz: regionAz(region, i.AvailabilityZone, i.MultiAZ),
    size: i.DBInstanceClass ?? null,
    vpc: i.DBSubnetGroup?.VpcId ?? null,
    multiAz: i.MultiAZ ? "Yes" : "No",
    parent: i.DBClusterIdentifier ?? i.ReadReplicaSourceDBInstanceIdentifier ?? null,
    arn: i.DBInstanceArn ?? null,
  };
}

export function clusterRow(c: DBCluster, region: string): DatabaseRow {
  const azs = c.AvailabilityZones ?? [];
  return {
    key: dbKey("cluster", c.DBClusterIdentifier ?? ""),
    identifier: c.DBClusterIdentifier ?? "",
    status: c.Status ?? null,
    role: clusterRole(c),
    engine: engineName(c.Engine),
    engineVersion: c.EngineVersion ?? null,
    regionAz: azs.length ? `${region} (${azs.length} AZs)` : region,
    size: `${c.DBClusterMembers?.length ?? 0} instance${c.DBClusterMembers?.length === 1 ? "" : "s"}`,
    vpc: null,
    multiAz: c.MultiAZ ? "Yes" : "No",
    parent: null,
    arn: c.DBClusterArn ?? null,
  };
}

/** Clusters first, each followed by its instances (writer first); then instances, each followed by its replicas. */
export function orderDatabases(rows: DatabaseRow[]): DatabaseRow[] {
  const out: DatabaseRow[] = [];
  const used = new Set<string>();
  const add = (r: DatabaseRow) => {
    if (used.has(r.key)) return;
    used.add(r.key);
    out.push(r);
  };
  const byName = (a: DatabaseRow, b: DatabaseRow) => a.identifier.localeCompare(b.identifier);
  const clusters = rows.filter((r) => r.key.startsWith("cluster:")).sort(byName);
  const instances = rows.filter((r) => r.key.startsWith("db:")).sort(byName);
  for (const c of clusters) {
    add(c);
    const members = instances.filter((i) => i.parent === c.identifier).sort((a, b) => (a.role === "Writer instance" ? -1 : b.role === "Writer instance" ? 1 : byName(a, b)));
    members.forEach(add);
  }
  const addWithReplicas = (r: DatabaseRow) => {
    add(r);
    instances.filter((i) => i.role === "Replica" && i.parent === r.identifier).forEach(addWithReplicas);
  };
  instances.filter((i) => i.role !== "Replica" || !instances.some((p) => p.identifier === i.parent)).forEach(addWithReplicas);
  return out;
}

/** Pending modified values as "DBInstanceClass: db.t3.small, AllocatedStorage: 30". */
export function pendingText(pending: object | undefined): string {
  if (!pending) return "None";
  const entries = Object.entries(pending).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "None";
  return entries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ");
}

/** "Change" select for modify forms: "" keeps the current value. */
export function triState(v: unknown): boolean | undefined {
  return v === "enable" ? true : v === "disable" ? false : undefined;
}
