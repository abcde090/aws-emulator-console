/** Choices for the Cost Explorer report builder (shared by the page and the server action). */

export interface Choice {
  value: string;
  label: string;
}

export const COST_METRICS: Choice[] = [
  { value: "UnblendedCost", label: "Unblended costs" },
  { value: "BlendedCost", label: "Blended costs" },
  { value: "AmortizedCost", label: "Amortized costs" },
  { value: "NetUnblendedCost", label: "Net unblended costs" },
  { value: "UsageQuantity", label: "Usage quantity" },
];

export const GROUP_BY: Choice[] = [
  { value: "SERVICE", label: "Service" },
  { value: "LINKED_ACCOUNT", label: "Linked account" },
  { value: "REGION", label: "Region" },
  { value: "USAGE_TYPE", label: "Usage type" },
  { value: "INSTANCE_TYPE", label: "Instance type" },
  { value: "RECORD_TYPE", label: "Charge type" },
];

export const FILTER_DIMENSIONS: Choice[] = [
  { value: "SERVICE", label: "Service" },
  { value: "LINKED_ACCOUNT", label: "Linked account" },
  { value: "REGION", label: "Region" },
  { value: "USAGE_TYPE", label: "Usage type" },
  { value: "RECORD_TYPE", label: "Charge type" },
];
