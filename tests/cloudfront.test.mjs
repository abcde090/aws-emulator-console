import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedMethods,
  behaviorRows,
  bucketFromOriginDomain,
  isPathPattern,
  lines,
  mergeOacStatement,
  oacBucketPolicy,
  parseInvalidationPaths,
  priceClassLabel,
  s3OriginDomain,
  viewerProtocolLabel,
} from "../src/services/cloudfront/helpers.ts";

test("CloudFront allowed methods", () => {
  assert.deepEqual(allowedMethods("GET_HEAD"), { Quantity: 2, Items: ["GET", "HEAD"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } });
  assert.equal(allowedMethods("ALL").Quantity, 7);
  assert.deepEqual(allowedMethods("GET_HEAD_OPTIONS").CachedMethods?.Items, ["GET", "HEAD", "OPTIONS"]);
  assert.deepEqual(allowedMethods("junk").Items, ["GET", "HEAD"]);
});

test("CloudFront S3 origin domains", () => {
  assert.equal(s3OriginDomain("my-b", "us-east-1"), "my-b.s3.us-east-1.amazonaws.com");
  assert.equal(bucketFromOriginDomain("my-b.s3.us-east-1.amazonaws.com"), "my-b");
  assert.equal(bucketFromOriginDomain("my.dotted.b.s3.amazonaws.com"), "my.dotted.b");
  assert.equal(bucketFromOriginDomain("example.com"), null);
});

test("CloudFront invalidation paths", () => {
  assert.deepEqual(parseInvalidationPaths("/*\n /a.html \n\n/*"), { ok: true, paths: ["/*", "/a.html"] });
  assert.equal(parseInvalidationPaths("").ok, false);
  assert.equal(parseInvalidationPaths("images/*").ok, false);
  assert.deepEqual(lines("a, b\nb\n"), ["a", "b"]);
});

test("CloudFront OAC bucket policy", () => {
  const arn = "arn:aws:cloudfront::000000000000:distribution/E1";
  const fresh = oacBucketPolicy("b", arn);
  assert.equal(fresh.Statement[0].Resource, "arn:aws:s3:::b/*");
  assert.equal(fresh.Statement[0].Condition.StringEquals["AWS:SourceArn"], arn);
  const existing = { Version: "2012-10-17", Statement: [{ Sid: "Keep", Effect: "Deny" }] };
  const merged = mergeOacStatement(existing, "b", arn);
  assert.equal(merged.Statement.length, 2);
  assert.equal(merged.Statement[1].Sid, "AllowCloudFrontServicePrincipal-E1");
  assert.equal(mergeOacStatement(merged, "b", arn).Statement.length, 2, "re-applying does not duplicate");
  assert.equal(existing.Statement.length, 1, "input is not mutated");
  assert.equal(mergeOacStatement(null, "b", arn).Id, "PolicyForCloudFrontPrivateContent");
});

test("CloudFront behavior rows and labels", () => {
  const rows = behaviorRows(
    { TargetOriginId: "o", ViewerProtocolPolicy: "redirect-to-https", CachePolicyId: "p1", Compress: true, AllowedMethods: { Items: ["GET", "HEAD"] } },
    [{ PathPattern: "/api/*", TargetOriginId: "o", ViewerProtocolPolicy: "https-only" }],
    { p1: "Managed-CachingOptimized" }
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pathPattern, "/api/*");
  assert.equal(rows[0].cachePolicy, "Legacy cache settings");
  assert.equal(rows[1].pathPattern, "Default (*)");
  assert.equal(rows[1].cachePolicy, "Managed-CachingOptimized");
  assert.equal(rows[1].viewerProtocolPolicy, "Redirect HTTP to HTTPS");
  assert.equal(viewerProtocolLabel(undefined), null);
  assert.equal(priceClassLabel("PriceClass_100"), "Use only North America and Europe");
  assert.equal(isPathPattern("/images/*"), true);
  assert.equal(isPathPattern("*"), false);
  assert.equal(isPathPattern("/a b"), false);
});
