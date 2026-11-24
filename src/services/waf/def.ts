/**
 * AWS WAF (WAFV2, Regional and Global / CloudFront scopes): web ACLs, IP sets, regex pattern sets, rule groups and
 * the AWS Managed Rules catalogue. Every value comes from a WAFV2 response.
 */

import type { ServiceDef } from "../../console/types.ts";
import { managedRuleGroups, ruleGroups } from "./rule-groups.ts";
import { ipSets, regexSets } from "./sets.ts";
import { webAcls } from "./web-acls.ts";

export const wafService: ServiceDef = {
  id: "waf",
  name: "AWS WAF",
  category: "Security, Identity, & Compliance",
  description: "Web application firewall that protects web applications from common exploits and bots.",
  resources: [webAcls, ipSets, regexSets, ruleGroups, managedRuleGroups],
};
