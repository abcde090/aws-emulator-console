/**
 * Hand-built Step Functions state machine page: the generic detail (summary, states,
 * logging, versions, tags, actions) plus an Executions list that links to each execution
 * and an Amazon States Language editor. /stepfunctions/state-machines/create stays generic.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { DefinitionEditor } from "@/services/stepfunctions/DefinitionEditor";
import { ExecutionsPanel } from "@/services/stepfunctions/ExecutionsPanel";
import { loadStateMachinePage } from "@/services/stepfunctions/page-data";

interface PageProps {
  params: Promise<{ arn: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StateMachinePage({ params, searchParams }: PageProps) {
  const service = getService("stepfunctions");
  const resource = getResource("stepfunctions", "state-machines");
  if (!service || !resource) notFound();
  const arn = decodeSegment((await params).arn);
  if (arn === "create") return <GenericCreatePage service={service} resource={resource} />;

  const data = await loadStateMachinePage(arn);
  const created = firstParam((await searchParams).created);
  const extraTabs = data.definitionError
    ? []
    : [
        { id: "executions", label: "Executions", content: <ExecutionsPanel rows={data.executions} error={data.executionsError} express={data.express} /> },
        { id: "editor", label: "Edit definition", content: <DefinitionEditor key={data.definition ?? ""} arn={arn} initial={data.definition ?? ""} /> },
      ];
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={arn}
      flash={created ? `Created state machine ${created.slice(created.lastIndexOf(":") + 1)}.` : null}
      extraTabs={extraTabs}
    />
  );
}
