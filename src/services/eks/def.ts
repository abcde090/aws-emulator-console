/**
 * Amazon EKS: clusters, managed node groups, add-ons, access entries and Pod Identity
 * associations. Child resources use "<cluster>/<name>" ids; the hand-built cluster screen
 * (src/app/eks/clusters/[cluster]) shows them on its Compute, Add-ons and Access tabs.
 */

import type { ServiceDef } from "../../console/types.ts";
import { accessEntries, podIdentity } from "./access.ts";
import { addons } from "./addons.ts";
import { clusters } from "./clusters.ts";
import { nodegroups } from "./nodegroups.ts";

export const eksService: ServiceDef = {
  id: "eks",
  name: "Amazon Elastic Kubernetes Service",
  category: "Containers",
  description: "Managed Kubernetes control planes, node groups and add-ons on AWS.",
  resources: [clusters, nodegroups, addons, accessEntries, podIdentity],
  notSupported: [
    "Listing Fargate profiles (ListFargateProfiles): add, view and delete a profile by name from the cluster's Actions menu",
    "Identity provider configs (ListIdentityProviderConfigs)"
  ],
};
