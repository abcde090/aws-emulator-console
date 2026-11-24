/**
 * CloudFront distributions: list, detail tabs (General, Origins, Behaviors, Error pages,
 * Invalidations, Tags), create with an S3 origin and OAC, and the console's edit actions.
 * Every update reads the config and its ETag first and sends it back with IfMatch.
 */

import { secondary, unavailableText } from "../../console/secondary.ts";
import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import {
  CreateDistributionWithTagsCommand,
  CreateInvalidationCommand,
  CreateOriginAccessControlCommand,
  DeleteDistributionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  ListInvalidationsCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateDistributionCommand,
  type CacheBehavior,
  type DistributionConfig,
  type HttpVersion,
  type InvalidationSummary,
  type Origin,
  type PriceClass,
  type ViewerProtocolPolicy,
} from "@aws-sdk/client-cloudfront";
import { GetBucketPolicyCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";
import type { ActionDef, Ctx, FieldDef, FieldValues, ResourceDef, Row, Tag } from "../../console/types.ts";
import {
  allowedMethods,
  behaviorRows,
  bucketFromOriginDomain,
  isPathPattern,
  mergeOacStatement,
  parseInvalidationPaths,
  priceClassLabel,
  s3OriginDomain,
} from "./helpers.ts";
import {
  bucketOptions,
  cachePolicyOptions,
  listDistributions,
  listOacs,
  NEW_OAC,
  oacOptions,
  originRequestPolicyOptions,
  policyNames,
  responseHeadersPolicyOptions,
} from "./lookups.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function readConfig(ctx: Ctx, id: string): Promise<{ config: DistributionConfig; etag: string }> {
  const r = await ctx.clients.cloudfront.send(new GetDistributionConfigCommand({ Id: id }));
  if (!r.DistributionConfig || !r.ETag) throw new Error(`CloudFront returned no configuration for distribution ${id}.`);
  return { config: r.DistributionConfig, etag: r.ETag };
}

/** Read-modify-write with the ETag, the way every CloudFront edit works. */
async function updateConfig(ctx: Ctx, id: string, change: (c: DistributionConfig) => DistributionConfig): Promise<void> {
  const { config, etag } = await readConfig(ctx, id);
  await ctx.clients.cloudfront.send(new UpdateDistributionCommand({ Id: id, IfMatch: etag, DistributionConfig: change(config) }));
}

async function newOac(ctx: Ctx, bucket: string): Promise<string> {
  const r = await ctx.clients.cloudfront.send(
    new CreateOriginAccessControlCommand({
      OriginAccessControlConfig: {
        Name: bucket.slice(0, 64),
        Description: `Created for the ${bucket} origin`,
        SigningProtocol: "sigv4",
        SigningBehavior: "always",
        OriginAccessControlOriginType: "s3",
      },
    })
  );
  const id = r.OriginAccessControl?.Id;
  if (!id) throw new Error("CloudFront returned no ID for the new origin access control.");
  return id;
}

async function buildS3Origin(ctx: Ctx, v: FieldValues): Promise<Origin> {
  const bucket = str(v.originBucket);
  if (!bucket) throw new Error("Choose an S3 bucket as the origin domain.");
  const domain = s3OriginDomain(bucket, ctx.region);
  let oacId = "";
  if (v.originAccess === "oac") {
    const chosen = str(v.oacId);
    oacId = chosen === NEW_OAC || chosen === "" ? await newOac(ctx, bucket) : chosen;
  }
  return {
    Id: str(v.originName) || domain,
    DomainName: domain,
    OriginPath: str(v.originPath),
    S3OriginConfig: { OriginAccessIdentity: "" },
    ...(oacId ? { OriginAccessControlId: oacId } : {}),
  };
}

function behaviorSettings(v: FieldValues) {
  return {
    ViewerProtocolPolicy: (str(v.viewerProtocolPolicy) || "allow-all") as ViewerProtocolPolicy,
    AllowedMethods: allowedMethods(v.allowedMethods),
    Compress: v.compress === true,
    CachePolicyId: str(v.cachePolicyId),
    ...(str(v.originRequestPolicyId) ? { OriginRequestPolicyId: str(v.originRequestPolicyId) } : {}),
    ...(str(v.responseHeadersPolicyId) ? { ResponseHeadersPolicyId: str(v.responseHeadersPolicyId) } : {}),
  };
}

const VIEWER_PROTOCOL: FieldDef["options"] = [
  { value: "allow-all", label: "HTTP and HTTPS" },
  { value: "redirect-to-https", label: "Redirect HTTP to HTTPS" },
  { value: "https-only", label: "HTTPS only" },
];
const METHOD_OPTIONS: FieldDef["options"] = [
  { value: "GET_HEAD", label: "GET, HEAD" },
  { value: "GET_HEAD_OPTIONS", label: "GET, HEAD, OPTIONS" },
  { value: "ALL", label: "GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE" },
];
const PRICE_CLASSES = [
  { value: "PriceClass_All", label: "Use all edge locations (best performance)" },
  { value: "PriceClass_200", label: "Use North America, Europe, Asia, Middle East, and Africa" },
  { value: "PriceClass_100", label: "Use only North America and Europe" },
];
const HTTP_VERSIONS = [
  { value: "http2", label: "HTTP/2 (and HTTP/1.1, HTTP/1.0)" },
  { value: "http2and3", label: "HTTP/2 and HTTP/3" },
  { value: "http3", label: "HTTP/3 (and HTTP/1.1, HTTP/1.0)" },
  { value: "http1.1", label: "HTTP/1.1 and HTTP/1.0 only" },
];
const ORIGIN_PATH = { pattern: "/[^\\s]*[^/\\s]", message: "Starts with / and doesn't end with /, for example /production." };

function originFields(section: string): FieldDef[] {
  return [
    { name: "originBucket", label: "Origin domain", kind: "select", required: true, section, options: bucketOptions, help: "Choose an S3 bucket. CloudFront uses its regional endpoint (bucket.s3.<Region>.amazonaws.com)." },
    { name: "originPath", label: "Origin path", kind: "text", section, placeholder: "/production", help: "A folder in the bucket that CloudFront requests content from.", validate: ORIGIN_PATH },
    { name: "originName", label: "Name", kind: "text", section, help: "A name for this origin. Leave empty to use the origin domain.", validate: { pattern: "[^\\s]{1,128}", message: "Up to 128 characters, no spaces." } },
    {
      name: "originAccess", label: "Origin access", kind: "radio", default: "oac", section,
      options: [
        { value: "public", label: "Public: the bucket must allow public access" },
        { value: "oac", label: "Origin access control settings (recommended): the bucket can restrict access to CloudFront only" },
      ],
    },
    { name: "oacId", label: "Origin access control", kind: "select", required: true, section, showIf: { field: "originAccess", equals: "oac" }, options: oacOptions, help: "After creating the distribution, update the S3 bucket policy (Actions › Update S3 bucket policy) so this OAC can read the bucket." },
  ];
}

function behaviorFields(section: string): FieldDef[] {
  return [
    { name: "compress", label: "Compress objects automatically", kind: "checkbox", default: true, section },
    { name: "viewerProtocolPolicy", label: "Viewer protocol policy", kind: "radio", default: "allow-all", section, options: VIEWER_PROTOCOL },
    { name: "allowedMethods", label: "Allowed HTTP methods", kind: "radio", default: "GET_HEAD", section, options: METHOD_OPTIONS },
    { name: "cachePolicyId", label: "Cache policy", kind: "select", required: true, section, options: cachePolicyOptions, help: "Cache key and origin requests: CloudFront recommends a cache policy. Managed-CachingOptimized is the default." },
    { name: "originRequestPolicyId", label: "Origin request policy", kind: "select", section, options: originRequestPolicyOptions },
    { name: "responseHeadersPolicyId", label: "Response headers policy", kind: "select", section, options: responseHeadersPolicyOptions },
  ];
}

function settingsConfig(v: FieldValues) {
  return {
    PriceClass: (str(v.priceClass) || "PriceClass_All") as PriceClass,
    HttpVersion: (str(v.httpVersion) || "http2") as HttpVersion,
    DefaultRootObject: str(v.defaultRootObject),
    IsIPV6Enabled: v.ipv6 === true,
    Comment: str(v.comment),
  };
}

/** Every page of the distribution's invalidations. */
async function listInvalidations(ctx: Ctx, id: string): Promise<InvalidationSummary[]> {
  const out: InvalidationSummary[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.clients.cloudfront.send(new ListInvalidationsCommand({ DistributionId: id, Marker: marker, MaxItems: 100 }));
    const l = r.InvalidationList;
    out.push(...(l?.Items ?? []));
    if (!l?.IsTruncated || !l.NextMarker || l.NextMarker === marker) break;
    marker = l.NextMarker;
  }
  return out;
}

async function tagsOf(ctx: Ctx, arn: string): Promise<Tag[]> {
  const r = await ctx.clients.cloudfront.send(new ListTagsForResourceCommand({ Resource: arn }));
  return (r.Tags?.Items ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

function originRows(origins: Origin[], oacNames: Record<string, string>): Row[] {
  return origins.map((o) => ({
    name: o.Id ?? null,
    domain: o.DomainName ?? null,
    path: o.OriginPath || null,
    type: o.S3OriginConfig ? "S3" : o.CustomOriginConfig ? "Custom origin" : "-",
    originAccess: o.OriginAccessControlId ? `OAC: ${oacNames[o.OriginAccessControlId] ?? o.OriginAccessControlId}` : o.S3OriginConfig?.OriginAccessIdentity ? `OAI: ${o.S3OriginConfig.OriginAccessIdentity}` : "Public",
    protocol: o.CustomOriginConfig?.OriginProtocolPolicy ?? null,
  }));
}

const settingsActionFields: FieldDef[] = [
  { name: "comment", label: "Description", kind: "text", help: "Clear the box to remove the description.", validate: { max: 128, message: "At most 128 characters." } },
  { name: "defaultRootObject", label: "Default root object", kind: "text", placeholder: "index.html", help: "The object CloudFront returns for the root URL. Clear the box to remove it." },
  { name: "priceClass", label: "Price class", kind: "select", required: true, options: PRICE_CLASSES },
  { name: "httpVersion", label: "Supported HTTP versions", kind: "select", required: true, options: HTTP_VERSIONS },
  { name: "ipv6", label: "IPv6", kind: "checkbox" },
];

/** "Enabled" / "Disabled" from a list row (state) or the detail summary (State); null when unknown. */
function enabledState(row: Row): boolean | null {
  const s = row.state ?? row.State;
  return s === "Enabled" ? true : s === "Disabled" ? false : null;
}

async function distributionArn(ctx: Ctx, id: string): Promise<string> {
  const d = await ctx.clients.cloudfront.send(new GetDistributionCommand({ Id: id }));
  const arn = d.Distribution?.ARN;
  if (!arn) throw new Error("CloudFront returned no ARN for this distribution.");
  return arn;
}

const actions: ActionDef[] = [
  {
    id: "disable",
    label: "Disable",
    availableFor: (row) => enabledState(row) !== false,
    confirm: "Viewers can no longer reach the distribution. You must disable a distribution, and wait until its status is Deployed, before you can delete it.",
    async run(ctx, id) {
      await updateConfig(ctx, id, (c) => ({ ...c, Enabled: false }));
      return { message: `Disabling ${id}. Its status shows Deployed when the change is done.` };
    },
  },
  {
    id: "enable",
    label: "Enable",
    availableFor: (row) => enabledState(row) !== true,
    async run(ctx, id) {
      await updateConfig(ctx, id, (c) => ({ ...c, Enabled: true }));
      return { message: `Enabling ${id}.` };
    },
  },
  {
    id: "edit-settings",
    label: "Edit settings",
    fields: settingsActionFields,
    async initialValues(ctx, id) {
      const { config: c } = await readConfig(ctx, id);
      return {
        comment: c.Comment ?? "",
        defaultRootObject: c.DefaultRootObject ?? "",
        priceClass: c.PriceClass || "PriceClass_All",
        httpVersion: c.HttpVersion || "http2",
        ipv6: c.IsIPV6Enabled === true,
      };
    },
    async run(ctx, id, v) {
      // The dialog opens on the current values, so what is submitted is the new setting:
      // an empty description or default root object clears it.
      await updateConfig(ctx, id, (c) => ({
        ...c,
        Comment: str(v.comment),
        DefaultRootObject: str(v.defaultRootObject),
        PriceClass: (str(v.priceClass) || c.PriceClass) as PriceClass,
        HttpVersion: (str(v.httpVersion) || c.HttpVersion) as HttpVersion,
        IsIPV6Enabled: v.ipv6 === true,
      }));
      return { message: "Settings saved." };
    },
  },
  {
    id: "invalidate",
    label: "Create invalidation",
    fields: [{ name: "paths", label: "Add object paths", kind: "textarea", required: true, placeholder: "/*", help: "One path per line, each starting with /. Use * as a wildcard at the end, for example /images/*." }],
    async run(ctx, id, v) {
      const parsed = parseInvalidationPaths(v.paths);
      if (!parsed.ok) throw new Error(parsed.error);
      const r = await ctx.clients.cloudfront.send(
        new CreateInvalidationCommand({ DistributionId: id, InvalidationBatch: { CallerReference: `console-${Date.now()}`, Paths: { Quantity: parsed.paths.length, Items: parsed.paths } } })
      );
      return { message: `Invalidation ${r.Invalidation?.Id ?? ""} created. Status: ${r.Invalidation?.Status ?? "unknown"}.`, json: r.Invalidation };
    },
  },
  {
    id: "create-behavior",
    label: "Create behavior",
    fields: [
      { name: "pathPattern", label: "Path pattern", kind: "text", required: true, placeholder: "/images/*", help: "Requests that match this pattern use this behavior. Path behaviors are evaluated before the default (*)." },
      { name: "originId", label: "Origin and origin groups", kind: "text", required: true, help: "The name of one of this distribution's origins (see the Origins tab)." },
      ...behaviorFields(""),
    ],
    async run(ctx, id, v) {
      const path = str(v.pathPattern);
      if (!isPathPattern(path)) throw new Error("Enter a path pattern such as /images/* (no spaces; the default behavior is already *).");
      await updateConfig(ctx, id, (c) => {
        const origins = (c.Origins?.Items ?? []).map((o) => o.Id);
        if (!origins.includes(str(v.originId))) throw new Error(`"${str(v.originId)}" is not an origin of this distribution. Its origins: ${origins.join(", ") || "none"}.`);
        const existing = c.CacheBehaviors?.Items ?? [];
        if (existing.some((b) => b.PathPattern === path)) throw new Error(`A behavior with path pattern ${path} already exists.`);
        const added: CacheBehavior = { PathPattern: path, TargetOriginId: str(v.originId), ...behaviorSettings(v) };
        const items = [...existing, added];
        return { ...c, CacheBehaviors: { Quantity: items.length, Items: items } };
      });
      return { message: `Behavior ${path} created.` };
    },
  },
  {
    id: "delete-behavior",
    label: "Delete behavior",
    danger: true,
    fields: [{ name: "pathPattern", label: "Path pattern", kind: "text", required: true, help: "The path pattern of the behavior to delete (see the Behaviors tab). The default (*) behavior can't be deleted." }],
    async run(ctx, id, v) {
      const path = str(v.pathPattern);
      await updateConfig(ctx, id, (c) => {
        const existing = c.CacheBehaviors?.Items ?? [];
        const items = existing.filter((b) => b.PathPattern !== path);
        if (items.length === existing.length) throw new Error(`No behavior has the path pattern ${path}.`);
        return { ...c, CacheBehaviors: { Quantity: items.length, Items: items } };
      });
      return { message: `Behavior ${path} deleted.` };
    },
  },
  {
    id: "create-origin",
    label: "Create origin",
    fields: originFields(""),
    async run(ctx, id, v) {
      const origin = await buildS3Origin(ctx, v);
      await updateConfig(ctx, id, (c) => {
        const existing = c.Origins?.Items ?? [];
        if (existing.some((o) => o.Id === origin.Id)) throw new Error(`An origin named ${origin.Id} already exists. Enter a different name.`);
        const items = [...existing, origin];
        return { ...c, Origins: { Quantity: items.length, Items: items } };
      });
      return { message: `Origin ${origin.Id} created.` };
    },
  },
  {
    id: "delete-origin",
    label: "Delete origin",
    danger: true,
    fields: [{ name: "originId", label: "Origin name", kind: "text", required: true, help: "An origin used by a behavior can't be deleted; change or delete the behavior first." }],
    async run(ctx, id, v) {
      const name = str(v.originId);
      await updateConfig(ctx, id, (c) => {
        const used = [c.DefaultCacheBehavior?.TargetOriginId, ...(c.CacheBehaviors?.Items ?? []).map((b) => b.TargetOriginId)];
        if (used.includes(name)) throw new Error(`Origin ${name} is used by a behavior. Change or delete that behavior first.`);
        const existing = c.Origins?.Items ?? [];
        const items = existing.filter((o) => o.Id !== name);
        if (items.length === existing.length) throw new Error(`No origin is named ${name}.`);
        return { ...c, Origins: { Quantity: items.length, Items: items } };
      });
      return { message: `Origin ${name} deleted.` };
    },
  },
  {
    id: "bucket-policy",
    label: "Update S3 bucket policy",
    fields: [
      {
        name: "mode", label: "What to do", kind: "radio", default: "show",
        options: [
          { value: "show", label: "Show the policy statement (copy policy)" },
          { value: "apply", label: "Add the statement to each S3 origin bucket's policy now (PutBucketPolicy)" },
        ],
        help: "An origin access control can read a bucket only if the bucket policy allows the CloudFront service principal for this distribution.",
      },
    ],
    async run(ctx, id, v) {
      const d = await ctx.clients.cloudfront.send(new GetDistributionCommand({ Id: id }));
      const arn = d.Distribution?.ARN;
      if (!arn) throw new Error("CloudFront returned no ARN for this distribution.");
      const buckets = [...new Set((d.Distribution?.DistributionConfig?.Origins?.Items ?? []).filter((o) => o.OriginAccessControlId).map((o) => bucketFromOriginDomain(o.DomainName ?? "")).filter((b): b is string => b !== null))];
      if (buckets.length === 0) throw new Error("This distribution has no S3 origin that uses an origin access control.");
      const policies: Record<string, unknown> = {};
      for (const bucket of buckets) {
        let existing: unknown = null;
        try {
          const p = await ctx.clients.s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
          existing = p.Policy ? JSON.parse(p.Policy) : null;
        } catch (err: unknown) {
          if (!(err instanceof Error && err.name === "NoSuchBucketPolicy")) throw err;
        }
        policies[bucket] = mergeOacStatement(existing, bucket, arn);
        if (v.mode === "apply") await ctx.clients.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policies[bucket]) }));
      }
      return { message: v.mode === "apply" ? `Bucket policy updated for ${buckets.join(", ")}.` : `Policy for ${buckets.join(", ")} (existing statements kept). Nothing was changed.`, json: policies };
    },
  },
  {
    id: "tags",
    label: "Manage tags",
    fields: [{ name: "tags", label: "Tags", kind: "tags", help: "The distribution's current tags. Removed tags are untagged; new and changed tags are added." }],
    async initialValues(ctx, id) {
      return { tags: await tagsOf(ctx, await distributionArn(ctx, id)) };
    },
    async run(ctx, id, v) {
      const arn = await distributionArn(ctx, id);
      const diff = tagDiff(await tagsOf(ctx, arn), fieldTags(v.tags));
      if (diff.remove.length) await ctx.clients.cloudfront.send(new UntagResourceCommand({ Resource: arn, TagKeys: { Items: diff.remove } }));
      if (diff.set.length) await ctx.clients.cloudfront.send(new TagResourceCommand({ Resource: arn, Tags: { Items: diff.set } }));
      return { message: tagDiffMessage(diff) };
    },
  },
];

export const distributions: ResourceDef = {
  id: "distributions",
  name: "Distributions",
  singular: "distribution",
  idField: "id",
  nameField: "id",
  description: "A distribution tells CloudFront where to get content (origins) and how to cache and deliver it (behaviors).",
  emptyText: "You don't have any distributions.",
  columns: [
    { key: "id", label: "ID", kind: "link" },
    { key: "comment", label: "Description", kind: "text" },
    { key: "domainName", label: "Domain name", kind: "code" },
    { key: "origins", label: "Origins", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "state", label: "State", kind: "status" },
    { key: "lastModified", label: "Last modified", kind: "date" },
    { key: "priceClass", label: "Price class", kind: "text", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await listDistributions(ctx)).map((d) => ({
      id: d.Id ?? "",
      comment: d.Comment || null,
      domainName: d.DomainName ?? null,
      origins: (d.Origins?.Items ?? []).map((o) => o.DomainName).join(", ") || null,
      status: d.Status ?? null,
      state: d.Enabled === undefined ? null : d.Enabled ? "Enabled" : "Disabled",
      lastModified: d.LastModifiedTime ?? null,
      priceClass: d.PriceClass ?? null,
      arn: d.ARN ?? null,
    }));
  },

  async get(ctx, id) {
    const r = await ctx.clients.cloudfront.send(new GetDistributionCommand({ Id: id }));
    const d = r.Distribution;
    if (!d) throw new Error(`CloudFront returned no distribution ${id}.`);
    const c = d.DistributionConfig;
    // Secondary lookups: a denied one marks its part unavailable instead of failing the page.
    const [namesR, oacsR, invalidationsR, tagsR] = await Promise.all([
      secondary(policyNames(ctx)),
      secondary(listOacs(ctx)),
      secondary(listInvalidations(ctx, id)),
      secondary(d.ARN ? tagsOf(ctx, d.ARN) : Promise.resolve([])),
    ]);
    const names = namesR.ok ? namesR.value : {};
    const oacs = oacsR.ok ? oacsR.value : [];
    const oacNames = Object.fromEntries(oacs.filter((o) => o.Id).map((o) => [o.Id as string, o.Name ?? (o.Id as string)]));
    return {
      summary: {
        "Distribution domain name": d.DomainName ?? null,
        ARN: d.ARN ?? null,
        Status: d.Status ?? null,
        State: c?.Enabled === undefined ? null : c.Enabled ? "Enabled" : "Disabled",
        "Last modified": d.LastModifiedTime ?? null,
        ID: d.Id ?? id,
      },
      tabs: [
        {
          id: "general",
          label: "General",
          kind: "keyvalue",
          data: {
            Description: c?.Comment || "-",
            "Price class": priceClassLabel(c?.PriceClass),
            "Supported HTTP versions": c?.HttpVersion ?? null,
            "Default root object": c?.DefaultRootObject || "-",
            IPv6: c?.IsIPV6Enabled ? "On" : "Off",
            "Alternate domain names": (c?.Aliases?.Items ?? []).join(", ") || "-",
            "Custom SSL certificate": c?.ViewerCertificate?.ACMCertificateArn ?? c?.ViewerCertificate?.IAMCertificateId ?? (c?.ViewerCertificate?.CloudFrontDefaultCertificate ? "Default CloudFront certificate" : "-"),
            "Security policy": c?.ViewerCertificate?.MinimumProtocolVersion ?? null,
            "AWS WAF": c?.WebACLId || "-",
            "Standard logging": c?.Logging?.Enabled ? `On (${c.Logging.Bucket ?? ""}${c.Logging.Prefix ?? ""})` : "Off",
            "In-progress invalidations": d.InProgressInvalidationBatches ?? 0,
          },
        },
        {
          id: "origins",
          label: "Origins",
          kind: "table",
          columns: [
            { key: "name", label: "Origin name", kind: "text" },
            { key: "domain", label: "Origin domain", kind: "code" },
            { key: "path", label: "Origin path", kind: "text" },
            { key: "type", label: "Origin type", kind: "text" },
            { key: "originAccess", label: "Origin access", kind: "text" },
          ],
          data: originRows(c?.Origins?.Items ?? [], oacNames),
          ...(oacsR.ok ? {} : { description: `OAC names: Unavailable: ${oacsR.error}` }),
          emptyText: "No origins.",
        },
        {
          id: "behaviors",
          label: "Behaviors",
          kind: "table",
          columns: [
            { key: "precedence", label: "Precedence", kind: "count" },
            { key: "pathPattern", label: "Path pattern", kind: "code" },
            { key: "origin", label: "Origin or origin group", kind: "text" },
            { key: "viewerProtocolPolicy", label: "Viewer protocol policy", kind: "text" },
            { key: "allowedMethods", label: "Allowed HTTP methods", kind: "text" },
            { key: "cachePolicy", label: "Cache policy name", kind: "text" },
            { key: "originRequestPolicy", label: "Origin request policy name", kind: "text" },
            { key: "responseHeadersPolicy", label: "Response headers policy name", kind: "text" },
            { key: "compress", label: "Compress", kind: "text" },
          ],
          data: behaviorRows(c?.DefaultCacheBehavior, c?.CacheBehaviors?.Items, names),
          description: namesR.ok ? "CloudFront checks path behaviors in precedence order and falls back to the default (*)." : `Policy names: Unavailable: ${namesR.error}`,
        },
        {
          id: "errors",
          label: "Error pages",
          kind: "table",
          columns: [
            { key: "code", label: "HTTP error code", kind: "count" },
            { key: "page", label: "Response page path", kind: "code" },
            { key: "responseCode", label: "HTTP response code", kind: "text" },
            { key: "ttl", label: "Error caching minimum TTL (seconds)", kind: "count" },
          ],
          data: (c?.CustomErrorResponses?.Items ?? []).map((e) => ({ code: e.ErrorCode ?? null, page: e.ResponsePagePath || null, responseCode: e.ResponseCode || null, ttl: e.ErrorCachingMinTTL ?? null })),
          emptyText: "No custom error responses.",
        },
        {
          id: "invalidations",
          label: "Invalidations",
          kind: "table",
          columns: [
            { key: "id", label: "Invalidation ID", kind: "code" },
            { key: "status", label: "Status", kind: "status" },
            { key: "created", label: "Date created", kind: "date" },
          ],
          data: invalidationsR.ok ? invalidationsR.value.map((i) => ({ id: i.Id ?? "", status: i.Status ?? null, created: i.CreateTime ?? null })) : [],
          ...(invalidationsR.ok ? {} : { description: `Unavailable: ${invalidationsR.error}` }),
          emptyText: "No invalidations. Use Actions › Create invalidation to remove objects from edge caches.",
        },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: tagsR.ok ? tagsR.value : [], emptyText: unavailableText(tagsR, "No tags.") },
        { id: "config", label: "Configuration (JSON)", kind: "json", data: c ?? null, description: "The DistributionConfig GetDistribution returned." },
      ],
    };
  },

  create: {
    title: "Create distribution",
    description: "Creates a CloudFront distribution with one S3 origin and a default cache behavior (CreateDistributionWithTags). Add more origins and path behaviors from the distribution's Actions menu.",
    fields: [
      ...originFields("Origin"),
      ...behaviorFields("Default cache behavior"),
      { name: "priceClass", label: "Price class", kind: "radio", default: "PriceClass_All", section: "Settings", options: PRICE_CLASSES },
      { name: "httpVersion", label: "Supported HTTP versions", kind: "select", default: "http2", section: "Settings", options: HTTP_VERSIONS },
      { name: "defaultRootObject", label: "Default root object", kind: "text", section: "Settings", placeholder: "index.html", help: "The object CloudFront returns when a viewer requests the root URL." },
      { name: "ipv6", label: "IPv6", kind: "checkbox", default: true, section: "Settings" },
      { name: "comment", label: "Description", kind: "text", section: "Settings", validate: { max: 128, message: "At most 128 characters." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const origin = await buildS3Origin(ctx, v);
      const config: DistributionConfig = {
        CallerReference: `console-${Date.now()}`,
        Enabled: true,
        Origins: { Quantity: 1, Items: [origin] },
        DefaultCacheBehavior: { TargetOriginId: origin.Id, ...behaviorSettings(v) },
        ...settingsConfig(v),
      };
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      const r = await ctx.clients.cloudfront.send(new CreateDistributionWithTagsCommand({ DistributionConfigWithTags: { DistributionConfig: config, Tags: { Items: tags } } }));
      const id = r.Distribution?.Id;
      if (!id) throw new Error("CloudFront returned no ID for the new distribution.");
      return id;
    },
  },

  actions,

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const r = await ctx.clients.cloudfront.send(new GetDistributionCommand({ Id: id }));
      if (r.Distribution?.DistributionConfig?.Enabled) throw new Error("Disable the distribution first (Actions › Disable), wait until its status is Deployed, then delete it.");
      if (r.Distribution?.Status && r.Distribution.Status !== "Deployed") throw new Error(`The distribution's status is ${r.Distribution.Status}. Wait until it is Deployed, then delete it.`);
      if (!r.ETag) throw new Error("CloudFront returned no ETag for this distribution.");
      await ctx.clients.cloudfront.send(new DeleteDistributionCommand({ Id: id, IfMatch: r.ETag }));
    },
  },
};
