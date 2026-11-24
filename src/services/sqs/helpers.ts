/** Small, pure helpers for reading SQS attribute strings. */

import type { QueueAttributeName } from "@aws-sdk/client-sqs";
import type { FieldValues } from "../../console/types.ts";

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** SQS timestamps are epoch seconds as strings. */
export function epochSecondsToIso(v: unknown): string | null {
  const n = num(v);
  return n === null ? null : new Date(n * 1000).toISOString();
}

/** Message SentTimestamp is epoch milliseconds as a string. */
export function epochMillisToIso(v: unknown): string | null {
  const n = num(v);
  return n === null ? null : new Date(n).toISOString();
}

/** The queue name is the last path segment of its URL. */
export function queueNameFromUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return decodeURIComponent(trimmed.slice(trimmed.lastIndexOf("/") + 1));
}

/** Policy and RedrivePolicy attributes are JSON strings; an empty one is null. */
export function parseJsonAttribute(v: string | undefined): unknown {
  if (v === undefined || v.trim() === "") return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** The Edit dialog's values from the queue's current attributes. */
export function editValuesFromAttributes(a: Record<string, string>): FieldValues {
  const redrive = parseJsonAttribute(a.RedrivePolicy) as { deadLetterTargetArn?: unknown; maxReceiveCount?: unknown } | null;
  const dlq = redrive && typeof redrive === "object" && typeof redrive.deadLetterTargetArn === "string" ? redrive.deadLetterTargetArn : "";
  return {
    visibilityTimeout: num(a.VisibilityTimeout),
    messageRetentionPeriod: num(a.MessageRetentionPeriod),
    delaySeconds: num(a.DelaySeconds),
    maximumMessageSize: num(a.MaximumMessageSize),
    receiveWaitTime: num(a.ReceiveMessageWaitTimeSeconds),
    contentBasedDeduplication: a.ContentBasedDeduplication === "true",
    enableDlq: dlq !== "",
    dlqArn: dlq,
    maxReceiveCount: dlq ? num(redrive?.maxReceiveCount) ?? 10 : 10,
  };
}

/** Only the attributes the user changed, so saving an untouched dialog sends nothing. */
export function changedAttributes(a: Record<string, string>, v: FieldValues): Partial<Record<QueueAttributeName, string>> {
  const out: Partial<Record<QueueAttributeName, string>> = {};
  const numeric: [QueueAttributeName, string][] = [
    ["VisibilityTimeout", "visibilityTimeout"],
    ["MessageRetentionPeriod", "messageRetentionPeriod"],
    ["DelaySeconds", "delaySeconds"],
    ["MaximumMessageSize", "maximumMessageSize"],
    ["ReceiveMessageWaitTimeSeconds", "receiveWaitTime"],
  ];
  for (const [attr, field] of numeric) {
    const n = v[field];
    if (typeof n === "number" && String(n) !== a[attr]) out[attr] = String(n);
  }
  const dedup = v.contentBasedDeduplication === true;
  if (dedup !== (a.ContentBasedDeduplication === "true")) {
    if (a.FifoQueue !== "true") {
      if (dedup) throw new Error("Content-based deduplication applies to FIFO queues only.");
    } else out.ContentBasedDeduplication = String(dedup);
  }
  const before = editValuesFromAttributes(a);
  if (v.enableDlq === true) {
    if (typeof v.dlqArn !== "string" || v.dlqArn === "") throw new Error("Choose a dead-letter queue, or turn the dead-letter queue off.");
    const max = typeof v.maxReceiveCount === "number" ? v.maxReceiveCount : 10;
    if (!before.enableDlq || before.dlqArn !== v.dlqArn || before.maxReceiveCount !== max) {
      out.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: v.dlqArn, maxReceiveCount: max });
    }
  } else if (before.enableDlq) out.RedrivePolicy = "";
  return out;
}

export function createAttributes(v: FieldValues): Partial<Record<QueueAttributeName, string>> {
  const attrs: Partial<Record<QueueAttributeName, string>> = {};
  const setNum = (key: QueueAttributeName, value: unknown) => {
    if (typeof value === "number") attrs[key] = String(value);
  };
  setNum("VisibilityTimeout", v.visibilityTimeout);
  setNum("MessageRetentionPeriod", v.messageRetentionPeriod);
  setNum("DelaySeconds", v.delaySeconds);
  setNum("MaximumMessageSize", v.maximumMessageSize);
  setNum("ReceiveMessageWaitTimeSeconds", v.receiveWaitTime);
  if (v.type === "fifo") {
    attrs.FifoQueue = "true";
    if (v.contentBasedDeduplication === true) attrs.ContentBasedDeduplication = "true";
  }
  if (v.enableDlq === true) {
    if (typeof v.dlqArn !== "string" || v.dlqArn === "") throw new Error("Choose a dead-letter queue, or turn the dead-letter queue off.");
    attrs.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: v.dlqArn, maxReceiveCount: typeof v.maxReceiveCount === "number" ? v.maxReceiveCount : 10 });
  }
  return attrs;
}

