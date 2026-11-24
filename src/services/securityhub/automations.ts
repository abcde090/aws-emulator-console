/** Security Hub CSPM automation rules and custom actions (EventBridge targets). */

import {
  BatchDeleteAutomationRulesCommand,
  BatchGetAutomationRulesCommand,
  BatchUpdateAutomationRulesCommand,
  CreateActionTargetCommand,
  CreateAutomationRuleCommand,
  DeleteActionTargetCommand,
  DescribeActionTargetsCommand,
  ListAutomationRulesCommand,
  type ActionTarget,
  type AutomationRulesConfig,
  type AutomationRulesMetadata,
} from "@aws-sdk/client-securityhub";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { needHub, str } from "./hub.ts";
import { arnTail, buildRuleCriteria, criteriaRows, isSeverity, isWorkflowStatus, SEVERITY_LABELS, WORKFLOW_STATUSES } from "./helpers.ts";

const ruleArn = (ctx: Ctx, id: string) => `arn:aws:securityhub:${ctx.region}:${ctx.accountId}:automation-rule/${id}`;

async function getRule(ctx: Ctx, id: string): Promise<AutomationRulesConfig> {
  const r = await needHub(() => ctx.clients.securityhub.send(new BatchGetAutomationRulesCommand({ AutomationRulesArns: [ruleArn(ctx, id)] })));
  const rule = r.Rules?.[0];
  if (!rule) throw new Error(`No automation rule ${id}${r.UnprocessedAutomationRules?.[0]?.ErrorMessage ? `: ${r.UnprocessedAutomationRules[0].ErrorMessage}` : "."}`);
  return rule;
}

const statusOf = (row: Row): unknown => row.status ?? row.Status;
const actionArn = (ctx: Ctx, id: string) => `arn:aws:securityhub:${ctx.region}:${ctx.accountId}:action/custom/${id}`;

async function allRules(ctx: Ctx): Promise<AutomationRulesMetadata[]> {
  const out: AutomationRulesMetadata[] = [];
  let token: string | undefined;
  do {
    const r = await needHub(() => ctx.clients.securityhub.send(new ListAutomationRulesCommand({ MaxResults: 100, NextToken: token })));
    out.push(...(r.AutomationRulesMetadata ?? []));
    token = r.NextToken || undefined;
  } while (token);
  return out;
}

async function allActionTargets(ctx: Ctx): Promise<ActionTarget[]> {
  const out: ActionTarget[] = [];
  let token: string | undefined;
  do {
    const r = await needHub(() => ctx.clients.securityhub.send(new DescribeActionTargetsCommand({ MaxResults: 100, NextToken: token })));
    out.push(...(r.ActionTargets ?? []));
    token = r.NextToken || undefined;
  } while (token);
  return out;
}

async function getActionTarget(ctx: Ctx, id: string): Promise<ActionTarget> {
  const r = await needHub(() => ctx.clients.securityhub.send(new DescribeActionTargetsCommand({ ActionTargetArns: [actionArn(ctx, id)] })));
  const a = r.ActionTargets?.[0];
  if (!a) throw new Error(`No custom action ${id}.`);
  return a;
}

async function setStatus(ctx: Ctx, id: string, status: "ENABLED" | "DISABLED") {
  const r = await ctx.clients.securityhub.send(new BatchUpdateAutomationRulesCommand({ UpdateAutomationRulesRequestItems: [{ RuleArn: ruleArn(ctx, id), RuleStatus: status }] }));
  if (r.UnprocessedAutomationRules?.length) throw new Error(r.UnprocessedAutomationRules.map((u) => u.ErrorMessage ?? u.ErrorCode ?? "Not updated").join("; "));
  return { message: `Rule ${status === "ENABLED" ? "enabled" : "disabled"}.` };
}

export const automationRules: ResourceDef = {
  id: "automations",
  name: "Automations",
  singular: "automation rule",
  idField: "id",
  nameField: "name",
  description: "Automation rules update findings as Security Hub CSPM receives them, in rule order.",
  emptyText: "No automation rules.",
  columns: [
    { key: "name", label: "Rule name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "order", label: "Rule order", kind: "count" },
    { key: "terminal", label: "Terminal", kind: "boolean" },
    { key: "description", label: "Description", kind: "text" },
    { key: "updated", label: "Updated", kind: "date" },
  ],
  async list(ctx) {
    return (await allRules(ctx)).map((m) => ({ id: arnTail(m.RuleArn), name: m.RuleName ?? "", status: m.RuleStatus ?? null, order: m.RuleOrder ?? null, terminal: m.IsTerminal ?? null, description: m.Description ?? null, updated: m.UpdatedAt ?? null }));
  },
  async get(ctx, id) {
    const r = await getRule(ctx, id);
    return {
      summary: { "Rule name": r.RuleName, Status: r.RuleStatus, "Rule order": r.RuleOrder, Terminal: r.IsTerminal ?? false, ARN: r.RuleArn, Description: r.Description ?? null, "Created by": r.CreatedBy ?? null },
      tabs: [
        { id: "criteria", label: "Criteria", kind: "table", columns: [{ key: "field", label: "Field", kind: "code" }, { key: "condition", label: "Condition", kind: "text" }], data: criteriaRows(r.Criteria as Record<string, unknown> | undefined), emptyText: "No criteria." },
        { id: "actions", label: "Actions", kind: "json", data: r.Actions ?? [] },
      ],
    };
  },
  create: {
    title: "Create rule",
    description: "Creates an automation rule with CreateAutomationRule. Matching findings are updated as they arrive.",
    fields: [
      { name: "name", label: "Rule name", kind: "text", required: true, section: "Rule", validate: { max: 256, message: "At most 256 characters." } },
      { name: "description", label: "Description", kind: "text", required: true, section: "Rule" },
      { name: "order", label: "Rule order", kind: "number", required: true, default: 1, section: "Rule", help: "Rules with a lower number run first (1-1000).", validate: { min: 1, max: 1000, message: "Between 1 and 1000." } },
      { name: "terminal", label: "Ignore subsequent rules for findings that match these criteria", kind: "checkbox", default: false, section: "Rule" },
      { name: "severities", label: "Severity label is", kind: "multiselect", section: "Criteria", options: SEVERITY_LABELS.map((s) => ({ value: s, label: s })) },
      { name: "productName", label: "Product name equals", kind: "text", section: "Criteria", placeholder: "Security Hub" },
      { name: "resourceType", label: "Resource type equals", kind: "text", section: "Criteria", placeholder: "AwsS3Bucket" },
      { name: "titlePrefix", label: "Title starts with", kind: "text", section: "Criteria" },
      { name: "complianceStatus", label: "Compliance status", kind: "select", section: "Criteria", options: ["PASSED", "WARNING", "FAILED", "NOT_AVAILABLE"].map((s) => ({ value: s, label: s })) },
      { name: "setWorkflow", label: "Set workflow status", kind: "select", section: "Automated action", options: WORKFLOW_STATUSES.map((s) => ({ value: s, label: s })) },
      { name: "setSeverity", label: "Set severity", kind: "select", section: "Automated action", options: SEVERITY_LABELS.map((s) => ({ value: s, label: s })) },
      { name: "note", label: "Add note", kind: "text", section: "Automated action" },
      { name: "enabled", label: "Enable the rule", kind: "checkbox", default: true, section: "Automated action" },
    ],
    async run(ctx, v) {
      const criteria = buildRuleCriteria({ severities: Array.isArray(v.severities) ? (v.severities as string[]) : [], productName: str(v.productName), resourceType: str(v.resourceType), titlePrefix: str(v.titlePrefix), complianceStatus: str(v.complianceStatus) });
      const update = {
        Workflow: isWorkflowStatus(v.setWorkflow) ? { Status: v.setWorkflow } : undefined,
        Severity: isSeverity(v.setSeverity) ? { Label: v.setSeverity } : undefined,
        Note: str(v.note) ? { Text: str(v.note), UpdatedBy: "automation-rule" } : undefined,
      };
      if (!update.Workflow && !update.Severity && !update.Note) throw new Error("Choose at least one automated action: workflow status, severity or note.");
      const r = await needHub(() =>
        ctx.clients.securityhub.send(
          new CreateAutomationRuleCommand({
            RuleName: str(v.name), Description: str(v.description), RuleOrder: typeof v.order === "number" ? v.order : 1, IsTerminal: v.terminal === true,
            RuleStatus: v.enabled === false ? "DISABLED" : "ENABLED", Criteria: criteria, Actions: [{ Type: "FINDING_FIELDS_UPDATE", FindingFieldsUpdate: update }],
          })
        )
      );
      if (!r.RuleArn) throw new Error("CreateAutomationRule returned no ARN.");
      return arnTail(r.RuleArn);
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit rule",
      fields: [
        { name: "name", label: "Rule name", kind: "text", required: true, validate: { max: 256, message: "At most 256 characters." } },
        { name: "description", label: "Description", kind: "text", required: true },
        { name: "order", label: "Rule order", kind: "number", required: true, default: 1, help: "Rules with a lower number run first (1-1000).", validate: { min: 1, max: 1000, message: "Between 1 and 1000." } },
        { name: "terminal", label: "Ignore subsequent rules for findings that match these criteria", kind: "checkbox", default: false },
      ],
      async initialValues(ctx, id) {
        const r = await getRule(ctx, id);
        return { name: r.RuleName ?? "", description: r.Description ?? "", order: r.RuleOrder ?? 1, terminal: r.IsTerminal === true };
      },
      async run(ctx, id, v) {
        const cur = await getRule(ctx, id);
        const name = str(v.name);
        const description = str(v.description);
        const order = typeof v.order === "number" ? v.order : cur.RuleOrder;
        const terminal = v.terminal === true;
        const item = {
          RuleArn: ruleArn(ctx, id),
          RuleName: name !== cur.RuleName ? name : undefined,
          Description: description !== (cur.Description ?? "") ? description : undefined,
          RuleOrder: order !== cur.RuleOrder ? order : undefined,
          IsTerminal: terminal !== (cur.IsTerminal === true) ? terminal : undefined,
        };
        if (item.RuleName === undefined && item.Description === undefined && item.RuleOrder === undefined && item.IsTerminal === undefined) return { message: "No changes to save." };
        const r = await ctx.clients.securityhub.send(new BatchUpdateAutomationRulesCommand({ UpdateAutomationRulesRequestItems: [item] }));
        if (r.UnprocessedAutomationRules?.length) throw new Error(r.UnprocessedAutomationRules.map((u) => u.ErrorMessage ?? u.ErrorCode ?? "Not updated").join("; "));
        return { message: "Rule updated." };
      },
    },
    { id: "enable", label: "Enable", availableFor: (row) => statusOf(row) !== "ENABLED", run: (ctx, id) => setStatus(ctx, id, "ENABLED") },
    { id: "disable", label: "Disable", availableFor: (row) => statusOf(row) !== "DISABLED", run: (ctx, id) => setStatus(ctx, id, "DISABLED") },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const r = await ctx.clients.securityhub.send(new BatchDeleteAutomationRulesCommand({ AutomationRulesArns: [ruleArn(ctx, id)] }));
      if (r.UnprocessedAutomationRules?.length) throw new Error(r.UnprocessedAutomationRules.map((u) => u.ErrorMessage ?? u.ErrorCode ?? "Not deleted").join("; "));
    },
  },
};

export const customActions: ResourceDef = {
  id: "custom-actions",
  name: "Custom actions",
  singular: "custom action",
  idField: "id",
  nameField: "name",
  description: "Custom actions send selected findings to Amazon EventBridge as \"Security Hub Findings - Custom Action\" events.",
  emptyText: "No custom actions.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "id", label: "Custom action ID", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn" },
  ],
  async list(ctx) {
    return (await allActionTargets(ctx)).map((a) => ({ id: arnTail(a.ActionTargetArn), name: a.Name ?? "", description: a.Description ?? null, arn: a.ActionTargetArn ?? "" }));
  },
  async get(ctx, id) {
    const a = await getActionTarget(ctx, id);
    return {
      summary: { Name: a.Name, "Custom action ID": id, ARN: a.ActionTargetArn, Description: a.Description ?? null },
      tabs: [{ id: "pattern", label: "EventBridge event pattern", kind: "json", description: "Use this pattern in an EventBridge rule to act on findings sent with this custom action.", data: { source: ["aws.securityhub"], "detail-type": ["Security Hub Findings - Custom Action"], resources: [a.ActionTargetArn] } }],
    };
  },
  create: {
    title: "Create custom action",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, validate: { max: 20, message: "At most 20 characters." } },
      { name: "description", label: "Description", kind: "text", required: true },
      { name: "id", label: "Custom action ID", kind: "text", required: true, help: "Up to 20 letters and numbers. Used in the action's ARN.", validate: { pattern: "[A-Za-z0-9]{1,20}", message: "Up to 20 letters and numbers." } },
    ],
    async run(ctx, v) {
      const r = await needHub(() => ctx.clients.securityhub.send(new CreateActionTargetCommand({ Name: str(v.name), Description: str(v.description), Id: str(v.id) })));
      return arnTail(r.ActionTargetArn) || str(v.id);
    },
  },
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.securityhub.send(new DeleteActionTargetCommand({ ActionTargetArn: actionArn(ctx, id) }));
    },
  },
};
