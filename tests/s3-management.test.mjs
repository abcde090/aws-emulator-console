import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  checkPriorities,
  filterOf,
  inventoryFromValues,
  inventoryRow,
  inventoryValues,
  lifecycleRow,
  lifecycleRuleFromValues,
  lifecycleValues,
  nextPriority,
  normalisedLifecycleRule,
  normalisedReplicationRule,
  replicationRow,
  replicationRuleFromValues,
  replicationValues,
  scopeOf,
  scopeText,
  withRule,
} from "../src/services/s3/management.ts";

const base = { ruleId: "r1", status: "Enabled", scope: "filter", prefix: "logs/", filterTags: [], minSize: null, maxSize: null };

test("S3 rule filters: one condition alone, several inside And, none for the whole bucket", () => {
  assert.deepEqual(filterOf({ prefix: "", tags: [] }), {});
  assert.deepEqual(filterOf({ prefix: "a/", tags: [] }), { Prefix: "a/" });
  assert.deepEqual(filterOf({ prefix: "", tags: [{ Key: "k", Value: "v" }] }), { Tag: { Key: "k", Value: "v" } });
  assert.deepEqual(filterOf({ prefix: "a/", tags: [], minSize: 10 }), { And: { Prefix: "a/", ObjectSizeGreaterThan: 10 } });
  assert.deepEqual(scopeOf({ And: { Prefix: "p", Tags: [{ Key: "a", Value: "b" }] } }), { prefix: "p", tags: [{ Key: "a", Value: "b" }], minSize: undefined, maxSize: undefined });
  assert.equal(scopeOf(undefined, "legacy/").prefix, "legacy/");
  assert.equal(scopeText({ prefix: "", tags: [] }), "Entire bucket");
  assert.equal(scopeText({ prefix: "p/", tags: [{ Key: "a", Value: "b" }] }), "Prefix: p/, Tag: a=b");
});

test("S3 lifecycle rules: form values -> rule, with the console's checks", () => {
  const rule = lifecycleRuleFromValues({ ...base, transitionCurrent: true, t1Class: "STANDARD_IA", t1Days: 30, t2Class: "", t2Days: null, expireCurrent: true, expireDays: 365, abortMultipart: true, abortDays: 7 });
  assert.deepEqual(rule, {
    ID: "r1",
    Status: "Enabled",
    Filter: { Prefix: "logs/" },
    Transitions: [{ StorageClass: "STANDARD_IA", Days: 30 }],
    Expiration: { Days: 365 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
  });
  assert.throws(() => lifecycleRuleFromValues(base), /at least one lifecycle rule action/);
  assert.throws(() => lifecycleRuleFromValues({ ...base, prefix: "" }), /limit the scope/);
  assert.throws(() => lifecycleRuleFromValues({ ...base, expireCurrent: true, expireDays: 1, deleteMarkers: true }), /delete markers/);
  assert.throws(() => lifecycleRuleFromValues({ ...base, filterTags: [{ Key: "a", Value: "b" }], abortMultipart: true, abortDays: 1 }), /tag or object size/);
  assert.throws(() => lifecycleRuleFromValues({ ...base, expireCurrent: true, expireDays: 1.5 }), /whole number/);
  assert.deepEqual(lifecycleRuleFromValues({ ...base, scope: "all", deleteMarkers: true }).Filter, {});
});

test("S3 lifecycle rules: a stored rule round-trips through the Edit form unchanged", () => {
  const stored = {
    ID: "r1",
    Status: "Enabled",
    Filter: { And: { Prefix: "logs/", Tags: [{ Key: "a", Value: "b" }] } },
    Transitions: [{ Days: 30, StorageClass: "STANDARD_IA" }, { Days: 90, StorageClass: "GLACIER" }],
    NoncurrentVersionTransitions: [{ NoncurrentDays: 30, StorageClass: "GLACIER", NewerNoncurrentVersions: 2 }],
    NoncurrentVersionExpiration: { NoncurrentDays: 90 },
    Expiration: { Days: 365 },
  };
  const values = lifecycleValues(stored);
  assert.equal(values.scope, "filter");
  assert.equal(values.t2Class, "GLACIER");
  assert.equal(canonicalJson(lifecycleRuleFromValues(values)), canonicalJson(stored));
  assert.equal(normalisedLifecycleRule(stored), canonicalJson(stored));
  assert.throws(() => lifecycleValues({ ID: "d", Status: "Enabled", Filter: {}, Expiration: { Date: new Date("2030-01-01") } }), /date-based/);
  const row = lifecycleRow(stored);
  assert.equal(row.currentActions, "Transition to Standard-IA after 30 days; Transition to Glacier Flexible Retrieval (formerly Glacier) after 90 days; Expire after 365 days");
  assert.equal(row.noncurrentActions, "Transition to Glacier Flexible Retrieval (formerly Glacier) after 30 days, keep 2 newer; Permanently delete after 90 days");
  assert.equal(row.multipart, "-");
});

test("S3 rules: create appends, edit replaces (and may rename), names stay unique", () => {
  const rules = [{ ID: "a" }, { ID: "b" }];
  assert.deepEqual(withRule(rules, { ID: "c" }, null), [{ ID: "a" }, { ID: "b" }, { ID: "c" }]);
  assert.deepEqual(withRule(rules, { ID: "a2" }, "a"), [{ ID: "a2" }, { ID: "b" }]);
  assert.throws(() => withRule(rules, { ID: "b" }, null), /already exists/);
  assert.throws(() => withRule(rules, { ID: "b" }, "a"), /already exists/);
  assert.throws(() => withRule(rules, { ID: "z" }, "gone"), /no longer exists/);
});

test("S3 replication rules: values <-> rule, priorities, delete marker limits", () => {
  const v = { ruleId: "rep", status: "Enabled", priority: 3, scope: "all", prefix: "", filterTags: [], destBucket: "dst", role: "arn:aws:iam::000000000000:role/r", changeStorageClass: true, storageClass: "STANDARD_IA", deleteMarkerReplication: true };
  const rule = replicationRuleFromValues(v, "src");
  assert.deepEqual(rule, { ID: "rep", Priority: 3, Status: "Enabled", Filter: {}, DeleteMarkerReplication: { Status: "Enabled" }, Destination: { Bucket: "arn:aws:s3:::dst", StorageClass: "STANDARD_IA" } });
  assert.equal(replicationValues(rule, "role-arn").destBucket, "dst");
  assert.equal(normalisedReplicationRule(rule, "src"), canonicalJson(rule));
  assert.throws(() => replicationRuleFromValues({ ...v, destBucket: "src" }, "src"), /different bucket/);
  assert.throws(() => replicationRuleFromValues({ ...v, scope: "filter", filterTags: [{ Key: "a", Value: "b" }] }, "src"), /tag filters/);
  assert.throws(() => checkPriorities([{ ID: "a", Priority: 1 }, { ID: "b", Priority: 1 }]), /same priority/);
  assert.equal(nextPriority([]), 0);
  assert.equal(nextPriority([{ Priority: 4 }, { Priority: 1 }]), 5);
  assert.deepEqual(replicationRow({ ...rule, Destination: { Bucket: "arn:aws:s3:::dst" } }), { id: "rep", status: "Enabled", destination: "dst", priority: 3, scope: "Entire bucket", storageClass: "Same as source", deleteMarkers: "Enabled" });
});

test("S3 inventory configurations: values <-> configuration", () => {
  const v = { inventoryId: "inv-1", enabled: true, prefix: "", destBucket: "dst", destPrefix: "reports", format: "CSV", frequency: "Weekly", versions: "All", optionalFields: ["Size"] };
  const c = inventoryFromValues(v);
  assert.deepEqual(c, { Id: "inv-1", IsEnabled: true, Destination: { S3BucketDestination: { Bucket: "arn:aws:s3:::dst", Format: "CSV", Prefix: "reports" } }, Schedule: { Frequency: "Weekly" }, IncludedObjectVersions: "All", OptionalFields: ["Size"] });
  assert.equal(canonicalJson(inventoryFromValues(inventoryValues(c))), canonicalJson(c));
  assert.equal(inventoryRow(c).destination, "s3://dst/reports");
  assert.throws(() => inventoryFromValues({ ...v, inventoryId: "bad name" }), /1-64/);
});
