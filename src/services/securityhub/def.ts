/**
 * AWS Security Hub CSPM: subscription (Settings), security standards, controls, findings
 * (with ASFF import), automation rules and custom actions. Every value comes from a
 * Security Hub API response; until the account is subscribed, pages show the API's own
 * "not subscribed" error.
 */

import type { ServiceDef } from "../../console/types.ts";
import { automationRules, customActions } from "./automations.ts";
import { findings } from "./findings.ts";
import { hub } from "./hub.ts";
import { controls, standards } from "./standards.ts";

export const securityhubService: ServiceDef = {
  id: "securityhub",
  name: "AWS Security Hub CSPM",
  category: "Security, Identity, & Compliance",
  description: "Cloud security posture management: automated best-practice checks and a single place for security findings.",
  resources: [hub, standards, controls, findings, automationRules, customActions],
  notSupported: [
    "Insights: GetInsights and UpdateInsight are not implemented, so saved and managed insights can't be listed.",
    "Integrations: DescribeProducts, EnableImportFindingsForProduct and ListEnabledProductsForImport are not implemented.",
    "Control parameters and consolidated control status: BatchGetSecurityControls, UpdateSecurityControl, ListStandardsControlAssociations and BatchUpdateStandardsControlAssociations are not implemented.",
    "Editing a custom action: UpdateActionTarget is not implemented, so delete and re-create it to change its name or description.",
    "Auto-enable new controls setting: UpdateSecurityHubConfiguration is not implemented.",
    "Central configuration and multi-account: ListConfigurationPolicies, DescribeOrganizationConfiguration and GetAdministratorAccount are not implemented.",
    "Security Hub (OCSF findings, GetFindingsV2, DescribeProductsV2) is not implemented.",
  ],
};
