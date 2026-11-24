/**
 * Hand-built Step Functions execution page: the generic detail (summary, events, input,
 * output, actions) with the Graph view first, like the console.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, GenericDetailPage } from "@/console/ui/pages";
import { ExecutionGraph } from "@/services/stepfunctions/ExecutionGraph";
import { loadExecutionGraph } from "@/services/stepfunctions/page-data";

interface PageProps {
  params: Promise<{ arn: string }>;
}

export default async function ExecutionPage({ params }: PageProps) {
  const service = getService("stepfunctions");
  const resource = getResource("stepfunctions", "executions");
  if (!service || !resource) notFound();
  const arn = decodeSegment((await params).arn);
  const graph = await loadExecutionGraph(arn);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={arn}
      extraTabs={[{ id: "graph", label: "Graph view", content: <ExecutionGraph definition={graph.definition} events={graph.events} status={graph.status} error={graph.error} /> }]}
    />
  );
}
