/**
 * CloudTrail event history: pure row mapping and filter checking (unit tested), plus the
 * resource definition. The list screen is hand-built (src/app/cloudtrail/event-history)
 * because it needs lookup attribute and time filters; event details use the generic page.
 */

import { LookupEventsCommand, type Event, type LookupAttributeKey } from "@aws-sdk/client-cloudtrail";
import type { Ctx, ResourceDef } from "../../console/types.ts";

export const LOOKUP_KEYS: { value: LookupAttributeKey; label: string }[] = [
  { value: "EventName", label: "Event name" },
  { value: "EventSource", label: "Event source" },
  { value: "Username", label: "User name" },
  { value: "ResourceType", label: "Resource type" },
  { value: "ResourceName", label: "Resource name" },
  { value: "ReadOnly", label: "Read-only" },
  { value: "AccessKeyId", label: "AWS access key" },
  { value: "EventId", label: "Event ID" },
];

export interface EventFilter {
  key: string;
  value: string;
  start: string;
  end: string;
}

export interface CheckedFilter {
  attribute?: { AttributeKey: LookupAttributeKey; AttributeValue: string };
  start?: Date;
  end?: Date;
}

/** Validates a filter from the browser. Never trust it: unknown keys and bad dates are rejected. */
export function checkFilter(f: unknown): CheckedFilter {
  if (f === null || typeof f !== "object") return {};
  const raw = f as Record<string, unknown>;
  const key = typeof raw.key === "string" ? raw.key : "";
  const value = typeof raw.value === "string" ? raw.value.trim() : "";
  const out: CheckedFilter = {};
  if (key && value) {
    const known = LOOKUP_KEYS.find((k) => k.value === key);
    if (!known) throw new Error(`Unknown lookup attribute ${key}.`);
    if (value.length > 2000) throw new Error("The lookup value is too long.");
    if (key === "ReadOnly" && value !== "true" && value !== "false") throw new Error("Read-only must be true or false.");
    out.attribute = { AttributeKey: known.value, AttributeValue: value };
  }
  for (const side of ["start", "end"] as const) {
    const s = typeof raw[side] === "string" ? (raw[side] as string) : "";
    if (!s) continue;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`The ${side} time is not a valid date.`);
    out[side] = d;
  }
  if (out.start && out.end && out.start > out.end) throw new Error("The start time must be before the end time.");
  return out;
}

export interface EventRow {
  [key: string]: unknown;
  id: string;
  name: string;
  time: string | null;
  user: string | null;
  source: string | null;
  resourceType: string | null;
  resourceName: string | null;
  readOnly: string | null;
  accessKey: string | null;
  errorCode: string | null;
  sourceIp: string | null;
}

function parseRecord(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function eventRow(e: Event): EventRow {
  const record = parseRecord(e.CloudTrailEvent);
  const time = e.EventTime instanceof Date ? e.EventTime.toISOString() : typeof e.EventTime === "string" ? e.EventTime : null;
  return {
    id: e.EventId ?? "",
    name: e.EventName ?? "",
    time,
    user: e.Username ?? null,
    source: e.EventSource ?? null,
    resourceType: e.Resources?.[0]?.ResourceType ?? null,
    resourceName: e.Resources?.[0]?.ResourceName ?? null,
    readOnly: e.ReadOnly ?? null,
    accessKey: e.AccessKeyId ?? null,
    errorCode: typeof record?.errorCode === "string" ? record.errorCode : null,
    sourceIp: typeof record?.sourceIPAddress === "string" ? record.sourceIPAddress : null,
  };
}

export async function lookup(ctx: Ctx, filter: CheckedFilter, token?: string, max = 50): Promise<{ rows: EventRow[]; events: Event[]; nextToken: string | null }> {
  const r = await ctx.clients.cloudtrail.send(
    new LookupEventsCommand({ LookupAttributes: filter.attribute ? [filter.attribute] : undefined, StartTime: filter.start, EndTime: filter.end, MaxResults: max, NextToken: token || undefined })
  );
  const events = r.Events ?? [];
  return { rows: events.map(eventRow), events, nextToken: r.NextToken || null };
}

export const eventHistory: ResourceDef = {
  id: "event-history",
  name: "Event history",
  singular: "event",
  idField: "id",
  nameField: "name",
  description: "The last 90 days of management events in this Region, newest first.",
  emptyText: "No events match.",
  columns: [
    { key: "name", label: "Event name", kind: "link" },
    { key: "time", label: "Event time", kind: "date" },
    { key: "user", label: "User name", kind: "text" },
    { key: "source", label: "Event source", kind: "text" },
    { key: "resourceType", label: "Resource type", kind: "text" },
    { key: "resourceName", label: "Resource name", kind: "text" },
  ],
  async list(ctx) {
    return (await lookup(ctx, {})).rows;
  },
  async get(ctx, id) {
    const { events } = await lookup(ctx, { attribute: { AttributeKey: "EventId", AttributeValue: id } }, undefined, 1);
    const e = events[0];
    if (!e) throw new Error(`No event with ID ${id} in the last 90 days.`);
    const row = eventRow(e);
    const record = parseRecord(e.CloudTrailEvent);
    return {
      summary: {
        "Event name": row.name, "Event time": row.time, "User name": row.user, "Event source": row.source, "AWS access key": row.accessKey,
        "Source IP address": row.sourceIp, "Event ID": row.id, "Read-only": row.readOnly, "Error code": row.errorCode,
        "AWS region": typeof record?.awsRegion === "string" ? record.awsRegion : null, "Request ID": typeof record?.requestID === "string" ? record.requestID : null,
      },
      tabs: [
        { id: "record", label: "Event record", kind: "json", data: record ?? e.CloudTrailEvent ?? null, description: "The CloudTrail record exactly as LookupEvents returned it." },
        {
          id: "resources", label: "Resources referenced", kind: "table",
          columns: [{ key: "ResourceType", label: "Resource type", kind: "text" }, { key: "ResourceName", label: "Resource name", kind: "text" }],
          data: e.Resources ?? [], emptyText: "This event references no resources.",
        },
      ],
    };
  },
};
