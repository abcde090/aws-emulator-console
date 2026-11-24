/** Amazon Redshift (provisioned): clusters, snapshots, subnet groups, parameter groups, events. */

import type { ServiceDef } from "../../console/types.ts";
import { clusterResource } from "./clusters.ts";
import { eventResource, parameterGroupResource, snapshotResource, subnetGroupResource } from "./configs.ts";

export const redshiftService: ServiceDef = {
  id: "redshift",
  name: "Amazon Redshift",
  category: "Database",
  description: "Fast, fully managed, petabyte-scale cloud data warehouse.",
  resources: [clusterResource, snapshotResource, subnetGroupResource, parameterGroupResource, eventResource],
};
