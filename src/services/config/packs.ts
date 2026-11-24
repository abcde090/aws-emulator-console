/** AWS Config conformance packs, aggregators and advanced queries. */

import {
  DeleteConfigurationAggregatorCommand,
  DeleteConformancePackCommand,
  DeleteStoredQueryCommand,
  DescribeAggregateComplianceByConfigRulesCommand,
  DescribeConfigurationAggregatorsCommand,
  DescribeConfigurationAggregatorSourcesStatusCommand,
  DescribeConformancePackComplianceCommand,
  DescribeConformancePacksCommand,
  DescribeConformancePackStatusCommand,
  GetAggregateDiscoveredResourceCountsCommand,
  GetConformancePackComplianceSummaryCommand,
  GetStoredQueryCommand,
  ListStoredQueriesCommand,
  PutConfigurationAggregatorCommand,
  PutConformancePackCommand,
  PutStoredQueryCommand,
  SelectAggregateResourceConfigCommand,
  SelectResourceConfigCommand,
  type ConfigurationAggregator,
  type StoredQueryMetadata,
} from "@aws-sdk/client-config-service";
import type { ActionResult, Ctx, Option, ResourceDef } from "../../console/types.ts";
import { complianceLabel, queryRows } from "./helpers.ts";
import { bucketOptions, str } from "./settings.ts";

const SAMPLE_TEMPLATE = `Resources:
  S3BucketVersioningEnabled:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: s3-bucket-versioning-enabled
      Source:
        Owner: AWS
        SourceIdentifier: S3_BUCKET_VERSIONING_ENABLED
  S3BucketServerSideEncryptionEnabled:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: s3-bucket-server-side-encryption-enabled
      Source:
        Owner: AWS
        SourceIdentifier: S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED
`;

async function allAggregators(ctx: Ctx): Promise<ConfigurationAggregator[]> {
  const out: ConfigurationAggregator[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.config.send(new DescribeConfigurationAggregatorsCommand({ NextToken: token }));
    out.push(...(r.ConfigurationAggregators ?? []));
    token = r.NextToken || undefined;
  } while (token);
  return out;
}

async function allStoredQueries(ctx: Ctx): Promise<StoredQueryMetadata[]> {
  const out: StoredQueryMetadata[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.config.send(new ListStoredQueriesCommand({ MaxResults: 100, NextToken: token }));
    out.push(...(r.StoredQueryMetadata ?? []));
    token = r.NextToken || undefined;
  } while (token);
  return out;
}

export const conformancePacks: ResourceDef = {
  id: "conformance-packs",
  name: "Conformance packs",
  singular: "conformance pack",
  idField: "name",
  nameField: "name",
  description: "Collections of Config rules and remediation actions deployed together from a template.",
  emptyText: "No conformance packs.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "state", label: "Deployment status", kind: "status" },
    { key: "compliance", label: "Compliance", kind: "status" },
    { key: "updated", label: "Last update requested", kind: "date" },
  ],
  async list(ctx) {
    const [packs, status] = await Promise.all([ctx.clients.config.send(new DescribeConformancePacksCommand({})), ctx.clients.config.send(new DescribeConformancePackStatusCommand({}))]);
    const names = (packs.ConformancePackDetails ?? []).map((p) => p.ConformancePackName ?? "").filter(Boolean);
    const summary = names.length ? await ctx.clients.config.send(new GetConformancePackComplianceSummaryCommand({ ConformancePackNames: names.slice(0, 5) })) : null;
    return (packs.ConformancePackDetails ?? []).map((p) => ({
      name: p.ConformancePackName ?? "", state: status.ConformancePackStatusDetails?.find((s) => s.ConformancePackName === p.ConformancePackName)?.ConformancePackState ?? null,
      compliance: complianceLabel(summary?.ConformancePackComplianceSummaryList?.find((s) => s.ConformancePackName === p.ConformancePackName)?.ConformancePackComplianceStatus, undefined),
      updated: p.LastUpdateRequestedTime ?? null,
    }));
  },
  async get(ctx, name) {
    const [packs, status, compliance] = await Promise.all([
      ctx.clients.config.send(new DescribeConformancePacksCommand({ ConformancePackNames: [name] })),
      ctx.clients.config.send(new DescribeConformancePackStatusCommand({ ConformancePackNames: [name] })),
      ctx.clients.config.send(new DescribeConformancePackComplianceCommand({ ConformancePackName: name })),
    ]);
    const p = packs.ConformancePackDetails?.[0];
    const s = status.ConformancePackStatusDetails?.[0];
    return {
      summary: { Name: p?.ConformancePackName, ARN: p?.ConformancePackArn ?? null, "Deployment status": s?.ConformancePackState ?? null, "Status reason": s?.ConformancePackStatusReason ?? null, "Stack ARN": s?.StackArn ?? null, "Delivery S3 bucket": p?.DeliveryS3Bucket ?? null },
      tabs: [
        {
          id: "rules", label: "Rules", kind: "table",
          columns: [{ key: "rule", label: "Rule", kind: "text" }, { key: "compliance", label: "Compliance", kind: "status" }, { key: "controls", label: "Controls", kind: "text" }],
          data: (compliance.ConformancePackRuleComplianceList ?? []).map((r) => ({ rule: r.ConfigRuleName ?? "", compliance: complianceLabel(r.ComplianceType, undefined), controls: (r.Controls ?? []).join(", ") || null })),
          emptyText: "No rules reported yet.",
        },
        { id: "parameters", label: "Parameters", kind: "table", columns: [{ key: "ParameterName", label: "Name", kind: "text" }, { key: "ParameterValue", label: "Value", kind: "text" }], data: p?.ConformancePackInputParameters ?? [], emptyText: "No input parameters." },
      ],
    };
  },
  create: {
    title: "Deploy conformance pack",
    description: "Deploys a conformance pack from a template with PutConformancePack.",
    fields: [
      { name: "name", label: "Conformance pack name", kind: "text", required: true, section: "Pack details", validate: { pattern: "[a-zA-Z][-a-zA-Z0-9]{0,255}", message: "Start with a letter; letters, numbers and hyphens." } },
      { name: "template", label: "Template (YAML or JSON)", kind: "textarea", required: true, default: SAMPLE_TEMPLATE, section: "Template", help: "Each AWS::Config::ConfigRule resource becomes a rule. The example deploys two S3 rules." },
      { name: "bucket", label: "Delivery S3 bucket", kind: "select", section: "Pack details", options: bucketOptions },
      { name: "parameters", label: "Parameters", kind: "textarea", section: "Pack details", placeholder: "Name=Value, one per line" },
    ],
    async run(ctx, v) {
      const params = str(v.parameters).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf("=");
        if (i <= 0) throw new Error(`"${l}" is not Name=Value.`);
        return { ParameterName: l.slice(0, i).trim(), ParameterValue: l.slice(i + 1).trim() };
      });
      await ctx.clients.config.send(new PutConformancePackCommand({ ConformancePackName: str(v.name), TemplateBody: str(v.template), DeliveryS3Bucket: str(v.bucket) || undefined, ConformancePackInputParameters: params.length ? params : undefined }));
      return str(v.name);
    },
  },
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.config.send(new DeleteConformancePackCommand({ ConformancePackName: name }));
    },
  },
};

export const aggregators: ResourceDef = {
  id: "aggregators",
  name: "Aggregators",
  singular: "aggregator",
  idField: "name",
  nameField: "name",
  description: "Aggregators collect configuration and compliance data from multiple accounts and Regions.",
  emptyText: "No aggregators.",
  columns: [
    { key: "name", label: "Aggregator name", kind: "link" },
    { key: "source", label: "Source type", kind: "text" },
    { key: "accounts", label: "Accounts", kind: "text" },
    { key: "regions", label: "Regions", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
  ],
  async list(ctx) {
    return (await allAggregators(ctx)).map((a) => {
      const src = a.AccountAggregationSources?.[0];
      return {
        name: a.ConfigurationAggregatorName ?? "", source: a.OrganizationAggregationSource ? "Organization" : "Individual accounts",
        accounts: (src?.AccountIds ?? []).join(", ") || null, regions: src?.AllAwsRegions || a.OrganizationAggregationSource?.AllAwsRegions ? "All Regions" : (src?.AwsRegions ?? []).join(", ") || null, created: a.CreationTime ?? null,
      };
    });
  },
  async get(ctx, name) {
    const [aggs, status, counts, compliance] = await Promise.all([
      ctx.clients.config.send(new DescribeConfigurationAggregatorsCommand({ ConfigurationAggregatorNames: [name] })),
      ctx.clients.config.send(new DescribeConfigurationAggregatorSourcesStatusCommand({ ConfigurationAggregatorName: name })),
      ctx.clients.config.send(new GetAggregateDiscoveredResourceCountsCommand({ ConfigurationAggregatorName: name, GroupByKey: "RESOURCE_TYPE" })),
      ctx.clients.config.send(new DescribeAggregateComplianceByConfigRulesCommand({ ConfigurationAggregatorName: name })),
    ]);
    const a = aggs.ConfigurationAggregators?.[0];
    return {
      summary: { "Aggregator name": a?.ConfigurationAggregatorName, ARN: a?.ConfigurationAggregatorArn ?? null, "Total discovered resources": counts.TotalDiscoveredResources ?? null, Created: a?.CreationTime ?? null, "Last updated": a?.LastUpdatedTime ?? null },
      tabs: [
        { id: "counts", label: "Resources", kind: "table", columns: [{ key: "GroupName", label: "Resource type", kind: "text" }, { key: "ResourceCount", label: "Count", kind: "count" }], data: counts.GroupedResourceCounts ?? [], emptyText: "No grouped counts returned." },
        {
          id: "rules", label: "Rules", kind: "table",
          columns: [{ key: "rule", label: "Rule", kind: "text" }, { key: "compliance", label: "Compliance", kind: "status" }, { key: "account", label: "Account", kind: "text" }, { key: "region", label: "Region", kind: "text" }],
          data: (compliance.AggregateComplianceByConfigRules ?? []).map((c) => ({ rule: c.ConfigRuleName ?? "", compliance: complianceLabel(c.Compliance?.ComplianceType, c.Compliance?.ComplianceContributorCount?.CappedCount), account: c.AccountId ?? null, region: c.AwsRegion ?? null })),
          emptyText: "No rules aggregated.",
        },
        {
          id: "sources", label: "Source status", kind: "table",
          columns: [{ key: "SourceId", label: "Source", kind: "text" }, { key: "AwsRegion", label: "Region", kind: "text" }, { key: "LastUpdateStatus", label: "Status", kind: "status" }, { key: "LastUpdateTime", label: "Updated", kind: "date" }],
          data: status.AggregatedSourceStatusList ?? [], emptyText: "No source status reported.",
        },
        { id: "json", label: "Sources", kind: "json", data: a?.AccountAggregationSources ?? a?.OrganizationAggregationSource ?? null },
      ],
    };
  },
  create: {
    title: "Create aggregator",
    description: "Creates an account-based aggregator with PutConfigurationAggregator. Source accounts other than this one must authorize it.",
    fields: [
      { name: "name", label: "Aggregator name", kind: "text", required: true, validate: { pattern: "[\\w-]{1,256}", message: "Letters, numbers, hyphens or underscores." } },
      { name: "accounts", label: "Source account IDs", kind: "text", required: true, default: "", placeholder: "111122223333, 444455556666", help: "12-digit account IDs separated by commas. Include this account to aggregate its own data." },
      { name: "allRegions", label: "Include all current and future AWS Regions", kind: "checkbox", default: true },
      { name: "regions", label: "Regions", kind: "text", placeholder: "us-east-1, eu-west-1", showIf: { field: "allRegions", equals: false } },
    ],
    async run(ctx, v) {
      const accounts = str(v.accounts).split(/[\s,]+/).filter(Boolean);
      const bad = accounts.find((a) => !/^\d{12}$/.test(a));
      if (bad || accounts.length === 0) throw new Error(bad ? `"${bad}" is not a 12-digit account ID.` : "Enter at least one account ID.");
      const all = v.allRegions === true;
      const regions = str(v.regions).split(/[\s,]+/).filter(Boolean);
      if (!all && regions.length === 0) throw new Error("Enter at least one Region, or include all Regions.");
      await ctx.clients.config.send(new PutConfigurationAggregatorCommand({ ConfigurationAggregatorName: str(v.name), AccountAggregationSources: [{ AccountIds: accounts, AllAwsRegions: all, AwsRegions: all ? undefined : regions }] }));
      return str(v.name);
    },
  },
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.config.send(new DeleteConfigurationAggregatorCommand({ ConfigurationAggregatorName: name }));
    },
  },
};

async function aggregatorOptions(ctx: Ctx): Promise<Option[]> {
  return (await allAggregators(ctx)).filter((a) => a.ConfigurationAggregatorName).map((a) => ({ value: a.ConfigurationAggregatorName as string, label: a.ConfigurationAggregatorName as string }));
}

async function runQuery(ctx: Ctx, expression: string, aggregator: string): Promise<ActionResult> {
  const r = aggregator
    ? await ctx.clients.config.send(new SelectAggregateResourceConfigCommand({ Expression: expression, ConfigurationAggregatorName: aggregator, Limit: 100 }))
    : await ctx.clients.config.send(new SelectResourceConfigCommand({ Expression: expression, Limit: 100 }));
  const { columns, rows } = queryRows(r.Results);
  return {
    message: `${rows.length} result${rows.length === 1 ? "" : "s"}${r.NextToken ? " (first 100)" : ""}.`,
    table: { rowKey: "__row", columns: columns.map((c) => ({ key: c, label: c, kind: "text" as const })), rows: rows.map((row, i) => ({ ...row, __row: String(i) })), emptyText: "The query returned no results." },
  };
}

export const queries: ResourceDef = {
  id: "advanced-queries",
  name: "Advanced queries",
  singular: "query",
  idField: "name",
  nameField: "name",
  description: "Saved SQL SELECT queries over the current configuration of your resources. Open a query and choose Run.",
  emptyText: "No saved queries. Create one, for example SELECT resourceId, resourceType WHERE resourceType = 'AWS::S3::Bucket'.",
  columns: [
    { key: "name", label: "Query name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await allStoredQueries(ctx)).map((q) => ({ name: q.QueryName ?? "", description: q.Description ?? null, arn: q.QueryArn ?? null }));
  },
  async get(ctx, name) {
    const r = await ctx.clients.config.send(new GetStoredQueryCommand({ QueryName: name }));
    return {
      summary: { "Query name": r.StoredQuery?.QueryName, Description: r.StoredQuery?.Description ?? null, ARN: r.StoredQuery?.QueryArn ?? null },
      tabs: [{ id: "expression", label: "Query", kind: "text", data: r.StoredQuery?.Expression ?? "" }],
    };
  },
  create: {
    title: "Save query",
    description: "Saves a query with PutStoredQuery. Open it to run it against this account or an aggregator.",
    fields: [
      { name: "name", label: "Query name", kind: "text", required: true, validate: { pattern: "[a-zA-Z0-9_-]{1,64}", message: "Up to 64 letters, numbers, hyphens or underscores." } },
      { name: "description", label: "Description", kind: "text" },
      { name: "expression", label: "Query", kind: "textarea", required: true, default: "SELECT\n  resourceId,\n  resourceName,\n  resourceType,\n  awsRegion\nWHERE\n  resourceType = 'AWS::S3::Bucket'" },
    ],
    async run(ctx, v) {
      await ctx.clients.config.send(new PutStoredQueryCommand({ StoredQuery: { QueryName: str(v.name), Description: str(v.description) || undefined, Expression: str(v.expression) } }));
      return str(v.name);
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit query",
      fields: [
        { name: "description", label: "Description", kind: "text" },
        { name: "expression", label: "Query", kind: "textarea", required: true },
      ],
      async initialValues(ctx, name) {
        const q = (await ctx.clients.config.send(new GetStoredQueryCommand({ QueryName: name }))).StoredQuery;
        return { description: q?.Description ?? "", expression: q?.Expression ?? "" };
      },
      async run(ctx, name, v) {
        const q = (await ctx.clients.config.send(new GetStoredQueryCommand({ QueryName: name }))).StoredQuery;
        const description = str(v.description);
        const expression = str(v.expression);
        if (description === (q?.Description ?? "") && expression === (q?.Expression ?? "")) return { message: "No changes to save." };
        await ctx.clients.config.send(new PutStoredQueryCommand({ StoredQuery: { QueryId: q?.QueryId, QueryName: name, Description: description || undefined, Expression: expression } }));
        return { message: "Query saved." };
      },
    },
    {
      id: "run",
      label: "Run",
      fields: [{ name: "aggregator", label: "Query scope", kind: "select", options: aggregatorOptions, help: "Leave empty to query this account and Region; choose an aggregator to query its accounts." }],
      async run(ctx, name, v) {
        const q = await ctx.clients.config.send(new GetStoredQueryCommand({ QueryName: name }));
        if (!q.StoredQuery?.Expression) throw new Error("The stored query has no expression.");
        return runQuery(ctx, q.StoredQuery.Expression, str(v.aggregator));
      },
    },
    {
      id: "run-adhoc",
      label: "Run a different query",
      fields: [
        { name: "expression", label: "Query", kind: "textarea", required: true, default: "SELECT resourceType, COUNT(*) GROUP BY resourceType" },
        { name: "aggregator", label: "Query scope", kind: "select", options: aggregatorOptions },
      ],
      async run(ctx, _name, v) {
        return runQuery(ctx, str(v.expression), str(v.aggregator));
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.config.send(new DeleteStoredQueryCommand({ QueryName: name }));
    },
  },
};
