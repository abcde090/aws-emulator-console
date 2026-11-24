/** Hand-built trace detail: the segments timeline first, then the generic tabs. */

import { BatchGetTracesCommand } from "@aws-sdk/client-xray";
import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { makeCtx } from "@/console/server";
import { decodeSegment, GenericDetailPage } from "@/console/ui/pages";
import { timelineRows, type TimelineRow } from "@/services/xray/helpers";
import { TraceTimeline } from "@/services/xray/TraceTimeline";

async function rows(id: string): Promise<TimelineRow[]> {
  try {
    const ctx = await makeCtx();
    const r = await ctx.clients.xray.send(new BatchGetTracesCommand({ TraceIds: [id] }));
    return timelineRows((r.Traces?.[0]?.Segments ?? []).map((s) => s.Document ?? ""));
  } catch {
    // The summary panel shows the BatchGetTraces error.
    return [];
  }
}

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const service = getService("xray");
  const resource = getResource("xray", "traces");
  if (!service || !resource) notFound();
  const id = decodeSegment((await params).id);
  return <GenericDetailPage service={service} resource={resource} id={id} extraTabs={[{ id: "timeline", label: "Timeline", content: <TraceTimeline rows={await rows(id)} /> }]} />;
}
