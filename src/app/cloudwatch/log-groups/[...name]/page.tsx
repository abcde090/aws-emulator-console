/**
 * Hand-built log group page. Log group names contain "/", so this is a catch-all route:
 * /cloudwatch/log-groups/%2Faws%2Flambda%2Ffn and /cloudwatch/log-groups/aws/lambda/fn both work.
 */

import { DescribeLogStreamsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { makeCtx } from "@/console/server";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { LogEventsViewer } from "@/services/cloudwatch/LogEventsViewer";

interface PageProps {
  params: Promise<{ name: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function streamNames(group: string): Promise<string[]> {
  try {
    const ctx = await makeCtx();
    const r = await ctx.clients.logs.send(new DescribeLogStreamsCommand({ logGroupName: group, orderBy: "LastEventTime", descending: true, limit: 50 }));
    return (r.logStreams ?? []).map((s) => s.logStreamName ?? "").filter(Boolean);
  } catch {
    // The detail panel above shows the error from DescribeLogGroups/DescribeLogStreams.
    return [];
  }
}

export default async function LogGroupPage({ params, searchParams }: PageProps) {
  const service = getService("cloudwatch");
  const resource = getResource("cloudwatch", "log-groups");
  if (!service || !resource) notFound();
  const segments = (await params).name.map(decodeSegment);
  const name = segments.join("/");
  if (name === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  const streams = await streamNames(name);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={name}
      flash={created ? `Created log group ${created}.` : null}
      extraTabs={[{ id: "events", label: "Log events", content: <LogEventsViewer group={name} streams={streams} /> }]}
    />
  );
}
