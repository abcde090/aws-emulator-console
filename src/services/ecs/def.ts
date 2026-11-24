/**
 * Amazon Elastic Container Service: clusters (Fargate), services, tasks, task definitions
 * and account settings. Services and tasks belong to a cluster; their ids are
 * "<cluster>/<name>". Cluster, service and task definition detail screens are hand-built
 * (src/app/ecs/...) to add the linked Services / Tasks / Revisions tabs.
 */

import type { ServiceDef } from "../../console/types.ts";
import { accountSettings } from "./account-settings.ts";
import { clusters } from "./clusters.ts";
import { services } from "./services.ts";
import { taskDefinitions } from "./task-definitions.ts";
import { tasks } from "./tasks.ts";

export const ecsService: ServiceDef = {
  id: "ecs",
  name: "Amazon Elastic Container Service",
  category: "Containers",
  description: "Run and scale containerized applications on AWS Fargate with clusters, services, tasks and task definitions.",
  resources: [clusters, services, tasks, taskDefinitions, accountSettings],
  notSupported: [
    "Registering service tasks in load balancer target groups (DescribeTargetHealth stays empty, so target health shows no targets)",
    "Delivering container logs to CloudWatch Logs (awslogs log groups and streams are not created)",
  ],
};
