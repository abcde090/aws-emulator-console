"use server";

/**
 * Server actions for the S3 object page (/s3/buckets/<bucket>/object?key=…): properties,
 * tags and versions of one object, plus its actions. Every call uses the permission-checked
 * S3 client. Secondary reads (tags, versions) that fail are reported per section, so a
 * restricted identity still sees what it may read.
 */

import {
  CopyObjectCommand,
  DeleteObjectTaggingCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectTaggingCommand,
  type StorageClass,
} from "@aws-sdk/client-s3";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result, Tag } from "../../console/types.ts";
import { isBucketName, parseS3Uri, STORAGE_CLASSES } from "./object-paths.ts";
import type { VersionEntry } from "./object-actions.ts";

/** A section that may be unreadable for the acting identity. */
export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ObjectProperties {
  size: number | null;
  lastModified: string | null;
  etag: string | null;
  contentType: string | null;
  storageClass: string;
  serverSideEncryption: string | null;
  kmsKeyId: string | null;
  versionId: string | null;
  metadata: Record<string, string>;
}

export interface ObjectDetail {
  bucket: string;
  key: string;
  properties: ObjectProperties;
  tags: Section<Tag[]>;
  versions: Section<VersionEntry[]>;
}

const MAX_VERSIONS = 1000;

function checkTarget(bucket: unknown, key: unknown): { bucket: string; key: string } {
  if (!isBucketName(bucket)) throw new Error("That is not a valid bucket name.");
  if (typeof key !== "string" || key === "" || new TextEncoder().encode(key).length > 1024) throw new Error("That is not a valid object key.");
  return { bucket, key };
}

const versionArg = (v: unknown): string | undefined => (typeof v === "string" && v !== "" && v.length <= 1024 ? v : undefined);

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function readTags(bucket: string, key: string, versionId?: string): Promise<Tag[]> {
  const r = await clients.s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  return (r.TagSet ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

async function readVersions(bucket: string, key: string): Promise<VersionEntry[]> {
  const out: VersionEntry[] = [];
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const r = await clients.s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
    const rows = [
      ...(r.Versions ?? []).map((v) => ({ v, deleteMarker: false, size: v.Size ?? null, storageClass: v.StorageClass ?? null })),
      ...(r.DeleteMarkers ?? []).map((v) => ({ v, deleteMarker: true, size: null, storageClass: null })),
    ];
    for (const { v, deleteMarker, size, storageClass } of rows) {
      // Prefix also matches "key-other"; keep this exact key only.
      if (v.Key !== key) continue;
      out.push({
        key,
        versionId: v.VersionId ?? "null",
        isLatest: v.IsLatest === true,
        deleteMarker,
        size,
        lastModified: v.LastModified ? v.LastModified.toISOString() : null,
        storageClass,
      });
    }
    keyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
    versionMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
  } while (keyMarker && out.length < MAX_VERSIONS);
  return out.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
}

export async function getObjectDetail(bucket: string, key: string, versionId?: string | null): Promise<Result<ObjectDetail>> {
  return attempt(async () => {
    const t = checkTarget(bucket, key);
    const v = versionArg(versionId);
    const head = await clients.s3.send(new HeadObjectCommand({ Bucket: t.bucket, Key: t.key, VersionId: v })).catch((err: unknown) => {
      // HeadObject has no body, so a missing key comes back as a bare "NotFound".
      if (err instanceof Error && err.name === "NotFound") {
        throw new Error(`NotFound: ${v ? `Version ${v} of ` : ""}s3://${t.bucket}/${t.key} does not exist${v ? "" : " (or its current version is a delete marker)"}.`);
      }
      throw err;
    });
    const [tags, versions] = await Promise.all([section(() => readTags(t.bucket, t.key, v)), section(() => readVersions(t.bucket, t.key))]);
    return {
      ...t,
      properties: {
        size: head.ContentLength ?? null,
        lastModified: head.LastModified ? head.LastModified.toISOString() : null,
        etag: head.ETag ?? null,
        contentType: head.ContentType ?? null,
        // HeadObject leaves StorageClass out for STANDARD objects.
        storageClass: head.StorageClass ?? "STANDARD",
        serverSideEncryption: head.ServerSideEncryption ?? null,
        kmsKeyId: head.SSEKMSKeyId ?? null,
        versionId: head.VersionId ?? null,
        metadata: head.Metadata ?? {},
      },
      tags,
      versions,
    };
  });
}

/** Applies the edited tag list (the dialog starts from the current tags). */
export async function saveObjectTags(bucket: string, key: string, tags: Tag[]): Promise<Result<{ count: number }>> {
  return attempt(async () => {
    const t = checkTarget(bucket, key);
    const clean = (Array.isArray(tags) ? tags : [])
      .filter((x) => typeof x?.Key === "string" && x.Key.trim() !== "")
      .map((x) => ({ Key: x.Key.trim(), Value: typeof x.Value === "string" ? x.Value : "" }));
    if (clean.length > 10) throw new Error("An object can have at most 10 tags.");
    if (new Set(clean.map((x) => x.Key)).size !== clean.length) throw new Error("Tag keys must be unique.");
    if (clean.some((x) => x.Key.length > 128 || x.Value.length > 256)) throw new Error("Tag keys are at most 128 characters, values 256.");
    if (clean.length === 0) await clients.s3.send(new DeleteObjectTaggingCommand({ Bucket: t.bucket, Key: t.key }));
    else await clients.s3.send(new PutObjectTaggingCommand({ Bucket: t.bucket, Key: t.key, Tagging: { TagSet: clean } }));
    return { count: clean.length };
  });
}

/** Changes the storage class the way the S3 console does: copies the object onto itself. */
export async function changeStorageClass(bucket: string, key: string, storageClass: string): Promise<Result<{ versionId: string | null }>> {
  return attempt(async () => {
    const t = checkTarget(bucket, key);
    if (!(STORAGE_CLASSES as readonly string[]).includes(storageClass)) throw new Error("Choose a storage class.");
    const r = await clients.s3.send(
      new CopyObjectCommand({
        Bucket: t.bucket,
        Key: t.key,
        CopySource: `${t.bucket}/${encodeURIComponent(t.key)}`,
        StorageClass: storageClass as StorageClass,
        MetadataDirective: "COPY",
        TaggingDirective: "COPY",
      })
    );
    return { versionId: r.VersionId ?? null };
  });
}

/** Copies the object to another S3 URI ("s3://bucket/key" or "s3://bucket/prefix/"). */
export async function copyObjectTo(bucket: string, key: string, destination: string): Promise<Result<{ bucket: string; key: string }>> {
  return attempt(async () => {
    const t = checkTarget(bucket, key);
    const dest = parseS3Uri(destination, t.key);
    if (!dest) throw new Error('Enter a destination like "s3://bucket/folder/" or "s3://bucket/new-name.txt".');
    if (dest.bucket === t.bucket && dest.key === t.key) throw new Error("The destination is the object itself.");
    await clients.s3.send(new CopyObjectCommand({ Bucket: dest.bucket, Key: dest.key, CopySource: `${t.bucket}/${encodeURIComponent(t.key)}` }));
    return dest;
  });
}
