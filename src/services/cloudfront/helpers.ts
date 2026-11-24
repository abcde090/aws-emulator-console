/**
 * Pure helpers for the CloudFront definition: origin domains, allowed methods, invalidation
 * paths, the OAC bucket policy and rows for the Behaviors/Origins tabs. No SDK calls here.
 */

import type { AllowedMethods, Method } from "@aws-sdk/client-cloudfront";

export type MethodsChoice = "GET_HEAD" | "GET_HEAD_OPTIONS" | "ALL";

const METHODS: Record<MethodsChoice, Method[]> = {
  GET_HEAD: ["GET", "HEAD"],
  GET_HEAD_OPTIONS: ["GET", "HEAD", "OPTIONS"],
  ALL: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
};

/** AllowedMethods as the API wants it; cached methods are GET/HEAD (+OPTIONS when allowed). */
export function allowedMethods(choice: unknown): AllowedMethods {
  const key: MethodsChoice = choice === "GET_HEAD_OPTIONS" || choice === "ALL" ? choice : "GET_HEAD";
  const items = METHODS[key];
  const cached: Method[] = key === "GET_HEAD" ? ["GET", "HEAD"] : ["GET", "HEAD", "OPTIONS"];
  return { Quantity: items.length, Items: items, CachedMethods: { Quantity: cached.length, Items: cached } };
}

/** The regional REST endpoint CloudFront uses for an S3 bucket origin. */
export function s3OriginDomain(bucket: string, region: string): string {
  return `${bucket}.s3.${region}.amazonaws.com`;
}

/** The bucket name behind an S3 origin domain, or null when the domain is not an S3 bucket. */
export function bucketFromOriginDomain(domain: string): string | null {
  const m = /^(.+?)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.exec(domain);
  return m ? m[1] : null;
}

export const MAX_INVALIDATION_PATHS = 3000;

/** One path per line; each must start with "/". Returns the paths or an error. */
export function parseInvalidationPaths(text: unknown): { ok: true; paths: string[] } | { ok: false; error: string } {
  const paths = String(text ?? "")
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (paths.length === 0) return { ok: false, error: "Add at least one object path, for example /index.html or /*." };
  if (paths.length > MAX_INVALIDATION_PATHS) return { ok: false, error: `At most ${MAX_INVALIDATION_PATHS} paths per invalidation.` };
  const bad = paths.find((p) => !p.startsWith("/"));
  if (bad !== undefined) return { ok: false, error: `Each path must start with "/": ${bad}` };
  return { ok: true, paths: [...new Set(paths)] };
}

/** One value per line (alternate domain names, header names …), trimmed, de-duplicated. */
export function lines(text: unknown): string[] {
  return [...new Set(String(text ?? "").split(/\r?\n|,/).map((s) => s.trim()).filter((s) => s !== ""))];
}

/** The bucket policy the console asks you to copy so an OAC can read the bucket. */
export function oacBucketPolicy(bucket: string, distributionArn: string): Record<string, unknown> {
  return {
    Version: "2008-10-17",
    Id: "PolicyForCloudFrontPrivateContent",
    Statement: [
      {
        Sid: "AllowCloudFrontServicePrincipal",
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucket}/*`,
        Condition: { StringEquals: { "AWS:SourceArn": distributionArn } },
      },
    ],
  };
}

/** Adds (or replaces, by Sid) the OAC statement in an existing policy document. */
export function mergeOacStatement(existing: unknown, bucket: string, distributionArn: string): Record<string, unknown> {
  const fresh = oacBucketPolicy(bucket, distributionArn);
  const statement = (fresh.Statement as Record<string, unknown>[])[0];
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return fresh;
  const doc = existing as Record<string, unknown>;
  const current = Array.isArray(doc.Statement) ? (doc.Statement as unknown[]) : doc.Statement ? [doc.Statement] : [];
  const sid = `AllowCloudFrontServicePrincipal-${distributionArn.split("/").pop() ?? ""}`;
  const kept = current.filter((s) => !(s && typeof s === "object" && (s as Record<string, unknown>).Sid === sid));
  return { ...doc, Statement: [...kept, { ...statement, Sid: sid }] };
}

interface BehaviorLike {
  PathPattern?: string;
  TargetOriginId?: string;
  ViewerProtocolPolicy?: string;
  CachePolicyId?: string;
  OriginRequestPolicyId?: string;
  ResponseHeadersPolicyId?: string;
  Compress?: boolean;
  AllowedMethods?: { Items?: string[] };
}

/** Behaviors in precedence order: path behaviors first, the default (*) last, as the console lists them. */
export function behaviorRows(defaultBehavior: BehaviorLike | undefined, others: BehaviorLike[] | undefined, policyNames: Record<string, string>) {
  const row = (b: BehaviorLike, precedence: number, path: string) => ({
    precedence,
    pathPattern: path,
    origin: b.TargetOriginId ?? null,
    viewerProtocolPolicy: viewerProtocolLabel(b.ViewerProtocolPolicy),
    allowedMethods: (b.AllowedMethods?.Items ?? []).join(", ") || null,
    cachePolicy: b.CachePolicyId ? policyNames[b.CachePolicyId] ?? b.CachePolicyId : "Legacy cache settings",
    originRequestPolicy: b.OriginRequestPolicyId ? policyNames[b.OriginRequestPolicyId] ?? b.OriginRequestPolicyId : null,
    responseHeadersPolicy: b.ResponseHeadersPolicyId ? policyNames[b.ResponseHeadersPolicyId] ?? b.ResponseHeadersPolicyId : null,
    compress: b.Compress === undefined ? null : b.Compress ? "Yes" : "No",
  });
  const rows = (others ?? []).map((b, i) => row(b, i, b.PathPattern ?? ""));
  if (defaultBehavior) rows.push(row(defaultBehavior, rows.length, "Default (*)"));
  return rows;
}

export function viewerProtocolLabel(v: string | undefined): string | null {
  if (v === "allow-all") return "HTTP and HTTPS";
  if (v === "redirect-to-https") return "Redirect HTTP to HTTPS";
  if (v === "https-only") return "HTTPS only";
  return v ?? null;
}

export function priceClassLabel(v: string | undefined): string | null {
  if (v === "PriceClass_All") return "Use all edge locations (best performance)";
  if (v === "PriceClass_200") return "Use North America, Europe, Asia, Middle East, and Africa";
  if (v === "PriceClass_100") return "Use only North America and Europe";
  return v ?? null;
}

/** A path pattern a cache behavior accepts: no spaces, at most 255 characters. */
export function isPathPattern(p: string): boolean {
  return p.length > 0 && p.length <= 255 && !/\s/.test(p) && p !== "*" && p !== "Default (*)";
}
