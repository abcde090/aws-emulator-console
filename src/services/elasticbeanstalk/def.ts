/**
 * AWS Elastic Beanstalk: applications, environments (create, deploy, health, events, logs,
 * configuration), application versions and saved configurations. Engine screens only.
 */

import type { ServiceDef } from "../../console/types.ts";
import { applicationsResource } from "./applications.ts";
import { environmentsResource } from "./environments.ts";
import { templatesResource } from "./templates.ts";
import { versionsResource } from "./versions.ts";

export const elasticbeanstalkService: ServiceDef = {
  id: "elasticbeanstalk",
  name: "AWS Elastic Beanstalk",
  category: "Compute",
  description: "Deploy and scale web applications without managing the infrastructure underneath.",
  resources: [applicationsResource, environmentsResource, versionsResource, templatesResource],
};
