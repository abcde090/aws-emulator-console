/**
 * Pure helpers for the table "Edit …" dialogs: the current settings a dialog opens with,
 * and the comparisons that turn a save without changes into a no-op. Unit tested.
 */

import type { TableDescription } from "@aws-sdk/client-dynamodb";

export type CapacityModeValue = "PAY_PER_REQUEST" | "PROVISIONED";
export type EncryptionValue = "OWNED" | "AWS_MANAGED" | "CMK";

export interface CapacityValues {
  capacityMode: CapacityModeValue;
  rcu: number;
  wcu: number;
}

const DEFAULT_UNITS = 5;

/** The table's capacity mode and units, as the Edit capacity dialog shows them. */
export function capacityValues(t: TableDescription): CapacityValues {
  const onDemand = t.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST";
  return {
    capacityMode: onDemand ? "PAY_PER_REQUEST" : "PROVISIONED",
    rcu: onDemand ? DEFAULT_UNITS : t.ProvisionedThroughput?.ReadCapacityUnits || DEFAULT_UNITS,
    wcu: onDemand ? DEFAULT_UNITS : t.ProvisionedThroughput?.WriteCapacityUnits || DEFAULT_UNITS,
  };
}

/** True when the requested capacity is what the table already has. */
export function sameCapacity(current: CapacityValues, wanted: CapacityValues): boolean {
  if (current.capacityMode !== wanted.capacityMode) return false;
  return wanted.capacityMode === "PAY_PER_REQUEST" || (current.rcu === wanted.rcu && current.wcu === wanted.wcu);
}

/**
 * How the table is encrypted. `customerKeyArns` is the set of customer managed key ARNs
 * (null when they could not be listed: then only the aws/dynamodb alias marks an AWS managed key).
 */
export function encryptionValue(t: TableDescription, customerKeyArns: ReadonlySet<string> | null): { encryption: EncryptionValue; kmsKey: string } {
  const sse = t.SSEDescription;
  const on = sse && (sse.Status === "ENABLED" || sse.Status === "ENABLING" || sse.Status === "UPDATING") && sse.SSEType === "KMS";
  if (!on) return { encryption: "OWNED", kmsKey: "" };
  const arn = sse.KMSMasterKeyArn ?? "";
  const customer = customerKeyArns ? customerKeyArns.has(arn) : arn !== "" && !arn.includes(":alias/aws/dynamodb");
  return customer ? { encryption: "CMK", kmsKey: arn } : { encryption: "AWS_MANAGED", kmsKey: "" };
}

/** True when the requested encryption is what the table already has. */
export function sameEncryption(current: { encryption: EncryptionValue; kmsKey: string }, wanted: { encryption: string; kmsKey: string }): boolean {
  if (current.encryption !== wanted.encryption) return false;
  return current.encryption !== "CMK" || current.kmsKey === wanted.kmsKey;
}

/** The stream dialog's values: on/off and the view type (the console's default when off). */
export function streamValues(t: TableDescription): { enabled: boolean; viewType: string } {
  const s = t.StreamSpecification;
  return s?.StreamEnabled ? { enabled: true, viewType: s.StreamViewType ?? "NEW_AND_OLD_IMAGES" } : { enabled: false, viewType: "NEW_AND_OLD_IMAGES" };
}

/** TTL counts as on while it is ENABLED or ENABLING. */
export function ttlOn(status: string | undefined): boolean {
  return status === "ENABLED" || status === "ENABLING";
}

/** Contributor Insights counts as on while it is ENABLED or ENABLING. */
export function insightsOn(status: string | undefined): boolean {
  return status === "ENABLED" || status === "ENABLING";
}

/** JSON documents compared by content, not by formatting. */
export function sameJson(a: string | undefined, b: string | undefined): boolean {
  if ((a ?? "") === (b ?? "")) return true;
  try {
    return JSON.stringify(JSON.parse(a ?? "")) === JSON.stringify(JSON.parse(b ?? ""));
  } catch {
    return false;
  }
}

/** Pretty-prints a policy for an editor; text that is not JSON is returned unchanged. */
export function prettyPolicy(text: string | undefined): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
