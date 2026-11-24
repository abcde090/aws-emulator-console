/** CloudTrail Lake event data stores and SQL queries. */

import {
  CreateEventDataStoreCommand,
  DeleteEventDataStoreCommand,
  GetEventDataStoreCommand,
  GetQueryResultsCommand,
  ListEventDataStoresCommand,
  ListQueriesCommand,
  StartQueryCommand,
  UpdateEventDataStoreCommand,
  type GetQueryResultsCommandOutput,
  type EventDataStore,
} from "@aws-sdk/client-cloudtrail";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { selectorRows } from "./selectors.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const QUERY_WAIT_MS = 15_000;

const edsArn = (ctx: Ctx, id: string) => `arn:aws:cloudtrail:${ctx.region}:${ctx.accountId}:eventdatastore/${id}`;
const edsId = (arn: string | undefined) => (arn ? arn.slice(arn.lastIndexOf("/") + 1) : "");

/** Query rows come back as lists of single-key maps; turn each into one flat row. */
export function lakeRows(rows: GetQueryResultsCommandOutput["QueryResultRows"]): { columns: string[]; rows: Row[] } {
  const columns: string[] = [];
  const out: Row[] = (rows ?? []).map((cells, i) => {
    const row: Row = { __row: String(i) };
    for (const cell of cells) {
      for (const [k, v] of Object.entries(cell)) {
        if (!columns.includes(k)) columns.push(k);
        row[k] = v;
      }
    }
    return row;
  });
  return { columns, rows: out };
}

export const eventDataStores: ResourceDef = {
  id: "event-data-stores",
  name: "Lake: Event data stores",
  singular: "event data store",
  idField: "id",
  nameField: "name",
  description: "CloudTrail Lake event data stores keep events for SQL queries, for up to 10 years.",
  emptyText: "No event data stores.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "retention", label: "Retention (days)", kind: "count" },
    { key: "multiRegion", label: "Multi-Region", kind: "boolean" },
    { key: "termination", label: "Termination protection", kind: "boolean" },
    { key: "created", label: "Created", kind: "date" },
  ],
  async list(ctx) {
    const stores: EventDataStore[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.cloudtrail.send(new ListEventDataStoresCommand({ MaxResults: 100, NextToken: token }));
      stores.push(...(r.EventDataStores ?? []));
      token = r.NextToken || undefined;
    } while (token);
    return Promise.all(
      stores.map(async (e) => {
        const full = await ctx.clients.cloudtrail.send(new GetEventDataStoreCommand({ EventDataStore: e.EventDataStoreArn }));
        return { id: edsId(e.EventDataStoreArn), name: full.Name ?? e.Name ?? "", status: full.Status ?? null, retention: full.RetentionPeriod ?? null, multiRegion: full.MultiRegionEnabled ?? null, termination: full.TerminationProtectionEnabled ?? null, created: full.CreatedTimestamp ?? null };
      })
    );
  },
  async get(ctx, id) {
    const e = await ctx.clients.cloudtrail.send(new GetEventDataStoreCommand({ EventDataStore: edsArn(ctx, id) }));
    const queries = await ctx.clients.cloudtrail.send(new ListQueriesCommand({ EventDataStore: edsArn(ctx, id), MaxResults: 50 }));
    return {
      summary: {
        Name: e.Name, Status: e.Status, ARN: e.EventDataStoreArn, "Retention period (days)": e.RetentionPeriod ?? null, "Pricing option": e.BillingMode ?? null,
        "Multi-Region": e.MultiRegionEnabled ?? null, "Organization": e.OrganizationEnabled ?? null, "Termination protection": e.TerminationProtectionEnabled ?? null,
        "KMS key": e.KmsKeyId ?? null, Created: e.CreatedTimestamp ?? null,
      },
      tabs: [
        { id: "selectors", label: "Event selectors", kind: "table", columns: [{ key: "name", label: "Selector", kind: "text" }, { key: "conditions", label: "Conditions", kind: "code" }], data: selectorRows(e.AdvancedEventSelectors), emptyText: "No advanced event selectors: this store collects no events." },
        {
          id: "queries", label: "Query history", kind: "table",
          columns: [{ key: "QueryId", label: "Query ID", kind: "text" }, { key: "QueryStatus", label: "Status", kind: "status" }, { key: "CreationTime", label: "Created", kind: "date" }],
          data: queries.Queries ?? [], emptyText: "No queries yet. Use Actions > Run query.",
        },
      ],
    };
  },
  create: {
    title: "Create event data store",
    description: "Creates a CloudTrail Lake event data store with CreateEventDataStore.",
    fields: [
      { name: "name", label: "Event data store name", kind: "text", required: true, section: "General details", validate: { pattern: "[A-Za-z0-9._-]{3,128}", message: "3-128 letters, numbers, . _ or -." } },
      { name: "billing", label: "Pricing option", kind: "radio", default: "EXTENDABLE_RETENTION_PRICING", section: "General details", options: [{ value: "EXTENDABLE_RETENTION_PRICING", label: "One-year extendable retention pricing" }, { value: "FIXED_RETENTION_PRICING", label: "Seven-year retention pricing" }] },
      { name: "retention", label: "Retention period (days)", kind: "number", default: 366, section: "General details", validate: { min: 7, max: 3653, message: "Between 7 and 3653 days." } },
      { name: "termination", label: "Enable termination protection", kind: "checkbox", default: true, section: "General details" },
      { name: "events", label: "Events", kind: "radio", default: "Management", section: "Events", options: [{ value: "Management", label: "Management events" }, { value: "Data", label: "Data events (S3 objects)" }] },
      { name: "multiRegion", label: "Include all Regions", kind: "checkbox", default: true, section: "Events" },
      { name: "ingest", label: "Ingest events", kind: "checkbox", default: true, section: "Events" },
    ],
    async run(ctx, v) {
      const selectors = v.events === "Data"
        ? [{ Name: "S3 data events", FieldSelectors: [{ Field: "eventCategory", Equals: ["Data"] }, { Field: "resources.type", Equals: ["AWS::S3::Object"] }] }]
        : [{ Name: "Management events", FieldSelectors: [{ Field: "eventCategory", Equals: ["Management"] }] }];
      const r = await ctx.clients.cloudtrail.send(
        new CreateEventDataStoreCommand({
          Name: str(v.name), RetentionPeriod: typeof v.retention === "number" ? v.retention : 366, TerminationProtectionEnabled: v.termination === true,
          BillingMode: v.billing === "FIXED_RETENTION_PRICING" ? "FIXED_RETENTION_PRICING" : "EXTENDABLE_RETENTION_PRICING",
          MultiRegionEnabled: v.multiRegion === true, AdvancedEventSelectors: selectors, StartIngestion: v.ingest === true,
        })
      );
      if (!r.EventDataStoreArn) throw new Error("CreateEventDataStore returned no ARN.");
      return edsId(r.EventDataStoreArn);
    },
  },
  actions: [
    {
      id: "query",
      label: "Run query",
      fields: [{ name: "sql", label: "SQL query", kind: "textarea", required: true, default: "SELECT eventName, eventTime, userIdentity.arn FROM $EDS_ID ORDER BY eventTime DESC LIMIT 10", help: "$EDS_ID is replaced with this event data store's ID." }],
      async run(ctx, id, v) {
        const sql = str(v.sql).replace(/\$EDS_ID/g, id);
        const started = await ctx.clients.cloudtrail.send(new StartQueryCommand({ QueryStatement: sql }));
        if (!started.QueryId) throw new Error("StartQuery returned no query ID.");
        const deadline = Date.now() + QUERY_WAIT_MS;
        for (;;) {
          const r = await ctx.clients.cloudtrail.send(new GetQueryResultsCommand({ EventDataStore: edsArn(ctx, id), QueryId: started.QueryId, MaxQueryResults: 100 }));
          if (r.QueryStatus === "FAILED" || r.QueryStatus === "CANCELLED" || r.QueryStatus === "TIMED_OUT") throw new Error(`Query ${r.QueryStatus}: ${r.ErrorMessage ?? "no error message"}`);
          if (r.QueryStatus === "FINISHED") {
            const { columns, rows } = lakeRows(r.QueryResultRows);
            return {
              message: `Query ${started.QueryId} finished: ${r.QueryStatistics?.ResultsCount ?? rows.length} result(s), ${r.QueryStatistics?.BytesScanned ?? 0} bytes scanned.`,
              table: { rowKey: "__row", columns: columns.map((c) => ({ key: c, label: c, kind: "text" as const })), rows, emptyText: "The query returned no rows." },
            };
          }
          if (Date.now() > deadline) return { message: `Query ${started.QueryId} is still ${r.QueryStatus ?? "running"}. Check Query history in a moment.` };
          await new Promise((res) => setTimeout(res, 500));
        }
      },
    },
    {
      id: "protect",
      label: "Turn termination protection on",
      availableFor: (row) => (row.termination ?? row["Termination protection"]) !== true,
      async run(ctx, id) {
        await ctx.clients.cloudtrail.send(new UpdateEventDataStoreCommand({ EventDataStore: edsArn(ctx, id), TerminationProtectionEnabled: true }));
        return { message: "Termination protection enabled." };
      },
    },
    {
      id: "unprotect",
      label: "Turn termination protection off",
      availableFor: (row) => (row.termination ?? row["Termination protection"]) !== false,
      async run(ctx, id) {
        await ctx.clients.cloudtrail.send(new UpdateEventDataStoreCommand({ EventDataStore: edsArn(ctx, id), TerminationProtectionEnabled: false }));
        return { message: "Termination protection disabled. You can now delete the event data store." };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, id) {
      await ctx.clients.cloudtrail.send(new DeleteEventDataStoreCommand({ EventDataStore: edsArn(ctx, id) }));
    },
  },
};
