"use server";

/**
 * Server actions for the S3 object browser. Every call uses the permission-checked S3
 * client, so the IAM simulator sees each ListBucket, PutObject and DeleteObject.
 */

import { DeleteObjectsCommand, GetBucketVersioningCommand, ListObjectsV2Command, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { checkFolderName, isBucketName, normalisePrefix, uploadKey } from "./object-paths.ts";

export interface FolderEntry {
  prefix: string;
}

export interface ObjectEntry {
  key: string;
  size: number | null;
  lastModified: string | null;
  storageClass: string | null;
  etag: string | null;
}

export interface ObjectListing {
  folders: FolderEntry[];
  objects: ObjectEntry[];
  nextToken: string | null;
}

/** One row of the "Show versions" view: an object version or a delete marker. */
export interface VersionEntry {
  key: string;
  versionId: string;
  isLatest: boolean;
  deleteMarker: boolean;
  size: number | null;
  lastModified: string | null;
  storageClass: string | null;
}

export interface VersionListing {
  folders: FolderEntry[];
  versions: VersionEntry[];
  /** "keyMarker\u0000versionIdMarker" for the next page, or null. */
  nextToken: string | null;
}

/** "Enabled", "Suspended" or "Disabled" (never versioned). */
export type VersioningStatus = "Enabled" | "Suspended" | "Disabled";

export interface DeleteOutcome {
  /** Objects or versions S3 removed for good. */
  deleted: number;
  /** Delete markers S3 created instead (versioned buckets, versions hidden). */
  deleteMarkers: number;
}

const MAX_UPLOAD_FILES = 100;
const MAX_DELETE_KEYS = 10_000;

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function requireBucket(bucket: unknown): string {
  if (!isBucketName(bucket)) throw new Error("That is not a valid bucket name.");
  return bucket;
}

export async function listObjects(bucket: string, prefix: string, token?: string | null): Promise<Result<ObjectListing>> {
  return attempt(async () => {
    const b = requireBucket(bucket);
    const p = normalisePrefix(prefix);
    const r = await clients.s3.send(
      new ListObjectsV2Command({ Bucket: b, Prefix: p || undefined, Delimiter: "/", MaxKeys: 1000, ContinuationToken: typeof token === "string" && token ? token : undefined })
    );
    return {
      folders: (r.CommonPrefixes ?? []).filter((c) => c.Prefix).map((c) => ({ prefix: c.Prefix as string })),
      // The folder's own placeholder object ("photos/") is not shown inside it.
      objects: (r.Contents ?? [])
        .filter((o) => o.Key !== undefined && o.Key !== p)
        .map((o) => ({
          key: o.Key as string,
          size: o.Size ?? null,
          lastModified: o.LastModified ? o.LastModified.toISOString() : null,
          storageClass: o.StorageClass ?? null,
          etag: o.ETag ?? null,
        })),
      nextToken: r.IsTruncated ? r.NextContinuationToken ?? null : null,
    };
  });
}

export async function createFolder(bucket: string, prefix: string, name: string): Promise<Result<{ key: string }>> {
  return attempt(async () => {
    const b = requireBucket(bucket);
    const p = normalisePrefix(prefix);
    const check = checkFolderName(name, p);
    if (!check.ok) throw new Error(check.error);
    const key = `${p}${check.name}/`;
    await clients.s3.send(new PutObjectCommand({ Bucket: b, Key: key, Body: "" }));
    return { key };
  });
}

export async function uploadObjects(form: FormData): Promise<Result<{ uploaded: string[] }>> {
  return attempt(async () => {
    const b = requireBucket(form.get("bucket"));
    const p = normalisePrefix(form.get("prefix"));
    const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
    if (files.length === 0) throw new Error("Choose at least one file.");
    if (files.length > MAX_UPLOAD_FILES) throw new Error(`Upload at most ${MAX_UPLOAD_FILES} files at a time.`);
    const uploaded: string[] = [];
    for (const file of files) {
      const key = uploadKey(p, file.name);
      if (!key) throw new Error(`"${file.name}" can't be used as an object name.`);
      await clients.s3.send(
        new PutObjectCommand({ Bucket: b, Key: key, Body: Buffer.from(await file.arrayBuffer()), ContentType: file.type || "application/octet-stream" })
      );
      uploaded.push(key);
    }
    return { uploaded };
  });
}

/** Deletes the given keys, and every object under the given folder prefixes. */
export async function deleteObjects(bucket: string, keys: string[], prefixes: string[]): Promise<Result<DeleteOutcome>> {
  return attempt(async () => {
    const b = requireBucket(bucket);
    const all = new Set((Array.isArray(keys) ? keys : []).filter((k): k is string => typeof k === "string" && k !== ""));
    for (const raw of Array.isArray(prefixes) ? prefixes : []) {
      const p = normalisePrefix(raw);
      if (p === "") continue;
      let token: string | undefined;
      do {
        const r = await clients.s3.send(new ListObjectsV2Command({ Bucket: b, Prefix: p, ContinuationToken: token }));
        for (const o of r.Contents ?? []) if (o.Key) all.add(o.Key);
        if (all.size > MAX_DELETE_KEYS) throw new Error(`More than ${MAX_DELETE_KEYS} objects selected; delete fewer at a time.`);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      all.add(p);
    }
    const list = [...all];
    if (list.length === 0) throw new Error("Select at least one object or folder.");
    return deleteBatch(b, list.map((Key) => ({ Key })));
  });
}

async function deleteBatch(bucket: string, objects: { Key: string; VersionId?: string }[]): Promise<DeleteOutcome> {
  let deleted = 0;
  let deleteMarkers = 0;
  for (let i = 0; i < objects.length; i += 1000) {
    const r = await clients.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.slice(i, i + 1000) } }));
    for (const d of r.Deleted ?? []) {
      // Deleting by key alone in a versioned bucket adds a delete marker; the data stays.
      // (Deleting a specific version that is itself a marker also reports DeleteMarker.)
      if (d.DeleteMarker && !d.VersionId) deleteMarkers += 1;
      else deleted += 1;
    }
    if (r.Errors?.length) throw new Error(`Deleted ${deleted}; ${r.Errors.length} failed: ${r.Errors.map((e) => `${e.Key}: ${e.Code} ${e.Message ?? ""}`).join("; ")}`);
  }
  return { deleted, deleteMarkers };
}

export async function bucketVersioning(bucket: string): Promise<Result<VersioningStatus>> {
  return attempt(async () => {
    const r = await clients.s3.send(new GetBucketVersioningCommand({ Bucket: requireBucket(bucket) }));
    return r.Status === "Enabled" || r.Status === "Suspended" ? r.Status : "Disabled";
  });
}

export async function listVersions(bucket: string, prefix: string, token?: string | null): Promise<Result<VersionListing>> {
  return attempt(async () => {
    const b = requireBucket(bucket);
    const p = normalisePrefix(prefix);
    const [keyMarker, versionMarker] = typeof token === "string" && token ? token.split("\u0000") : [undefined, undefined];
    const r = await clients.s3.send(
      new ListObjectVersionsCommand({ Bucket: b, Prefix: p || undefined, Delimiter: "/", MaxKeys: 1000, KeyMarker: keyMarker || undefined, VersionIdMarker: versionMarker || undefined })
    );
    const versions: VersionEntry[] = [
      ...(r.Versions ?? []).map((v) => ({ v, deleteMarker: false, size: v.Size ?? null, storageClass: v.StorageClass ?? null })),
      ...(r.DeleteMarkers ?? []).map((v) => ({ v, deleteMarker: true, size: null, storageClass: null })),
    ]
      .filter(({ v }) => v.Key !== undefined && v.Key !== p)
      .map(({ v, deleteMarker, size, storageClass }) => ({
        key: v.Key as string,
        versionId: v.VersionId ?? "null",
        isLatest: v.IsLatest === true,
        deleteMarker,
        size,
        lastModified: v.LastModified ? v.LastModified.toISOString() : null,
        storageClass,
      }))
      .sort((a, b) => (a.key === b.key ? (b.lastModified ?? "").localeCompare(a.lastModified ?? "") : a.key.localeCompare(b.key)));
    return {
      folders: (r.CommonPrefixes ?? []).filter((c) => c.Prefix).map((c) => ({ prefix: c.Prefix as string })),
      versions,
      nextToken: r.IsTruncated ? `${r.NextKeyMarker ?? ""}\u0000${r.NextVersionIdMarker ?? ""}` : null,
    };
  });
}

/** Permanently deletes specific object versions (and delete markers). */
export async function deleteVersions(bucket: string, items: { key: string; versionId: string }[]): Promise<Result<DeleteOutcome>> {
  return attempt(async () => {
    const b = requireBucket(bucket);
    const list = (Array.isArray(items) ? items : []).filter(
      (i): i is { key: string; versionId: string } => typeof i?.key === "string" && i.key !== "" && typeof i.versionId === "string" && i.versionId !== ""
    );
    if (list.length === 0) throw new Error("Select at least one version.");
    if (list.length > MAX_DELETE_KEYS) throw new Error(`More than ${MAX_DELETE_KEYS} versions selected; delete fewer at a time.`);
    return deleteBatch(b, list.map((i) => ({ Key: i.key, VersionId: i.versionId })));
  });
}
