/** AWS Config rules: managed rules with scope and parameters, evaluation, compliance, remediation (SSM Automation). */

import {
  DeleteConfigRuleCommand,
  DeleteRemediationConfigurationCommand,
  DescribeComplianceByConfigRuleCommand,
  DescribeConfigRuleEvaluationStatusCommand,
  DescribeConfigRulesCommand,
  DescribeRemediationConfigurationsCommand,
  DescribeRemediationExecutionStatusCommand,
  GetComplianceDetailsByConfigRuleCommand,
  PutConfigRuleCommand,
  PutRemediationConfigurationsCommand,
  StartConfigRulesEvaluationCommand,
  StartRemediationExecutionCommand,
  type ConfigRule,
  type EvaluationResult,
  type MaximumExecutionFrequency,
  type ResourceType,
  type ResourceValueType,
} from "@aws-sdk/client-config-service";
import { ListDocumentsCommand } from "@aws-sdk/client-ssm";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { complianceLabel, MANAGED_RULES, managedRule, parseJsonObject, splitResourceKey, resourceKey } from "./helpers.ts";
import { roleOptions, str } from "./settings.ts";

const RESOURCE_TYPES = [...new Set(MANAGED_RULES.flatMap((r) => r.scope))].sort();

async function allRules(ctx: Ctx, names?: string[]): Promise<ConfigRule[]> {
  const out: ConfigRule[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.config.send(new DescribeConfigRulesCommand({ ConfigRuleNames: names, NextToken: token }));
    out.push(...(r.ConfigRules ?? []));
    token = r.NextToken || undefined;
  } while (token);
  return out;
}

async function evaluations(ctx: Ctx, name: string): Promise<EvaluationResult[]> {
  const out: EvaluationResult[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.config.send(new GetComplianceDetailsByConfigRuleCommand({ ConfigRuleName: name, Limit: 100, NextToken: token }));
    out.push(...(r.EvaluationResults ?? []));
    token = r.NextToken || undefined;
  } while (token && out.length < 1000);
  return out;
}

function ruleType(r: ConfigRule): string {
  if (r.Source?.Owner === "AWS") return "AWS managed";
  if (r.Source?.Owner === "CUSTOM_LAMBDA") return "Custom Lambda";
  if (r.Source?.Owner === "CUSTOM_POLICY") return "Custom policy (Guard)";
  return r.Source?.Owner ?? "-";
}

async function ssmAutomationOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ssm.send(new ListDocumentsCommand({ Filters: [{ Key: "DocumentType", Values: ["Automation"] }], MaxResults: 50, NextToken: token }));
    for (const d of r.DocumentIdentifiers ?? []) if (d.Name) out.push({ value: d.Name, label: d.Name });
    token = r.NextToken || undefined;
  } while (token && out.length < 1000);
  return out;
}

/** Remediation document per rule. DescribeRemediationConfigurations takes at most 25 rule names. */
async function remediationTargets(ctx: Ctx, names: string[]): Promise<Map<string | undefined, string | undefined>> {
  const map = new Map<string | undefined, string | undefined>();
  for (let i = 0; i < names.length; i += 25) {
    const r = await ctx.clients.config.send(new DescribeRemediationConfigurationsCommand({ ConfigRuleNames: names.slice(i, i + 25) }));
    for (const c of r.RemediationConfigurations ?? []) map.set(c.ConfigRuleName, c.TargetId);
  }
  return map;
}

/** Remediation document from a list row ("remediation") or the detail summary ("Remediation action"). */
const hasRemediation = (row: Row): boolean => {
  const v = row.remediation ?? row["Remediation action"];
  return v === undefined || (v !== "Not set" && v !== null);
};

const FREQUENCY_OPTIONS: Option[] = [{ value: "One_Hour", label: "1 hour" }, { value: "Three_Hours", label: "3 hours" }, { value: "Six_Hours", label: "6 hours" }, { value: "Twelve_Hours", label: "12 hours" }, { value: "TwentyFour_Hours", label: "24 hours" }];

/** Current remediation settings in the "Manage remediation" form's terms. */
async function remediationValues(ctx: Ctx, name: string): Promise<FieldValues> {
  const r = await ctx.clients.config.send(new DescribeRemediationConfigurationsCommand({ ConfigRuleNames: [name] }));
  const c = r.RemediationConfigurations?.[0];
  if (!c) return {};
  const params = c.Parameters ?? {};
  const resourceParam = Object.entries(params).find(([, p]) => p.ResourceValue?.Value === "RESOURCE_ID")?.[0];
  const statics = Object.fromEntries(Object.entries(params).filter(([k, p]) => k !== "AutomationAssumeRole" && p.StaticValue).map(([k, p]) => [k, p.StaticValue?.Values ?? []]));
  return {
    document: c.TargetId ?? "", resourceParam: resourceParam ?? "BucketName", role: params.AutomationAssumeRole?.StaticValue?.Values?.[0] ?? "",
    staticParams: Object.keys(statics).length ? JSON.stringify(statics) : "", automatic: c.Automatic === true,
    retries: c.MaximumAutomaticAttempts ?? 5, retrySeconds: c.RetryAttemptSeconds ?? 60,
  };
}

const EVAL_COLUMNS = [
  { key: "resourceType", label: "Resource type", kind: "text" as const },
  { key: "resourceId", label: "Resource ID", kind: "text" as const },
  { key: "compliance", label: "Compliance", kind: "status" as const },
  { key: "recorded", label: "Recorded", kind: "date" as const },
];

const evalRow = (e: EvaluationResult): Row => {
  const q = e.EvaluationResultIdentifier?.EvaluationResultQualifier;
  return { key: resourceKey(q?.ResourceType ?? "", q?.ResourceId ?? ""), resourceType: q?.ResourceType ?? "", resourceId: q?.ResourceId ?? "", compliance: complianceLabel(e.ComplianceType, undefined), recorded: e.ResultRecordedTime ?? null, annotation: e.Annotation ?? null };
};

export const rules: ResourceDef = {
  id: "rules",
  name: "Rules",
  singular: "rule",
  idField: "name",
  nameField: "name",
  description: "Rules evaluate the configuration of your resources. Detective compliance shows the latest evaluation.",
  emptyText: "No rules. Choose Add rule to evaluate your resources against a managed rule.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "remediation", label: "Remediation action", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "mode", label: "Enabled evaluation mode", kind: "text" },
    { key: "compliance", label: "Detective compliance", kind: "status" },
    { key: "state", label: "State", kind: "status", hidden: true },
  ],
  async list(ctx) {
    const all = await allRules(ctx);
    // Compliance and remediation are secondary: if either is denied, the rules still list.
    const [compliance, rem] = await Promise.allSettled([ctx.clients.config.send(new DescribeComplianceByConfigRuleCommand({})), remediationTargets(ctx, all.map((r) => r.ConfigRuleName ?? "").filter(Boolean))]);
    return all.map((r) => {
      const c = compliance.status === "fulfilled" ? compliance.value.ComplianceByConfigRules?.find((x) => x.ConfigRuleName === r.ConfigRuleName)?.Compliance : undefined;
      return {
        name: r.ConfigRuleName ?? "", remediation: rem.status === "fulfilled" ? rem.value.get(r.ConfigRuleName) ?? "Not set" : "Unavailable", type: ruleType(r),
        mode: (r.EvaluationModes ?? []).map((m) => (m.Mode === "DETECTIVE" ? "Detective" : m.Mode === "PROACTIVE" ? "Proactive" : m.Mode)).join(", ") || "Detective",
        compliance: compliance.status === "fulfilled" ? complianceLabel(c?.ComplianceType, c?.ComplianceContributorCount?.CappedCount) : "Unavailable", state: r.ConfigRuleState ?? null,
      };
    });
  },
  async get(ctx, name) {
    const [rule] = await allRules(ctx, [name]);
    if (!rule) throw new Error(`NoSuchConfigRuleException: no rule ${name}.`);
    // Secondary lookups: a denied call marks its tab unavailable instead of failing the page.
    const [status, results, rem] = await Promise.allSettled([
      ctx.clients.config.send(new DescribeConfigRuleEvaluationStatusCommand({ ConfigRuleNames: [name] })),
      evaluations(ctx, name),
      ctx.clients.config.send(new DescribeRemediationConfigurationsCommand({ ConfigRuleNames: [name] })),
    ]);
    const failed = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? `Unavailable: ${errorMessage(r.reason)}` : undefined);
    const s = status.status === "fulfilled" ? status.value.ConfigRulesEvaluationStatus?.[0] : undefined;
    const remediation = rem.status === "fulfilled" ? rem.value.RemediationConfigurations?.[0] : undefined;
    // DescribeRemediationExecutionStatus fails with NoSuchRemediationConfiguration when there is none, so only ask when one exists.
    const execs = remediation
      ? await ctx.clients.config.send(new DescribeRemediationExecutionStatusCommand({ ConfigRuleName: name })).catch((err: unknown) => ({ RemediationExecutionStatuses: [], error: errorMessage(err) }))
      : { RemediationExecutionStatuses: [] };
    const execError = "error" in execs ? `Unavailable: ${execs.error}` : undefined;
    return {
      summary: {
        Name: rule.ConfigRuleName, Description: rule.Description ?? null, "Rule ARN": rule.ConfigRuleArn, Type: ruleType(rule), "Source identifier": rule.Source?.SourceIdentifier ?? null,
        State: rule.ConfigRuleState ?? null, Trigger: rule.MaximumExecutionFrequency ? `Periodic: ${rule.MaximumExecutionFrequency}` : "Configuration changes",
        "Last successful evaluation": s?.LastSuccessfulEvaluationTime ?? null,
        "Remediation action": rem.status === "fulfilled" ? remediation?.TargetId ?? "Not set" : "Unavailable",
      },
      tabs: [
        { id: "resources", label: "Resources in scope", kind: "table", columns: EVAL_COLUMNS, data: results.status === "fulfilled" ? results.value.map(evalRow) : [], emptyText: failed(results) ?? "No evaluation results yet. Run Re-evaluate, or check that the configuration recorder is recording." },
        {
          id: "scope", label: "Scope and parameters", kind: "keyvalue",
          data: {
            "Resource types": (rule.Scope?.ComplianceResourceTypes ?? []).join(", ") || "All changes",
            "Tag key": rule.Scope?.TagKey ?? null, "Tag value": rule.Scope?.TagValue ?? null, "Resource ID": rule.Scope?.ComplianceResourceId ?? null,
            Parameters: rule.InputParameters && rule.InputParameters !== "{}" ? rule.InputParameters : null,
          },
        },
        {
          id: "remediation", label: "Remediation action", kind: "keyvalue",
          data: remediation
            ? {
                "Action (SSM document)": remediation.TargetId ?? null, Automatic: remediation.Automatic ?? false, "Retry attempts": remediation.MaximumAutomaticAttempts ?? null,
                "Retry seconds": remediation.RetryAttemptSeconds ?? null, Parameters: JSON.stringify(remediation.Parameters ?? {}),
              }
            : {},
          emptyText: failed(rem) ?? "No remediation action. Use Actions > Manage remediation.",
        },
        {
          id: "executions", label: "Remediation executions", kind: "table",
          columns: [{ key: "resource", label: "Resource", kind: "text" }, { key: "state", label: "State", kind: "status" }, { key: "invoked", label: "Invoked", kind: "date" }, { key: "updated", label: "Updated", kind: "date" }],
          data: (execs.RemediationExecutionStatuses ?? []).map((e) => ({ resource: `${e.ResourceKey?.resourceType ?? ""} ${e.ResourceKey?.resourceId ?? ""}`, state: e.State ?? null, invoked: e.InvocationTime ?? null, updated: e.LastUpdatedTime ?? null })),
          emptyText: execError ?? "No remediation has run for this rule.",
        },
        { id: "json", label: "JSON", kind: "json", data: rule },
      ],
    };
  },
  create: {
    title: "Add rule",
    description: "Adds an AWS managed rule with PutConfigRule. Rules evaluate resources the configuration recorder records.",
    fields: [
      { name: "identifier", label: "AWS managed rule", kind: "select", required: true, section: "Rule type", options: MANAGED_RULES.map((r) => ({ value: r.id, label: `${r.id.toLowerCase().replace(/_/g, "-")}: ${r.description}` })) },
      { name: "name", label: "Name", kind: "text", section: "Details", help: "Defaults to the managed rule's name in lowercase.", validate: { pattern: "[A-Za-z0-9_.-]{1,128}", message: "Up to 128 letters, numbers, . _ or -." } },
      { name: "description", label: "Description", kind: "textarea", section: "Details" },
      { name: "scopeMode", label: "Scope of changes", kind: "radio", default: "default", section: "Evaluation mode", options: [{ value: "default", label: "Rule default (the resource types the rule evaluates)" }, { value: "types", label: "Resources (choose resource types)" }, { value: "tags", label: "Tags" }, { value: "all", label: "All changes" }] },
      { name: "types", label: "Resource types", kind: "multiselect", section: "Evaluation mode", options: RESOURCE_TYPES.map((t) => ({ value: t, label: t })), showIf: { field: "scopeMode", equals: "types" } },
      { name: "tagKey", label: "Tag key", kind: "text", section: "Evaluation mode", showIf: { field: "scopeMode", equals: "tags" } },
      { name: "tagValue", label: "Tag value", kind: "text", section: "Evaluation mode", showIf: { field: "scopeMode", equals: "tags" } },
      { name: "frequency", label: "Periodic frequency", kind: "select", section: "Evaluation mode", help: "For periodic rules (account-level checks such as iam-password-policy).", options: FREQUENCY_OPTIONS },
      { name: "parameters", label: "Rule parameters (JSON)", kind: "json", section: "Parameters", placeholder: '{"isMfaDeleteEnabled":"false"}', help: "Key-value pairs the managed rule accepts, as strings." },
    ],
    async run(ctx, v) {
      const id = str(v.identifier);
      const def = managedRule(id);
      if (!def) throw new Error(`Unknown managed rule ${id}.`);
      const name = str(v.name) || id.toLowerCase().replace(/_/g, "-");
      const params = parseJsonObject(str(v.parameters), "Rule parameters");
      const types = Array.isArray(v.types) ? (v.types as string[]) : [];
      const scope = v.scopeMode === "types" ? { ComplianceResourceTypes: types } : v.scopeMode === "tags" ? { TagKey: str(v.tagKey), TagValue: str(v.tagValue) || undefined } : v.scopeMode === "all" ? undefined : def.scope.length ? { ComplianceResourceTypes: def.scope } : undefined;
      if (v.scopeMode === "types" && types.length === 0) throw new Error("Choose at least one resource type.");
      if (v.scopeMode === "tags" && !str(v.tagKey)) throw new Error("Enter a tag key.");
      const frequency = str(v.frequency) || (def.periodic ? "TwentyFour_Hours" : "");
      await ctx.clients.config.send(
        new PutConfigRuleCommand({
          ConfigRule: {
            ConfigRuleName: name, Description: str(v.description) || def.description, Scope: scope, Source: { Owner: "AWS", SourceIdentifier: id },
            InputParameters: params ? JSON.stringify(params) : undefined, MaximumExecutionFrequency: frequency ? (frequency as MaximumExecutionFrequency) : undefined,
          },
        })
      );
      return name;
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit rule",
      fields: [
        { name: "description", label: "Description", kind: "textarea" },
        { name: "frequency", label: "Periodic frequency", kind: "select", options: FREQUENCY_OPTIONS, help: "Leave empty for a rule triggered by configuration changes." },
        { name: "parameters", label: "Rule parameters (JSON)", kind: "json", help: "Key-value pairs the managed rule accepts, as strings." },
      ],
      async initialValues(ctx, name): Promise<FieldValues> {
        const [rule] = await allRules(ctx, [name]);
        if (!rule) return {};
        return { description: rule.Description ?? "", frequency: rule.MaximumExecutionFrequency ?? "", parameters: rule.InputParameters && rule.InputParameters !== "{}" ? rule.InputParameters : "" };
      },
      async run(ctx, name, v) {
        const [rule] = await allRules(ctx, [name]);
        if (!rule) throw new Error(`NoSuchConfigRuleException: no rule ${name}.`);
        const params = parseJsonObject(str(v.parameters), "Rule parameters");
        const frequency = str(v.frequency);
        // PutConfigRule replaces the rule: send the current rule back with only these fields changed.
        await ctx.clients.config.send(
          new PutConfigRuleCommand({
            ConfigRule: {
              ...rule, ConfigRuleArn: undefined, ConfigRuleId: undefined, CreatedBy: undefined,
              Description: str(v.description) || undefined, InputParameters: params ? JSON.stringify(params) : undefined,
              MaximumExecutionFrequency: frequency ? (frequency as MaximumExecutionFrequency) : undefined,
            },
          })
        );
        return { message: "Rule updated." };
      },
    },
    {
      id: "evaluate",
      label: "Re-evaluate",
      async run(ctx, name) {
        await ctx.clients.config.send(new StartConfigRulesEvaluationCommand({ ConfigRuleNames: [name] }));
        return { message: "Evaluation started. Refresh the rule in a few seconds to see the results." };
      },
    },
    {
      id: "remediation",
      label: "Manage remediation",
      fields: [
        { name: "document", label: "Remediation action (SSM Automation document)", kind: "select", required: true, options: ssmAutomationOptions, help: "For example AWS-ConfigureS3BucketVersioning for s3-bucket-versioning-enabled." },
        { name: "resourceParam", label: "Resource ID parameter", kind: "text", required: true, default: "BucketName", help: "The document parameter that receives the noncompliant resource's ID." },
        { name: "role", label: "AutomationAssumeRole", kind: "select", options: roleOptions, help: "The role the automation runs as." },
        { name: "staticParams", label: "Other parameters (JSON)", kind: "json", placeholder: '{"VersioningState":["Enabled"]}', help: "Static values: parameter name to a list of strings." },
        { name: "automatic", label: "Automatic remediation", kind: "checkbox", default: false },
        { name: "retries", label: "Retries", kind: "number", default: 5, showIf: { field: "automatic", equals: true }, validate: { min: 1, max: 25, message: "Between 1 and 25." } },
        { name: "retrySeconds", label: "Seconds", kind: "number", default: 60, showIf: { field: "automatic", equals: true }, validate: { min: 1, max: 2678000, message: "Between 1 and 2678000." } },
      ],
      initialValues: remediationValues,
      async run(ctx, name, v) {
        const statics = parseJsonObject(str(v.staticParams), "Other parameters") ?? {};
        const parameters: Record<string, { ResourceValue?: { Value: ResourceValueType }; StaticValue?: { Values: string[] } }> = { [str(v.resourceParam)]: { ResourceValue: { Value: "RESOURCE_ID" } } };
        for (const [k, val] of Object.entries(statics)) parameters[k] = { StaticValue: { Values: Array.isArray(val) ? val.map(String) : [String(val)] } };
        if (str(v.role)) parameters.AutomationAssumeRole = { StaticValue: { Values: [str(v.role)] } };
        const auto = v.automatic === true;
        const r = await ctx.clients.config.send(
          new PutRemediationConfigurationsCommand({
            RemediationConfigurations: [{
              ConfigRuleName: name, TargetType: "SSM_DOCUMENT", TargetId: str(v.document), Parameters: parameters, Automatic: auto,
              MaximumAutomaticAttempts: auto && typeof v.retries === "number" ? v.retries : undefined, RetryAttemptSeconds: auto && typeof v.retrySeconds === "number" ? v.retrySeconds : undefined,
            }],
          })
        );
        if (r.FailedBatches?.length) throw new Error(r.FailedBatches.map((b) => b.FailureMessage ?? "Failed").join("; "));
        return { message: `Remediation action ${str(v.document)} saved${auto ? " (automatic)" : ""}.` };
      },
    },
    {
      id: "delete-remediation",
      label: "Delete remediation",
      danger: true,
      confirm: "Removes the remediation action from this rule.",
      availableFor: hasRemediation,
      async run(ctx, name) {
        await ctx.clients.config.send(new DeleteRemediationConfigurationCommand({ ConfigRuleName: name }));
        return { message: "Remediation action deleted." };
      },
    },
    {
      id: "noncompliant",
      label: "Remediate resources",
      availableFor: hasRemediation,
      async run(ctx, name) {
        const rows = (await evaluations(ctx, name)).filter((e) => e.ComplianceType === "NON_COMPLIANT").map(evalRow);
        return {
          message: "Noncompliant resources. Select resources to run the rule's remediation action on them.",
          table: { rowKey: "key", columns: EVAL_COLUMNS, rows, emptyText: "No noncompliant resources.", selectionAction: { actionId: "remediate", label: "Remediate", valuesField: "keys" } },
        };
      },
    },
    {
      id: "remediate",
      label: "Remediate",
      hidden: true,
      fields: [{ name: "keys", label: "Resources", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const keys = (Array.isArray(v.keys) ? (v.keys as string[]) : []).map(splitResourceKey);
        const r = await ctx.clients.config.send(new StartRemediationExecutionCommand({ ConfigRuleName: name, ResourceKeys: keys.map((k) => ({ resourceType: k.type as ResourceType, resourceId: k.id })) }));
        if (r.FailedItems?.length) throw new Error(`${r.FailureMessage ?? "Some resources failed"}: ${r.FailedItems.map((f) => f.resourceId).join(", ")}`);
        return { message: `Remediation started for ${keys.length} resource${keys.length === 1 ? "" : "s"}. See the Remediation executions tab.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      const rem = await ctx.clients.config.send(new DescribeRemediationConfigurationsCommand({ ConfigRuleNames: [name] }));
      if (rem.RemediationConfigurations?.length) await ctx.clients.config.send(new DeleteRemediationConfigurationCommand({ ConfigRuleName: name }));
      await ctx.clients.config.send(new DeleteConfigRuleCommand({ ConfigRuleName: name }));
    },
  },
};
