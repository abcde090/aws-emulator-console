/** EventBridge archives and replays. */

import {
  CancelReplayCommand,
  CreateArchiveCommand,
  DeleteArchiveCommand,
  DescribeArchiveCommand,
  DescribeReplayCommand,
  ListArchivesCommand,
  ListReplaysCommand,
  StartReplayCommand,
  UpdateArchiveCommand,
  type Archive,
  type Replay,
} from "@aws-sdk/client-eventbridge";
import type { Ctx, FieldDef, FieldValues, ResourceDef } from "../../console/types.ts";
import { prettyJson, sameJson } from "../../console/values.ts";
import { isoOrNull, jsonObjectText, parseJsonText, rowState, text } from "./helpers.ts";
import { archiveOptions, busArnOptions } from "./lookups.ts";

const NAME = "[A-Za-z0-9._-]{1,48}";

function parseTime(label: string, v: unknown): Date {
  const t = text(v);
  const d = new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`);
  if (!t || Number.isNaN(d.getTime())) throw new Error(`${label}: use a UTC date and time such as 2026-11-23T00:00:00Z.`);
  return d;
}

const replayFields = (withArchive: boolean): FieldDef[] => [
  { name: "name", label: "Replay name", kind: "text", required: true, section: "Replay details", validate: { pattern: NAME, message: "Up to 48 letters, numbers, . - _" } },
  { name: "description", label: "Description", kind: "text", section: "Replay details" },
  ...(withArchive ? [{ name: "archive", label: "Source archive", kind: "select", required: true, section: "Replay details", options: archiveOptions } as FieldDef] : []),
  { name: "start", label: "Replay start time (UTC)", kind: "text", required: true, section: "Replay time frame", placeholder: "2026-11-23T00:00:00Z", help: "Events archived from this time are replayed." },
  { name: "end", label: "Replay end time (UTC)", kind: "text", required: true, section: "Replay time frame", placeholder: "2026-11-24T00:00:00Z" },
];

async function startReplay(ctx: Ctx, archiveName: string, v: FieldValues): Promise<string> {
  const archive = await ctx.clients.eventbridge.send(new DescribeArchiveCommand({ ArchiveName: archiveName }));
  if (!archive.ArchiveArn || !archive.EventSourceArn) throw new Error("EventBridge returned no ARN for the archive.");
  const name = text(v.name);
  await ctx.clients.eventbridge.send(
    new StartReplayCommand({
      ReplayName: name,
      Description: text(v.description) || undefined,
      EventSourceArn: archive.ArchiveArn,
      EventStartTime: parseTime("Replay start time", v.start),
      EventEndTime: parseTime("Replay end time", v.end),
      // A replay goes back to the bus the events were archived from.
      Destination: { Arn: archive.EventSourceArn },
    })
  );
  return name;
}

function archiveRow(a: Archive) {
  return {
    name: a.ArchiveName ?? null,
    state: a.State ?? null,
    source: a.EventSourceArn ? a.EventSourceArn.slice(a.EventSourceArn.indexOf("/") + 1) : null,
    events: a.EventCount ?? null,
    size: a.SizeBytes ?? null,
    retention: a.RetentionDays ? `${a.RetentionDays} days` : "Indefinite",
    created: isoOrNull(a.CreationTime),
  };
}

export const archives: ResourceDef = {
  id: "archives",
  name: "Archives",
  singular: "archive",
  idField: "name",
  nameField: "Name",
  description: "Archives keep events sent to an event bus so you can replay them later.",
  emptyText: "No archives.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "state", label: "Status", kind: "status" },
    { key: "source", label: "Source", kind: "text" },
    { key: "events", label: "Event count", kind: "count" },
    { key: "size", label: "Size", kind: "bytes" },
    { key: "retention", label: "Retention period", kind: "text" },
    { key: "created", label: "Creation time", kind: "date" },
  ],

  async list(ctx) {
    const out: Archive[] = [];
    let token: string | undefined;
    do {
      const page = await ctx.clients.eventbridge.send(new ListArchivesCommand({ NextToken: token }));
      out.push(...(page.Archives ?? []));
      token = page.NextToken;
    } while (token);
    return out.map(archiveRow);
  },

  async get(ctx, name) {
    const a = await ctx.clients.eventbridge.send(new DescribeArchiveCommand({ ArchiveName: name }));
    return {
      summary: {
        Name: a.ArchiveName ?? name,
        ARN: a.ArchiveArn ?? null,
        Status: a.State ?? null,
        Source: a.EventSourceArn ?? null,
        Description: a.Description || "-",
        "Event count": a.EventCount ?? null,
        "Size (bytes)": a.SizeBytes ?? null,
        "Retention period": a.RetentionDays ? `${a.RetentionDays} days` : "Indefinite",
        "Creation time": isoOrNull(a.CreationTime),
      },
      tabs: [
        { id: "pattern", label: "Event pattern", kind: "json", data: parseJsonText(a.EventPattern), emptyText: "No event pattern: every event sent to the bus is archived." },
      ],
    };
  },

  create: {
    title: "Create archive",
    description: "Creates an archive with CreateArchive.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Archive detail", validate: { pattern: NAME, message: "Up to 48 letters, numbers, . - _" } },
      { name: "description", label: "Description", kind: "text", section: "Archive detail" },
      { name: "source", label: "Source", kind: "select", required: true, section: "Archive detail", options: busArnOptions, help: "The event bus whose events are archived." },
      { name: "indefinite", label: "Indefinite retention", kind: "checkbox", default: true, section: "Retention period" },
      { name: "days", label: "Days", kind: "number", default: 30, section: "Retention period", showIf: { field: "indefinite", equals: false }, validate: { min: 1, max: 36500, message: "At least 1 day." } },
      { name: "pattern", label: "Event pattern (JSON)", kind: "json", section: "Filter events - optional", help: "Archive only events that match this pattern. Leave empty to archive every event." },
    ],
    async run(ctx, v) {
      const name = text(v.name);
      await ctx.clients.eventbridge.send(
        new CreateArchiveCommand({
          ArchiveName: name,
          EventSourceArn: text(v.source),
          Description: text(v.description) || undefined,
          EventPattern: jsonObjectText("Event pattern", v.pattern),
          RetentionDays: v.indefinite === true ? 0 : typeof v.days === "number" ? v.days : undefined,
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit archive",
      fields: [
        { name: "description", label: "Description", kind: "text", help: "Leave empty to remove the description.", validate: { max: 512, message: "At most 512 characters." } },
        { name: "indefinite", label: "Indefinite retention", kind: "checkbox", default: true },
        { name: "days", label: "Days", kind: "number", required: true, default: 30, showIf: { field: "indefinite", equals: false }, validate: { min: 1, max: 36500, message: "At least 1 day." } },
        { name: "pattern", label: "Event pattern (JSON)", kind: "json", help: "Archive only events that match this pattern. Leave empty to archive every event." },
      ],
      async initialValues(ctx, name) {
        const a = await ctx.clients.eventbridge.send(new DescribeArchiveCommand({ ArchiveName: name }));
        const days = a.RetentionDays ?? 0;
        return { description: a.Description ?? "", indefinite: days === 0, days: days || 30, pattern: prettyJson(a.EventPattern) };
      },
      async run(ctx, name, v) {
        const a = await ctx.clients.eventbridge.send(new DescribeArchiveCommand({ ArchiveName: name }));
        const description = text(v.description);
        const days = v.indefinite === true ? 0 : typeof v.days === "number" ? v.days : 0;
        const pattern = jsonObjectText("Event pattern", v.pattern) ?? "";
        // UpdateArchive keeps what it isn't sent, so only changed settings are sent.
        const changes = {
          Description: description !== (a.Description ?? "") ? description : undefined,
          RetentionDays: days !== (a.RetentionDays ?? 0) ? days : undefined,
          EventPattern: sameJson(a.EventPattern, pattern) ? undefined : pattern,
        };
        if (Object.values(changes).every((c) => c === undefined)) return { message: "No changes to save." };
        await ctx.clients.eventbridge.send(new UpdateArchiveCommand({ ArchiveName: name, ...changes }));
        return { message: `Archive ${name} updated.` };
      },
    },
    {
      id: "start-replay",
      label: "Start replay",
      fields: replayFields(false),
      async run(ctx, name, v) {
        const replay = await startReplay(ctx, name, v);
        return { message: `Replay ${replay} started. See Replays for its status.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.eventbridge.send(new DeleteArchiveCommand({ ArchiveName: name }));
    },
  },
};

function replayRow(r: Replay) {
  return {
    name: r.ReplayName ?? null,
    state: r.State ?? null,
    archive: r.EventSourceArn ? r.EventSourceArn.slice(r.EventSourceArn.indexOf("/") + 1) : null,
    started: isoOrNull(r.ReplayStartTime),
    ended: isoOrNull(r.ReplayEndTime),
  };
}

export const replays: ResourceDef = {
  id: "replays",
  name: "Replays",
  singular: "replay",
  idField: "name",
  nameField: "Name",
  description: "Replays send archived events back to their event bus.",
  emptyText: "No replays. Start a replay from an archive.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "state", label: "Status", kind: "status" },
    { key: "archive", label: "Source archive", kind: "text" },
    { key: "started", label: "Replay start time", kind: "date" },
    { key: "ended", label: "Replay end time", kind: "date" },
  ],

  async list(ctx) {
    const out: Replay[] = [];
    let token: string | undefined;
    do {
      const page = await ctx.clients.eventbridge.send(new ListReplaysCommand({ NextToken: token }));
      out.push(...(page.Replays ?? []));
      token = page.NextToken;
    } while (token);
    return out.map(replayRow);
  },

  async get(ctx, name) {
    const r = await ctx.clients.eventbridge.send(new DescribeReplayCommand({ ReplayName: name }));
    return {
      summary: {
        Name: r.ReplayName ?? name,
        ARN: r.ReplayArn ?? null,
        Status: r.State ?? null,
        "Status reason": r.StateReason ?? "-",
        "Source archive": r.EventSourceArn ?? null,
        Destination: r.Destination?.Arn ?? null,
        Description: r.Description || "-",
        "Events from": isoOrNull(r.EventStartTime),
        "Events to": isoOrNull(r.EventEndTime),
        "Last replayed event": isoOrNull(r.EventLastReplayedTime),
        "Replay start time": isoOrNull(r.ReplayStartTime),
        "Replay end time": isoOrNull(r.ReplayEndTime),
      },
    };
  },

  create: {
    title: "Start new replay",
    description: "Starts a replay with StartReplay. Events go back to the archive's source event bus.",
    fields: replayFields(true),
    async run(ctx, v) {
      return startReplay(ctx, text(v.archive), v);
    },
  },

  actions: [
    {
      id: "cancel",
      label: "Cancel replay",
      availableFor: (row) => {
        const state = rowState(row);
        return state === "" || state === "STARTING" || state === "RUNNING";
      },
      danger: true,
      confirm: "Stops a replay that is starting or running. Events already replayed stay delivered.",
      async run(ctx, name) {
        const r = await ctx.clients.eventbridge.send(new CancelReplayCommand({ ReplayName: name }));
        return { message: `Replay ${name}: ${r.State ?? "cancel requested"}.` };
      },
    },
  ],
};
