/**
 * Billing and Cost Management: Budgets (AWS Budgets API), Cost Explorer, cost categories
 * and cost anomaly detection (Cost Explorer API). Gaps listed in notSupported were each
 * verified against AWS Emulator.
 */

import type { ServiceDef } from "../../console/types.ts";
import { budgets } from "./budgets.ts";
import { anomalyMonitors, anomalySubscriptions, costCategories, costExplorer } from "./explorer.ts";

export const costService: ServiceDef = {
  id: "cost",
  name: "Billing and Cost Management",
  category: "Cloud Financial Management",
  description: "Budgets, Cost Explorer, cost categories and cost anomaly detection.",
  resources: [budgets, costExplorer, costCategories, anomalyMonitors, anomalySubscriptions],
  notSupported: [
    "Cost Explorer reports and forecasts (GetCostAndUsage, GetCostForecast, GetUsageForecast, GetDimensionValues, GetTags, GetCostCategories): the Cost Explorer page says so and offers no report builder while the emulator answers NotImplemented",
    "Savings Plans and Reserved Instance coverage, utilization and purchase recommendations",
    "Rightsizing recommendations (GetRightsizingRecommendation)",
    "Detected anomalies history (GetAnomalies)",
    "Deleting alert subscriptions (DeleteAnomalySubscription)",
    "Cost allocation tags (ListCostAllocationTags)",
    "Data Exports / CUR 2.0: this console has no BCM Data Exports client",
  ],
};
