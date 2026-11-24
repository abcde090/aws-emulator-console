"use server";

/**
 * Server actions for the hosted zone's Records tab. Every call uses the permission-checked
 * Route 53 client, so the IAM simulator sees each ListResourceRecordSets and
 * ChangeResourceRecordSets.
 */

import { ChangeResourceRecordSetsCommand, GetHostedZoneCommand, ListHealthChecksCommand, ListHostedZonesCommand, ListResourceRecordSetsCommand, type Change, type ResourceRecordSet } from "@aws-sdk/client-route-53";
import { clients } from "../../lib/aws.ts";
import { errorMessage, toPlain } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { buildRecordSet, isZoneDefault, recordKey, recordRow, recordToInput, type RecordInput, type RecordRow } from "./records.ts";
import { bareZoneId } from "./zone-id.ts";

export interface RecordListing {
  zoneName: string;
  rows: (RecordRow & { protected: boolean })[];
  /** Editor input for every record, by key. */
  inputs: Record<string, RecordInput>;
}

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: toPlain(await fn()) as T };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function requireZone(zoneId: unknown): string {
  const id = typeof zoneId === "string" ? bareZoneId(zoneId) : "";
  if (!/^[A-Z0-9]{1,64}$/.test(id)) throw new Error("That is not a valid hosted zone ID.");
  return id;
}

async function zoneName(id: string): Promise<string> {
  const r = await clients.route53.send(new GetHostedZoneCommand({ Id: id }));
  const name = r.HostedZone?.Name;
  if (!name) throw new Error(`Route 53 returned no name for hosted zone ${id}.`);
  return name;
}

async function allRecords(id: string): Promise<ResourceRecordSet[]> {
  const out: ResourceRecordSet[] = [];
  let next: { name?: string; type?: ResourceRecordSet["Type"]; identifier?: string } = {};
  for (;;) {
    const r = await clients.route53.send(
      new ListResourceRecordSetsCommand({ HostedZoneId: id, StartRecordName: next.name, StartRecordType: next.type, StartRecordIdentifier: next.identifier, MaxItems: 300 })
    );
    out.push(...(r.ResourceRecordSets ?? []));
    if (!r.IsTruncated) return out;
    next = { name: r.NextRecordName, type: r.NextRecordType, identifier: r.NextRecordIdentifier };
  }
}

export async function listRecords(zoneId: string): Promise<Result<RecordListing>> {
  return attempt(async () => {
    const id = requireZone(zoneId);
    const [name, records] = await Promise.all([zoneName(id), allRecords(id)]);
    return {
      zoneName: name,
      rows: records.map((r) => ({ ...recordRow(r), protected: isZoneDefault(r, name) })),
      inputs: Object.fromEntries(records.map((r) => [recordKey(r), recordToInput(r, name)])),
    };
  });
}

function checkInput(raw: unknown): RecordInput {
  if (raw === null || typeof raw !== "object") throw new Error("Record values are missing.");
  const r = raw as Record<string, unknown>;
  const text = (k: string): string => {
    const v = r[k];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string" || v.length > 40_000) throw new Error(`${k} must be text.`);
    return v;
  };
  return {
    name: text("name"),
    type: text("type"),
    alias: r.alias === true,
    values: text("values"),
    ttl: text("ttl"),
    routing: text("routing") as RecordInput["routing"],
    setIdentifier: text("setIdentifier"),
    weight: text("weight"),
    region: text("region"),
    failover: text("failover"),
    geoContinent: text("geoContinent"),
    geoCountry: text("geoCountry"),
    geoSubdivision: text("geoSubdivision"),
    healthCheckId: text("healthCheckId"),
    aliasZoneId: text("aliasZoneId"),
    aliasDnsName: text("aliasDnsName"),
    evaluateTargetHealth: r.evaluateTargetHealth === true,
  };
}

async function submit(id: string, changes: Change[], comment: string): Promise<string> {
  const r = await clients.route53.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: id, ChangeBatch: { Comment: comment, Changes: changes } }));
  return r.ChangeInfo?.Status ?? "submitted";
}

/**
 * Creates a record, or (with `previousKey`) replaces one. When the name, type or record ID
 * changes, the old record set is deleted and the new one created in the same change batch.
 */
export async function saveRecord(zoneId: string, rawInput: RecordInput, previousKey: string | null): Promise<Result<{ key: string; status: string }>> {
  return attempt(async () => {
    const id = requireZone(zoneId);
    const name = await zoneName(id);
    const built = buildRecordSet(checkInput(rawInput), name);
    if (!built.ok) throw new Error(built.error);
    const key = recordKey(built.record);
    if (previousKey === null) {
      return { key, status: await submit(id, [{ Action: "CREATE", ResourceRecordSet: built.record }], "Created in AWS Emulator Console") };
    }
    const old = (await allRecords(id)).find((r) => recordKey(r) === previousKey);
    if (!old) throw new Error("That record no longer exists. Refresh the list and try again.");
    if (isZoneDefault(old, name) && key !== previousKey) throw new Error("You can't rename the zone's default NS or SOA record.");
    const changes: Change[] = key === previousKey
      ? [{ Action: "UPSERT", ResourceRecordSet: built.record }]
      : [{ Action: "DELETE", ResourceRecordSet: old }, { Action: "CREATE", ResourceRecordSet: built.record }];
    return { key, status: await submit(id, changes, "Edited in AWS Emulator Console") };
  });
}

export async function deleteRecords(zoneId: string, keys: string[]): Promise<Result<{ deleted: number; status: string }>> {
  return attempt(async () => {
    const id = requireZone(zoneId);
    const wanted = new Set((Array.isArray(keys) ? keys : []).filter((k): k is string => typeof k === "string"));
    if (wanted.size === 0) throw new Error("Select at least one record.");
    const name = await zoneName(id);
    const targets = (await allRecords(id)).filter((r) => wanted.has(recordKey(r)));
    if (targets.length !== wanted.size) throw new Error("Some selected records no longer exist. Refresh the list and try again.");
    if (targets.some((r) => isZoneDefault(r, name))) throw new Error("The zone's default NS and SOA records can't be deleted.");
    const status = await submit(id, targets.map((r) => ({ Action: "DELETE", ResourceRecordSet: r })), "Deleted in AWS Emulator Console");
    return { deleted: targets.length, status };
  });
}

export interface EditorOptions {
  healthChecks: { value: string; label: string }[];
  zones: { value: string; label: string }[];
}

/** Choices for the record editor: health checks to attach and hosted zones for alias targets. */
export async function editorOptions(): Promise<Result<EditorOptions>> {
  return attempt(async () => {
    const [checks, zones] = await Promise.all([
      clients.route53.send(new ListHealthChecksCommand({ MaxItems: 100 })),
      clients.route53.send(new ListHostedZonesCommand({ MaxItems: 100 })),
    ]);
    return {
      healthChecks: (checks.HealthChecks ?? []).filter((c) => c.Id).map((c) => ({ value: c.Id as string, label: `${c.Id} (${c.HealthCheckConfig?.Type ?? ""} ${c.HealthCheckConfig?.FullyQualifiedDomainName ?? c.HealthCheckConfig?.IPAddress ?? ""})` })),
      zones: (zones.HostedZones ?? []).filter((z) => z.Id).map((z) => ({ value: bareZoneId(z.Id as string), label: `${z.Name ?? ""} (${bareZoneId(z.Id as string)})` })),
    };
  });
}
