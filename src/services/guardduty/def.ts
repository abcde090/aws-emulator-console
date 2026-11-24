/**
 * Amazon GuardDuty: findings, the Region's detector (Settings), suppression rules, trusted IP
 * and threat lists, and publishing destinations. Every value comes from a GuardDuty response.
 */

import type { ServiceDef } from "../../console/types.ts";
import { findings } from "./findings.ts";
import { publishingDestinations, suppressionRules, threatLists, trustedIpLists } from "./lists.ts";
import { settings } from "./settings.ts";

export const guarddutyService: ServiceDef = {
  id: "guardduty",
  name: "Amazon GuardDuty",
  category: "Security, Identity, & Compliance",
  description: "Intelligent threat detection that continuously monitors accounts and workloads for malicious activity.",
  resources: [findings, settings, suppressionRules, trustedIpLists, threatLists, publishingDestinations],
};
