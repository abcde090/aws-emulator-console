/**
 * Amazon EC2: the left navigation of the EC2 console (Instances, Images, Elastic Block Store,
 * Network & Security, Load Balancing, Auto Scaling). Instances are launched with the hand-built
 * wizard at /ec2/instances/create; key pairs are created at /ec2/key-pairs/create.
 */

import type { ServiceDef } from "../../console/types.ts";
import { autoScalingGroups } from "./auto-scaling.ts";
import { amiCatalog, amis } from "./images.ts";
import { instances } from "./instances.ts";
import { keyPairs } from "./key-pairs.ts";
import { loadBalancers, targetGroups } from "./load-balancing.ts";
import { elasticIps, networkInterfaces, placementGroups } from "./network.ts";
import { securityGroups } from "./security-groups.ts";
import { snapshots, volumes } from "./storage.ts";
import { launchTemplates } from "./templates.ts";

export const ec2Service: ServiceDef = {
  id: "ec2",
  name: "Amazon EC2",
  category: "Compute",
  description: "Secure and resizable virtual servers, block storage, load balancing and Auto Scaling.",
  resources: [
    instances,
    launchTemplates,
    amis,
    amiCatalog,
    volumes,
    snapshots,
    securityGroups,
    elasticIps,
    placementGroups,
    keyPairs,
    networkInterfaces,
    loadBalancers,
    targetGroups,
    autoScalingGroups,
  ],
  notSupported: [
    "Create image from an instance (CreateImage): use Register image from a snapshot instead",
    "Deregister AMI (DeregisterImage)",
  ],
};
