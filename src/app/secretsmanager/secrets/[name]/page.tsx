/** Secrets Manager secret page: Overview with Retrieve secret value, resource permissions editor, then the generic tabs. */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { ErrorBanner } from "@/console/ui/primitives";
import { JsonEditor } from "@/services/iam/ui/JsonEditor";
import { SecretValuePanel } from "@/services/secretsmanager/SecretValuePanel";
import { readResourcePolicy, removeResourcePolicy, saveResourcePolicy } from "@/services/secretsmanager/value-actions";

interface PageProps {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SecretPage({ params, searchParams }: PageProps) {
  const service = getService("secretsmanager");
  const resource = getResource("secretsmanager", "secrets");
  if (!service || !resource) notFound();
  const name = decodeSegment((await params).name);
  if (name === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  const policy = await readResourcePolicy(name);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={name}
      flash={created ? `Secret ${created} stored.` : null}
      extraTabs={[
        { id: "overview", label: "Overview", content: <SecretValuePanel name={name} /> },
        {
          id: "resource-permissions",
          label: "Resource permissions",
          content: policy.ok ? (
            <JsonEditor
              title="Resource permissions"
              description="A resource-based policy that controls which principals can access this secret. Policies that grant public access are blocked."
              initial={policy.data}
              kind="resource"
              saveLabel="Save"
              save={saveResourcePolicy.bind(null, name)}
              remove={{ label: "Delete", run: removeResourcePolicy.bind(null, name) }}
            />
          ) : (
            <ErrorBanner message={policy.error} />
          ),
        },
      ]}
    />
  );
}
