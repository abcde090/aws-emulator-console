/** IAM managed policy page: the generic detail plus a hand-built policy editor (CreatePolicyVersion, set as default). */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { ErrorBanner } from "@/console/ui/primitives";
import { savePolicyVersion } from "@/services/iam/editor-actions";
import { managedPolicyText } from "@/services/iam/page-data";
import { JsonEditor } from "@/services/iam/ui/JsonEditor";

interface PageProps {
  params: Promise<{ arn: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PolicyPage({ params, searchParams }: PageProps) {
  const service = getService("iam");
  const resource = getResource("iam", "policies");
  if (!service || !resource) notFound();
  const arn = decodeSegment((await params).arn);
  if (arn === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  const doc = await managedPolicyText(arn);
  const awsManaged = arn.startsWith("arn:aws:iam::aws:policy/");
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={arn}
      flash={created ? `Policy ${created.replace(/^.*:policy\//, "")} created.` : null}
      extraTabs={[
        {
          id: "editor",
          label: "Permissions defined in this policy",
          content: doc.ok ? (
            <JsonEditor
              title={`Policy document (${doc.data.version})`}
              description="Editing saves a new version and sets it as the default."
              initial={doc.data.text}
              kind="identity"
              saveLabel="Save changes"
              save={savePolicyVersion.bind(null, arn)}
              readOnlyReason={awsManaged ? "AWS managed policies are maintained by AWS and can't be edited." : undefined}
            />
          ) : (
            <ErrorBanner message={doc.error} />
          ),
        },
      ]}
    />
  );
}
