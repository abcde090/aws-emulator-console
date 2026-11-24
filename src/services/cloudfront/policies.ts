/**
 * CloudFront policies: cache policies (managed and custom; create, edit TTLs, delete custom),
 * origin request policies and response headers policies (read-only views).
 */

import { secondary } from "../../console/secondary.ts";
import {
  CreateCachePolicyCommand,
  DeleteCachePolicyCommand,
  GetCachePolicyCommand,
  GetOriginRequestPolicyCommand,
  GetResponseHeadersPolicyCommand,
  UpdateCachePolicyCommand,
  type CachePolicyConfig,
  type CachePolicyCookieBehavior,
  type CachePolicyHeaderBehavior,
  type CachePolicyQueryStringBehavior,
} from "@aws-sdk/client-cloudfront";
import type { FieldDef, FieldValues, ResourceDef } from "../../console/types.ts";
import { lines } from "./helpers.ts";
import { listCachePolicies, listOriginRequestPolicies, listResponseHeadersPolicies } from "./lookups.ts";

const typeLabel = (t: string | undefined) => (t === "managed" ? "Managed" : t === "custom" ? "Custom" : t ?? null);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function namesList(behavior: string, text: unknown, field: string) {
  if (behavior !== "whitelist" && behavior !== "allExcept") return undefined;
  const items = lines(text);
  if (items.length === 0) throw new Error(`${field}: list at least one name for this setting.`);
  return { Quantity: items.length, Items: items };
}

function cacheConfig(v: FieldValues): CachePolicyConfig {
  const minTTL = num(v.minTTL) ?? 1;
  const defaultTTL = num(v.defaultTTL) ?? 86400;
  const maxTTL = num(v.maxTTL) ?? 31536000;
  if (!(minTTL <= defaultTTL && defaultTTL <= maxTTL)) throw new Error("TTL settings must satisfy Minimum TTL ≤ Default TTL ≤ Maximum TTL.");
  const headerBehavior = String(v.headerBehavior || "none") as CachePolicyHeaderBehavior;
  const cookieBehavior = String(v.cookieBehavior || "none") as CachePolicyCookieBehavior;
  const queryBehavior = String(v.queryStringBehavior || "none") as CachePolicyQueryStringBehavior;
  return {
    Name: String(v.name),
    Comment: typeof v.comment === "string" && v.comment ? v.comment : undefined,
    MinTTL: minTTL,
    DefaultTTL: defaultTTL,
    MaxTTL: maxTTL,
    ParametersInCacheKeyAndForwardedToOrigin: {
      EnableAcceptEncodingGzip: v.gzip === true,
      EnableAcceptEncodingBrotli: v.brotli === true,
      HeadersConfig: { HeaderBehavior: headerBehavior, Headers: namesList(headerBehavior, v.headers, "Headers") },
      CookiesConfig: { CookieBehavior: cookieBehavior, Cookies: namesList(cookieBehavior, v.cookies, "Cookies") },
      QueryStringsConfig: { QueryStringBehavior: queryBehavior, QueryStrings: namesList(queryBehavior, v.queryStrings, "Query strings") },
    },
  };
}

const ttlFields = (section: string): FieldDef[] => [
  { name: "minTTL", label: "Minimum TTL", kind: "number", default: 1, section, help: "Seconds.", validate: { min: 0, max: 31536000, message: "Between 0 and 31536000 seconds." } },
  { name: "maxTTL", label: "Maximum TTL", kind: "number", default: 31536000, section, help: "Seconds.", validate: { min: 0, max: 31536000 * 100, message: "At least 0 seconds." } },
  { name: "defaultTTL", label: "Default TTL", kind: "number", default: 86400, section, help: "Seconds. Used when the origin sends no Cache-Control or Expires header.", validate: { min: 0, max: 31536000 * 100, message: "At least 0 seconds." } },
];

const ALL_EXCEPT = [
  { value: "none", label: "None" },
  { value: "whitelist", label: "Include specified" },
  { value: "allExcept", label: "All - except" },
  { value: "all", label: "All" },
];

export const cachePolicies: ResourceDef = {
  id: "cache-policies",
  name: "Cache policies",
  singular: "cache policy",
  idField: "id",
  nameField: "name",
  description: "A cache policy sets the cache key (headers, cookies, query strings) and how long objects stay in the cache.",
  emptyText: "No cache policies.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "comment", label: "Description", kind: "text" },
    { key: "minTTL", label: "Minimum TTL", kind: "count" },
    { key: "defaultTTL", label: "Default TTL", kind: "count" },
    { key: "maxTTL", label: "Maximum TTL", kind: "count" },
    { key: "id", label: "ID", kind: "code", hidden: true },
  ],
  async list(ctx) {
    return (await listCachePolicies(ctx)).map((p) => {
      const c = p.CachePolicy?.CachePolicyConfig;
      return { id: p.CachePolicy?.Id ?? "", name: c?.Name ?? null, type: typeLabel(p.Type), comment: c?.Comment ?? null, minTTL: c?.MinTTL ?? null, defaultTTL: c?.DefaultTTL ?? null, maxTTL: c?.MaxTTL ?? null };
    });
  },
  async get(ctx, id) {
    const [r, managed] = await Promise.all([ctx.clients.cloudfront.send(new GetCachePolicyCommand({ Id: id })), secondary(isManaged(ctx, id))]);
    const c = r.CachePolicy?.CachePolicyConfig;
    const p = c?.ParametersInCacheKeyAndForwardedToOrigin;
    const join = (items: string[] | undefined) => (items ?? []).join(", ") || null;
    return {
      summary: { Name: c?.Name ?? id, ID: id, Type: managed.ok ? (managed.value ? "Managed" : "Custom") : null, Description: c?.Comment ?? null, "Last modified": r.CachePolicy?.LastModifiedTime ?? null },
      tabs: [
        { id: "ttl", label: "TTL settings", kind: "keyvalue", data: { "Minimum TTL (seconds)": c?.MinTTL ?? null, "Default TTL (seconds)": c?.DefaultTTL ?? null, "Maximum TTL (seconds)": c?.MaxTTL ?? null } },
        {
          id: "cache-key",
          label: "Cache key settings",
          kind: "keyvalue",
          data: {
            Headers: p?.HeadersConfig?.HeaderBehavior ?? null,
            "Header names": join(p?.HeadersConfig?.Headers?.Items),
            Cookies: p?.CookiesConfig?.CookieBehavior ?? null,
            "Cookie names": join(p?.CookiesConfig?.Cookies?.Items),
            "Query strings": p?.QueryStringsConfig?.QueryStringBehavior ?? null,
            "Query string names": join(p?.QueryStringsConfig?.QueryStrings?.Items),
            Gzip: p?.EnableAcceptEncodingGzip ? "Enabled" : "Disabled",
            Brotli: p?.EnableAcceptEncodingBrotli ? "Enabled" : "Disabled",
          },
        },
        { id: "json", label: "JSON", kind: "json", data: r.CachePolicy ?? null },
      ],
    };
  },
  create: {
    title: "Create cache policy",
    description: "Creates a custom cache policy (CreateCachePolicy). Attach it to a behavior from a distribution's Actions menu.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Details", validate: { pattern: "[A-Za-z0-9_-]{1,128}", message: "Up to 128 letters, numbers, hyphens or underscores." } },
      { name: "comment", label: "Description", kind: "text", section: "Details" },
      ...ttlFields("TTL settings"),
      { name: "headerBehavior", label: "Headers", kind: "select", default: "none", section: "Cache key settings", options: [{ value: "none", label: "None" }, { value: "whitelist", label: "Include the following headers" }] },
      { name: "headers", label: "Header names", kind: "textarea", section: "Cache key settings", showIf: { field: "headerBehavior", equals: "whitelist" }, help: "One per line." },
      { name: "cookieBehavior", label: "Cookies", kind: "select", default: "none", section: "Cache key settings", options: ALL_EXCEPT },
      { name: "cookies", label: "Cookie names", kind: "textarea", section: "Cache key settings", help: "One per line. Used with Include specified or All - except." },
      { name: "queryStringBehavior", label: "Query strings", kind: "select", default: "none", section: "Cache key settings", options: ALL_EXCEPT },
      { name: "queryStrings", label: "Query string names", kind: "textarea", section: "Cache key settings", help: "One per line. Used with Include specified or All - except." },
      { name: "gzip", label: "Gzip", kind: "checkbox", default: true, section: "Compression support" },
      { name: "brotli", label: "Brotli", kind: "checkbox", default: true, section: "Compression support" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.cloudfront.send(new CreateCachePolicyCommand({ CachePolicyConfig: cacheConfig(v) }));
      const id = r.CachePolicy?.Id;
      if (!id) throw new Error("CloudFront returned no ID for the new cache policy.");
      return id;
    },
  },
  actions: [
    {
      id: "edit-ttl",
      label: "Edit TTL settings",
      fields: ttlFields(""),
      availableFor: (row) => (row.type ?? row.Type) !== "Managed",
      async initialValues(ctx, id) {
        const c = (await ctx.clients.cloudfront.send(new GetCachePolicyCommand({ Id: id }))).CachePolicy?.CachePolicyConfig;
        return { minTTL: c?.MinTTL ?? 0, defaultTTL: c?.DefaultTTL ?? 0, maxTTL: c?.MaxTTL ?? 0 };
      },
      async run(ctx, id, v) {
        const r = await ctx.clients.cloudfront.send(new GetCachePolicyCommand({ Id: id }));
        const c = r.CachePolicy?.CachePolicyConfig;
        if (!c || !r.ETag) throw new Error("CloudFront returned no configuration for this cache policy.");
        if (r.CachePolicy && (await isManaged(ctx, id))) throw new Error("Managed cache policies can't be edited. Create a custom policy instead.");
        const minTTL = num(v.minTTL) ?? c.MinTTL ?? 0;
        const defaultTTL = num(v.defaultTTL) ?? c.DefaultTTL ?? 0;
        const maxTTL = num(v.maxTTL) ?? c.MaxTTL ?? 0;
        if (!(minTTL <= defaultTTL && defaultTTL <= maxTTL)) throw new Error("TTL settings must satisfy Minimum TTL ≤ Default TTL ≤ Maximum TTL.");
        await ctx.clients.cloudfront.send(new UpdateCachePolicyCommand({ Id: id, IfMatch: r.ETag, CachePolicyConfig: { ...c, MinTTL: minTTL, DefaultTTL: defaultTTL, MaxTTL: maxTTL } }));
        return { message: "TTL settings saved." };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      if (await isManaged(ctx, id)) throw new Error("Managed cache policies can't be deleted.");
      const r = await ctx.clients.cloudfront.send(new GetCachePolicyCommand({ Id: id }));
      if (!r.ETag) throw new Error("CloudFront returned no ETag for this cache policy.");
      await ctx.clients.cloudfront.send(new DeleteCachePolicyCommand({ Id: id, IfMatch: r.ETag }));
    },
  },
};

async function isManaged(ctx: Parameters<ResourceDef["list"]>[0], id: string): Promise<boolean> {
  return (await listCachePolicies(ctx)).some((p) => p.CachePolicy?.Id === id && p.Type === "managed");
}

export const originRequestPolicies: ResourceDef = {
  id: "origin-request-policies",
  name: "Origin request policies",
  singular: "origin request policy",
  idField: "id",
  nameField: "name",
  description: "An origin request policy sets which headers, cookies and query strings CloudFront forwards to the origin.",
  emptyText: "No origin request policies.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "comment", label: "Description", kind: "text" },
    { key: "headers", label: "Headers", kind: "text" },
    { key: "cookies", label: "Cookies", kind: "text" },
    { key: "queryStrings", label: "Query strings", kind: "text" },
  ],
  async list(ctx) {
    return (await listOriginRequestPolicies(ctx)).map((p) => {
      const c = p.OriginRequestPolicy?.OriginRequestPolicyConfig;
      return {
        id: p.OriginRequestPolicy?.Id ?? "",
        name: c?.Name ?? null,
        type: typeLabel(p.Type),
        comment: c?.Comment ?? null,
        headers: c?.HeadersConfig?.HeaderBehavior ?? null,
        cookies: c?.CookiesConfig?.CookieBehavior ?? null,
        queryStrings: c?.QueryStringsConfig?.QueryStringBehavior ?? null,
      };
    });
  },
  async get(ctx, id) {
    const r = await ctx.clients.cloudfront.send(new GetOriginRequestPolicyCommand({ Id: id }));
    const c = r.OriginRequestPolicy?.OriginRequestPolicyConfig;
    return {
      summary: { Name: c?.Name ?? id, ID: id, Description: c?.Comment ?? null, "Last modified": r.OriginRequestPolicy?.LastModifiedTime ?? null },
      tabs: [
        {
          id: "settings",
          label: "Origin request settings",
          kind: "keyvalue",
          data: {
            Headers: c?.HeadersConfig?.HeaderBehavior ?? null,
            "Header names": (c?.HeadersConfig?.Headers?.Items ?? []).join(", ") || null,
            Cookies: c?.CookiesConfig?.CookieBehavior ?? null,
            "Cookie names": (c?.CookiesConfig?.Cookies?.Items ?? []).join(", ") || null,
            "Query strings": c?.QueryStringsConfig?.QueryStringBehavior ?? null,
            "Query string names": (c?.QueryStringsConfig?.QueryStrings?.Items ?? []).join(", ") || null,
          },
        },
        { id: "json", label: "JSON", kind: "json", data: r.OriginRequestPolicy ?? null },
      ],
    };
  },
};

export const responseHeadersPolicies: ResourceDef = {
  id: "response-headers-policies",
  name: "Response headers policies",
  singular: "response headers policy",
  idField: "id",
  nameField: "name",
  description: "A response headers policy adds CORS, security and custom headers to responses CloudFront sends to viewers.",
  emptyText: "No response headers policies.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "comment", label: "Description", kind: "text" },
  ],
  async list(ctx) {
    return (await listResponseHeadersPolicies(ctx)).map((p) => ({
      id: p.ResponseHeadersPolicy?.Id ?? "",
      name: p.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.Name ?? null,
      type: typeLabel(p.Type),
      comment: p.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.Comment ?? null,
    }));
  },
  async get(ctx, id) {
    const r = await ctx.clients.cloudfront.send(new GetResponseHeadersPolicyCommand({ Id: id }));
    const c = r.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig;
    return {
      summary: { Name: c?.Name ?? id, ID: id, Description: c?.Comment ?? null, "Last modified": r.ResponseHeadersPolicy?.LastModifiedTime ?? null },
      tabs: [
        {
          id: "settings",
          label: "Headers",
          kind: "keyvalue",
          data: {
            CORS: c?.CorsConfig ? "Configured" : "Not configured",
            "Security headers": c?.SecurityHeadersConfig ? "Configured" : "Not configured",
            "Custom headers": (c?.CustomHeadersConfig?.Items ?? []).map((h) => `${h.Header}: ${h.Value}`).join("; ") || "-",
            "Remove headers": (c?.RemoveHeadersConfig?.Items ?? []).map((h) => h.Header).join(", ") || "-",
            "Server-Timing header": c?.ServerTimingHeadersConfig?.Enabled ? "Enabled" : "Disabled",
          },
        },
        { id: "json", label: "JSON", kind: "json", data: r.ResponseHeadersPolicy ?? null },
      ],
    };
  },
};
