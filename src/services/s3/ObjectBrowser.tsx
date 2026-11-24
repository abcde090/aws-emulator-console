"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { formatBytes, formatDate } from "@/console/format";
import { Modal } from "@/console/ui/Modal";
import { Button, buttonClass, Container, EmptyState, ErrorBanner, Flash } from "@/console/ui/primitives";
import { DeleteObjectsDialog, deleteMode } from "./DeleteObjectsDialog";
import {
  createFolder,
  deleteObjects,
  deleteVersions,
  listObjects,
  listVersions,
  uploadObjects,
  type ObjectListing,
  type VersioningStatus,
  type VersionListing,
} from "./object-actions";
import { displayName, objectHref, prefixCrumbs, s3Uri } from "./object-paths";

interface ObjectBrowserProps {
  bucket: string;
  prefix: string;
  initial: ObjectListing | null;
  initialError: string | null;
  /** The bucket's versioning status; null when it could not be read. */
  versioning: VersioningStatus | null;
}

/** Selection key for one version in the "Show versions" view. */
const versionKey = (key: string, versionId: string) => `${key}\u0000${versionId}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Dialog = "folder" | "delete" | null;

export function ObjectBrowser({ bucket, prefix, initial, initialError, versioning }: ObjectBrowserProps) {
  const router = useRouter();
  const [listing, setListing] = useState<ObjectListing | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [folderName, setFolderName] = useState("");
  const [filter, setFilter] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const [versionListing, setVersionListing] = useState<VersionListing | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const open = (p: string) => router.push(`/s3/buckets/${encodeURIComponent(bucket)}${p ? `?prefix=${encodeURIComponent(p)}` : ""}`);

  const reload = useCallback(
    async (versions: boolean = showVersions) => {
      if (versions) {
        const r = await listVersions(bucket, prefix);
        if (r.ok) {
          setVersionListing(r.data);
          setError(null);
        } else setError(r.error);
      } else {
        const r = await listObjects(bucket, prefix);
        if (r.ok) {
          setListing(r.data);
          setError(null);
        } else setError(r.error);
      }
      setSelected([]);
    },
    [bucket, prefix, showVersions]
  );

  async function toggleVersions(on: boolean) {
    setShowVersions(on);
    await reload(on);
  }

  async function loadMore() {
    if (showVersions) {
      if (!versionListing?.nextToken) return;
      const r = await listVersions(bucket, prefix, versionListing.nextToken);
      if (!r.ok) return setError(r.error);
      setVersionListing({ folders: [...versionListing.folders, ...r.data.folders], versions: [...versionListing.versions, ...r.data.versions], nextToken: r.data.nextToken });
      return;
    }
    if (!listing?.nextToken) return;
    const r = await listObjects(bucket, prefix, listing.nextToken);
    if (!r.ok) return setError(r.error);
    setListing({ folders: [...listing.folders, ...r.data.folders], objects: [...listing.objects, ...r.data.objects], nextToken: r.data.nextToken });
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const form = new FormData();
    form.set("bucket", bucket);
    form.set("prefix", prefix);
    for (const f of Array.from(files)) form.append("files", f);
    setBusy(true);
    const r = await uploadObjects(form);
    setBusy(false);
    if (fileInput.current) fileInput.current.value = "";
    if (!r.ok) return setError(r.error);
    setNotice(`Uploaded ${r.data.uploaded.length} file${r.data.uploaded.length === 1 ? "" : "s"}: ${r.data.uploaded.join(", ")}`);
    await reload();
  }

  async function makeFolder() {
    setBusy(true);
    const r = await createFolder(bucket, prefix, folderName);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDialog(null);
    setFolderName("");
    setNotice(`Created folder ${r.data.key}`);
    await reload();
  }

  async function removeSelected() {
    setBusy(true);
    const r = showVersions
      ? await deleteVersions(
          bucket,
          selected.filter((s) => s.includes("\u0000")).map((s) => ({ key: s.split("\u0000")[0], versionId: s.split("\u0000")[1] }))
        )
      : await deleteObjects(
          bucket,
          selected.filter((s) => !s.endsWith("/")),
          selected.filter((s) => s.endsWith("/"))
        );
    setBusy(false);
    setDialog(null);
    if (!r.ok) return setError(r.error);
    const parts = [];
    if (r.data.deleted > 0 || r.data.deleteMarkers === 0) parts.push(`Permanently deleted ${plural(r.data.deleted, showVersions ? "version" : "object")}.`);
    if (r.data.deleteMarkers > 0) parts.push(`Created ${plural(r.data.deleteMarkers, "delete marker")}; the previous versions are still stored (turn on Show versions to see them).`);
    setNotice(parts.join(" "));
    await reload();
  }

  async function copyUri(uri: string) {
    try {
      await navigator.clipboard.writeText(uri);
      setNotice(`Copied S3 URI: ${uri}`);
    } catch {
      setNotice(`S3 URI: ${uri}`);
    }
  }

  const toggle = (k: string, on: boolean) => setSelected((prev) => (on ? [...prev, k] : prev.filter((x) => x !== k)));
  const q = filter.trim().toLowerCase();
  const matches = (k: string) => displayName(k, prefix).toLowerCase().includes(q);
  const current = showVersions ? versionListing : listing;
  const folders = (current?.folders ?? []).filter((f) => matches(f.prefix));
  const objects = showVersions ? [] : (listing?.objects ?? []).filter((o) => matches(o.key));
  const versions = showVersions ? (versionListing?.versions ?? []).filter((v) => matches(v.key)) : [];
  const singleObject = !showVersions && selected.length === 1 && !selected[0].endsWith("/") ? selected[0] : null;
  const singleVersion = showVersions && selected.length === 1 && selected[0].includes("\u0000") ? selected[0].split("\u0000") : null;
  const downloadKey = singleObject ?? singleVersion?.[0] ?? null;
  const downloadHref = downloadKey
    ? `/api/s3/object?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(downloadKey)}${singleVersion ? `&versionId=${encodeURIComponent(singleVersion[1])}` : ""}`
    : null;
  // The counter follows the filter, as in the S3 console.
  const count = folders.length + objects.length + versions.length;
  const mode = deleteMode(versioning, showVersions);

  return (
    <div className="space-y-4" data-testid="object-browser">
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Container
        title="Objects"
        counter={`(${count}${current?.nextToken ? "+" : ""})`}
        description="Objects are the files stored in the bucket. Folders are shown for key prefixes ending in /."
        actions={
          <>
            <Button aria-label="Refresh objects" onClick={() => void reload()}>
              ⟳
            </Button>
            <Button disabled={!downloadKey} onClick={() => downloadKey && void copyUri(s3Uri(bucket, downloadKey))}>
              Copy S3 URI
            </Button>
            {downloadHref ? (
              <a className={buttonClass("normal")} href={downloadHref}>
                Download
              </a>
            ) : (
              <Button disabled>Download</Button>
            )}
            <Button disabled={selected.length === 0 || busy} onClick={() => setDialog("delete")}>
              Delete
            </Button>
            <Button disabled={busy} onClick={() => setDialog("folder")}>
              Create folder
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? "Working…" : "Upload"}
            </Button>
            <input ref={fileInput} type="file" multiple className="hidden" data-testid="upload-input" onChange={(e) => void upload(e.target.files)} />
          </>
        }
      >
        <nav aria-label="Folder path" className="mb-3 flex flex-wrap items-center gap-1">
          <button type="button" className="text-link hover:underline" onClick={() => open("")}>
            {bucket}
          </button>
          {prefixCrumbs(prefix).map((c) => (
            <span key={c.prefix} className="flex items-center gap-1">
              <span className="text-muted">/</span>
              <button type="button" className="text-link hover:underline" onClick={() => open(c.prefix)}>
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="mb-3 flex flex-wrap items-center gap-4">
        <input
          type="search"
          aria-label="Find objects by prefix"
          placeholder="Find objects by name"
          className="w-full max-w-md rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" role="switch" data-testid="show-versions" checked={showVersions} onChange={(e) => void toggleVersions(e.target.checked)} />
            Show versions
          </label>
          {versioning && <span className="text-[13px] text-muted">Bucket Versioning: {versioning}</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="objects-table">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="w-8" />
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Type</th>
                {showVersions && <th className="px-2 py-2">Version ID</th>}
                <th className="px-2 py-2">Last modified</th>
                <th className="px-2 py-2">Size</th>
                <th className="px-2 py-2">Storage class</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((f) => (
                <tr key={f.prefix} className="border-b border-line-soft hover:bg-shade">
                  <td className="px-2 py-2">
                    <input type="checkbox" aria-label={`Select ${f.prefix}`} checked={selected.includes(f.prefix)} onChange={(e) => toggle(f.prefix, e.target.checked)} />
                  </td>
                  <td className="px-2 py-2">
                    <button type="button" className="text-link hover:underline" onClick={() => open(f.prefix)}>
                      📁 {displayName(f.prefix, prefix)}
                    </button>
                  </td>
                  <td className="px-2 py-2">Folder</td>
                  {showVersions && <td className="px-2 py-2">-</td>}
                  <td className="px-2 py-2">-</td>
                  <td className="px-2 py-2">-</td>
                  <td className="px-2 py-2">-</td>
                </tr>
              ))}
              {objects.map((o) => {
                const name = displayName(o.key, prefix);
                const ext = name.includes(".") ? name.split(".").pop() : "-";
                return (
                  <tr key={o.key} className="border-b border-line-soft hover:bg-shade">
                    <td className="px-2 py-2">
                      <input type="checkbox" aria-label={`Select ${o.key}`} checked={selected.includes(o.key)} onChange={(e) => toggle(o.key, e.target.checked)} />
                    </td>
                    <td className="px-2 py-2 break-all">
                      <a className="text-link hover:underline" href={objectHref(bucket, o.key)}>
                        {name}
                      </a>
                    </td>
                    <td className="px-2 py-2">{ext}</td>
                    <td className="px-2 py-2">{o.lastModified ? formatDate(o.lastModified) : "-"}</td>
                    <td className="px-2 py-2">{formatBytes(o.size)}</td>
                    <td className="px-2 py-2">{o.storageClass ?? "-"}</td>
                  </tr>
                );
              })}
              {versions.map((v) => {
                const name = displayName(v.key, prefix);
                const k = versionKey(v.key, v.versionId);
                return (
                  <tr key={k} className="border-b border-line-soft hover:bg-shade" data-testid="version-row">
                    <td className="px-2 py-2">
                      <input type="checkbox" aria-label={`Select ${v.key} version ${v.versionId}`} checked={selected.includes(k)} onChange={(e) => toggle(k, e.target.checked)} />
                    </td>
                    <td className="px-2 py-2 break-all">
                      {v.deleteMarker ? (
                        name
                      ) : (
                        <a className="text-link hover:underline" href={objectHref(bucket, v.key, v.versionId)}>
                          {name}
                        </a>
                      )}
                    </td>
                    <td className="px-2 py-2">{v.deleteMarker ? "Delete marker" : name.includes(".") ? name.split(".").pop() : "-"}</td>
                    <td className="px-2 py-2 font-mono text-[12px]">
                      {v.versionId}
                      {v.isLatest && <span className="ml-1 text-muted">(current)</span>}
                    </td>
                    <td className="px-2 py-2">{v.lastModified ? formatDate(v.lastModified) : "-"}</td>
                    <td className="px-2 py-2">{v.deleteMarker ? "-" : formatBytes(v.size)}</td>
                    <td className="px-2 py-2">{v.storageClass ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {current && count === 0 && (
          <EmptyState title={q ? "No matches" : "No objects"}>
            <p>{q ? "No objects match the filter." : `You don't have any objects in this ${prefix ? "folder" : "bucket"}.`}</p>
          </EmptyState>
        )}
        {current?.nextToken && (
          <div className="mt-3">
            <Button onClick={() => void loadMore()}>Load more</Button>
          </div>
        )}
      </Container>

      {dialog === "folder" && (
        <Modal
          title="Create folder"
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="link" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || folderName.trim() === ""} onClick={() => void makeFolder()}>
                Create folder
              </Button>
            </>
          }
        >
          <p className="text-muted">Creates a zero-byte object whose key ends in &quot;/&quot;, which S3 consoles show as a folder.</p>
          <label className="block space-y-1">
            <span className="font-bold">Folder name</span>
            <input aria-label="Folder name" className="w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1" value={folderName} onChange={(e) => setFolderName(e.target.value)} />
          </label>
        </Modal>
      )}
      {dialog === "delete" && (
        <DeleteObjectsDialog
          mode={mode}
          items={selected.map((x) => x.replace("\u0000", " version "))}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => void removeSelected()}
        />
      )}
    </div>
  );
}
