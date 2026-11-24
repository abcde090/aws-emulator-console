/**
 * Hand-built EKS cluster screen, in the console's tab order: Overview, Compute, Networking,
 * Add-ons, Access, Observability, Update history, Upgrade insights, Tags. Compute, Add-ons
 * and Access list the cluster's child resources with links; the rest come from get().
 * /eks/clusters/create is still the generic form.
 */

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { toResourceMeta } from "@/console/meta";
import { getResource, getService } from "@/console/registry";
import { errorMessage } from "@/console/serialize";
import { engineGet, makeCtx } from "@/console/server";
import type { DetailTab, Result, Row } from "@/console/types";
import { TabBody } from "@/console/ui/DetailTabs";
import { decodeSegment, firstParam, GenericCreatePage, ServiceFrame } from "@/console/ui/pages";
import { Container } from "@/console/ui/primitives";
import { ResourceDetail } from "@/console/ui/ResourceDetail";
import { ACCESS_ENTRY_COLUMNS, accessEntryRows, POD_IDENTITY_COLUMNS, podIdentityRows } from "@/services/eks/access";
import { ADDON_COLUMNS, addonRows } from "@/services/eks/addons";
import { ChildTable, withoutCluster } from "@/services/eks/ClusterTabs";
import { NODEGROUP_COLUMNS, nodegroupRows } from "@/services/eks/nodegroups";

interface PageProps {
  params: Promise<{ cluster: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function load(fn: () => Promise<Row[]>): Promise<Result<Row[]>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function engineTab(tab: DetailTab): ReactNode {
  return (
    <Container title={tab.label} description={tab.description}>
      <TabBody tab={tab} />
    </Container>
  );
}

const ORDER = ["overview", "compute", "networking", "addons", "access", "observability", "updates", "insights", "tags"];

export default async function ClusterPage({ params, searchParams }: PageProps) {
  const service = getService("eks");
  const resource = getResource("eks", "clusters");
  if (!service || !resource) notFound();
  const name = decodeSegment((await params).cluster);
  if (name === "create") return <GenericCreatePage service={service} resource={resource} />;

  const query = await searchParams;
  const created = firstParam(query.created);
  const detail = await engineGet("eks", "clusters", name);
  const tabs: { id: string; label: string; content: ReactNode }[] = [];

  if (detail.ok) {
    const ctx = await makeCtx();
    const [ngs, addons, entries, pods] = await Promise.all([
      load(() => nodegroupRows(ctx, name)),
      load(() => addonRows(ctx, name)),
      load(() => accessEntryRows(ctx, name)),
      load(() => podIdentityRows(ctx, name)),
    ]);
    const custom: Record<string, { label: string; content: ReactNode }> = {
      compute: {
        label: "Compute",
        content: (
          <div className="space-y-4">
            <ChildTable
              title="Node groups"
              description="Managed node groups run your pods on EC2 instances in an Auto Scaling group."
              result={ngs}
              columns={withoutCluster(NODEGROUP_COLUMNS)}
              resourceId="node-groups"
              cluster={name}
              addLabel="Add node group"
              emptyText="This cluster has no node groups."
              testId="cluster-nodegroups"
            />
            <Container title="Fargate profiles" description="Fargate profiles choose which pods run on AWS Fargate.">
              <p>
                AWS Emulator doesn&apos;t support listing Fargate profiles yet (ListFargateProfiles). Use <strong>Actions › Add Fargate profile</strong>,{" "}
                <strong>View Fargate profile</strong> or <strong>Delete Fargate profile</strong> with a profile name.
              </p>
            </Container>
          </div>
        ),
      },
      addons: {
        label: "Add-ons",
        content: (
          <ChildTable title="Add-ons" result={addons} columns={withoutCluster(ADDON_COLUMNS)} resourceId="add-ons" cluster={name} addLabel="Get more add-ons" emptyText="This cluster has no add-ons." testId="cluster-addons" />
        ),
      },
      access: {
        label: "Access",
        content: (
          <div className="space-y-4">
            <ChildTable
              title="IAM access entries"
              description="IAM principals that can reach this cluster's Kubernetes API."
              result={entries}
              columns={withoutCluster(ACCESS_ENTRY_COLUMNS)}
              resourceId="access-entries"
              cluster={name}
              addLabel="Create access entry"
              emptyText="No access entries."
              testId="cluster-access-entries"
            />
            <ChildTable
              title="Pod Identity associations"
              result={pods}
              columns={withoutCluster(POD_IDENTITY_COLUMNS)}
              resourceId="pod-identity-associations"
              cluster={name}
              addLabel="Create Pod Identity association"
              emptyText="No Pod Identity associations."
              testId="cluster-pod-identity"
            />
          </div>
        ),
      },
    };
    const fromGet = new Map((detail.data.tabs ?? []).map((t) => [t.id, t]));
    for (const id of ORDER) {
      const own = custom[id];
      const tab = fromGet.get(id);
      if (own) tabs.push({ id, label: own.label, content: own.content });
      else if (tab) tabs.push({ id, label: tab.label, content: engineTab(tab) });
    }
  }

  return (
    <ServiceFrame
      service={service}
      activeResource="clusters"
      crumbs={[
        { label: service.name, href: "/eks" },
        { label: resource.name, href: "/eks/clusters" },
        { label: name },
      ]}
    >
      <ResourceDetail
        serviceId="eks"
        resource={toResourceMeta(resource)}
        id={name}
        detail={detail.ok ? { ...detail.data, tabs: [] } : null}
        error={detail.ok ? null : detail.error}
        flash={detail.ok && created ? `Created cluster ${created}.` : null}
        extraTabs={tabs}
      />
    </ServiceFrame>
  );
}
