/**
 * CloudFront list calls shared by the resources: every page of distributions, OACs and the
 * three policy types, plus option loaders for the forms. All calls use ctx.clients.
 */

import {
  ListCachePoliciesCommand,
  ListDistributionsCommand,
  ListOriginAccessControlsCommand,
  ListOriginRequestPoliciesCommand,
  ListResponseHeadersPoliciesCommand,
  type CachePolicySummary,
  type DistributionSummary,
  type OriginAccessControlSummary,
  type OriginRequestPolicySummary,
  type ResponseHeadersPolicySummary,
} from "@aws-sdk/client-cloudfront";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import type { Ctx, Option } from "../../console/types.ts";

const MAX_PAGES = 50;

async function pages<T>(fetch: (marker: string | undefined) => Promise<{ items: T[]; next: string | undefined }>): Promise<T[]> {
  const all: T[] = [];
  let marker: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetch(marker);
    all.push(...page.items);
    if (!page.next || page.next === marker) break;
    marker = page.next;
  }
  return all;
}

export function listDistributions(ctx: Ctx): Promise<DistributionSummary[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.cloudfront.send(new ListDistributionsCommand({ Marker, MaxItems: 100 }));
    const l = r.DistributionList;
    return { items: l?.Items ?? [], next: l?.IsTruncated ? l.NextMarker : undefined };
  });
}

export function listOacs(ctx: Ctx): Promise<OriginAccessControlSummary[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.cloudfront.send(new ListOriginAccessControlsCommand({ Marker, MaxItems: 100 }));
    const l = r.OriginAccessControlList;
    return { items: l?.Items ?? [], next: l?.IsTruncated ? l.NextMarker : undefined };
  });
}

export function listCachePolicies(ctx: Ctx): Promise<CachePolicySummary[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.cloudfront.send(new ListCachePoliciesCommand({ Marker, MaxItems: 100 }));
    const l = r.CachePolicyList;
    return { items: l?.Items ?? [], next: l?.NextMarker };
  });
}

export function listOriginRequestPolicies(ctx: Ctx): Promise<OriginRequestPolicySummary[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.cloudfront.send(new ListOriginRequestPoliciesCommand({ Marker, MaxItems: 100 }));
    const l = r.OriginRequestPolicyList;
    return { items: l?.Items ?? [], next: l?.NextMarker };
  });
}

export function listResponseHeadersPolicies(ctx: Ctx): Promise<ResponseHeadersPolicySummary[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.cloudfront.send(new ListResponseHeadersPoliciesCommand({ Marker, MaxItems: 100 }));
    const l = r.ResponseHeadersPolicyList;
    return { items: l?.Items ?? [], next: l?.NextMarker };
  });
}

/** Policy id -> name for all three policy types (used to label behaviors). */
export async function policyNames(ctx: Ctx): Promise<Record<string, string>> {
  const [cache, origin, headers] = await Promise.all([listCachePolicies(ctx), listOriginRequestPolicies(ctx), listResponseHeadersPolicies(ctx)]);
  const names: Record<string, string> = {};
  for (const p of cache) if (p.CachePolicy?.Id) names[p.CachePolicy.Id] = p.CachePolicy.CachePolicyConfig?.Name ?? p.CachePolicy.Id;
  for (const p of origin) if (p.OriginRequestPolicy?.Id) names[p.OriginRequestPolicy.Id] = p.OriginRequestPolicy.OriginRequestPolicyConfig?.Name ?? p.OriginRequestPolicy.Id;
  for (const p of headers) if (p.ResponseHeadersPolicy?.Id) names[p.ResponseHeadersPolicy.Id] = p.ResponseHeadersPolicy.ResponseHeadersPolicyConfig?.Name ?? p.ResponseHeadersPolicy.Id;
  return names;
}

const DEFAULT_CACHE_POLICY = "Managed-CachingOptimized";

/** Cache policies with the console's default (CachingOptimized) first. */
export async function cachePolicyOptions(ctx: Ctx): Promise<Option[]> {
  const opts = (await listCachePolicies(ctx))
    .filter((p) => p.CachePolicy?.Id)
    .map((p) => ({ value: p.CachePolicy?.Id as string, label: `${p.CachePolicy?.CachePolicyConfig?.Name ?? p.CachePolicy?.Id}${p.Type === "custom" ? " (custom)" : ""}` }));
  return [...opts.filter((o) => o.label === DEFAULT_CACHE_POLICY), ...opts.filter((o) => o.label !== DEFAULT_CACHE_POLICY)];
}

export async function originRequestPolicyOptions(ctx: Ctx): Promise<Option[]> {
  const opts = (await listOriginRequestPolicies(ctx))
    .filter((p) => p.OriginRequestPolicy?.Id)
    .map((p) => ({ value: p.OriginRequestPolicy?.Id as string, label: p.OriginRequestPolicy?.OriginRequestPolicyConfig?.Name ?? (p.OriginRequestPolicy?.Id as string) }));
  return opts;
}

export async function responseHeadersPolicyOptions(ctx: Ctx): Promise<Option[]> {
  const opts = (await listResponseHeadersPolicies(ctx))
    .filter((p) => p.ResponseHeadersPolicy?.Id)
    .map((p) => ({ value: p.ResponseHeadersPolicy?.Id as string, label: p.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.Name ?? (p.ResponseHeadersPolicy?.Id as string) }));
  return opts;
}

export async function bucketOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.s3.send(new ListBucketsCommand({ ContinuationToken: token, MaxBuckets: 1000 }));
    for (const b of r.Buckets ?? []) if (b.Name) out.push({ value: b.Name, label: b.Name });
    token = r.ContinuationToken;
  } while (token);
  return out;
}

export const NEW_OAC = "__new__";

/** S3-type OACs, plus "create new". */
export async function oacOptions(ctx: Ctx): Promise<Option[]> {
  const existing = (await listOacs(ctx))
    .filter((o) => o.Id && o.OriginAccessControlOriginType === "s3")
    .map((o) => ({ value: o.Id as string, label: `${o.Name ?? o.Id} (${o.Id})` }));
  return [...existing, { value: NEW_OAC, label: "Create new OAC (named after the bucket)" }];
}
