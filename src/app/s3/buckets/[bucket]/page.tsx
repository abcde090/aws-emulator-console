/**
 * Hand-built S3 bucket screen: the Objects browser first, then the Properties and
 * Permissions tabs from the bucket definition, then the Management tab (lifecycle,
 * replication and inventory). /s3/buckets/create is still the generic form.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { bucketVersioning, listObjects } from "@/services/s3/object-actions";
import { ObjectBrowser } from "@/services/s3/ObjectBrowser";
import { ManagementTab } from "@/services/s3/ManagementTab";
import { loadManagement } from "@/services/s3/management-data";
import { normalisePrefix } from "@/services/s3/object-paths";

interface PageProps {
  params: Promise<{ bucket: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BucketPage({ params, searchParams }: PageProps) {
  const service = getService("s3");
  const resource = getResource("s3", "buckets");
  if (!service || !resource) notFound();
  const bucket = decodeSegment((await params).bucket);
  if (bucket === "create") return <GenericCreatePage service={service} resource={resource} />;

  const query = await searchParams;
  const prefix = normalisePrefix(firstParam(query.prefix) ?? "");
  const [listing, versioning, management] = await Promise.all([listObjects(bucket, prefix), bucketVersioning(bucket), loadManagement(bucket)]);
  const created = firstParam(query.created);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={bucket}
      flash={created ? `Created bucket ${created}.` : null}
      extraTabs={[
        {
          id: "objects",
          label: "Objects",
          content: <ObjectBrowser key={prefix} bucket={bucket} prefix={prefix} initial={listing.ok ? listing.data : null} initialError={listing.ok ? null : listing.error} versioning={versioning.ok ? versioning.data : null} />,
        },
        {
          id: "management",
          label: "Management",
          after: "$end",
          content: <ManagementTab bucket={bucket} data={management} versioning={versioning.ok ? versioning.data : null} />,
        },
      ]}
    />
  );
}
