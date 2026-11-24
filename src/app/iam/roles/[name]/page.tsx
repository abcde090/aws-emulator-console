/** IAM role page: the generic detail plus a hand-built Trust relationships editor (UpdateAssumeRolePolicy). */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { ErrorBanner } from "@/console/ui/primitives";
import { saveTrustPolicy } from "@/services/iam/editor-actions";
import { roleTrustPolicy } from "@/services/iam/page-data";
import { JsonEditor } from "@/services/iam/ui/JsonEditor";

interface PageProps {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RolePage({ params, searchParams }: PageProps) {
  const service = getService("iam");
  const resource = getResource("iam", "roles");
  if (!service || !resource) notFound();
  const name = decodeSegment((await params).name);
  if (name === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  const trust = await roleTrustPolicy(name);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={name}
      flash={created ? `Role ${created} created.` : null}
      extraTabs={[
        {
          id: "trust-editor",
          label: "Trust relationships",
          content: trust.ok ? (
            <JsonEditor
              title="Trusted entities"
              description="Entities that can assume this role under specified conditions."
              initial={trust.data}
              kind="trust"
              saveLabel="Update policy"
              save={saveTrustPolicy.bind(null, name)}
            />
          ) : (
            <ErrorBanner message={trust.error} />
          ),
        },
      ]}
    />
  );
}
