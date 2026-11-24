import { test } from "node:test";
import assert from "node:assert/strict";
import { lifecycleLabel, lifecyclePolicies, lifecycleValues, parseGidList, posixUserLabel, throughputLabel } from "../src/services/efs/helpers.ts";

test("EFS lifecycle policies round-trip between the form and the API", () => {
  assert.deepEqual(lifecyclePolicies({ toIA: "AFTER_30_DAYS", toArchive: "NONE", toPrimary: "AFTER_1_ACCESS" }), [{ TransitionToIA: "AFTER_30_DAYS" }, { TransitionToPrimaryStorageClass: "AFTER_1_ACCESS" }]);
  assert.deepEqual(lifecyclePolicies({ toIA: "NONE", toArchive: "NONE", toPrimary: "NONE" }), []);
  assert.deepEqual(lifecycleValues([{ TransitionToArchive: "AFTER_90_DAYS" }]), { toIA: "NONE", toArchive: "AFTER_90_DAYS", toPrimary: "NONE" });
  assert.deepEqual(lifecycleValues(undefined), { toIA: "NONE", toArchive: "NONE", toPrimary: "NONE" });
  assert.equal(lifecycleLabel("AFTER_1_DAY"), "1 day since last access");
  assert.equal(lifecycleLabel("AFTER_30_DAYS"), "30 days since last access");
  assert.equal(lifecycleLabel("AFTER_1_ACCESS"), "On first access");
  assert.equal(lifecycleLabel("NONE"), "None");
});

test("EFS display helpers", () => {
  assert.equal(throughputLabel("provisioned", 10), "Provisioned (10 MiB/s)");
  assert.equal(throughputLabel("elastic", undefined), "Elastic");
  assert.equal(posixUserLabel({ Uid: 1000, Gid: 1000, SecondaryGids: [5, 6] }), "1000:1000, secondary 5,6");
  assert.equal(posixUserLabel(undefined), null);
  assert.deepEqual(parseGidList(" 1, 2 "), [1, 2]);
  assert.equal(parseGidList(""), undefined);
  assert.throws(() => parseGidList("1,x"), /not a whole number/);
});
