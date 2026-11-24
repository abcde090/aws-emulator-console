/**
 * IAM Access reports › Access Analyzer: analyzers (create, archive rules, tags, delete) and
 * the external-access findings of every analyzer (archive / unarchive). Every call goes
 * through ctx.clients.accessanalyzer.
 */

import {
  CreateAnalyzerCommand,
  CreateArchiveRuleCommand,
  DeleteAnalyzerCommand,
  DeleteArchiveRuleCommand,
  GetAnalyzerCommand,
  GetFindingCommand,
  ListAnalyzersCommand,
  ListArchiveRulesCommand,
  ListFindingsCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateFindingsCommand,
  type AnalyzerSummary,
  type FindingSummary,
  type Type,
} from "@aws-sdk/client-accessanalyzer";
import type { Ctx, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { TAG_COLUMNS, tagRows, text } from "./common.ts";

const ANALYZER_NAME = "[A-Za-z][A-Za-z0-9_.-]{0,254}";

const TYPES: Option[] = [
  { value: "ACCOUNT", label: "External access analysis - current account" },
  { value: "ORGANIZATION", label: "External access analysis - current organization" },
  { value: "ACCOUNT_UNUSED_ACCESS", label: "Unused access analysis - current account" },
  { value: "ORGANIZATION_UNUSED_ACCESS", label: "Unused access analysis - current organization" },
];

const typeLabel = (t: string | undefined) => TYPES.find((o) => o.value === t)?.label ?? t ?? "-";
const isUnused = (t: string | undefined) => String(t ?? "").endsWith("UNUSED_ACCESS");

export async function allAnalyzers(ctx: Ctx): Promise<AnalyzerSummary[]> {
  const out: AnalyzerSummary[] = [];
  let nextToken: string | undefined;
  do {
    const r = await ctx.clients.accessanalyzer.send(new ListAnalyzersCommand({ nextToken }));
    out.push(...(r.analyzers ?? []));
    nextToken = r.nextToken;
  } while (nextToken);
  return out;
}

async function analyzerArn(ctx: Ctx, name: string): Promise<string> {
  const arn = (await ctx.clients.accessanalyzer.send(new GetAnalyzerCommand({ analyzerName: name }))).analyzer?.arn;
  if (!arn) throw new Error(`GetAnalyzer returned no ARN for ${name}.`);
  return arn;
}

async function analyzerTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const r = await ctx.clients.accessanalyzer.send(new ListTagsForResourceCommand({ resourceArn: arn }));
  return Object.entries(r.tags ?? {}).map(([Key, Value]) => ({ Key, Value }));
}

async function archiveRuleNames(ctx: Ctx, name: string): Promise<string[]> {
  const out: string[] = [];
  let nextToken: string | undefined;
  do {
    const r = await ctx.clients.accessanalyzer.send(new ListArchiveRulesCommand({ analyzerName: name, nextToken }));
    out.push(...(r.archiveRules ?? []).map((x) => x.ruleName ?? "").filter(Boolean));
    nextToken = r.nextToken;
  } while (nextToken);
  return out;
}

async function findingsOf(ctx: Ctx, arn: string): Promise<FindingSummary[]> {
  const out: FindingSummary[] = [];
  let nextToken: string | undefined;
  do {
    const r = await ctx.clients.accessanalyzer.send(new ListFindingsCommand({ analyzerArn: arn, nextToken }));
    out.push(...(r.findings ?? []));
    nextToken = r.nextToken;
  } while (nextToken);
  return out;
}

function findingRow(analyzer: AnalyzerSummary, f: FindingSummary): Row {
  return {
    key: `${analyzer.name}|${f.id}`,
    id: f.id ?? "",
    analyzer: analyzer.name ?? "",
    resource: f.resource ?? null,
    resourceType: f.resourceType ?? null,
    principal: f.principal ? Object.values(f.principal).join(", ") : null,
    isPublic: f.isPublic ?? null,
    status: f.status ?? null,
    updated: f.updatedAt ?? null,
  };
}

function splitFindingKey(key: string): { analyzer: string; id: string } {
  const i = key.indexOf("|");
  if (i < 1) throw new Error(`Malformed finding id ${key}.`);
  return { analyzer: key.slice(0, i), id: key.slice(i + 1) };
}

const FINDING_COLUMNS = [
  { key: "id", label: "Finding ID", kind: "link" as const },
  { key: "resource", label: "Resource", kind: "arn" as const },
  { key: "resourceType", label: "Resource type", kind: "text" as const },
  { key: "principal", label: "External principal", kind: "text" as const },
  { key: "isPublic", label: "Public", kind: "boolean" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "updated", label: "Updated", kind: "date" as const },
];

export const analyzers: ResourceDef = {
  id: "access-analyzer",
  name: "Access Analyzer",
  singular: "analyzer",
  idField: "name",
  nameField: "Analyzer name",
  description: "IAM Access Analyzer analyzers. An external access analyzer reports resources shared outside your zone of trust; an unused access analyzer reports unused roles, keys and permissions.",
  emptyText: "No analyzers. Create an analyzer to start finding external or unused access.",
  columns: [
    { key: "name", label: "Analyzer name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await allAnalyzers(ctx)).map((a) => ({ name: a.name ?? "", type: typeLabel(a.type), rawType: a.type ?? "", status: a.status ?? null, created: a.createdAt ?? null, arn: a.arn ?? null }));
  },

  async get(ctx, name) {
    const a = (await ctx.clients.accessanalyzer.send(new GetAnalyzerCommand({ analyzerName: name }))).analyzer;
    const arn = a?.arn ?? "";
    const rules = await ctx.clients.accessanalyzer.send(new ListArchiveRulesCommand({ analyzerName: name }));
    const unused = isUnused(a?.type);
    const findings = !unused && a ? (await findingsOf(ctx, arn)).map((f) => findingRow(a, f)) : [];
    const unusedAge = a?.configuration && "unusedAccess" in a.configuration ? a.configuration.unusedAccess?.unusedAccessAge : undefined;
    return {
      summary: {
        "Analyzer name": a?.name ?? name,
        ARN: arn || null,
        Type: typeLabel(a?.type),
        Status: a?.status ?? null,
        "Status reason": a?.statusReason?.code ?? null,
        "Creation time": a?.createdAt ?? null,
        "Last resource analyzed": a?.lastResourceAnalyzed ?? null,
        "Last resource analyzed at": a?.lastResourceAnalyzedAt ?? null,
        ...(unused ? { "Tracking period (days)": unusedAge ?? null } : {}),
      },
      tabs: [
        {
          id: "findings",
          label: "Findings",
          kind: "table",
          columns: FINDING_COLUMNS.map((c) => (c.key === "id" ? { ...c, kind: "text" as const } : c)),
          data: findings,
          emptyText: unused
            ? "Unused access findings need ListFindingsV2, which AWS Emulator doesn't support yet."
            : "No findings. Resources shared outside your zone of trust appear here.",
        },
        {
          id: "archive-rules",
          label: "Archive rules",
          kind: "table",
          columns: [
            { key: "ruleName", label: "Rule name", kind: "text" },
            { key: "filter", label: "Filter", kind: "code" },
            { key: "updated", label: "Last updated", kind: "date" },
          ],
          data: (rules.archiveRules ?? []).map((r) => ({ ruleName: r.ruleName ?? "", filter: JSON.stringify(r.filter ?? {}), updated: r.updatedAt ?? null })),
          description: "Archive rules archive new findings that match their filter automatically.",
          emptyText: "No archive rules.",
        },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(Object.entries(a?.tags ?? {}).map(([Key, Value]) => ({ Key, Value }))), emptyText: "No tags." },
      ],
    };
  },

  create: {
    title: "Create analyzer",
    description: "Creates an IAM Access Analyzer analyzer (CreateAnalyzer). An account can have one external access analyzer per Region.",
    fields: [
      { name: "type", label: "Findings type", kind: "radio", default: "ACCOUNT", options: TYPES, section: "Analysis" },
      { name: "name", label: "Analyzer name", kind: "text", required: true, section: "Analysis", help: "Starts with a letter; letters, numbers, periods, hyphens and underscores.", validate: { pattern: ANALYZER_NAME, message: "Start with a letter; use letters, numbers, . _ and -." } },
      {
        name: "unusedAccessAge", label: "Tracking period (days)", kind: "number", default: 90, section: "Analysis", showIf: { field: "type", equals: ["ACCOUNT_UNUSED_ACCESS", "ORGANIZATION_UNUSED_ACCESS"] },
        help: "Access unused for longer than this is reported.", validate: { min: 1, max: 365, message: "Between 1 and 365 days." },
      },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const name = text(v.name);
      const type = (text(v.type) || "ACCOUNT") as Type;
      const tags = fieldTags(v.tags);
      await ctx.clients.accessanalyzer.send(
        new CreateAnalyzerCommand({
          analyzerName: name,
          type,
          tags: tags.length ? Object.fromEntries(tags.map((t) => [t.Key, t.Value])) : undefined,
          configuration: isUnused(type) && typeof v.unusedAccessAge === "number" ? { unusedAccess: { unusedAccessAge: v.unusedAccessAge } } : undefined,
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "create-archive-rule",
      label: "Create archive rule",
      fields: [
        { name: "ruleName", label: "Rule name", kind: "text", required: true, validate: { pattern: ANALYZER_NAME, message: "Start with a letter; use letters, numbers, . _ and -." } },
        {
          name: "filter", label: "Filter criteria", kind: "json", required: true, help: 'Map of finding fields to criteria, e.g. {"resourceType": {"eq": ["AWS::S3::Bucket"]}}.',
          default: JSON.stringify({ resourceType: { eq: ["AWS::S3::Bucket"] } }, null, 2),
        },
      ],
      async run(ctx, name, v) {
        let filter: unknown;
        try {
          filter = JSON.parse(String(v.filter ?? ""));
        } catch {
          throw new Error("The filter criteria must be valid JSON.");
        }
        if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("The filter criteria must be a JSON object.");
        await ctx.clients.accessanalyzer.send(new CreateArchiveRuleCommand({ analyzerName: name, ruleName: text(v.ruleName), filter: filter as never }));
        return { message: `Created archive rule ${text(v.ruleName)}.` };
      },
    },
    {
      id: "delete-archive-rule",
      label: "Delete archive rule",
      danger: true,
      fields: [{ name: "ruleName", label: "Archive rule", kind: "select", required: true, options: async (ctx, name) => (name ? (await archiveRuleNames(ctx, name)).map((r) => ({ value: r, label: r })) : []) }],
      async run(ctx, name, v) {
        await ctx.clients.accessanalyzer.send(new DeleteArchiveRuleCommand({ analyzerName: name, ruleName: text(v.ruleName) }));
        return { message: `Deleted archive rule ${text(v.ruleName)}.` };
      },
    },
    {
      id: "manage-tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Add, change or remove tags. Only the differences are saved." }],
      async initialValues(ctx, name) {
        return { tags: await analyzerTags(ctx, await analyzerArn(ctx, name)) };
      },
      async run(ctx, name, v) {
        const arn = await analyzerArn(ctx, name);
        const { set, remove } = tagDiff(await analyzerTags(ctx, arn), fieldTags(v.tags));
        if (set.length) await ctx.clients.accessanalyzer.send(new TagResourceCommand({ resourceArn: arn, tags: Object.fromEntries(set.map((t) => [t.Key, t.Value])) }));
        if (remove.length) await ctx.clients.accessanalyzer.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: remove }));
        return { message: tagDiffMessage({ set, remove }) };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.accessanalyzer.send(new DeleteAnalyzerCommand({ analyzerName: name }));
    },
  },
};

export const analyzerFindings: ResourceDef = {
  id: "access-analyzer-findings",
  name: "Access Analyzer findings",
  singular: "finding",
  idField: "key",
  nameField: "Finding ID",
  description: "External access findings of every external access analyzer in this Region (ListFindings).",
  emptyText: "No findings. Create an external access analyzer; resources shared outside your account then appear here.",
  columns: [...FINDING_COLUMNS.slice(0, 1), { key: "analyzer", label: "Analyzer", kind: "text", href: "/iam/access-analyzer/{analyzer}" }, ...FINDING_COLUMNS.slice(1)],

  async list(ctx) {
    const list = (await allAnalyzers(ctx)).filter((a) => a.arn && !isUnused(a.type));
    const rows = await Promise.all(list.map(async (a) => (await findingsOf(ctx, a.arn as string)).map((f) => findingRow(a, f))));
    return rows.flat();
  },

  async get(ctx, key) {
    const { analyzer, id } = splitFindingKey(key);
    const arn = await analyzerArn(ctx, analyzer);
    const f = (await ctx.clients.accessanalyzer.send(new GetFindingCommand({ analyzerArn: arn, id }))).finding;
    return {
      summary: {
        "Finding ID": f?.id ?? id,
        Analyzer: analyzer,
        Status: f?.status ?? null,
        Resource: f?.resource ?? null,
        "Resource type": f?.resourceType ?? null,
        "Resource owner account": f?.resourceOwnerAccount ?? null,
        Public: f?.isPublic ?? null,
        "Created": f?.createdAt ?? null,
        "Updated": f?.updatedAt ?? null,
      },
      tabs: [
        { id: "principal", label: "External principal", kind: "json", data: f?.principal ?? null, emptyText: "No principal." },
        { id: "actions", label: "Actions", kind: "table", columns: [{ key: "action", label: "Action", kind: "code" }], data: (f?.action ?? []).map((action) => ({ action })), emptyText: "No actions." },
        { id: "condition", label: "Condition", kind: "json", data: f?.condition ?? null, emptyText: "No condition." },
      ],
    };
  },

  actions: (["ARCHIVED", "ACTIVE"] as const).map((status) => ({
    id: status === "ARCHIVED" ? "archive" : "unarchive",
    label: status === "ARCHIVED" ? "Archive" : "Unarchive",
    availableFor: (row: Row) => String(row.status ?? row.Status ?? "") !== status,
    async run(ctx: Ctx, key: string) {
      const { analyzer, id } = splitFindingKey(key);
      await ctx.clients.accessanalyzer.send(new UpdateFindingsCommand({ analyzerArn: await analyzerArn(ctx, analyzer), ids: [id], status }));
      return { message: `Finding ${id} is now ${status === "ARCHIVED" ? "archived" : "active"}.` };
    },
  })),
};
