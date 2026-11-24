/**
 * Hand-built Athena query editor. The rest of Athena (saved queries, workgroups, data
 * sources, and /athena/query-editor/<execution id>) uses the generic engine pages.
 */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { ServiceFrame } from "@/console/ui/pages";
import { PageHeader } from "@/console/ui/primitives";
import { loadEditorContext } from "@/services/athena/editor-actions";
import { QueryEditor } from "@/services/athena/QueryEditor";

export default async function QueryEditorPage() {
  const service = getService("athena");
  if (!service) notFound();
  const context = await loadEditorContext();
  return (
    <ServiceFrame service={service} activeResource="query-editor" crumbs={[{ label: service.name, href: "/athena" }, { label: "Query editor" }]}>
      <PageHeader title="Query editor" description="Run SQL against your AWS Glue Data Catalog tables. Each query's results are stored in the workgroup's S3 result location." />
      <QueryEditor context={context.ok ? context.data : null} contextError={context.ok ? null : context.error} />
    </ServiceFrame>
  );
}
