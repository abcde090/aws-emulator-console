import { test } from "node:test";
import assert from "node:assert/strict";
import { authModeLabel, csv, enabledLogTypes, endpointAccess, joinId, loggingRows, recordToRows, splitId, supportPeriod, tagsToRecord } from "../src/services/eks/helpers.ts";
import { presetCluster } from "../src/services/eks/preset.ts";

test("EKS composite ids split at the first slash", () => {
  assert.equal(joinId("c1", "ng1"), "c1/ng1");
  assert.deepEqual(splitId("c1/ng1"), { cluster: "c1", child: "ng1" });
  assert.deepEqual(splitId("c1/arn:aws:iam::000000000000:role/path/r"), { cluster: "c1", child: "arn:aws:iam::000000000000:role/path/r" });
  assert.throws(() => splitId("c1"));
  assert.throws(() => splitId("/x"));
  assert.throws(() => splitId("c1/"));
});

test("EKS tag, label and list helpers", () => {
  assert.deepEqual(tagsToRecord([{ Key: "a", Value: "1" }, { Key: "", Value: "x" }]), { a: "1" });
  assert.deepEqual(tagsToRecord(null), {});
  assert.deepEqual(recordToRows({ k: "v" }), [{ Key: "k", Value: "v" }]);
  assert.deepEqual(recordToRows(undefined), []);
  assert.deepEqual(csv(" a, b ,,c "), ["a", "b", "c"]);
  assert.deepEqual(csv(undefined), []);
});

test("EKS support period text", () => {
  const versions = [
    { clusterVersion: "1.36", versionStatus: "STANDARD_SUPPORT", endOfStandardSupportDate: "2027-12-01T00:00:00Z" },
    { clusterVersion: "1.32", status: "EXTENDED_SUPPORT", endOfExtendedSupportDate: new Date("2027-03-01T00:00:00Z") },
    { clusterVersion: "1.25", status: "UNSUPPORTED" },
  ];
  assert.equal(supportPeriod("1.36", versions), "Standard support until December 1, 2027");
  assert.equal(supportPeriod("1.32", versions), "Extended support until March 1, 2027");
  assert.equal(supportPeriod("1.25", versions), "Unsupported");
  assert.equal(supportPeriod("9.9", versions), null);
  assert.equal(supportPeriod(undefined, versions), null);
});

test("EKS logging, endpoint and auth wording", () => {
  const setups = [{ types: ["api", "audit"], enabled: true }, { types: ["scheduler"], enabled: false }];
  const rows = loggingRows(setups);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { type: "API server", status: "On" });
  assert.deepEqual(rows[4], { type: "Scheduler", status: "Off" });
  assert.deepEqual(enabledLogTypes(setups), ["api", "audit"]);
  assert.deepEqual(loggingRows(undefined).map((r) => r.status), ["Off", "Off", "Off", "Off", "Off"]);
  assert.equal(endpointAccess(true, true), "Public and private");
  assert.equal(endpointAccess(true, false), "Public");
  assert.equal(endpointAccess(false, true), "Private");
  assert.equal(authModeLabel("API_AND_CONFIG_MAP"), "EKS API and ConfigMap");
  assert.equal(authModeLabel("OTHER"), "OTHER");
});

test("EKS create forms preset the cluster only when it is a choice", () => {
  const fields = [{ name: "cluster", label: "Cluster", kind: "select", options: [{ value: "c1", label: "c1" }] }, { name: "name", label: "Name", kind: "text" }];
  assert.equal(presetCluster(fields, "c1")[0].default, "c1");
  assert.equal(presetCluster(fields, "nope")[0].default, undefined);
  assert.equal(presetCluster(fields, null), fields);
});

