/** AWS Database Migration Service: migration tasks, replication instances, endpoints, subnet groups. */

import type { ServiceDef } from "../../console/types.ts";
import { endpointResource, instanceResource, subnetGroupResource } from "./infra.ts";
import { taskResource } from "./tasks.ts";

export const dmsService: ServiceDef = {
  id: "dms",
  name: "AWS Database Migration Service",
  category: "Migration & Transfer",
  description: "Migrate databases to AWS quickly and securely, with minimal downtime.",
  resources: [taskResource, instanceResource, endpointResource, subnetGroupResource],
  notSupported: [
    "Stopping a migration task (StopReplicationTask)",
    "Modifying tasks, replication instances, endpoints or subnet groups (Modify* APIs)",
    "Rebooting a replication instance",
    "Testing endpoint connections (TestConnection, DescribeConnections) and refreshing schemas",
    "Tags (ListTagsForResource, AddTagsToResource)",
    "Events and event subscriptions",
    "Certificates",
    "Premigration assessments",
    "DMS Schema Conversion (data providers, instance profiles, migration projects)",
    "DMS Serverless replications (DescribeReplicationConfigs)",
  ],
};
