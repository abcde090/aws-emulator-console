/**
 * Amazon CloudFront: distributions (origins, behaviors, invalidations), policies and
 * origin access controls. Every value comes from a CloudFront (or S3, for bucket choices
 * and bucket policies) API response.
 */

import type { ServiceDef } from "../../console/types.ts";
import { distributions } from "./distributions.ts";
import { originAccessControls } from "./oac.ts";
import { cachePolicies, originRequestPolicies, responseHeadersPolicies } from "./policies.ts";

export const cloudfrontService: ServiceDef = {
  id: "cloudfront",
  name: "Amazon CloudFront",
  category: "Networking & Content Delivery",
  description: "Content delivery network that serves content from edge locations with low latency.",
  resources: [distributions, cachePolicies, originRequestPolicies, responseHeadersPolicies, originAccessControls],
  notSupported: ["VPC origins (ListVpcOrigins is not implemented)"],
};
