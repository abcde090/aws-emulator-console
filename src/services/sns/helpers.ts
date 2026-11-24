/** Pure helpers for Amazon SNS screens: ARN parsing, attribute strings and message attributes. */

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

export function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The last ":" segment of an SNS ARN is the topic name (or the subscription ID). */
export function lastArnSegment(arn: string): string {
  const i = arn.lastIndexOf(":");
  return i === -1 ? arn : arn.slice(i + 1);
}

/** arn:aws:sns:region:account:topic:subscription-id -> the topic ARN. */
export function topicArnOfSubscription(arn: string): string | null {
  const parts = arn.split(":");
  return parts.length === 7 ? parts.slice(0, 6).join(":") : null;
}

export function isFifoTopic(attrs: Record<string, string>, name: string): boolean {
  return attrs.FifoTopic === "true" || name.endsWith(".fifo");
}

export const PENDING_PREFIX = "pending:";

/**
 * Subscriptions waiting for confirmation have no ARN yet (SNS returns "PendingConfirmation").
 * The console still needs a unique row id, so it is built from the fields SNS returned.
 */
export function subscriptionRowId(sub: { SubscriptionArn?: string; TopicArn?: string; Protocol?: string; Endpoint?: string }): string {
  const arn = sub.SubscriptionArn ?? "";
  if (arn.startsWith("arn:")) return arn;
  return `${PENDING_PREFIX}${sub.TopicArn ?? ""}|${sub.Protocol ?? ""}|${sub.Endpoint ?? ""}`;
}

export function parsePendingId(id: string): { topicArn: string; protocol: string; endpoint: string } | null {
  if (!id.startsWith(PENDING_PREFIX)) return null;
  const [topicArn = "", protocol = "", ...rest] = id.slice(PENDING_PREFIX.length).split("|");
  return { topicArn, protocol, endpoint: rest.join("|") };
}

export interface MessageAttribute {
  DataType: string;
  StringValue: string;
}

/**
 * Message attributes typed as JSON. Accepts the console's simple form
 * {"name": "text" | 12 | ["a","b"]} and the API form {"name": {"DataType": "...", "StringValue": "..."}}.
 */
export function parseMessageAttributes(input: string): Record<string, MessageAttribute> {
  if (input.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Message attributes: not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Message attributes: use a JSON object of name/value pairs.");
  const out: Record<string, MessageAttribute> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (name.trim() === "") throw new Error("Message attributes: names can't be empty.");
    out[name] = toAttribute(name, value);
  }
  if (Object.keys(out).length > 10) throw new Error("Message attributes: at most 10 attributes.");
  return out;
}

function toAttribute(name: string, value: unknown): MessageAttribute {
  if (typeof value === "string") return { DataType: "String", StringValue: value };
  if (typeof value === "number" && Number.isFinite(value)) return { DataType: "Number", StringValue: String(value) };
  if (Array.isArray(value)) return { DataType: "String.Array", StringValue: JSON.stringify(value) };
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.DataType === "string" && typeof v.StringValue === "string") return { DataType: v.DataType, StringValue: v.StringValue };
  }
  throw new Error(`Message attributes: "${name}" needs a string, number, array or {"DataType","StringValue"}.`);
}

/** Validates a filter policy: a JSON object. Returned as compact JSON text. */
export function normaliseJsonObject(label: string, input: unknown): string | undefined {
  if (typeof input !== "string" || input.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(`${label}: not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}: must be a JSON object.`);
  return JSON.stringify(parsed);
}
