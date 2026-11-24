/**
 * AWS WAF lookups shared by the web ACL, rule group and set screens. Two scopes, as in the
 * real console: Regional (this Region) and Global (CloudFront, whose WAF API lives in
 * us-east-1). WAF calls need name + id + lock token, so the console's URL id is resolved
 * through the list calls. URL ids are the resource Id for Regional resources and
 * "global:<Id>" for CloudFront ones (see refId / parseRef).
 */

import {
  ListAvailableManagedRuleGroupsCommand,
  ListIPSetsCommand,
  ListLoggingConfigurationsCommand,
  ListRegexPatternSetsCommand,
  ListRuleGroupsCommand,
  ListTagsForResourceCommand,
  ListWebACLsCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type ManagedRuleGroupSummary,
  type Tag as WafTag,
} from "@aws-sdk/client-wafv2";
import { DescribeLoadBalancersCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { GetRestApisCommand, GetStagesCommand } from "@aws-sdk/client-api-gateway";
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import type { WAFV2Client } from "@aws-sdk/client-wafv2";
import type { ActionDef, ColumnDef, Ctx, FieldDef, FieldValues, Option, Row, Tag } from "../../console/types.ts";
import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";

export type Scope = "REGIONAL" | "CLOUDFRONT";
export const SCOPES: readonly Scope[] = ["REGIONAL", "CLOUDFRONT"];
/** CloudFront-scope WAF resources are managed through us-east-1. */
export const CLOUDFRONT_REGION = "us-east-1";
const GLOBAL_PREFIX = "global:";

export interface Ref {
  scope: Scope;
  id: string;
}

/** The console's URL id for a WAF resource Id in a scope. */
export function refId(scope: Scope, id: string): string {
  return scope === "CLOUDFRONT" ? `${GLOBAL_PREFIX}${id}` : id;
}

export function parseRef(id: string): Ref {
  return id.startsWith(GLOBAL_PREFIX) ? { scope: "CLOUDFRONT", id: id.slice(GLOBAL_PREFIX.length) } : { scope: "REGIONAL", id };
}

/** WAF ARNs name their scope: ...:regional/ipset/... or ...:global/ipset/... */
export function scopeOfArn(arn: string): Scope {
  return /:global\//.test(arn) ? "CLOUDFRONT" : "REGIONAL";
}

export function scopeLabel(scope: Scope, region: string): string {
  return scope === "CLOUDFRONT" ? "Global (CloudFront)" : `Regional (${region})`;
}

/** The permission-checked WAFV2 client for a scope. */
export function wafFor(ctx: Ctx, scope: Scope): WAFV2Client {
  return scope === "CLOUDFRONT" ? ctx.clientsIn(CLOUDFRONT_REGION).wafv2 : ctx.clients.wafv2;
}

export interface Summary {
  scope?: Scope;
  Name?: string;
  Id?: string;
  Description?: string;
  ARN?: string;
  LockToken?: string;
}

type Kind = "webacl" | "ipset" | "regex" | "rulegroup";

async function listPage(ctx: Ctx, kind: Kind, scope: Scope, marker: string | undefined): Promise<{ items: Summary[]; next?: string }> {
  const w = wafFor(ctx, scope);
  const base = { Scope: scope, Limit: 100, NextMarker: marker };
  switch (kind) {
    case "webacl": {
      const r = await w.send(new ListWebACLsCommand(base));
      return { items: r.WebACLs ?? [], next: r.NextMarker };
    }
    case "ipset": {
      const r = await w.send(new ListIPSetsCommand(base));
      return { items: r.IPSets ?? [], next: r.NextMarker };
    }
    case "regex": {
      const r = await w.send(new ListRegexPatternSetsCommand(base));
      return { items: r.RegexPatternSets ?? [], next: r.NextMarker };
    }
    case "rulegroup": {
      const r = await w.send(new ListRuleGroupsCommand(base));
      return { items: r.RuleGroups ?? [], next: r.NextMarker };
    }
  }
}

/** Every summary of one kind in one scope. WAF returns a NextMarker even on the last page, so stop on a short page. */
export async function listAll(ctx: Ctx, kind: Kind, scope: Scope = "REGIONAL"): Promise<Summary[]> {
  const out: Summary[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await listPage(ctx, kind, scope, marker);
    out.push(...page.items.map((x) => ({ ...x, scope })));
    if (!page.next || page.items.length < 100) break;
    marker = page.next;
  }
  return out;
}

/** Every summary of one kind in both scopes (Regional first, then Global / CloudFront). */
export async function listBothScopes(ctx: Ctx, kind: Kind): Promise<Summary[]> {
  const [regional, global] = await Promise.all(SCOPES.map((scope) => listAll(ctx, kind, scope)));
  return [...regional, ...global];
}

const KIND_NAME: Record<Kind, string> = { webacl: "web ACL", ipset: "IP set", regex: "regex pattern set", rulegroup: "rule group" };

/** Resolves a console URL id ("<Id>" or "global:<Id>") to the resource's summary. */
export async function findSummary(ctx: Ctx, kind: Kind, urlId: string): Promise<Summary & { Name: string; Id: string; scope: Scope }> {
  const ref = parseRef(urlId);
  const found = (await listAll(ctx, kind, ref.scope)).find((s) => s.Id === ref.id);
  if (!found?.Name || !found.Id) throw new Error(`WAFNonexistentItemException: No ${KIND_NAME[kind]} with ID ${ref.id} in the ${scopeLabel(ref.scope, ctx.region)} scope.`);
  return { ...found, Name: found.Name, Id: found.Id, scope: ref.scope };
}

/** IP sets / regex pattern sets in one scope (a rule can only reference sets in its own scope). */
export async function setOptions(ctx: Ctx, kind: "ipset" | "regex", scope: Scope = "REGIONAL"): Promise<Option[]> {
  return (await listAll(ctx, kind, scope)).filter((s) => s.ARN && s.Name).map((s) => ({ value: s.ARN as string, label: s.Name as string }));
}

/** Sets in both scopes, labelled with their scope (for the create form, before a scope is chosen). */
export async function setOptionsBothScopes(ctx: Ctx, kind: "ipset" | "regex"): Promise<Option[]> {
  return (await listBothScopes(ctx, kind))
    .filter((s) => s.ARN && s.Name)
    .map((s) => ({ value: s.ARN as string, label: `${s.Name as string} (${s.scope === "CLOUDFRONT" ? "Global" : "Regional"})` }));
}

export async function managedGroups(ctx: Ctx, scope: Scope = "REGIONAL"): Promise<ManagedRuleGroupSummary[]> {
  const out: ManagedRuleGroupSummary[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await wafFor(ctx, scope).send(new ListAvailableManagedRuleGroupsCommand({ Scope: scope, Limit: 100, NextMarker: marker }));
    const items = r.ManagedRuleGroups ?? [];
    out.push(...items);
    if (!r.NextMarker || items.length < 100) break;
    marker = r.NextMarker;
  }
  return out;
}

export async function managedGroupOptions(ctx: Ctx, scope: Scope = "REGIONAL"): Promise<Option[]> {
  return (await managedGroups(ctx, scope))
    .filter((g) => g.VendorName && g.Name)
    .map((g) => ({ value: `${g.VendorName}:${g.Name}`, label: `${g.Name} (${g.VendorName})` }));
}

export async function tagRows(ctx: Ctx, arn: string | undefined): Promise<Row[]> {
  if (!arn) return [];
  const r = await wafFor(ctx, scopeOfArn(arn)).send(new ListTagsForResourceCommand({ ResourceARN: arn }));
  return (r.TagInfoForResource?.TagList ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

export function toWafTags(v: unknown): WafTag[] | undefined {
  const tags = Array.isArray(v) ? (v as Tag[]) : [];
  return tags.length ? tags.map((t) => ({ Key: t.Key, Value: t.Value })) : undefined;
}

export async function loggingDestinations(ctx: Ctx, arn: string): Promise<string[]> {
  const scope = scopeOfArn(arn);
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await wafFor(ctx, scope).send(new ListLoggingConfigurationsCommand({ Scope: scope, Limit: 100, NextMarker: marker }));
    const items = r.LoggingConfigurations ?? [];
    const hit = items.find((c) => c.ResourceArn === arn);
    if (hit) return hit.LogDestinationConfigs ?? [];
    if (!r.NextMarker || items.length < 100) break;
    marker = r.NextMarker;
  }
  return [];
}

/** Application Load Balancers and API Gateway REST API stages a regional web ACL can protect. */
export async function protectableResources(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const lbs = await ctx.clients.elbv2.send(new DescribeLoadBalancersCommand({ Marker: marker }));
    for (const lb of lbs.LoadBalancers ?? []) {
      if (lb.Type === "application" && lb.LoadBalancerArn) out.push({ value: lb.LoadBalancerArn, label: `Application Load Balancer: ${lb.LoadBalancerName ?? lb.LoadBalancerArn}` });
    }
    marker = lbs.NextMarker;
  } while (marker);
  const apiItems: { id?: string; name?: string }[] = [];
  let position: string | undefined;
  do {
    const apis = await ctx.clients.apigateway.send(new GetRestApisCommand({ limit: 500, position }));
    apiItems.push(...(apis.items ?? []));
    position = apis.position;
  } while (position);
  for (const api of apiItems) {
    if (!api.id) continue;
    const stages = await ctx.clients.apigateway.send(new GetStagesCommand({ restApiId: api.id }));
    for (const s of stages.item ?? []) {
      if (s.stageName) out.push({ value: `arn:aws:apigateway:${ctx.region}::/restapis/${api.id}/stages/${s.stageName}`, label: `API Gateway REST API: ${api.name ?? api.id} - ${s.stageName}` });
    }
  }
  return out;
}

/** WAF log destinations must be named aws-waf-logs-*: CloudWatch Logs log groups or S3 buckets. */
export async function logDestinationOptions(ctx: Ctx, scope: Scope = "REGIONAL"): Promise<Option[]> {
  const out: Option[] = [];
  const region = scope === "CLOUDFRONT" ? CLOUDFRONT_REGION : ctx.region;
  const logs = scope === "CLOUDFRONT" ? ctx.clientsIn(CLOUDFRONT_REGION).logs : ctx.clients.logs;
  let token: string | undefined;
  do {
    const groups = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: "aws-waf-logs-", nextToken: token }));
    for (const g of groups.logGroups ?? []) {
      if (g.logGroupName) out.push({ value: `arn:aws:logs:${region}:${ctx.accountId}:log-group:${g.logGroupName}`, label: `CloudWatch Logs log group: ${g.logGroupName}` });
    }
    token = groups.nextToken;
  } while (token);
  const buckets = await ctx.clients.s3.send(new ListBucketsCommand({}));
  for (const b of buckets.Buckets ?? []) {
    if (b.Name?.startsWith("aws-waf-logs-")) out.push({ value: `arn:aws:s3:::${b.Name}`, label: `S3 bucket: ${b.Name}` });
  }
  return out;
}

export function resourceKind(arn: string): string {
  if (arn.includes(":elasticloadbalancing:")) return "Application Load Balancer";
  if (arn.includes(":apigateway:")) return "API Gateway REST API";
  if (arn.includes(":cognito-idp:")) return "Amazon Cognito user pool";
  if (arn.includes(":appsync:")) return "AWS AppSync GraphQL API";
  if (arn.includes(":apprunner:")) return "AWS App Runner service";
  if (arn.includes(":ec2:")) return "AWS Verified Access instance";
  return "AWS resource";
}

export const TAG_COLUMNS = [
  { key: "Key", label: "Key", kind: "text" as const },
  { key: "Value", label: "Value", kind: "text" as const },
];

export const SCOPE_COLUMN: ColumnDef = { key: "scope", label: "Scope", kind: "text" };

/** The create forms' scope choice, as in the real console's Region / Global (CloudFront) selector. */
export function scopeField(section: string): FieldDef {
  return {
    name: "scope",
    label: "Scope",
    kind: "radio",
    required: true,
    default: "REGIONAL",
    section,
    options: [
      { value: "REGIONAL", label: "Regional resources (Application Load Balancers, API Gateway REST APIs, Cognito user pools, …) in this Region" },
      { value: "CLOUDFRONT", label: "Amazon CloudFront distributions (Global, managed in us-east-1)" },
    ],
    help: "You can't change the scope later. A web ACL can only use IP sets, regex pattern sets and rule groups from its own scope.",
  };
}

export function scopeValue(v: FieldValues): Scope {
  return v.scope === "CLOUDFRONT" ? "CLOUDFRONT" : "REGIONAL";
}

/** "Manage tags": prefilled with the current tags; saves only the difference (TagResource / UntagResource). */
export function tagsAction(kind: Kind): ActionDef {
  return {
    id: "tags",
    label: "Manage tags",
    fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Add, change or remove tags. Only the changes are saved." }],
    async initialValues(ctx, id) {
      const s = await findSummary(ctx, kind, id);
      return { tags: (await tagRows(ctx, s.ARN)).map((t) => ({ Key: String(t.Key), Value: String(t.Value) })) };
    },
    async run(ctx, id, v) {
      const s = await findSummary(ctx, kind, id);
      if (!s.ARN) throw new Error(`The ${KIND_NAME[kind]} has no ARN.`);
      const current = (await tagRows(ctx, s.ARN)).map((t) => ({ Key: String(t.Key), Value: String(t.Value) }));
      const diff = tagDiff(current, fieldTags(v.tags));
      const w = wafFor(ctx, s.scope);
      if (diff.remove.length) await w.send(new UntagResourceCommand({ ResourceARN: s.ARN, TagKeys: diff.remove }));
      if (diff.set.length) await w.send(new TagResourceCommand({ ResourceARN: s.ARN, Tags: diff.set }));
      return { message: tagDiffMessage(diff) };
    },
  };
}
