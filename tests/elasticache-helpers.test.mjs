import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheId, endpointText, enabledText, engineLabel, familyMatchesEngine, majorVersion, parseCacheId, rowIdFor, splitList, usageLimitsText } from "../src/services/elasticache/helpers.ts";

test("ElastiCache cache ids round-trip and say which API owns them", () => {
  assert.deepEqual(parseCacheId("orders", "valkey"), { kind: "replication-group", name: "orders" });
  assert.deepEqual(parseCacheId("orders", "memcached"), { kind: "cluster", name: "orders" });
  assert.deepEqual(parseCacheId("serverless:s1", "redis"), { kind: "serverless", name: "s1" });
  assert.deepEqual(parseCacheId("cluster:c1", "redis"), { kind: "cluster", name: "c1" });
  assert.equal(cacheId({ kind: "serverless", name: "s1" }), "serverless:s1");
  assert.equal(rowIdFor("cluster", "c1", "memcached"), "c1");
  assert.equal(rowIdFor("cluster", "c1", "valkey"), "cluster:c1");
  assert.equal(rowIdFor("replication-group", "rg", "valkey"), "rg");
});

test("ElastiCache formatting helpers", () => {
  assert.equal(endpointText({ Address: "127.0.0.1", Port: 6379 }), "127.0.0.1:6379");
  assert.equal(endpointText(undefined), null);
  assert.equal(engineLabel("redis"), "Redis OSS");
  assert.equal(enabledText("enabled"), "Enabled");
  assert.equal(enabledText(false), "Disabled");
  assert.equal(enabledText(undefined), null);
  assert.equal(familyMatchesEngine("valkey8", "valkey"), true);
  assert.equal(familyMatchesEngine("redis7", "valkey"), false);
  assert.equal(majorVersion("valkey", "8.2"), "8");
  assert.equal(majorVersion("memcached", "1.6.22"), "1.6");
  assert.equal(majorVersion("redis", undefined), undefined);
  assert.deepEqual(usageLimitsText({ DataStorage: { Maximum: 10, Unit: "GB" }, ECPUPerSecond: { Maximum: 5000 } }), { storage: "Maximum 10 GB", ecpu: "Maximum 5000 ECPUs/second" });
  assert.deepEqual(usageLimitsText(undefined), { storage: null, ecpu: null });
  assert.deepEqual(splitList(" a, b  c,,"), ["a", "b", "c"]);
});
