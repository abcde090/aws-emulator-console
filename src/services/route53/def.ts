/**
 * Amazon Route 53: hosted zones (with a hand-built records table and record editor on the
 * zone page, src/app/route53/hosted-zones/[zone]) and health checks.
 */

import type { ServiceDef } from "../../console/types.ts";
import { healthChecks } from "./health-checks.ts";
import { hostedZones } from "./hosted-zones.ts";

export const route53Service: ServiceDef = {
  id: "route53",
  name: "Route 53",
  category: "Networking & Content Delivery",
  description: "A reliable and cost-effective way to route end users to internet applications: DNS hosted zones, records and health checks.",
  resources: [hostedZones, healthChecks],
};
