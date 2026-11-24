"use client";

/**
 * The S3 object overview: Properties, Tags and Versions tabs and the object Actions menu
 * (Download, Copy S3 URI, Copy, Edit storage class, Edit tags, delete versions).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatBytes, formatDate } from "@/console/format";
import { noTagChanges, tagDiff } from "@/console/tags";
import type { FieldMeta, FieldValue, FieldValues, Tag } from "@/console/types";
import { ActionsMenu } from "@/console/ui/ActionsMenu";
import { DetailTabs } from "@/console/ui/DetailTabs";
import { FormFields } from "@/console/ui/FormFields";
import { KeyValue } from "@/console/ui/KeyValue";
import { Modal } from "@/console/ui/Modal";
import { Button, buttonClass, Container, EmptyState, ErrorBanner, Flash, PageHeader } from "@/console/ui/primitives";
import { DeleteObjectsDialog } from "./DeleteObjectsDialog";
import { deleteVersions } from "./object-actions";
import { changeStorageClass, copyObjectTo, saveObjectTags, type ObjectDetail } from "./object-detail";
import { objectHref, s3Uri, STORAGE_CLASSES } from "./object-paths";

type Dialog = "tags" | "storage-class" | "copy" | "delete-versions" | null;

const FIELDS: Record<Exclude<Dialog, "delete-versions" | null>, FieldMeta[]> = {
  tags: [{ name: "tags", label: "Tags", kind: "tags", help: "The object's current tags. An object can have up to 10 tags." }],
  "storage-class": [
    {
      name: "storageClass", label: "Storage class", kind: "radio", required: true,
      help: "Changing the storage class copies the object onto itself; in a versioned bucket that creates a new version.",
      options: STORAGE_CLASSES.map((c) => ({ value: c, label: c })),
    },
  ],
  copy: [{ name: "destination", label: "Destination", kind: "text", required: true, placeholder: "s3://bucket/folder/", help: "An S3 URI. End it with / to keep the object's name." }],
};

const downloadHref = (bucket: string, key: string, versionId?: string | null) =>
  `/api/s3/object?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}${versionId ? `&versionId=${encodeURIComponent(versionId)}` : ""}`;

interface ObjectPageProps {
  detail: ObjectDetail;
  /** The version opened from the versions list, if any. */
  versionId: string | null;
}

export function ObjectPage({ detail, versionId }: ObjectPageProps) {
  const router = useRouter();
  const { bucket, key, properties: p } = detail;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [values, setValues] = useState<FieldValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const uri = s3Uri(bucket, key);
  const name = key.split("/").filter((x) => x !== "").pop() ?? key;

  function openDialog(d: Dialog) {
    setError(null);
    if (d === "tags") setValues({ tags: detail.tags.ok ? detail.tags.data : [] });
    else if (d === "storage-class") setValues({ storageClass: p.storageClass });
    else if (d === "copy") setValues({ destination: "" });
    setDialog(d);
  }

  async function run(fn: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDialog(null);
    setSelected([]);
    setNotice(r.message);
    router.refresh();
  }

  async function submit() {
    if (dialog === "tags") {
      const tags = (values.tags as Tag[] | null) ?? [];
      let unchanged = false;
      try {
        unchanged = detail.tags.ok && noTagChanges(tagDiff(detail.tags.data, tags));
      } catch (err: unknown) {
        return setError(err instanceof Error ? err.message : String(err));
      }
      if (unchanged) {
        setDialog(null);
        return setNotice("No tag changes.");
      }
      await run(async () => {
        const r = await saveObjectTags(bucket, key, tags);
        return r.ok ? { ok: true, message: `Saved ${r.data.count} tag${r.data.count === 1 ? "" : "s"}.` } : r;
      });
    } else if (dialog === "storage-class") {
      const target = String(values.storageClass ?? "");
      if (target === p.storageClass) {
        setDialog(null);
        return setNotice(`Storage class is already ${target}; nothing changed.`);
      }
      await run(async () => {
        const r = await changeStorageClass(bucket, key, target);
        return r.ok ? { ok: true, message: `Storage class changed to ${target}${r.data.versionId ? ` (new version ${r.data.versionId})` : ""}.` } : r;
      });
    } else if (dialog === "copy") {
      await run(async () => {
        const r = await copyObjectTo(bucket, key, String(values.destination ?? ""));
        return r.ok ? { ok: true, message: `Copied to ${s3Uri(r.data.bucket, r.data.key)}.` } : r;
      });
    } else if (dialog === "delete-versions") {
      await run(async () => {
        const r = await deleteVersions(bucket, selected.map((v) => ({ key, versionId: v })));
        return r.ok ? { ok: true, message: `Permanently deleted ${r.data.deleted} version${r.data.deleted === 1 ? "" : "s"}.` } : r;
      });
    }
  }

  async function copyUri() {
    try {
      await navigator.clipboard.writeText(uri);
      setNotice(`Copied S3 URI: ${uri}`);
    } catch {
      setNotice(`S3 URI: ${uri}`);
    }
  }

  const versionsTab = detail.versions.ok ? (
    <Container
      title="Versions"
      counter={`(${detail.versions.data.length})`}
      description="Every version of this object, newest first. Unversioned objects have the version ID null."
      actions={
        <Button disabled={selected.length === 0 || busy} onClick={() => setDialog("delete-versions")}>
          Delete
        </Button>
      }
    >
      {detail.versions.data.length === 0 ? (
        <EmptyState title="No versions" />
      ) : (
        <table className="w-full border-collapse text-left text-[13px]" data-testid="versions-table">
          <thead>
            <tr className="border-b border-line bg-shade text-muted">
              <th className="w-8" />
              <th className="px-3 py-2">Version ID</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Last modified</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2">Storage class</th>
            </tr>
          </thead>
          <tbody>
            {detail.versions.data.map((v) => (
              <tr key={v.versionId} className="border-b border-line-soft hover:bg-shade">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select version ${v.versionId}`}
                    checked={selected.includes(v.versionId)}
                    onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, v.versionId] : prev.filter((x) => x !== v.versionId)))}
                  />
                </td>
                <td className="px-3 py-2 font-mono text-[12px]">
                  {v.deleteMarker ? (
                    v.versionId
                  ) : (
                    <a className="text-link hover:underline" href={objectHref(bucket, key, v.versionId)}>
                      {v.versionId}
                    </a>
                  )}
                  {v.isLatest && <span className="ml-1 text-muted">(current)</span>}
                </td>
                <td className="px-3 py-2">{v.deleteMarker ? "Delete marker" : "Version"}</td>
                <td className="px-3 py-2">{v.lastModified ? formatDate(v.lastModified) : "-"}</td>
                <td className="px-3 py-2">{v.deleteMarker ? "-" : formatBytes(v.size)}</td>
                <td className="px-3 py-2">{v.storageClass ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Container>
  ) : (
    <ErrorBanner title="Versions unavailable" message={detail.versions.error} />
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={name}
        description={versionId ? `Version ${versionId}` : undefined}
        actions={
          <>
            <Button onClick={() => void copyUri()}>Copy S3 URI</Button>
            <a className={buttonClass("normal")} href={downloadHref(bucket, key, versionId)}>
              Download
            </a>
            <ActionsMenu
              items={[
                { id: "copy", label: "Copy" },
                { id: "storage-class", label: "Edit storage class" },
                { id: "tags", label: "Edit tags", disabled: !detail.tags.ok },
              ]}
              onSelect={(id) => openDialog(id as Dialog)}
            />
          </>
        }
      />
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && dialog === null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <DetailTabs
        tabs={[]}
        extra={[
          {
            id: "properties",
            label: "Properties",
            content: (
              <Container title="Object overview">
                <KeyValue
                  data={{
                    "S3 URI": uri,
                    "Amazon Resource Name (ARN)": `arn:aws:s3:::${bucket}/${key}`,
                    "Entity tag (ETag)": p.etag,
                    "Last modified": p.lastModified,
                    Size: formatBytes(p.size),
                    Type: p.contentType,
                    "Storage class": p.storageClass,
                    "Server-side encryption": p.serverSideEncryption,
                    "KMS key": p.kmsKeyId,
                    "Version ID": p.versionId ?? "null",
                    "User-defined metadata": Object.keys(p.metadata).length ? Object.entries(p.metadata).map(([k, v]) => `x-amz-meta-${k}: ${v}`).join(", ") : null,
                  }}
                />
              </Container>
            ),
          },
          {
            id: "tags",
            label: "Tags",
            content: detail.tags.ok ? (
              <Container title="Tags" counter={`(${detail.tags.data.length})`}>
                {detail.tags.data.length === 0 ? (
                  <EmptyState title="No tags are associated with this object." />
                ) : (
                  <KeyValue data={Object.fromEntries(detail.tags.data.map((t) => [t.Key, t.Value]))} />
                )}
              </Container>
            ) : (
              <ErrorBanner title="Tags unavailable" message={detail.tags.error} />
            ),
          },
          { id: "versions", label: "Versions", content: versionsTab },
        ]}
      />

      {dialog === "delete-versions" && (
        <DeleteObjectsDialog mode="versions" items={selected.map((v) => `${key} version ${v}`)} busy={busy} onCancel={() => setDialog(null)} onConfirm={() => void submit()} />
      )}
      {dialog && dialog !== "delete-versions" && (
        <Modal
          title={dialog === "tags" ? "Edit tags" : dialog === "copy" ? "Copy object" : "Edit storage class"}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="link" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void submit()} data-testid="action-submit">
                {busy ? "Working…" : dialog === "copy" ? "Copy" : "Save changes"}
              </Button>
            </>
          }
        >
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
          <FormFields fields={FIELDS[dialog]} values={values} onChange={(n: string, v: FieldValue) => setValues((prev) => ({ ...prev, [n]: v }))} />
        </Modal>
      )}
    </div>
  );
}
