/**
 * Server components for the generic screens. The generic route and hand-built routes
 * (e.g. the S3 bucket page) both use these, so every screen gets the same frame.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { toResourceMeta, toServiceMeta } from "../meta.ts";
import { engineFields, engineGet, engineList } from "../server.ts";
import type { ResourceDef, ServiceDef } from "../types.ts";
import { CreateForm } from "./CreateForm.tsx";
import type { ExtraTab } from "./DetailTabs.tsx";
import { RecordVisit } from "./RecordVisit.tsx";
import { ResourceDetail } from "./ResourceDetail.tsx";
import { ResourceTable } from "./ResourceTable.tsx";
import { ServiceSidebar } from "./ServiceSidebar.tsx";
import { ErrorBanner } from "./primitives.tsx";

export interface Crumb {
  label: string;
  href?: string;
}

export function ServiceFrame({ service, activeResource, crumbs, children }: { service: ServiceDef; activeResource?: string; crumbs: Crumb[]; children: ReactNode }) {
  const meta = toServiceMeta(service);
  return (
    <div className="flex min-h-[calc(100vh-40px)] bg-page">
      <RecordVisit serviceId={service.id} name={service.name} />
      <ServiceSidebar meta={meta} activeResource={activeResource} />
      <div className="min-w-0 flex-1">
        <nav
          aria-label="Breadcrumbs"
          className="flex flex-wrap items-center gap-1.5 border-b border-line-soft bg-white px-6 py-2 text-[12px]"
        >
          <Link href="/" className="text-link hover:text-link-hover">
            Console Home
          </Link>
          {crumbs.map((c, i) => (
            <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
              <span className="text-[#aab7b8]" aria-hidden="true">›</span>
              {c.href ? (
                <Link href={c.href} className="text-link hover:text-link-hover">
                  {c.label}
                </Link>
              ) : (
                <span className="font-medium text-ink">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}

function baseCrumbs(service: ServiceDef, resource: ResourceDef): Crumb[] {
  return [
    { label: service.name, href: `/${service.id}` },
    { label: resource.name, href: `/${service.id}/${resource.id}` },
  ];
}

export async function GenericListPage({ service, resource, flash }: { service: ServiceDef; resource: ResourceDef; flash?: string | null }) {
  const r = await engineList(service.id, resource.id);
  // The "deleted" note comes from the URL, so it is only shown when the list agrees.
  const deletedFlash = flash && r.ok && !r.data.some((row) => String(row[resource.idField]) === flash) ? `Deleted ${resource.singular} ${flash}.` : null;
  return (
    <ServiceFrame service={service} activeResource={resource.id} crumbs={[{ label: service.name, href: `/${service.id}` }, { label: resource.name }]}>
      <ResourceTable serviceId={service.id} resource={toResourceMeta(resource)} initialRows={r.ok ? r.data : []} initialError={r.ok ? null : r.error} flash={deletedFlash} />
    </ServiceFrame>
  );
}

export async function GenericCreatePage({ service, resource }: { service: ServiceDef; resource: ResourceDef }) {
  const fields = await engineFields(service.id, resource.id, "create");
  return (
    <ServiceFrame service={service} activeResource={resource.id} crumbs={[...baseCrumbs(service, resource), { label: resource.create?.title ?? "Create" }]}>
      {fields.ok ? <CreateForm serviceId={service.id} resource={toResourceMeta(resource)} fields={fields.data} /> : <ErrorBanner message={fields.error} />}
    </ServiceFrame>
  );
}

export async function GenericDetailPage({
  service,
  resource,
  id,
  flash,
  extraTabs,
}: {
  service: ServiceDef;
  resource: ResourceDef;
  id: string;
  flash?: string | null;
  extraTabs?: ExtraTab[];
}) {
  const r = resource.get ? await engineGet(service.id, resource.id, id) : null;
  return (
    <ServiceFrame service={service} activeResource={resource.id} crumbs={[...baseCrumbs(service, resource), { label: id }]}>
      <ResourceDetail
        serviceId={service.id}
        resource={toResourceMeta(resource)}
        id={id}
        detail={r?.ok ? r.data : null}
        error={r && !r.ok ? r.error : null}
        flash={r?.ok ? flash : null}
        extraTabs={extraTabs}
      />
    </ServiceFrame>
  );
}

export { decodeSegment } from "../meta.ts";

export function firstParam(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] ?? null : null;
}
