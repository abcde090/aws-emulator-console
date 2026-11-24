/**
 * Hand-built CloudTrail Event history list (lookup attribute and time filters). Event
 * details (/cloudtrail/event-history/<id>) use the generic detail page.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { ServiceFrame } from "@/console/ui/pages";
import { lookupEvents } from "@/services/cloudtrail/event-actions";
import { EventHistory } from "@/services/cloudtrail/EventHistory";
import { LOOKUP_KEYS } from "@/services/cloudtrail/events";

export default async function EventHistoryPage() {
  const service = getService("cloudtrail");
  const resource = getResource("cloudtrail", "event-history");
  if (!service || !resource) notFound();
  const first = await lookupEvents({}, null);
  return (
    <ServiceFrame service={service} activeResource={resource.id} crumbs={[{ label: service.name, href: `/${service.id}` }, { label: resource.name }]}>
      <EventHistory initial={first.ok ? first.data : null} initialError={first.ok ? null : first.error} lookupKeys={LOOKUP_KEYS.map((k) => ({ value: k.value, label: k.label }))} />
    </ServiceFrame>
  );
}
