/**
 * Rule actions shared by web ACLs and rule groups: add a managed rule group, a rate-based,
 * IP set, geo match or regex rule, and delete rules. Each reads the current rules and lock
 * token, then writes the whole list back with UpdateWebACL / UpdateRuleGroup.
 */

import { GetRuleGroupCommand, GetWebACLCommand, UpdateRuleGroupCommand, UpdateWebACLCommand, type Rule } from "@aws-sdk/client-wafv2";
import type { ActionDef, Ctx, FieldDef, FieldValues } from "../../console/types.ts";
import { findSummary, managedGroupOptions, parseRef, setOptions, wafFor } from "./client.ts";
import { buildRule, nextPriority, parseCountryCodes, ruleRows, RULE_ACTIONS, splitManagedId, type RuleAction, type RuleSpec } from "./helpers.ts";

export type RuleTarget = "webacl" | "rulegroup";

async function readRules(ctx: Ctx, target: RuleTarget, id: string): Promise<{ rules: Rule[]; write(rules: Rule[]): Promise<void> }> {
  const s = await findSummary(ctx, target, id);
  const scope = s.scope;
  const w = wafFor(ctx, scope);
  if (target === "webacl") {
    const r = await w.send(new GetWebACLCommand({ Scope: scope, Name: s.Name, Id: s.Id }));
    const acl = r.WebACL;
    if (!acl?.DefaultAction || !acl.VisibilityConfig) throw new Error("GetWebACL returned an incomplete web ACL.");
    return {
      rules: acl.Rules ?? [],
      async write(rules) {
        await w.send(
          new UpdateWebACLCommand({
            Scope: scope, Name: s.Name, Id: s.Id, LockToken: r.LockToken,
            DefaultAction: acl.DefaultAction, Description: acl.Description || undefined, Rules: rules, VisibilityConfig: acl.VisibilityConfig,
            CustomResponseBodies: acl.CustomResponseBodies, CaptchaConfig: acl.CaptchaConfig, ChallengeConfig: acl.ChallengeConfig,
            TokenDomains: acl.TokenDomains, AssociationConfig: acl.AssociationConfig,
          })
        );
      },
    };
  }
  const r = await w.send(new GetRuleGroupCommand({ Scope: scope, Name: s.Name, Id: s.Id }));
  const g = r.RuleGroup;
  if (!g?.VisibilityConfig) throw new Error("GetRuleGroup returned an incomplete rule group.");
  return {
    rules: g.Rules ?? [],
    async write(rules) {
      await w.send(
        new UpdateRuleGroupCommand({
          Scope: scope, Name: s.Name, Id: s.Id, LockToken: r.LockToken, Description: g.Description || undefined,
          Rules: rules, VisibilityConfig: g.VisibilityConfig, CustomResponseBodies: g.CustomResponseBodies,
        })
      );
    },
  };
}

const actionOptions = (allowed: RuleAction[]) => allowed.map((a) => ({ value: a, label: a }));
const RULE_NAME_FIELD: FieldDef = {
  name: "ruleName", label: "Name", kind: "text", required: true,
  help: "Up to 128 characters: letters, numbers, hyphens and underscores. Also used as the CloudWatch metric name.",
  validate: { pattern: "[\\w-]{1,128}", message: "Use 1-128 letters, numbers, hyphens or underscores." },
};
const PRIORITY_FIELD: FieldDef = { name: "priority", label: "Priority", kind: "number", help: "Rules are evaluated from the lowest priority. Leave empty to add the rule last.", validate: { min: 0, max: 100000, message: "Between 0 and 100000." } };
const actionField = (allowed: RuleAction[], def: RuleAction): FieldDef => ({ name: "action", label: "Action", kind: "radio", default: def, options: actionOptions(allowed) });

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function addRule(ctx: Ctx, target: RuleTarget, id: string, v: FieldValues, make: (priority: number) => RuleSpec): Promise<{ message: string }> {
  const current = await readRules(ctx, target, id);
  const priority = typeof v.priority === "number" ? v.priority : nextPriority(current.rules);
  const spec = make(priority);
  if (current.rules.some((r) => r.Name === spec.name)) throw new Error(`A rule named ${spec.name} already exists.`);
  if (current.rules.some((r) => r.Priority === priority)) throw new Error(`Priority ${priority} is already used. Rule priorities must be unique.`);
  await current.write([...current.rules, buildRule(spec)]);
  return { message: `Added rule ${spec.name} with priority ${priority}.` };
}

function ruleAction(v: FieldValues): RuleAction {
  const a = str(v.action);
  return (RULE_ACTIONS as string[]).includes(a) ? (a as RuleAction) : "Block";
}

export function ruleActions(target: RuleTarget): ActionDef[] {
  const managed: ActionDef[] = target === "webacl"
    ? [{
        id: "add-managed",
        label: "Add managed rule group",
        fields: [
          { name: "group", label: "Managed rule group", kind: "select", required: true, options: (ctx, id) => managedGroupOptions(ctx, parseRef(id ?? "").scope), help: "AWS Managed Rules and the other groups ListAvailableManagedRuleGroups returns for this web ACL's scope." },
          { name: "ruleName", label: "Rule name", kind: "text", help: "Defaults to the rule group name.", validate: { pattern: "[\\w-]{1,128}", message: "Use 1-128 letters, numbers, hyphens or underscores." } },
          { name: "overrideToCount", label: "Override rule group action to Count", kind: "checkbox", default: false, help: "Count matching requests instead of using the rule actions inside the group. Useful for testing." },
          PRIORITY_FIELD,
        ],
        async run(ctx, id, v) {
          const g = splitManagedId(str(v.group));
          return addRule(ctx, target, id, v, (priority) => ({ kind: "managed", name: str(v.ruleName) || g.name, priority, vendor: g.vendor, group: g.name, overrideToCount: v.overrideToCount === true }));
        },
      }]
    : [];
  return [
    ...managed,
    {
      id: "add-rate",
      label: "Add rate-based rule",
      fields: [
        RULE_NAME_FIELD,
        { name: "limit", label: "Rate limit", kind: "number", required: true, default: 2000, help: "Maximum requests from one IP address in the evaluation window (10 to 2,000,000,000).", validate: { min: 10, max: 2000000000, message: "Between 10 and 2,000,000,000." } },
        { name: "window", label: "Evaluation window", kind: "select", default: "300", options: [{ value: "60", label: "1 minute" }, { value: "120", label: "2 minutes" }, { value: "300", label: "5 minutes" }, { value: "600", label: "10 minutes" }] },
        { name: "aggregate", label: "Request aggregation", kind: "radio", default: "IP", options: [{ value: "IP", label: "Source IP address" }, { value: "FORWARDED_IP", label: "IP address in header (X-Forwarded-For)" }] },
        actionField(["Block", "Count", "CAPTCHA", "Challenge"], "Block"),
        PRIORITY_FIELD,
      ],
      async run(ctx, id, v) {
        return addRule(ctx, target, id, v, (priority) => ({
          kind: "rate", name: str(v.ruleName), priority, action: ruleAction(v), limit: typeof v.limit === "number" ? v.limit : 2000,
          windowSec: Number(str(v.window) || "300"), aggregateKey: v.aggregate === "FORWARDED_IP" ? "FORWARDED_IP" : "IP",
        }));
      },
    },
    {
      id: "add-ipset",
      label: "Add IP set rule",
      fields: [
        RULE_NAME_FIELD,
        { name: "ipSet", label: "IP set", kind: "select", required: true, options: (ctx, id) => setOptions(ctx, "ipset", parseRef(id ?? "").scope), help: "Matches requests whose source IP is in the set. Only IP sets in the same scope are listed; create them on the IP sets page." },
        actionField(["Allow", "Block", "Count", "CAPTCHA", "Challenge"], "Block"),
        PRIORITY_FIELD,
      ],
      async run(ctx, id, v) {
        return addRule(ctx, target, id, v, (priority) => ({ kind: "ipset", name: str(v.ruleName), priority, action: ruleAction(v), arn: str(v.ipSet) }));
      },
    },
    {
      id: "add-geo",
      label: "Add geo match rule",
      fields: [
        RULE_NAME_FIELD,
        { name: "countries", label: "Country codes", kind: "text", required: true, placeholder: "CN, RU", help: "Two-letter ISO 3166 country codes, separated by commas or spaces." },
        actionField(["Allow", "Block", "Count", "CAPTCHA", "Challenge"], "Block"),
        PRIORITY_FIELD,
      ],
      async run(ctx, id, v) {
        return addRule(ctx, target, id, v, (priority) => ({ kind: "geo", name: str(v.ruleName), priority, action: ruleAction(v), countryCodes: parseCountryCodes(str(v.countries)) }));
      },
    },
    {
      id: "add-regex",
      label: "Add regex pattern set rule",
      fields: [
        RULE_NAME_FIELD,
        { name: "regexSet", label: "Regex pattern set", kind: "select", required: true, options: (ctx, id) => setOptions(ctx, "regex", parseRef(id ?? "").scope), help: "Only regex pattern sets in the same scope are listed." },
        { name: "field", label: "Inspect", kind: "radio", default: "UriPath", options: [{ value: "UriPath", label: "URI path" }, { value: "QueryString", label: "Query string" }] },
        actionField(["Allow", "Block", "Count", "CAPTCHA", "Challenge"], "Block"),
        PRIORITY_FIELD,
      ],
      async run(ctx, id, v) {
        return addRule(ctx, target, id, v, (priority) => ({ kind: "regex", name: str(v.ruleName), priority, action: ruleAction(v), arn: str(v.regexSet), field: v.field === "QueryString" ? "QueryString" : "UriPath" }));
      },
    },
    {
      id: "manage-rules",
      label: "Delete rules",
      async run(ctx, id) {
        const { rules } = await readRules(ctx, target, id);
        return {
          message: `${rules.length} rule${rules.length === 1 ? "" : "s"}. Select the rules to delete.`,
          table: {
            rowKey: "name",
            emptyText: "No rules.",
            columns: [
              { key: "name", label: "Name", kind: "text" },
              { key: "priority", label: "Priority", kind: "count" },
              { key: "type", label: "Type", kind: "text" },
              { key: "action", label: "Action", kind: "text" },
            ],
            rows: ruleRows(rules),
            selectionAction: { actionId: "delete-rules", label: "Delete", danger: true, valuesField: "ruleNames" },
          },
        };
      },
    },
    {
      id: "delete-rules",
      label: "Delete selected rules",
      hidden: true,
      danger: true,
      fields: [{ name: "ruleNames", label: "Rules", kind: "multiselect", required: true }],
      async run(ctx, id, v) {
        const names = new Set(Array.isArray(v.ruleNames) ? (v.ruleNames as string[]) : []);
        const current = await readRules(ctx, target, id);
        const kept = current.rules.filter((r) => !names.has(r.Name ?? ""));
        const removed = current.rules.length - kept.length;
        if (removed === 0) throw new Error("None of the selected rules exist any more.");
        await current.write(kept);
        return { message: `Deleted ${removed} rule${removed === 1 ? "" : "s"}.` };
      },
    },
  ];
}
