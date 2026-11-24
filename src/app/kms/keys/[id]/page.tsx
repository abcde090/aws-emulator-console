/** KMS customer managed key page: the generic detail plus a hand-built key policy editor. */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { ErrorBanner } from "@/console/ui/primitives";
import { JsonEditor } from "@/services/iam/ui/JsonEditor";
import { readKeyPolicy, saveKeyPolicy } from "@/services/kms/policy-actions";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function KeyPage({ params, searchParams }: PageProps) {
  const service = getService("kms");
  const resource = getResource("kms", "keys");
  if (!service || !resource) notFound();
  const id = decodeSegment((await params).id);
  if (id === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  const policy = await readKeyPolicy(id);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={id}
      flash={created ? `Created key ${created}.` : null}
      extraTabs={[
        {
          id: "key-policy",
          label: "Key policy",
          content: policy.ok ? (
            <JsonEditor
              title="Key policy"
              description="The resource policy that controls access to this key. It must allow the account root (or you lose access through IAM)."
              initial={policy.data.text}
              kind="resource"
              saveLabel="Save changes"
              save={saveKeyPolicy.bind(null, id)}
              readOnlyReason={policy.data.awsManaged ? "AWS managed key policies can't be changed." : undefined}
            />
          ) : (
            <ErrorBanner message={policy.error} />
          ),
        },
      ]}
    />
  );
}
