/** Hand-built service page: the summary, then the quota table with Request increase. */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { makeCtx } from "@/console/server";
import { errorMessage } from "@/console/serialize";
import { decodeSegment, GenericDetailPage } from "@/console/ui/pages";
import { ErrorBanner } from "@/console/ui/primitives";
import type { QuotaRow } from "@/services/servicequotas/helpers";
import { quotasFor } from "@/services/servicequotas/quotas";
import { QuotaTable } from "@/services/servicequotas/QuotaTable";

export default async function ServiceQuotasPage({ params }: { params: Promise<{ code: string }> }) {
  const service = getService("servicequotas");
  const resource = getResource("servicequotas", "services");
  if (!service || !resource) notFound();
  const code = decodeSegment((await params).code);
  let quotas: QuotaRow[] = [];
  let error: string | null = null;
  try {
    quotas = await quotasFor(await makeCtx(), code);
  } catch (err: unknown) {
    error = errorMessage(err);
  }
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={code}
      extraTabs={[{ id: "quotas", label: "Service quotas", content: error ? <ErrorBanner message={error} /> : <QuotaTable serviceCode={code} quotas={quotas} /> }]}
    />
  );
}
