/**
 * Lambda Layers and Event source mappings. Creating a layer needs a .zip upload, so
 * /lambda/layers/create is hand-built (src/app/lambda/layers/create).
 */

import {
  CreateEventSourceMappingCommand,
  DeleteEventSourceMappingCommand,
  DeleteLayerVersionCommand,
  GetEventSourceMappingCommand,
  GetLayerVersionCommand,
  ListLayersCommand,
  ListLayerVersionsCommand,
  PublishLayerVersionCommand,
  UpdateEventSourceMappingCommand,
  type Architecture,
  type EventSourceMappingConfiguration,
  type Runtime,
} from "@aws-sdk/client-lambda";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { lambdaDate, RUNTIMES } from "./helpers.ts";
import { allMappings, eventSourceOptions, functionOptions, isStreamSource } from "./sources.ts";

export const LAYER_NAME = "[a-zA-Z0-9-_]{1,64}";
const LAYER_NAME_RE = new RegExp(`^${LAYER_NAME}$`);
const MAX_LAYER_ZIP = 50 * 1024 * 1024;

export interface NewLayerVersion {
  name: string;
  description: string;
  license: string;
  runtimes: string[];
  architectures: string[];
  zip: Uint8Array;
}

/** PublishLayerVersion with a .zip uploaded through the browser. Used by the hand-built create page. */
export async function publishLayer(ctx: Ctx, l: NewLayerVersion): Promise<{ name: string; version: number | null; arn: string | null }> {
  if (!LAYER_NAME_RE.test(l.name)) throw new Error("Name: up to 64 letters, numbers, hyphens and underscores.");
  if (l.zip.byteLength === 0) throw new Error("Choose a .zip file to upload.");
  if (l.zip.byteLength > MAX_LAYER_ZIP) throw new Error("The .zip file can be at most 50 MB when uploaded directly.");
  if (l.zip[0] !== 0x50 || l.zip[1] !== 0x4b) throw new Error("The file is not a .zip archive.");
  const runtimes = l.runtimes.filter((r) => RUNTIMES.some((x) => x.id === r) || /^[a-z0-9.]+$/.test(r)).slice(0, 15);
  const archs = l.architectures.filter((a) => a === "x86_64" || a === "arm64");
  const r = await ctx.clients.lambda.send(
    new PublishLayerVersionCommand({
      LayerName: l.name,
      Description: l.description.slice(0, 256) || undefined,
      LicenseInfo: l.license.slice(0, 512) || undefined,
      CompatibleRuntimes: runtimes.length ? (runtimes as Runtime[]) : undefined,
      CompatibleArchitectures: archs.length ? (archs as Architecture[]) : undefined,
      Content: { ZipFile: l.zip },
    })
  );
  return { name: l.name, version: r.Version ?? null, arn: r.LayerVersionArn ?? null };
}

async function versionsOf(ctx: Ctx, name: string) {
  const out = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.lambda.send(new ListLayerVersionsCommand({ LayerName: name, Marker: marker }));
    out.push(...(r.LayerVersions ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

export const layers: ResourceDef = {
  id: "layers",
  name: "Layers",
  singular: "layer",
  idField: "name",
  nameField: "Name",
  description: "Shared code and libraries, packaged as .zip archives, that functions can use.",
  emptyText: "There is no data to display. Create a layer to share code between functions.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "version", label: "Version", kind: "count" },
    { key: "description", label: "Description", kind: "text" },
    { key: "runtimes", label: "Compatible runtimes", kind: "text" },
    { key: "architectures", label: "Compatible architectures", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
    { key: "arn", label: "Version ARN", kind: "arn" },
  ],
  async list(ctx) {
    const out: Row[] = [];
    let marker: string | undefined;
    do {
      const r = await ctx.clients.lambda.send(new ListLayersCommand({ Marker: marker }));
      for (const l of r.Layers ?? []) {
        const v = l.LatestMatchingVersion;
        out.push({ name: l.LayerName ?? "", version: v?.Version ?? null, description: v?.Description || null, runtimes: (v?.CompatibleRuntimes ?? []).join(", ") || null, architectures: (v?.CompatibleArchitectures ?? []).join(", ") || null, created: lambdaDate(v?.CreatedDate), arn: v?.LayerVersionArn ?? null });
      }
      marker = r.NextMarker;
    } while (marker);
    return out;
  },
  async get(ctx, name) {
    const versions = await versionsOf(ctx, name);
    const latest = versions[0];
    if (!latest?.Version) throw new Error(`Layer ${name} was not found.`);
    const detail = await ctx.clients.lambda.send(new GetLayerVersionCommand({ LayerName: name, VersionNumber: latest.Version }));
    return {
      summary: { Name: name, "Latest version": latest.Version, "Version ARN": detail.LayerVersionArn ?? null, Description: detail.Description || null, Created: lambdaDate(detail.CreatedDate), License: detail.LicenseInfo ?? null },
      tabs: [
        {
          id: "versions",
          label: "Versions",
          kind: "table",
          columns: [
            { key: "version", label: "Version", kind: "count" },
            { key: "description", label: "Description", kind: "text" },
            { key: "runtimes", label: "Compatible runtimes", kind: "text" },
            { key: "architectures", label: "Compatible architectures", kind: "text" },
            { key: "created", label: "Created", kind: "date" },
            { key: "arn", label: "Version ARN", kind: "arn" },
          ],
          data: versions.map((v) => ({ version: v.Version ?? null, description: v.Description || null, runtimes: (v.CompatibleRuntimes ?? []).join(", ") || null, architectures: (v.CompatibleArchitectures ?? []).join(", ") || null, created: lambdaDate(v.CreatedDate), arn: v.LayerVersionArn ?? null })),
        },
        { id: "content", label: "Latest version content", kind: "keyvalue", data: { "Code size": detail.Content?.CodeSize ?? null, "Code SHA-256": detail.Content?.CodeSha256 ?? null, "Signing profile": detail.Content?.SigningProfileVersionArn ?? null } },
      ],
    };
  },
  create: {
    title: "Create layer",
    description: "Upload a .zip file with PublishLayerVersion.",
    fields: [],
    async run() {
      throw new Error("Create layers on the Create layer page, which uploads the .zip file.");
    },
  },
  actions: [
    {
      id: "delete-version",
      label: "Delete version",
      danger: true,
      fields: [
        {
          name: "version",
          label: "Version",
          kind: "select",
          required: true,
          async options(ctx, name) {
            if (!name) return [];
            return (await versionsOf(ctx, name)).filter((v) => v.Version !== undefined).map((v) => ({ value: String(v.Version), label: `Version ${v.Version}${v.Description ? ` (${v.Description})` : ""}` }));
          },
        },
      ],
      async run(ctx, name, v) {
        const version = Number(v.version);
        if (!Number.isInteger(version) || version < 1) throw new Error("Choose a version to delete.");
        await ctx.clients.lambda.send(new DeleteLayerVersionCommand({ LayerName: name, VersionNumber: version }));
        return { message: `Deleted version ${v.version} of ${name}. Functions that already use it keep working.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      for (const v of await versionsOf(ctx, name)) if (v.Version) await ctx.clients.lambda.send(new DeleteLayerVersionCommand({ LayerName: name, VersionNumber: v.Version }));
    },
  },
};

// ---- Event source mappings ----

/** State from a list row ("state") or the detail summary ("State"). */
function mappingState(row: Row): unknown {
  return row.state ?? row.State;
}

function mappingRow(m: EventSourceMappingConfiguration): Row {
  return {
    uuid: m.UUID ?? "",
    functionName: m.FunctionArn?.split(":")[6] ?? null,
    source: m.EventSourceArn ?? null,
    state: m.State ?? null,
    batchSize: m.BatchSize ?? null,
    window: m.MaximumBatchingWindowInSeconds ?? null,
    lastModified: m.LastModified ?? null,
    lastResult: m.LastProcessingResult ?? null,
  };
}

export const eventSourceMappings: ResourceDef = {
  id: "event-source-mappings",
  name: "Event source mappings",
  singular: "event source mapping",
  idField: "uuid",
  nameField: "UUID",
  description: "Every event source mapping in this Region, across all functions. Lambda polls an SQS queue, Kinesis stream or DynamoDB stream and invokes a function with batches of records. In the AWS console these appear as triggers on each function's page (Configuration > Triggers); this console also lists them here.",
  emptyText: "No event source mappings.",
  columns: [
    { key: "uuid", label: "UUID", kind: "link" },
    { key: "functionName", label: "Function", kind: "text", href: "/lambda/functions/{functionName}" },
    { key: "source", label: "Event source", kind: "arn" },
    { key: "state", label: "State", kind: "status" },
    { key: "batchSize", label: "Batch size", kind: "count" },
    { key: "lastModified", label: "Last modified", kind: "date" },
  ],
  async list(ctx) {
    return (await allMappings(ctx)).map(mappingRow);
  },
  async get(ctx, uuid) {
    const m = await ctx.clients.lambda.send(new GetEventSourceMappingCommand({ UUID: uuid }));
    const row = mappingRow(m);
    return {
      summary: { UUID: uuid, Function: m.FunctionArn ?? null, "Event source": m.EventSourceArn ?? null, State: m.State ?? null, "State transition reason": m.StateTransitionReason ?? null },
      tabs: [
        {
          id: "config",
          label: "Configuration",
          kind: "keyvalue",
          data: {
            "Batch size": row.batchSize,
            "Batch window (seconds)": row.window,
            "Starting position": m.StartingPosition ?? null,
            "Maximum concurrency": m.ScalingConfig?.MaximumConcurrency ?? null,
            "Report batch item failures": (m.FunctionResponseTypes ?? []).includes("ReportBatchItemFailures"),
            "Last processing result": row.lastResult,
            "Last modified": row.lastModified,
            Filters: m.FilterCriteria?.Filters?.map((f) => f.Pattern).join("; ") || null,
          },
        },
      ],
    };
  },
  create: {
    title: "Create event source mapping",
    description: "Creates an event source mapping (trigger) with CreateEventSourceMapping. The function's execution role needs permission to read the source.",
    fields: [
      { name: "functionName", label: "Lambda function", kind: "select", required: true, options: functionOptions, section: "Trigger configuration" },
      { name: "source", label: "Event source", kind: "select", required: true, options: eventSourceOptions, section: "Trigger configuration", help: "SQS queues, Kinesis data streams, and DynamoDB tables with streams turned on." },
      { name: "enabled", label: "Activate trigger", kind: "checkbox", default: true, section: "Trigger configuration" },
      { name: "batchSize", label: "Batch size", kind: "number", default: 10, section: "Trigger configuration", help: "SQS: 1-10000 (10 default). Streams: 1-10000 (100 default).", validate: { min: 1, max: 10000, message: "Between 1 and 10000." } },
      { name: "window", label: "Batch window (seconds)", kind: "number", section: "Trigger configuration", validate: { min: 0, max: 300, message: "Between 0 and 300." } },
      { name: "startingPosition", label: "Starting position (streams only)", kind: "select", default: "LATEST", section: "Trigger configuration", options: [{ value: "LATEST", label: "Latest" }, { value: "TRIM_HORIZON", label: "Trim horizon" }] },
      { name: "reportFailures", label: "Report batch item failures", kind: "checkbox", default: false, section: "Trigger configuration" },
    ],
    async run(ctx, v) {
      const source = String(v.source);
      const r = await ctx.clients.lambda.send(
        new CreateEventSourceMappingCommand({
          FunctionName: String(v.functionName),
          EventSourceArn: source,
          Enabled: v.enabled === true,
          BatchSize: typeof v.batchSize === "number" ? v.batchSize : undefined,
          MaximumBatchingWindowInSeconds: typeof v.window === "number" ? v.window : undefined,
          StartingPosition: isStreamSource(source) ? (String(v.startingPosition || "LATEST") as "LATEST" | "TRIM_HORIZON") : undefined,
          FunctionResponseTypes: v.reportFailures === true ? ["ReportBatchItemFailures"] : undefined,
        })
      );
      if (!r.UUID) throw new Error("CreateEventSourceMapping returned no UUID.");
      return r.UUID;
    },
  },
  actions: [
    {
      id: "enable",
      label: "Enable",
      availableFor: (row) => mappingState(row) !== "Enabled" && mappingState(row) !== "Enabling",
      async run(ctx, uuid) {
        const r = await ctx.clients.lambda.send(new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: true }));
        return { message: `Trigger state: ${r.State ?? "updating"}.` };
      },
    },
    {
      id: "disable",
      label: "Disable",
      availableFor: (row) => mappingState(row) !== "Disabled" && mappingState(row) !== "Disabling",
      async run(ctx, uuid) {
        const r = await ctx.clients.lambda.send(new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: false }));
        return { message: `Trigger state: ${r.State ?? "updating"}.` };
      },
    },
    {
      id: "edit",
      label: "Edit batch settings",
      fields: [
        { name: "batchSize", label: "Batch size", kind: "number", required: true, default: 10, validate: { min: 1, max: 10000, message: "Between 1 and 10000." } },
        { name: "window", label: "Batch window (seconds)", kind: "number", validate: { min: 0, max: 300, message: "Between 0 and 300." } },
      ],
      async initialValues(ctx, uuid) {
        const m = await ctx.clients.lambda.send(new GetEventSourceMappingCommand({ UUID: uuid }));
        return { batchSize: m.BatchSize ?? 10, window: m.MaximumBatchingWindowInSeconds ?? null };
      },
      async run(ctx, uuid, v) {
        const m = await ctx.clients.lambda.send(new GetEventSourceMappingCommand({ UUID: uuid }));
        const batchSize = Number(v.batchSize);
        const window = typeof v.window === "number" ? v.window : undefined;
        const changes = { ...(batchSize !== m.BatchSize ? { BatchSize: batchSize } : {}), ...(window !== undefined && window !== m.MaximumBatchingWindowInSeconds ? { MaximumBatchingWindowInSeconds: window } : {}) };
        if (Object.keys(changes).length === 0) return { message: "No changes to save." };
        const r = await ctx.clients.lambda.send(new UpdateEventSourceMappingCommand({ UUID: uuid, ...changes }));
        return { message: `Batch size ${r.BatchSize ?? v.batchSize}, state ${r.State ?? "updating"}.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, uuid) {
      await ctx.clients.lambda.send(new DeleteEventSourceMappingCommand({ UUID: uuid }));
    },
  },
};
