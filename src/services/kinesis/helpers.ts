/** Pure Kinesis helpers. */

export type RetentionChange = "increase" | "decrease" | "none";

/** Kinesis has separate APIs to raise and lower retention; pick the right one. */
export function retentionChange(currentHours: number | undefined, targetHours: number): RetentionChange {
  if (currentHours === undefined || targetHours > currentHours) return "increase";
  if (targetHours < currentHours) return "decrease";
  return "none";
}

/** Which shard-level metrics to enable and disable to reach the wanted set. */
export function metricChanges(current: string[], wanted: string[]): { enable: string[]; disable: string[] } {
  const cur = new Set(current.filter((m) => m !== "ALL"));
  const want = new Set(wanted);
  return { enable: [...want].filter((m) => !cur.has(m)), disable: [...cur].filter((m) => !want.has(m)) };
}

export const SHARD_METRICS = [
  "IncomingBytes",
  "IncomingRecords",
  "OutgoingBytes",
  "OutgoingRecords",
  "WriteProvisionedThroughputExceeded",
  "ReadProvisionedThroughputExceeded",
  "IteratorAgeMilliseconds",
];

/** Splits text into one record per non-empty line (Firehose batch input). */
export function lines(textValue: string): string[] {
  return textValue.split(/\r?\n/).filter((l) => l.trim() !== "");
}
