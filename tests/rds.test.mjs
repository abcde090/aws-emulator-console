import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterRow, dbKey, engineName, instanceRole, instanceRow, isIdentifier, orderDatabases, parseDbKey, pendingText, triState } from "../src/services/rds/format.ts";

test("database keys keep instances and clusters apart", () => {
  assert.equal(dbKey("cluster", "a"), "cluster:a");
  assert.deepEqual(parseDbKey("db:my-db"), { kind: "db", id: "my-db" });
  assert.deepEqual(parseDbKey("cluster:c1"), { kind: "cluster", id: "c1" });
  assert.throws(() => parseDbKey("my-db"));
  assert.throws(() => parseDbKey("snap:x"));
  assert.throws(() => parseDbKey("db:"));
});

test("RDS identifiers", () => {
  assert.equal(isIdentifier("database-1"), true);
  assert.equal(isIdentifier("1db"), false);
  assert.equal(isIdentifier("db--1"), false);
  assert.equal(isIdentifier("db-"), false);
  assert.equal(isIdentifier("a".repeat(64)), false);
});

test("roles, rows and ordering", () => {
  const cluster = { DBClusterIdentifier: "c", Engine: "aurora-postgresql", Status: "available", DBClusterMembers: [{ DBInstanceIdentifier: "c-2", IsClusterWriter: true }, { DBInstanceIdentifier: "c-1", IsClusterWriter: false }], AvailabilityZones: ["a", "b"] };
  const writer = { DBInstanceIdentifier: "c-2", DBClusterIdentifier: "c", Engine: "aurora-postgresql", AvailabilityZone: "us-east-1a" };
  const reader = { DBInstanceIdentifier: "c-1", DBClusterIdentifier: "c", Engine: "aurora-postgresql" };
  const primary = { DBInstanceIdentifier: "p", Engine: "postgres", MultiAZ: true, AvailabilityZone: "us-east-1b", ReadReplicaDBInstanceIdentifiers: ["r"] };
  const replica = { DBInstanceIdentifier: "r", Engine: "postgres", ReadReplicaSourceDBInstanceIdentifier: "p" };
  assert.equal(instanceRole(writer, [cluster]), "Writer instance");
  assert.equal(instanceRole(reader, [cluster]), "Reader instance");
  assert.equal(instanceRole(primary, []), "Primary");
  assert.equal(instanceRole(replica, []), "Replica");
  const p = instanceRow(primary, [], "us-east-1");
  assert.equal(p.regionAz, "us-east-1b (Multi-AZ)");
  assert.equal(p.engine, "PostgreSQL");
  const c = clusterRow(cluster, "us-east-1");
  assert.equal(c.role, "Regional cluster");
  assert.equal(c.size, "2 instances");
  const ordered = orderDatabases([instanceRow(replica, [], "r"), instanceRow(reader, [cluster], "r"), p, instanceRow(writer, [cluster], "r"), c]).map((r) => r.key);
  assert.deepEqual(ordered, ["cluster:c", "db:c-2", "db:c-1", "db:p", "db:r"]);
});

test("small formatting helpers", () => {
  assert.equal(engineName("aurora-mysql"), "Aurora MySQL");
  assert.equal(engineName("custom-x"), "custom-x");
  assert.equal(engineName(undefined), null);
  assert.equal(pendingText({}), "None");
  assert.equal(pendingText({ DBInstanceClass: "db.t3.small", AllocatedStorage: 30 }), "DBInstanceClass: db.t3.small, AllocatedStorage: 30");
  assert.equal(triState("enable"), true);
  assert.equal(triState("disable"), false);
  assert.equal(triState(""), undefined);
});
