import { test } from "node:test";
import assert from "node:assert/strict";
import { contributorSeries, insightsRuleKind, sortInsightsRules } from "../src/services/dynamodb/contributor-insights.ts";
import {
  buildFilter,
  buildKeyCondition,
  displayValue,
  formRowsToItem,
  isTableName,
  itemColumns,
  itemToFormRows,
  itemToPlain,
  keyOf,
  needsDynamoJson,
  parseWireItem,
  plainToItem,
  sameKey,
  scalarWire,
} from "../src/services/dynamodb/attr.ts";
import { capacityText, encryptionText, indexRows, keyLabel, keyNames, projectionText } from "../src/services/dynamodb/table-info.ts";
import { dimensionText, statisticFor } from "../src/services/dynamodb/monitoring.ts";

test("DynamoDB JSON items are validated strictly", () => {
  assert.deepEqual(parseWireItem({ a: { S: "x" }, n: { N: " 42 " } }), { ok: true, value: { a: { S: "x" }, n: { N: "42" } } });
  assert.equal(parseWireItem({ a: { N: "abc" } }).ok, false);
  assert.equal(parseWireItem({ a: { S: "x", N: "1" } }).ok, false);
  assert.equal(parseWireItem({ a: { SS: [] } }).ok, false);
  assert.equal(parseWireItem({ a: { SS: ["a", "a"] } }).ok, false);
  assert.equal(parseWireItem({ a: { NULL: false } }).ok, false);
  assert.equal(parseWireItem([]).ok, false);
  assert.equal(parseWireItem({ "": { S: "x" } }).ok, false);
  const nested = parseWireItem({ m: { M: { l: { L: [{ BOOL: true }, { NS: ["1", "2.5"] }] } } } });
  assert.equal(nested.ok, true);
  const bad = parseWireItem({ m: { M: { l: { L: [{ X: 1 }] } } } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /m\.l\[0\]/);
});

test("plain JSON and DynamoDB JSON convert both ways", () => {
  const plain = { id: "a", n: 3, f: 1.5, ok: true, none: null, list: [1, "x"], map: { k: "v" } };
  const wire = plainToItem(plain);
  assert.equal(wire.ok, true);
  assert.deepEqual(wire.value.n, { N: "3" });
  assert.deepEqual(wire.value.list, { L: [{ N: "1" }, { S: "x" }] });
  assert.deepEqual(itemToPlain(wire.value), plain);
  // Numbers JSON can't hold exactly stay as text.
  assert.deepEqual(itemToPlain({ big: { N: "12345678901234567890" } }), { big: "12345678901234567890" });
  assert.equal(needsDynamoJson({ s: { SS: ["a"] } }), true);
  assert.equal(needsDynamoJson({ m: { M: { b: { B: "AA==" } } } }), true);
  assert.equal(needsDynamoJson(wire.value), false);
  assert.equal(plainToItem({ x: Number.NaN }).ok, false);
});

test("display, keys and columns", () => {
  assert.equal(displayValue({ S: "x" }), "x");
  assert.equal(displayValue({ BOOL: false }), "false");
  assert.equal(displayValue({ M: { a: { N: "1" } } }), '{"a":1}');
  assert.equal(displayValue(undefined), "");
  const item = { pk: { S: "a" }, sk: { N: "1" }, z: { S: "z" }, b: { S: "b" } };
  assert.deepEqual(keyOf(item, ["pk", "sk"]), { ok: true, value: { pk: { S: "a" }, sk: { N: "1" } } });
  assert.equal(keyOf(item, ["missing"]).ok, false);
  assert.equal(sameKey(item, { pk: { S: "a" }, sk: { N: "1" } }, ["pk", "sk"]), true);
  assert.equal(sameKey(item, { pk: { S: "b" }, sk: { N: "1" } }, ["pk", "sk"]), false);
  assert.deepEqual(itemColumns([item, { pk: { S: "q" }, a: { S: "1" } }], ["pk", "sk"]), ["pk", "sk", "a", "b", "z"]);
  assert.equal(isTableName("Music"), true);
  assert.equal(isTableName("ab"), false);
  assert.equal(isTableName("../x"), false);
});

test("key condition and filter expressions use placeholders", () => {
  const kc = buildKeyCondition({ attr: "pk", type: "S", value: "a" }, { attr: "sk", type: "N", op: "between", value: "1", value2: "9" });
  assert.equal(kc.ok, true);
  assert.equal(kc.value.expression, "#k0 = :k0 AND #k1 BETWEEN :k1 AND :k2");
  assert.deepEqual(kc.value.names, { "#k0": "pk", "#k1": "sk" });
  assert.deepEqual(kc.value.values, { ":k0": { S: "a" }, ":k1": { N: "1" }, ":k2": { N: "9" } });
  const bw = buildKeyCondition({ attr: "pk", type: "S", value: "a" }, { attr: "sk", type: "S", op: "begins_with", value: "2026" });
  assert.equal(bw.value.expression, "#k0 = :k0 AND begins_with(#k1, :k1)");
  assert.equal(buildKeyCondition({ attr: "pk", type: "S", value: "a" }, { attr: "sk", type: "S", op: "=", value: "" }).value.expression, "#k0 = :k0");
  assert.equal(buildKeyCondition({ attr: "pk", type: "S", value: "" }, null).ok, false);
  assert.equal(buildKeyCondition({ attr: "pk", type: "N", value: "x" }, null).ok, false);
  assert.equal(buildKeyCondition({ attr: "pk", type: "S", value: "a" }, { attr: "sk", type: "S", op: "contains", value: "x" }).ok, false);

  const f = buildFilter([
    { attr: "status", type: "S", op: "<>", value: "done" },
    { attr: "tags", type: "S", op: "not_contains", value: "x" },
    { attr: "ttl", type: "S", op: "exists", value: "" },
    { attr: "", type: "S", op: "=", value: "ignored" },
  ]);
  assert.equal(f.value.expression, "#f0 <> :f0 AND NOT contains(#f1, :f1) AND attribute_exists(#f2)");
  assert.deepEqual(buildFilter([]), { ok: true, value: null });
  assert.equal(buildFilter([{ attr: "a", type: "BOOL", op: "=", value: "yes" }]).ok, false);
  assert.deepEqual(scalarWire("NULL", "", "x"), { ok: true, value: { NULL: true } });
});

test("form rows round-trip items", () => {
  const item = { pk: { S: "a" }, n: { N: "2" }, ok: { BOOL: true }, nil: { NULL: true }, s: { SS: ["x", "y"] }, m: { M: { k: { S: "v" } } } };
  const rows = itemToFormRows(item);
  assert.deepEqual(rows.find((r) => r.name === "s"), { name: "s", type: "SS", value: '["x","y"]' });
  assert.deepEqual(formRowsToItem(rows), { ok: true, value: item });
  assert.equal(formRowsToItem([{ name: "a", type: "N", value: "x" }]).ok, false);
  assert.equal(formRowsToItem([{ name: "a", type: "S", value: "1" }, { name: "a", type: "S", value: "2" }]).ok, false);
  assert.equal(formRowsToItem([{ name: "m", type: "M", value: '{"L":[]}' }]).ok, false);
  assert.equal(formRowsToItem([{ name: "", type: "S", value: "x" }]).ok, false);
});

test("table descriptions map to console words", () => {
  const t = {
    TableName: "T",
    TableStatus: "ACTIVE",
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "g", AttributeType: "N" }],
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
    BillingModeSummary: { BillingMode: "PROVISIONED" },
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 3 },
    GlobalSecondaryIndexes: [{ IndexName: "g-idx", IndexStatus: "CREATING", KeySchema: [{ AttributeName: "g", KeyType: "HASH" }], Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["a", "b"] }, ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 2 } }],
  };
  assert.deepEqual(keyNames(t.KeySchema), { partition: "pk", sort: null });
  assert.equal(keyLabel(t.AttributeDefinitions, "g"), "g (Number)");
  assert.equal(keyLabel(t.AttributeDefinitions, null), null);
  assert.equal(capacityText(t, "write"), "Provisioned (3)");
  assert.equal(capacityText({ BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" } }, "read"), "On-demand");
  assert.equal(encryptionText({}), "Owned by Amazon DynamoDB");
  assert.equal(encryptionText({ SSEDescription: { Status: "ENABLED", SSEType: "KMS", KMSMasterKeyArn: "arn:aws:kms:us-east-1:0:key/x" } }), "AWS KMS key");
  assert.equal(projectionText({ ProjectionType: "KEYS_ONLY" }), "Keys only");
  const rows = indexRows(t);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projection, "Include: a, b");
  assert.equal(rows[0].readCapacity, "1");
  assert.equal(rows[0].status, "CREATING");
});

test("monitoring labels", () => {
  assert.equal(statisticFor("SuccessfulRequestLatency"), "Average");
  assert.equal(statisticFor("ConsumedReadCapacityUnits"), "Sum");
  assert.equal(dimensionText([{ Name: "TableName", Value: "t" }]), "Table");
  assert.equal(dimensionText([{ Name: "TableName", Value: "t" }, { Name: "Operation", Value: "Query" }]), "Operation=Query");
});

import { capacityValues, encryptionValue, prettyPolicy, sameCapacity, sameEncryption, sameJson, streamValues, ttlOn } from "../src/services/dynamodb/table-edits.ts";

test("Edit capacity opens with the table's mode and units; unchanged saves are detected", () => {
  const prov = { BillingModeSummary: { BillingMode: "PROVISIONED" }, ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 } };
  assert.deepEqual(capacityValues(prov), { capacityMode: "PROVISIONED", rcu: 3, wcu: 4 });
  assert.deepEqual(capacityValues({ ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 8 } }), { capacityMode: "PROVISIONED", rcu: 7, wcu: 8 });
  assert.deepEqual(capacityValues({ BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" } }), { capacityMode: "PAY_PER_REQUEST", rcu: 5, wcu: 5 });
  assert.equal(sameCapacity({ capacityMode: "PROVISIONED", rcu: 3, wcu: 4 }, { capacityMode: "PROVISIONED", rcu: 3, wcu: 4 }), true);
  assert.equal(sameCapacity({ capacityMode: "PROVISIONED", rcu: 3, wcu: 4 }, { capacityMode: "PROVISIONED", rcu: 3, wcu: 5 }), false);
  assert.equal(sameCapacity({ capacityMode: "PROVISIONED", rcu: 3, wcu: 4 }, { capacityMode: "PAY_PER_REQUEST", rcu: 3, wcu: 4 }), false);
  assert.equal(sameCapacity({ capacityMode: "PAY_PER_REQUEST", rcu: 5, wcu: 5 }, { capacityMode: "PAY_PER_REQUEST", rcu: 9, wcu: 9 }), true);
});

test("Edit encryption reads the current key management", () => {
  const cmk = "arn:aws:kms:us-east-1:000000000000:key/abc";
  assert.deepEqual(encryptionValue({}, new Set()), { encryption: "OWNED", kmsKey: "" });
  assert.deepEqual(encryptionValue({ SSEDescription: { Status: "DISABLED" } }, new Set()), { encryption: "OWNED", kmsKey: "" });
  assert.deepEqual(encryptionValue({ SSEDescription: { Status: "ENABLED", SSEType: "KMS", KMSMasterKeyArn: cmk } }, new Set([cmk])), { encryption: "CMK", kmsKey: cmk });
  assert.deepEqual(encryptionValue({ SSEDescription: { Status: "ENABLED", SSEType: "KMS", KMSMasterKeyArn: "arn:aws:kms:us-east-1:000000000000:key/aws" } }, new Set([cmk])), { encryption: "AWS_MANAGED", kmsKey: "" });
  assert.deepEqual(encryptionValue({ SSEDescription: { Status: "ENABLED", SSEType: "KMS", KMSMasterKeyArn: cmk } }, null), { encryption: "CMK", kmsKey: cmk });
  assert.equal(sameEncryption({ encryption: "CMK", kmsKey: cmk }, { encryption: "CMK", kmsKey: cmk }), true);
  assert.equal(sameEncryption({ encryption: "CMK", kmsKey: cmk }, { encryption: "CMK", kmsKey: "other" }), false);
  assert.equal(sameEncryption({ encryption: "OWNED", kmsKey: "" }, { encryption: "OWNED", kmsKey: "" }), true);
});

test("Stream and TTL states", () => {
  assert.deepEqual(streamValues({}), { enabled: false, viewType: "NEW_AND_OLD_IMAGES" });
  assert.deepEqual(streamValues({ StreamSpecification: { StreamEnabled: true, StreamViewType: "KEYS_ONLY" } }), { enabled: true, viewType: "KEYS_ONLY" });
  assert.equal(ttlOn("ENABLED"), true);
  assert.equal(ttlOn("DISABLED"), false);
  assert.equal(ttlOn(undefined), false);
});

test("Policies compare by content", () => {
  assert.equal(sameJson('{"a":1}', '{ "a": 1 }'), true);
  assert.equal(sameJson('{"a":1}', '{"a":2}'), false);
  assert.equal(sameJson(undefined, '{"a":1}'), false);
  assert.equal(prettyPolicy('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyPolicy(undefined), "");
});

test("DynamoDB Contributor Insights: managed rule names map to the console's graphs", () => {
  assert.deepEqual(insightsRuleKind("DynamoDBContributorInsights-PKC-orders-1795499525963"), { kind: "PKC", title: "Most accessed items (partition key)", index: null });
  assert.deepEqual(insightsRuleKind("DynamoDBContributorInsights-SKT-orders/index/by-status-1795499525963"), { kind: "SKT", title: "Most throttled items (partition and sort keys)", index: "by-status" });
  assert.equal(insightsRuleKind("my-own-rule"), null);
  assert.deepEqual(
    sortInsightsRules(["DynamoDBContributorInsights-SKT-t-1", "DynamoDBContributorInsights-PKT-t-1", "DynamoDBContributorInsights-SKC-t-1", "DynamoDBContributorInsights-PKC-t-1"]),
    ["DynamoDBContributorInsights-PKC-t-1", "DynamoDBContributorInsights-SKC-t-1", "DynamoDBContributorInsights-PKT-t-1", "DynamoDBContributorInsights-SKT-t-1"]
  );
  assert.deepEqual(contributorSeries([{ keys: ["user#1", "s1"], value: 3, points: [{ t: 1, v: 3 }] }, { keys: [], value: 1, points: [] }]), [
    { id: "c0", label: "user#1 | s1", points: [{ t: 1, v: 3 }] },
    { id: "c1", label: "(no key)", points: [] },
  ]);
});
