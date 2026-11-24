/** AWS WAF rule groups (your own) and AWS Managed Rules (read-only catalogue). */

import { secondary } from "../../console/secondary.ts";
import { CreateRuleGroupCommand, DeleteRuleGroupCommand, DescribeManagedRuleGroupCommand, GetRuleGroupCommand } from "@aws-sdk/client-wafv2";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { findSummary, listBothScopes, managedGroups, refId, SCOPE_COLUMN, scopeField, scopeLabel, scopeValue, tagRows, tagsAction, TAG_COLUMNS, toWafTags, wafFor } from "./client.ts";
import { metricName, ruleRows, splitManagedId } from "./helpers.ts";
import { ruleActions } from "./rules.ts";

const NAME = "[\\w-]{1,128}";
const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function readGroup(ctx: Ctx, id: string) {
  const s = await findSummary(ctx, "rulegroup", id);
  const r = await wafFor(ctx, s.scope).send(new GetRuleGroupCommand({ Scope: s.scope, Name: s.Name, Id: s.Id }));
  if (!r.RuleGroup) throw new Error(`GetRuleGroup returned nothing for ${s.Name}.`);
  return { s, group: r.RuleGroup, lockToken: r.LockToken };
}

const RULE_COLUMNS = [
  { key: "name", label: "Name", kind: "text" as const },
  { key: "priority", label: "Priority", kind: "count" as const },
  { key: "type", label: "Type", kind: "text" as const },
  { key: "action", label: "Action", kind: "text" as const },
  { key: "statement", label: "Inspects", kind: "text" as const },
];

export const ruleGroups: ResourceDef = {
  id: "rule-groups",
  name: "Rule groups",
  singular: "rule group",
  idField: "id",
  nameField: "name",
  description: "Your own reusable collections of rules. A rule group's capacity is fixed when you create it.",
  emptyText: "No rule groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "wafId", label: "ID", kind: "text" },
    SCOPE_COLUMN,
    { key: "capacity", label: "Capacity", kind: "count" },
    { key: "rules", label: "Rules", kind: "count" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    const items = await listBothScopes(ctx, "rulegroup");
    return Promise.all(
      items.map(async (s): Promise<Row> => {
        const scope = s.scope ?? "REGIONAL";
        // Capacity and rule count are a second call per group: a denied GetRuleGroup leaves them blank, not the list.
        const r = await secondary(wafFor(ctx, scope).send(new GetRuleGroupCommand({ Scope: scope, Name: s.Name, Id: s.Id })));
        const g = r.ok ? r.value.RuleGroup : undefined;
        return { id: refId(scope, s.Id ?? ""), wafId: s.Id ?? "", scope: scopeLabel(scope, ctx.region), name: s.Name ?? "", description: s.Description || null, arn: s.ARN ?? null, capacity: g?.Capacity ?? null, rules: g?.Rules?.length ?? null };
      })
    );
  },
  async get(ctx, id) {
    const { s, group } = await readGroup(ctx, id);
    const tags = await secondary(tagRows(ctx, group.ARN));
    return {
      summary: { Name: group.Name, ID: group.Id, ARN: group.ARN, Description: group.Description || "-", Scope: scopeLabel(s.scope, ctx.region), Capacity: group.Capacity ?? null, "Label namespace": group.LabelNamespace ?? null },
      tabs: [
        { id: "rules", label: "Rules", kind: "table", columns: RULE_COLUMNS, data: ruleRows(group.Rules), emptyText: "No rules. Use Actions to add one." },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tags.ok ? tags.value : [], emptyText: tags.ok ? "No tags." : `Tags unavailable: ${tags.error}` },
        { id: "json", label: "Rules JSON", kind: "json", data: group.Rules ?? [] },
      ],
    };
  },
  create: {
    title: "Create rule group",
    description: "Creates an empty rule group with CreateRuleGroup. Add rules from its Actions menu.",
    fields: [
      scopeField("Rule group details"),
      { name: "name", label: "Name", kind: "text", required: true, section: "Rule group details", validate: { pattern: NAME, message: "Use 1-128 letters, numbers, hyphens or underscores." } },
      { name: "description", label: "Description", kind: "text", section: "Rule group details", validate: { pattern: "[\\w+=:#@/\\-,.][\\w+=:#@/\\-,.\\s]+[\\w+=:#@/\\-,.]", message: "At least 3 characters; letters, numbers, spaces and + = : # @ / - , . only." } },
      { name: "metricName", label: "CloudWatch metric name", kind: "text", section: "Rule group details", help: "Defaults to the rule group name." },
      { name: "capacity", label: "Capacity", kind: "number", required: true, default: 100, section: "Rule group details", help: "The most WCUs this rule group's rules can use. You can't change it after creation.", validate: { min: 1, max: 5000, message: "Between 1 and 5000." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = str(v.name);
      const scope = scopeValue(v);
      const r = await wafFor(ctx, scope).send(
        new CreateRuleGroupCommand({
          Scope: scope, Name: name, Description: str(v.description) || undefined, Capacity: typeof v.capacity === "number" ? v.capacity : 100, Rules: [],
          VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: str(v.metricName) || metricName(name) }, Tags: toWafTags(v.tags),
        })
      );
      if (!r.Summary?.Id) throw new Error("CreateRuleGroup returned no ID.");
      return refId(scope, r.Summary.Id);
    },
  },
  actions: [...ruleActions("rulegroup"), tagsAction("rulegroup")],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { s, lockToken } = await readGroup(ctx, id);
      await wafFor(ctx, s.scope).send(new DeleteRuleGroupCommand({ Scope: s.scope, Name: s.Name, Id: s.Id, LockToken: lockToken }));
    },
  },
};

export const managedRuleGroups: ResourceDef = {
  id: "managed-rule-groups",
  name: "AWS Managed Rules",
  singular: "managed rule group",
  idField: "id",
  nameField: "name",
  description: "Managed rule groups you can add to a web ACL. Open one to see its rules and capacity.",
  emptyText: "ListAvailableManagedRuleGroups returned no rule groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "vendor", label: "Vendor", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "versioning", label: "Versioning supported", kind: "boolean" },
  ],
  async list(ctx) {
    return (await managedGroups(ctx)).map((g) => ({ id: `${g.VendorName}:${g.Name}`, name: g.Name ?? "", vendor: g.VendorName ?? "", description: g.Description ?? null, versioning: g.VersioningSupported ?? null }));
  },
  async get(ctx, id) {
    const { vendor, name } = splitManagedId(id);
    const r = await ctx.clients.wafv2.send(new DescribeManagedRuleGroupCommand({ Scope: "REGIONAL", VendorName: vendor, Name: name }));
    return {
      summary: { Name: name, Vendor: vendor, Capacity: r.Capacity ?? null, "Label namespace": r.LabelNamespace ?? null, "SNS topic": r.SnsTopicArn ?? null, Version: r.VersionName ?? null },
      tabs: [
        {
          id: "rules", label: "Rules", kind: "table",
          columns: [{ key: "name", label: "Rule", kind: "text" }, { key: "action", label: "Action", kind: "text" }],
          data: (r.Rules ?? []).map((x): Row => ({ name: x.Name ?? "", action: Object.keys(x.Action ?? {})[0] ?? "-" })),
          emptyText: "No rules returned.",
        },
        { id: "labels", label: "Labels", kind: "table", columns: [{ key: "name", label: "Label", kind: "code" }], data: (r.AvailableLabels ?? []).map((l) => ({ name: l.Name ?? "" })), emptyText: "No labels returned." },
      ],
    };
  },
};
