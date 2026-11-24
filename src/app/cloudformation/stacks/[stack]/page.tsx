/**
 * Stack detail. The engine's detail page with the definition's tabs in the console's order;
 * only the Change sets tab is hand-built (its names open the change set page).
 */

import { notFound } from "next/navigation";
import { toResourceMeta } from "@/console/meta";
import { getResource, getService } from "@/console/registry";
import { engineGet } from "@/console/server";
import { TabBody } from "@/console/ui/DetailTabs";
import { decodeSegment, firstParam, ServiceFrame } from "@/console/ui/pages";
import { Container } from "@/console/ui/primitives";
import { ResourceDetail } from "@/console/ui/ResourceDetail";
import { ChangeSetsTab } from "@/services/cloudformation/ChangeSetsTab";
import { UpdateStackMenu } from "@/services/cloudformation/UpdateStackMenu";

interface PageProps {
  params: Promise<{ stack: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StackPage({ params, searchParams }: PageProps) {
  const service = getService("cloudformation");
  const resource = getResource("cloudformation", "stacks");
  if (!service || !resource) notFound();
  const stack = decodeSegment((await params).stack);
  const query = await searchParams;
  const created = firstParam(query.created);
  const updated = firstParam(query.updated);
  const r = await engineGet("cloudformation", "stacks", stack);
  const tabs = r.ok ? r.data.tabs ?? [] : [];
  const extraTabs = tabs.map((t) => ({
    id: t.id,
    label: t.label,
    content:
      t.id === "changesets" ? (
        <ChangeSetsTab stack={stack} tab={t} />
      ) : (
        <Container title={t.label} description={t.description}>
          <TabBody tab={t} />
        </Container>
      ),
  }));
  return (
    <ServiceFrame
      service={service}
      activeResource="stacks"
      crumbs={[
        { label: service.name, href: "/cloudformation" },
        { label: resource.name, href: "/cloudformation/stacks" },
        { label: stack },
      ]}
    >
      <ResourceDetail
        serviceId="cloudformation"
        resource={toResourceMeta(resource)}
        id={stack}
        detail={r.ok ? { ...r.data, tabs: [] } : null}
        error={r.ok ? null : r.error}
        flash={
          r.ok && created
            ? `Created stack ${created}. CloudFormation is provisioning its resources; see the Events tab.`
            : r.ok && updated
              ? `Update started for ${stack}. CloudFormation is updating its resources; see the Events tab.`
              : null
        }
        extraTabs={extraTabs}
        headerActions={r.ok ? <UpdateStackMenu stack={stack} /> : null}
      />
    </ServiceFrame>
  );
}
