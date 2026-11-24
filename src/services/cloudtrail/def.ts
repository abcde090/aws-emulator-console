/**
 * AWS CloudTrail: event history (hand-built list with lookup filters), trails and CloudTrail
 * Lake event data stores. Every value comes from a CloudTrail API response.
 */

import type { ServiceDef } from "../../console/types.ts";
import { eventHistory } from "./events.ts";
import { eventDataStores } from "./lake.ts";
import { trails } from "./trails.ts";

export const cloudtrailService: ServiceDef = {
  id: "cloudtrail",
  name: "AWS CloudTrail",
  category: "Management & Governance",
  description: "Records user activity and API calls across your account for auditing, governance and compliance.",
  resources: [eventHistory, trails, eventDataStores],
};
