/**
 * AWS Config: rules (with remediation), resource inventory and timelines, conformance packs,
 * aggregators, advanced queries and the recorder settings. Every value comes from a Config API response.
 */

import type { ServiceDef } from "../../console/types.ts";
import { aggregators, conformancePacks, queries } from "./packs.ts";
import { resources } from "./resources.ts";
import { rules } from "./rules.ts";
import { settings } from "./settings.ts";

export const configService: ServiceDef = {
  id: "config",
  name: "AWS Config",
  category: "Management & Governance",
  description: "Records resource configurations, evaluates them against rules and tracks compliance over time.",
  resources: [rules, resources, conformancePacks, aggregators, queries, settings],
};
