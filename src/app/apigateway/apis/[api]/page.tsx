/**
 * Hand-built API page: summary and read-only tabs come from the definition's get(); the
 * editors are hand-built. REST APIs get Resources and Stages; HTTP and WebSocket APIs get
 * Routes, Integrations and Stages. /apigateway/apis/create stays the generic form.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { findApi } from "@/services/apigateway/common";
import { clients } from "@/lib/aws";
import { HttpApiPanel } from "@/services/apigateway/HttpApiPanels";
import { loadV2Api } from "@/services/apigateway/http-actions";
import { listLambdaOptions, listRestResources, listRestStages } from "@/services/apigateway/rest-actions";
import { RestResources } from "@/services/apigateway/RestResources";
import { RestStages } from "@/services/apigateway/RestStages";

interface PageProps {
  params: Promise<{ api: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function apiKind(id: string): Promise<"rest" | "v2" | null> {
  try {
    return (await findApi(clients, id)).kind;
  } catch {
    // The generic detail page shows the same error from get(); no editor tabs then.
    return null;
  }
}

export default async function ApiPage({ params, searchParams }: PageProps) {
  const service = getService("apigateway");
  const resource = getResource("apigateway", "apis");
  if (!service || !resource) notFound();
  const id = decodeSegment((await params).api);
  if (id === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  const flash = created ? `Created API ${created}.` : null;

  const kind = /^[A-Za-z0-9]{1,64}$/.test(id) ? await apiKind(id) : null;
  if (kind === null) return <GenericDetailPage service={service} resource={resource} id={id} flash={flash} />;

  const lambda = await listLambdaOptions();
  const lambdaOptions = lambda.ok ? lambda.data : [];
  const lambdaError = lambda.ok ? null : `choices could not be loaded: ${lambda.error}`;

  if (kind === "rest") {
    const [res, stages] = await Promise.all([listRestResources(id), listRestStages(id)]);
    return (
      <GenericDetailPage
        service={service}
        resource={resource}
        id={id}
        flash={flash}
        extraTabs={[
          {
            id: "resources",
            label: "Resources",
            content: <RestResources apiId={id} initial={res.ok ? res.data : null} initialError={res.ok ? null : res.error} lambda={lambdaOptions} lambdaError={lambdaError} />,
          },
          { id: "stages", label: "Stages", content: <RestStages apiId={id} initial={stages.ok ? stages.data : null} initialError={stages.ok ? null : stages.error} /> },
        ]}
      />
    );
  }

  const v2 = await loadV2Api(id);
  const common = { apiId: id, initial: v2.ok ? v2.data : null, initialError: v2.ok ? null : v2.error, lambda: lambdaOptions, lambdaError };
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={id}
      flash={flash}
      extraTabs={[
        { id: "routes", label: "Routes", content: <HttpApiPanel panel="routes" {...common} /> },
        { id: "integrations", label: "Integrations", content: <HttpApiPanel panel="integrations" {...common} /> },
        { id: "stages", label: "Stages", content: <HttpApiPanel panel="stages" {...common} /> },
      ]}
    />
  );
}
