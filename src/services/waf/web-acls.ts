/** AWS WAF web ACLs (Regional and Global / CloudFront scopes): list, detail, the create wizard as one form, rules, associations, logging. */

import { secondary } from "../../console/secondary.ts";
import {
  AssociateWebACLCommand,
  CreateWebACLCommand,
  DeleteLoggingConfigurationCommand,
  DeleteWebACLCommand,
  DisassociateWebACLCommand,
  GetWebACLCommand,
  ListResourcesForWebACLCommand,
  PutLoggingConfigurationCommand,
  UpdateWebACLCommand,
  type ResourceType,
  type Rule,
} from "@aws-sdk/client-wafv2";
import { ListDistributionsByWebACLIdCommand } from "@aws-sdk/client-cloudfront";
import type { Ctx, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import {
  findSummary, listBothScopes, loggingDestinations, logDestinationOptions, managedGroupOptions, parseRef, protectableResources, refId, resourceKind, SCOPE_COLUMN, scopeField, scopeLabel, scopeOfArn,
  scopeValue, setOptionsBothScopes, tagRows, tagsAction, TAG_COLUMNS, toWafTags, wafFor, type Scope,
} from "./client.ts";
import { buildRule, metricName, parseCountryCodes, ruleRows, splitManagedId } from "./helpers.ts";
import { ruleActions } from "./rules.ts";

const WCU_LIMIT = 5000;
const RESOURCE_TYPES: ResourceType[] = ["APPLICATION_LOAD_BALANCER", "API_GATEWAY", "COGNITO_USER_POOL", "APPSYNC", "APP_RUNNER_SERVICE", "VERIFIED_ACCESS_INSTANCE"];
const NAME = "[\\w-]{1,128}";
const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function readAcl(ctx: Ctx, id: string) {
  const s = await findSummary(ctx, "webacl", id);
  const r = await wafFor(ctx, s.scope).send(new GetWebACLCommand({ Scope: s.scope, Name: s.Name, Id: s.Id }));
  if (!r.WebACL) throw new Error(`GetWebACL returned no web ACL for ${s.Name}.`);
  return { summary: s, acl: r.WebACL, lockToken: r.LockToken };
}

/** List rows carry "scope", detail summaries "Scope"; both start with "Global" for CloudFront. */
const isRegionalRow = (row: Row): boolean => !String(row.scope ?? row.Scope ?? "").startsWith("Global");

/** CloudFront distributions are attached to a web ACL from the distribution (its WebACLId), so read them from CloudFront. */
async function distributionArns(ctx: Ctx, aclArn: string): Promise<string[]> {
  const out: string[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.clients.cloudfront.send(new ListDistributionsByWebACLIdCommand({ WebACLId: aclArn, Marker: marker, MaxItems: 100 }));
    out.push(...(r.DistributionList?.Items ?? []).map((d) => d.ARN ?? d.Id ?? "").filter(Boolean));
    if (!r.DistributionList?.IsTruncated || !r.DistributionList.NextMarker) break;
    marker = r.DistributionList.NextMarker;
  }
  return out;
}

async function associatedArns(ctx: Ctx, arn: string): Promise<{ arns: string[]; errors: string[] }> {
  const arns: string[] = [];
  const errors: string[] = [];
  if (scopeOfArn(arn) === "CLOUDFRONT") {
    try {
      return { arns: await distributionArns(ctx, arn), errors };
    } catch (err: unknown) {
      return { arns, errors: [`CloudFront distributions: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }
  for (const type of RESOURCE_TYPES) {
    try {
      const r = await ctx.clients.wafv2.send(new ListResourcesForWebACLCommand({ WebACLArn: arn, ResourceType: type }));
      arns.push(...(r.ResourceArns ?? []));
    } catch (err: unknown) {
      errors.push(`${type}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { arns: [...new Set(arns)], errors };
}

function defaultActionLabel(a: { Allow?: unknown; Block?: unknown } | undefined): string {
  return a?.Block ? "Block" : a?.Allow ? "Allow" : "-";
}

function createRules(v: FieldValues): Rule[] {
  const rules: Rule[] = [];
  const add = (r: Rule) => rules.push(r);
  for (const id of Array.isArray(v.managedGroups) ? (v.managedGroups as string[]) : []) {
    const g = splitManagedId(id);
    add(buildRule({ kind: "managed", name: g.name, priority: rules.length, vendor: g.vendor, group: g.name, overrideToCount: false }));
  }
  if (v.addRate === true) {
    add(buildRule({ kind: "rate", name: "RateLimit", priority: rules.length, action: "Block", limit: typeof v.rateLimit === "number" ? v.rateLimit : 2000, windowSec: 300, aggregateKey: "IP" }));
  }
  if (str(v.ipSet) && scopeOfArn(str(v.ipSet)) !== scopeValue(v)) throw new Error("The IP set is in the other scope. A web ACL can only use IP sets from its own scope.");
  if (str(v.ipSet)) add(buildRule({ kind: "ipset", name: "IPSetRule", priority: rules.length, action: v.ipSetAction === "Allow" ? "Allow" : "Block", arn: str(v.ipSet) }));
  if (str(v.geoCountries)) add(buildRule({ kind: "geo", name: "GeoMatch", priority: rules.length, action: "Block", countryCodes: parseCountryCodes(str(v.geoCountries)) }));
  return rules;
}

export const webAcls: ResourceDef = {
  id: "web-acls",
  name: "Web ACLs",
  singular: "web ACL",
  idField: "id",
  nameField: "name",
  description: "Web ACLs in this Region (Regional: Application Load Balancers, API Gateway REST APIs and other regional resources) and Global ones for CloudFront distributions.",
  emptyText: "No web ACLs. Create a web ACL to protect a regional resource.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "wafId", label: "ID", kind: "text" },
    SCOPE_COLUMN,
    { key: "defaultAction", label: "Default action", kind: "text" },
    { key: "rules", label: "Rules", kind: "count" },
    { key: "capacity", label: "WCUs", kind: "count" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const items = await listBothScopes(ctx, "webacl");
    return Promise.all(
      items.map(async (s): Promise<Row> => {
        const scope: Scope = s.scope ?? "REGIONAL";
        // Default action, rules and WCUs need GetWebACL: if it's denied those cells say so instead of failing the list.
        const r = await secondary(wafFor(ctx, scope).send(new GetWebACLCommand({ Scope: scope, Name: s.Name, Id: s.Id })));
        const acl = r.ok ? r.value.WebACL : undefined;
        return {
          id: refId(scope, s.Id ?? ""), wafId: s.Id ?? "", scope: scopeLabel(scope, ctx.region), name: s.Name ?? "", description: s.Description || null, arn: s.ARN ?? null,
          defaultAction: r.ok ? defaultActionLabel(acl?.DefaultAction) : "Unavailable", rules: acl?.Rules?.length ?? null, capacity: acl?.Capacity ?? null,
        };
      })
    );
  },

  async get(ctx, id) {
    const { summary: s, acl } = await readAcl(ctx, id);
    const arn = acl.ARN ?? "";
    const [assoc, loggingR, tagsR] = await Promise.all([associatedArns(ctx, arn), secondary(loggingDestinations(ctx, arn)), secondary(tagRows(ctx, arn))]);
    const logging = loggingR.ok ? loggingR.value : [];
    return {
      summary: {
        Name: acl.Name, ID: acl.Id, ARN: arn, Description: acl.Description || "-",
        "Default action": defaultActionLabel(acl.DefaultAction),
        "Web ACL rule capacity units used": acl.Capacity === undefined ? null : `${acl.Capacity}/${WCU_LIMIT} WCUs`,
        Scope: scopeLabel(s.scope, ctx.region),
      },
      tabs: [
        {
          id: "rules", label: "Rules", kind: "table",
          description: "Rules run in priority order, lowest first. Requests that match no rule get the default action.",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "priority", label: "Priority", kind: "count" },
            { key: "type", label: "Type", kind: "text" },
            { key: "action", label: "Action", kind: "text" },
            { key: "statement", label: "Inspects", kind: "text" },
          ],
          data: ruleRows(acl.Rules),
          emptyText: "No rules. Use Actions to add a managed rule group or your own rule.",
        },
        {
          id: "resources", label: "Associated AWS resources", kind: "table",
          columns: [
            { key: "type", label: "Resource type", kind: "text" },
            { key: "arn", label: "ARN", kind: "arn" },
          ],
          data: assoc.arns.map((a) => ({ type: resourceKind(a), arn: a })),
          description: assoc.errors.length
            ? `Some resource types could not be listed: ${assoc.errors.join("; ")}`
            : s.scope === "CLOUDFRONT" ? "CloudFront distributions that use this web ACL (set from the distribution's settings in CloudFront)." : undefined,
          emptyText: s.scope === "CLOUDFRONT" ? "No CloudFront distributions use this web ACL." : "No associated resources. Use Actions > Associate AWS resource.",
        },
        {
          id: "logging", label: "Logging and metrics", kind: "keyvalue",
          description: loggingR.ok ? undefined : `Logging configuration unavailable: ${loggingR.error}`,
          data: {
            Logging: !loggingR.ok ? "Unavailable" : logging.length ? "Enabled" : "Disabled",
            "Logging destination": logging.length ? logging.join(", ") : null,
            "CloudWatch metric name": acl.VisibilityConfig?.MetricName ?? null,
            "CloudWatch metrics": acl.VisibilityConfig?.CloudWatchMetricsEnabled ? "Enabled" : "Disabled",
            "Sampled requests": acl.VisibilityConfig?.SampledRequestsEnabled ? "Enabled" : "Disabled",
            "Label namespace": acl.LabelNamespace ?? null,
          },
        },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagsR.ok ? tagsR.value : [], emptyText: tagsR.ok ? "No tags." : `Tags unavailable: ${tagsR.error}` },
        { id: "json", label: "Rules JSON", kind: "json", data: acl.Rules ?? [], description: "The rules exactly as GetWebACL returned them." },
      ],
    };
  },

  create: {
    title: "Create web ACL",
    description: "Creates the web ACL with CreateWebACL, then associates the Regional resources you choose. CloudFront distributions pick their web ACL in CloudFront. You can add more rules from the web ACL's Actions menu.",
    fields: [
      { ...scopeField("Web ACL details"), label: "Resource type" },
      { name: "name", label: "Name", kind: "text", required: true, section: "Web ACL details", placeholder: "my-web-acl", help: "Up to 128 characters: letters, numbers, hyphens and underscores. You can't change the name later.", validate: { pattern: NAME, message: "Use 1-128 letters, numbers, hyphens or underscores." } },
      { name: "description", label: "Description", kind: "text", section: "Web ACL details", validate: { pattern: "[\\w+=:#@/\\-,.][\\w+=:#@/\\-,.\\s]+[\\w+=:#@/\\-,.]", message: "At least 3 characters; letters, numbers, spaces and + = : # @ / - , . only." } },
      { name: "metricName", label: "CloudWatch metric name", kind: "text", section: "Web ACL details", help: "Defaults to the web ACL name.", validate: { pattern: NAME, message: "Use letters, numbers, hyphens or underscores." } },
      { name: "resources", label: "Associated AWS resources", kind: "multiselect", section: "Associated AWS resources", options: protectableResources, showIf: { field: "scope", equals: "REGIONAL" }, help: "Application Load Balancers and API Gateway REST API stages in this Region." },
      { name: "managedGroups", label: "Add managed rule groups", kind: "multiselect", section: "Rules", options: (ctx) => managedGroupOptions(ctx), help: "Each group becomes a rule that uses the group's own rule actions. Watch the capacity: a web ACL can use up to 5,000 WCUs." },
      { name: "addRate", label: "Add a rate-based rule (Block)", kind: "checkbox", default: false, section: "Rules" },
      { name: "rateLimit", label: "Rate limit (requests per 5 minutes per IP)", kind: "number", default: 2000, section: "Rules", showIf: { field: "addRate", equals: true }, validate: { min: 10, max: 2000000000, message: "Between 10 and 2,000,000,000." } },
      { name: "ipSet", label: "IP set rule", kind: "select", section: "Rules", options: (ctx) => setOptionsBothScopes(ctx, "ipset"), help: "Adds a rule that matches source IPs in the set. Choose a set from the web ACL's scope." },
      { name: "ipSetAction", label: "IP set rule action", kind: "radio", default: "Block", section: "Rules", options: [{ value: "Allow", label: "Allow" }, { value: "Block", label: "Block" }] },
      { name: "geoCountries", label: "Block countries", kind: "text", section: "Rules", placeholder: "CN, RU", help: "Adds a geo match rule that blocks these two-letter country codes." },
      { name: "defaultAction", label: "Default web ACL action for requests that don't match any rules", kind: "radio", default: "Allow", section: "Default action", options: [{ value: "Allow", label: "Allow" }, { value: "Block", label: "Block" }] },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = str(v.name);
      const scope = scopeValue(v);
      const w = wafFor(ctx, scope);
      const r = await w.send(
        new CreateWebACLCommand({
          Scope: scope, Name: name, Description: str(v.description) || undefined,
          DefaultAction: v.defaultAction === "Block" ? { Block: {} } : { Allow: {} },
          Rules: createRules(v),
          VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: str(v.metricName) || metricName(name) },
          Tags: toWafTags(v.tags),
        })
      );
      const arn = r.Summary?.ARN;
      const id = r.Summary?.Id;
      if (!arn || !id) throw new Error("CreateWebACL returned no ARN or ID.");
      if (scope === "REGIONAL") {
        for (const res of Array.isArray(v.resources) ? (v.resources as string[]) : []) {
          await w.send(new AssociateWebACLCommand({ WebACLArn: arn, ResourceArn: res }));
        }
      }
      return refId(scope, id);
    },
  },

  actions: [
    ...ruleActions("webacl"),
    {
      id: "default-action",
      label: "Edit default action",
      fields: [{ name: "defaultAction", label: "Default action", kind: "radio", required: true, default: "Allow", options: [{ value: "Allow", label: "Allow" }, { value: "Block", label: "Block" }] }],
      async initialValues(ctx, id) {
        const { acl } = await readAcl(ctx, id);
        return { defaultAction: acl.DefaultAction?.Block ? "Block" : "Allow" };
      },
      async run(ctx, id, v) {
        const { summary, acl, lockToken } = await readAcl(ctx, id);
        if (!acl.VisibilityConfig) throw new Error("GetWebACL returned no visibility configuration.");
        const want = v.defaultAction === "Block" ? "Block" : "Allow";
        if (defaultActionLabel(acl.DefaultAction) === want) return { message: `Default action is already ${want}. Nothing changed.` };
        await wafFor(ctx, summary.scope).send(
          new UpdateWebACLCommand({
            Scope: summary.scope, Name: summary.Name, Id: summary.Id, LockToken: lockToken, Description: acl.Description || undefined,
            DefaultAction: want === "Block" ? { Block: {} } : { Allow: {} }, Rules: acl.Rules ?? [], VisibilityConfig: acl.VisibilityConfig,
            CustomResponseBodies: acl.CustomResponseBodies, CaptchaConfig: acl.CaptchaConfig, ChallengeConfig: acl.ChallengeConfig, TokenDomains: acl.TokenDomains, AssociationConfig: acl.AssociationConfig,
          })
        );
        return { message: `Default action is now ${want}.` };
      },
    },
    {
      id: "associate",
      label: "Associate AWS resource",
      availableFor: isRegionalRow,
      fields: [{ name: "resource", label: "Resource", kind: "select", required: true, options: protectableResources, help: "A resource can be associated with only one web ACL." }],
      async run(ctx, id, v) {
        const { summary, acl } = await readAcl(ctx, id);
        await wafFor(ctx, summary.scope).send(new AssociateWebACLCommand({ WebACLArn: acl.ARN, ResourceArn: str(v.resource) }));
        return { message: `Associated ${str(v.resource)} with ${acl.Name}.` };
      },
    },
    {
      id: "associations",
      label: "Disassociate AWS resources",
      availableFor: isRegionalRow,
      async run(ctx, id) {
        const { acl } = await readAcl(ctx, id);
        const { arns, errors } = await associatedArns(ctx, acl.ARN ?? "");
        return {
          message: errors.length ? `Select the resources to disassociate. Some resource types could not be listed: ${errors.join("; ")}` : "Select the resources to disassociate.",
          table: {
            rowKey: "arn",
            emptyText: "No associated resources.",
            columns: [{ key: "type", label: "Resource type", kind: "text" }, { key: "arn", label: "ARN", kind: "arn" }],
            rows: arns.map((a) => ({ type: resourceKind(a), arn: a })),
            selectionAction: { actionId: "disassociate", label: "Disassociate", danger: true, valuesField: "arns" },
          },
        };
      },
    },
    {
      id: "disassociate",
      label: "Disassociate",
      hidden: true,
      danger: true,
      fields: [{ name: "arns", label: "Resources", kind: "multiselect", required: true }],
      async run(ctx, id, v) {
        const arns = Array.isArray(v.arns) ? (v.arns as string[]) : [];
        const w = wafFor(ctx, parseRef(id).scope);
        for (const a of arns) await w.send(new DisassociateWebACLCommand({ ResourceArn: a }));
        return { message: `Disassociated ${arns.length} resource${arns.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "enable-logging",
      label: "Enable logging",
      fields: [{ name: "destination", label: "Logging destination", kind: "select", required: true, options: (ctx, id) => logDestinationOptions(ctx, parseRef(id ?? "").scope), help: "WAF only logs to destinations whose names start with aws-waf-logs-: a CloudWatch Logs log group or an S3 bucket. Global (CloudFront) web ACLs log to log groups in us-east-1." }],
      async run(ctx, id, v) {
        const { summary, acl } = await readAcl(ctx, id);
        await wafFor(ctx, summary.scope).send(new PutLoggingConfigurationCommand({ LoggingConfiguration: { ResourceArn: acl.ARN, LogDestinationConfigs: [str(v.destination)] } }));
        return { message: `Logging enabled to ${str(v.destination)}.` };
      },
    },
    {
      id: "disable-logging",
      label: "Disable logging",
      confirm: "Stops sending this web ACL's traffic logs to its logging destination.",
      async run(ctx, id) {
        const { summary, acl } = await readAcl(ctx, id);
        await wafFor(ctx, summary.scope).send(new DeleteLoggingConfigurationCommand({ ResourceArn: acl.ARN }));
        return { message: "Logging disabled." };
      },
    },
    tagsAction("webacl"),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { summary, lockToken } = await readAcl(ctx, id);
      await wafFor(ctx, summary.scope).send(new DeleteWebACLCommand({ Scope: summary.scope, Name: summary.Name, Id: summary.Id, LockToken: lockToken }));
    },
  },
};
