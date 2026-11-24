/**
 * Amazon RDS: databases (DB instances and Aurora clusters together), snapshots, subnet
 * groups, parameter groups, option groups and events. All generic engine screens.
 */

import type { ServiceDef } from "../../console/types.ts";
import { databasesResource } from "./databases.ts";
import { eventsResource, optionGroupsResource, parameterGroupsResource, subnetGroupsResource } from "./groups.ts";
import { snapshotsResource } from "./snapshots.ts";

export const rdsService: ServiceDef = {
  id: "rds",
  name: "Amazon RDS",
  category: "Database",
  description: "Managed relational databases: Aurora, PostgreSQL, MySQL, MariaDB, Oracle, SQL Server and Db2.",
  resources: [databasesResource, snapshotsResource, subnetGroupsResource, parameterGroupsResource, optionGroupsResource, eventsResource],
  notSupported: [
    "Listing an engine's available options (DescribeOptionGroupOptions returns NotImplemented), so Add option takes the option name as text",
    "CloudWatch metrics for databases (the AWS/RDS namespace has no datapoints)",
  ],
};
