/** Hand-built change set page: review changes (with Replacement), then execute or delete. */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { decodeSegment, firstParam, ServiceFrame } from "@/console/ui/pages";
import { ChangeSetPanel } from "@/services/cloudformation/ChangeSetPanel";
import { describeChangeSet } from "@/services/cloudformation/stack-actions";

interface PageProps {
  params: Promise<{ stack: string; changeset: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ChangeSetPage({ params, searchParams }: PageProps) {
  const service = getService("cloudformation");
  if (!service) notFound();
  const p = await params;
  const stack = decodeSegment(p.stack);
  const changeSet = decodeSegment(p.changeset);
  if (changeSet === "create") notFound();
  const created = firstParam((await searchParams).created);
  const r = await describeChangeSet(stack, changeSet);
  return (
    <ServiceFrame
      service={service}
      activeResource="stacks"
      crumbs={[
        { label: service.name, href: "/cloudformation" },
        { label: "Stacks", href: "/cloudformation/stacks" },
        { label: stack, href: `/cloudformation/stacks/${encodeURIComponent(stack)}` },
        { label: "Change sets" },
        { label: changeSet },
      ]}
    >
      <ChangeSetPanel
        key={`${stack}/${changeSet}`}
        stack={stack}
        changeSet={changeSet}
        view={r.ok ? r.data : null}
        error={r.ok ? null : r.error}
        flash={r.ok && created ? `Created change set ${changeSet}. Review the changes, then execute it to update the stack.` : null}
      />
    </ServiceFrame>
  );
}
