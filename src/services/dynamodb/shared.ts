/**
 * DynamoDB calls shared by the tables, backups, exports and imports definitions. Server
 * only; every call goes through the permission-checked clients in ctx.
 */

import { DescribeTableCommand, ListTablesCommand, type TableDescription } from "@aws-sdk/client-dynamodb";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { ListAliasesCommand, ListKeysCommand } from "@aws-sdk/client-kms";
import { ListStreamsCommand } from "@aws-sdk/client-kinesis";
import type { Ctx, FieldValue, Option, Tag } from "../../console/types.ts";

export async function listTableNames(ctx: Ctx): Promise<string[]> {
  const names: string[] = [];
  let start: string | undefined;
  do {
    const page = await ctx.clients.dynamodb.send(new ListTablesCommand({ ExclusiveStartTableName: start, Limit: 100 }));
    names.push(...(page.TableNames ?? []));
    start = page.LastEvaluatedTableName;
  } while (start);
  return names;
}

export async function describeTable(ctx: Ctx, name: string): Promise<TableDescription> {
  const r = await ctx.clients.dynamodb.send(new DescribeTableCommand({ TableName: name }));
  if (!r.Table) throw new Error(`DynamoDB returned no description for table ${name}.`);
  return r.Table;
}

export async function tableOptions(ctx: Ctx): Promise<Option[]> {
  return (await listTableNames(ctx)).map((n) => ({ value: n, label: n }));
}

export async function bucketOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.s3.send(new ListBucketsCommand({}));
  return (r.Buckets ?? []).filter((b) => b.Name).map((b) => ({ value: b.Name as string, label: b.Name as string }));
}

/** Customer managed keys, labelled with their alias when they have one. */
export async function kmsKeyOptions(ctx: Ctx): Promise<Option[]> {
  const [keys, aliases] = await Promise.all([allPages(async (Marker) => {
    const r = await ctx.clients.kms.send(new ListKeysCommand({ Limit: 1000, Marker }));
    return { items: r.Keys, next: r.Truncated ? r.NextMarker : undefined };
  }), allPages(async (Marker) => {
    const r = await ctx.clients.kms.send(new ListAliasesCommand({ Limit: 100, Marker }));
    return { items: r.Aliases, next: r.Truncated ? r.NextMarker : undefined };
  })]);
  const aliasOf = new Map<string, string>();
  for (const a of aliases) if (a.TargetKeyId && a.AliasName) aliasOf.set(a.TargetKeyId, a.AliasName);
  return keys
    .filter((k) => k.KeyId && k.KeyArn && !(aliasOf.get(k.KeyId) ?? "").startsWith("alias/aws/"))
    .map((k) => ({ value: k.KeyArn as string, label: aliasOf.get(k.KeyId as string) ? `${aliasOf.get(k.KeyId as string)} (${k.KeyId})` : (k.KeyId as string) }));
}

export async function kinesisStreamOptions(ctx: Ctx): Promise<Option[]> {
  const streams = await allPages(async (NextToken) => {
    const r = await ctx.clients.kinesis.send(new ListStreamsCommand({ Limit: 1000, NextToken }));
    return { items: r.StreamSummaries, next: r.HasMoreStreams ? r.NextToken : undefined };
  });
  return streams.filter((s) => s.StreamARN).map((s) => ({ value: s.StreamARN as string, label: s.StreamName ?? (s.StreamARN as string) }));
}

/** Follows a list API's pages (at most 50) until it stops returning a next token. */
async function allPages<T>(fetch: (token: string | undefined) => Promise<{ items?: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await fetch(token);
    out.push(...(r.items ?? []));
    if (!r.next || r.next === token) break;
    token = r.next;
  }
  return out;
}

export function tagList(v: FieldValue | undefined): Tag[] {
  return Array.isArray(v) ? (v as Tag[]).filter((t) => typeof t === "object" && t !== null && "Key" in t) : [];
}

export function text(v: FieldValue | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

export function optionalText(v: FieldValue | undefined): string | undefined {
  const t = text(v);
  return t === "" ? undefined : t;
}

export function numberOr(v: FieldValue | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** "2026-11-23T10:00:00Z" style text into a Date, or an error naming the field. */
export function parseDateTime(v: FieldValue | undefined, label: string): Date {
  const t = text(v);
  const d = new Date(t);
  if (t === "" || Number.isNaN(d.getTime())) throw new Error(`${label}: enter a date and time such as 2026-11-23T10:00:00Z.`);
  return d;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
