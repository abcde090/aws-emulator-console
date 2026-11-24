/**
 * The S3 object page: /s3/buckets/<bucket>/object?key=<key>[&versionId=<id>].
 * Object keys may contain any character, so the key travels in the query string.
 */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { decodeSegment, firstParam, ServiceFrame } from "@/console/ui/pages";
import { ErrorBanner } from "@/console/ui/primitives";
import { getObjectDetail } from "@/services/s3/object-detail";
import { ObjectPage } from "@/services/s3/ObjectPage";

interface PageProps {
  params: Promise<{ bucket: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function S3ObjectPage({ params, searchParams }: PageProps) {
  const service = getService("s3");
  if (!service) notFound();
  const bucket = decodeSegment((await params).bucket);
  const query = await searchParams;
  const key = firstParam(query.key) ?? "";
  const versionId = firstParam(query.versionId);
  const folder = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
  const bucketHref = `/s3/buckets/${encodeURIComponent(bucket)}`;
  const crumbs = [
    { label: service.name, href: "/s3" },
    { label: "Buckets", href: "/s3/buckets" },
    { label: bucket, href: bucketHref },
    ...(folder ? [{ label: folder, href: `${bucketHref}?prefix=${encodeURIComponent(folder)}` }] : []),
    { label: key.slice(folder.length) || "Object" },
  ];
  const r = key ? await getObjectDetail(bucket, key, versionId) : { ok: false as const, error: "No object key given." };
  return (
    <ServiceFrame service={service} activeResource="buckets" crumbs={crumbs}>
      {r.ok ? <ObjectPage key={`${key}|${versionId ?? ""}`} detail={r.data} versionId={versionId} /> : <ErrorBanner message={r.error} />}
    </ServiceFrame>
  );
}
