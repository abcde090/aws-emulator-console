"use server";

/**
 * Server actions for the hand-built "Explore items" and "PartiQL editor" screens. Every
 * call uses the permission-checked DynamoDB client, so the IAM simulator sees each Scan,
 * Query, PutItem, DeleteItem and ExecuteStatement. Nothing here throws to the browser.
 */

import {
  DeleteItemCommand,
  DescribeTableCommand,
  ExecuteStatementCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { buildFilter, buildKeyCondition, isTableName, keyOf, parseWireItem, sameKey, type Condition, type KeyOp, type ScalarType, type Wire, type WireItem } from "./attr.ts";
import { attrType, keyNames } from "./table-info.ts";

export interface KeyDef {
  name: string;
  type: ScalarType;
}

export interface IndexSchema {
  name: string;
  kind: "Global" | "Local";
  partition: KeyDef;
  sort: KeyDef | null;
}

export interface TableSchema {
  name: string;
  status: string | null;
  partition: KeyDef;
  sort: KeyDef | null;
  indexes: IndexSchema[];
  itemCount: number | null;
}

export interface ItemQuery {
  table: string;
  mode: "scan" | "query";
  index: string | null;
  pkValue: string;
  skOp: KeyOp;
  skValue: string;
  skValue2: string;
  filters: Condition[];
  limit: number;
  startKey: WireItem | null;
}

export interface ItemPage {
  items: WireItem[];
  lastKey: WireItem | null;
  count: number;
  scannedCount: number;
}

const MAX_DELETE = 100;

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function requireTable(t: unknown): string {
  if (!isTableName(t)) throw new Error("That is not a valid table name.");
  return t;
}

function toAv(w: Wire): AttributeValue {
  if ("B" in w) return { B: Buffer.from(w.B, "base64") };
  if ("BS" in w) return { BS: w.BS.map((b) => Buffer.from(b, "base64")) };
  if ("L" in w) return { L: w.L.map(toAv) };
  if ("M" in w) return { M: toAvItem(w.M) };
  return w as AttributeValue;
}

function toAvItem(item: WireItem): Record<string, AttributeValue> {
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, toAv(v)]));
}

function fromAv(av: AttributeValue): Wire {
  if (av.S !== undefined) return { S: av.S };
  if (av.N !== undefined) return { N: av.N };
  if (av.B !== undefined) return { B: Buffer.from(av.B).toString("base64") };
  if (av.BOOL !== undefined) return { BOOL: av.BOOL };
  if (av.NULL !== undefined) return { NULL: true };
  if (av.L !== undefined) return { L: av.L.map(fromAv) };
  if (av.M !== undefined) return { M: fromAvItem(av.M) };
  if (av.SS !== undefined) return { SS: av.SS };
  if (av.NS !== undefined) return { NS: av.NS };
  if (av.BS !== undefined) return { BS: av.BS.map((b) => Buffer.from(b).toString("base64")) };
  return { NULL: true };
}

function fromAvItem(item: Record<string, AttributeValue>): WireItem {
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, fromAv(v)]));
}

function keyDef(defs: Parameters<typeof attrType>[0], name: string | null): KeyDef | null {
  if (!name) return null;
  return { name, type: (attrType(defs, name) ?? "S") as ScalarType };
}

async function loadSchema(table: string): Promise<TableSchema> {
  const t = (await clients.dynamodb.send(new DescribeTableCommand({ TableName: table }))).Table;
  if (!t) throw new Error(`DynamoDB returned no description for table ${table}.`);
  const defs = t.AttributeDefinitions;
  const k = keyNames(t.KeySchema);
  const partition = keyDef(defs, k.partition);
  if (!partition) throw new Error(`Table ${table} has no partition key.`);
  const index = (name: string | undefined, kind: "Global" | "Local", schema: Parameters<typeof keyNames>[0]): IndexSchema | null => {
    const ik = keyNames(schema);
    const p = keyDef(defs, ik.partition);
    return name && p ? { name, kind, partition: p, sort: keyDef(defs, ik.sort) } : null;
  };
  return {
    name: t.TableName ?? table,
    status: t.TableStatus ?? null,
    partition,
    sort: keyDef(defs, k.sort),
    indexes: [
      ...(t.GlobalSecondaryIndexes ?? []).map((g) => index(g.IndexName, "Global", g.KeySchema)),
      ...(t.LocalSecondaryIndexes ?? []).map((l) => index(l.IndexName, "Local", l.KeySchema)),
    ].filter((i): i is IndexSchema => i !== null),
    itemCount: t.ItemCount ?? null,
  };
}

export async function describeForExplorer(table: string): Promise<Result<TableSchema>> {
  return attempt(() => loadSchema(requireTable(table)));
}

const tableKeyNames = (s: TableSchema): string[] => [s.partition.name, ...(s.sort ? [s.sort.name] : [])];

export async function runItemQuery(q: ItemQuery): Promise<Result<ItemPage>> {
  return attempt(async () => {
    if (q === null || typeof q !== "object") throw new Error("Missing query.");
    const table = requireTable(q.table);
    const schema = await loadSchema(table);
    const index = q.index ? schema.indexes.find((i) => i.name === q.index) : null;
    if (q.index && !index) throw new Error(`Index ${q.index} is not on table ${table}.`);
    const limit = Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= 1000 ? q.limit : 50;
    const filters = Array.isArray(q.filters) ? q.filters : [];
    const filter = buildFilter(filters);
    if (!filter.ok) throw new Error(filter.error);
    let start: WireItem | undefined;
    if (q.startKey) {
      const p = parseWireItem(q.startKey, "start key");
      if (!p.ok) throw new Error(p.error);
      start = p.value;
    }
    const names: Record<string, string> = { ...(filter.value?.names ?? {}) };
    const values: WireItem = { ...(filter.value?.values ?? {}) };
    let keyExpr: string | undefined;
    if (q.mode === "query") {
      const keys = index ?? schema;
      const sortCond = keys.sort ? { attr: keys.sort.name, type: keys.sort.type, op: q.skOp, value: String(q.skValue ?? ""), value2: String(q.skValue2 ?? "") } : null;
      const kc = buildKeyCondition({ attr: keys.partition.name, type: keys.partition.type, value: String(q.pkValue ?? "") }, sortCond);
      if (!kc.ok) throw new Error(kc.error);
      keyExpr = kc.value.expression;
      Object.assign(names, kc.value.names);
      Object.assign(values, kc.value.values);
    }
    const common = {
      TableName: table,
      IndexName: index?.name,
      Limit: limit,
      ExclusiveStartKey: start ? toAvItem(start) : undefined,
      FilterExpression: filter.value?.expression,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: Object.keys(values).length ? toAvItem(values) : undefined,
    };
    const r = q.mode === "query" ? await clients.dynamodb.send(new QueryCommand({ ...common, KeyConditionExpression: keyExpr })) : await clients.dynamodb.send(new ScanCommand(common));
    return {
      items: (r.Items ?? []).map(fromAvItem),
      lastKey: r.LastEvaluatedKey ? fromAvItem(r.LastEvaluatedKey) : null,
      count: r.Count ?? 0,
      scannedCount: r.ScannedCount ?? 0,
    };
  });
}

/** Create (refuses to overwrite an existing item) or edit (key attributes can't change). */
export async function saveItem(table: string, rawItem: unknown, originalKey: WireItem | null): Promise<Result<{ created: boolean }>> {
  return attempt(async () => {
    const t = requireTable(table);
    const parsed = parseWireItem(rawItem);
    if (!parsed.ok) throw new Error(parsed.error);
    const schema = await loadSchema(t);
    const keys = tableKeyNames(schema);
    const key = keyOf(parsed.value, keys);
    if (!key.ok) throw new Error(key.error);
    for (const k of [schema.partition, ...(schema.sort ? [schema.sort] : [])]) {
      const actual = Object.keys(parsed.value[k.name])[0];
      if (actual !== k.type) throw new Error(`Key attribute ${k.name} must be of type ${k.type}, not ${actual}.`);
    }
    if (originalKey) {
      const orig = parseWireItem(originalKey, "original key");
      if (!orig.ok) throw new Error(orig.error);
      if (!sameKey(parsed.value, orig.value, keys)) throw new Error("Key attributes can't be changed. Create a new item instead, then delete this one.");
      await clients.dynamodb.send(new PutItemCommand({ TableName: t, Item: toAvItem(parsed.value) }));
      return { created: false };
    }
    await clients.dynamodb.send(
      new PutItemCommand({
        TableName: t,
        Item: toAvItem(parsed.value),
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": schema.partition.name },
      })
    );
    return { created: true };
  });
}

export async function deleteItems(table: string, rawKeys: unknown[]): Promise<Result<{ deleted: number }>> {
  return attempt(async () => {
    const t = requireTable(table);
    if (!Array.isArray(rawKeys) || rawKeys.length === 0) throw new Error("Select at least one item.");
    if (rawKeys.length > MAX_DELETE) throw new Error(`Delete at most ${MAX_DELETE} items at a time.`);
    const schema = await loadSchema(t);
    let deleted = 0;
    for (const raw of rawKeys) {
      const p = parseWireItem(raw, "key");
      if (!p.ok) throw new Error(p.error);
      const key = keyOf(p.value, tableKeyNames(schema));
      if (!key.ok) throw new Error(key.error);
      await clients.dynamodb.send(new DeleteItemCommand({ TableName: t, Key: toAvItem(key.value) }));
      deleted++;
    }
    return { deleted };
  });
}

export interface StatementResult {
  items: WireItem[];
  nextToken: string | null;
}

export async function runStatement(statement: string, nextToken: string | null): Promise<Result<StatementResult>> {
  return attempt(async () => {
    if (typeof statement !== "string" || statement.trim() === "") throw new Error("Enter a PartiQL statement.");
    if (statement.length > 8192) throw new Error("Statements are at most 8,192 characters.");
    const r = await clients.dynamodb.send(new ExecuteStatementCommand({ Statement: statement, NextToken: typeof nextToken === "string" && nextToken ? nextToken : undefined }));
    return { items: (r.Items ?? []).map(fromAvItem), nextToken: r.NextToken ?? null };
  });
}
