/** Pure helpers for CloudTrail trails: advanced event selectors and the bucket policy CloudTrail needs. Unit tested. */

import type { AdvancedEventSelector, EventSelector } from "@aws-sdk/client-cloudtrail";

export type ReadWrite = "All" | "ReadOnly" | "WriteOnly";

export interface SelectorInput {
  management: boolean;
  readWrite: ReadWrite;
  excludeKms: boolean;
  excludeRdsData: boolean;
  dataTypes: string[];
}

export const DATA_RESOURCE_TYPES: { value: string; label: string }[] = [
  { value: "AWS::S3::Object", label: "S3 (objects)" },
  { value: "AWS::Lambda::Function", label: "Lambda (functions)" },
  { value: "AWS::DynamoDB::Table", label: "DynamoDB (tables)" },
  { value: "AWS::SNS::Topic", label: "SNS (topics)" },
  { value: "AWS::SQS::Queue", label: "SQS (queues)" },
];

/** Advanced event selectors equivalent to the console's management and data event choices. */
export function buildSelectors(i: SelectorInput): AdvancedEventSelector[] {
  const out: AdvancedEventSelector[] = [];
  if (i.management) {
    const fields: AdvancedEventSelector["FieldSelectors"] = [{ Field: "eventCategory", Equals: ["Management"] }];
    if (i.readWrite !== "All") fields.push({ Field: "readOnly", Equals: [i.readWrite === "ReadOnly" ? "true" : "false"] });
    const excluded = [...(i.excludeKms ? ["kms.amazonaws.com"] : []), ...(i.excludeRdsData ? ["rdsdata.amazonaws.com"] : [])];
    if (excluded.length) fields.push({ Field: "eventSource", NotEquals: excluded });
    out.push({ Name: "Management events selector", FieldSelectors: fields });
  }
  for (const type of i.dataTypes) {
    if (!DATA_RESOURCE_TYPES.some((d) => d.value === type)) throw new Error(`Unsupported data event resource type ${type}.`);
    out.push({ Name: `Log all ${type} data events`, FieldSelectors: [{ Field: "eventCategory", Equals: ["Data"] }, { Field: "resources.type", Equals: [type] }] });
  }
  if (out.length === 0) throw new Error("Choose management events, data events or both. A trail must log something.");
  return out;
}

/** The S3 bucket policy the CloudTrail console writes when it creates a new log bucket. */
export function trailBucketPolicy(bucket: string, account: string, region: string, trail: string, prefix: string): string {
  const path = prefix ? `${prefix.replace(/^\/+|\/+$/g, "")}/AWSLogs/${account}/*` : `AWSLogs/${account}/*`;
  const sourceArn = `arn:aws:cloudtrail:${region}:${account}:trail/${trail}`;
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "AWSCloudTrailAclCheck", Effect: "Allow", Principal: { Service: "cloudtrail.amazonaws.com" }, Action: "s3:GetBucketAcl", Resource: `arn:aws:s3:::${bucket}`, Condition: { StringEquals: { "AWS:SourceArn": sourceArn } } },
      {
        Sid: "AWSCloudTrailWrite", Effect: "Allow", Principal: { Service: "cloudtrail.amazonaws.com" }, Action: "s3:PutObject", Resource: `arn:aws:s3:::${bucket}/${path}`,
        Condition: { StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control", "AWS:SourceArn": sourceArn } },
      },
    ],
  });
}

/** Readable rows for advanced event selectors. */
export function selectorRows(selectors: readonly AdvancedEventSelector[] | undefined): { name: string; conditions: string }[] {
  return (selectors ?? []).map((s) => ({
    name: s.Name ?? "-",
    conditions: (s.FieldSelectors ?? [])
      .map((f) => {
        const parts: string[] = [];
        if (f.Equals?.length) parts.push(`equals ${f.Equals.join(", ")}`);
        if (f.NotEquals?.length) parts.push(`not equals ${f.NotEquals.join(", ")}`);
        if (f.StartsWith?.length) parts.push(`starts with ${f.StartsWith.join(", ")}`);
        if (f.NotStartsWith?.length) parts.push(`does not start with ${f.NotStartsWith.join(", ")}`);
        if (f.EndsWith?.length) parts.push(`ends with ${f.EndsWith.join(", ")}`);
        return `${f.Field} ${parts.join("; ")}`;
      })
      .join(" AND "),
  }));
}

/**
 * The "Edit event types" form values for a trail's current selectors (advanced or basic),
 * the reverse of buildSelectors. Selectors the form can't express are ignored.
 */
export function selectorInput(advanced: readonly AdvancedEventSelector[] | undefined, basic: readonly EventSelector[] | undefined): SelectorInput {
  const known = new Set(DATA_RESOURCE_TYPES.map((d) => d.value));
  const out: SelectorInput = { management: false, readWrite: "All", excludeKms: false, excludeRdsData: false, dataTypes: [] };
  if (advanced?.length) {
    for (const sel of advanced) {
      const fields = sel.FieldSelectors ?? [];
      const category = fields.find((f) => f.Field === "eventCategory")?.Equals?.[0];
      if (category === "Management") {
        out.management = true;
        const ro = fields.find((f) => f.Field === "readOnly")?.Equals?.[0];
        out.readWrite = ro === "true" ? "ReadOnly" : ro === "false" ? "WriteOnly" : "All";
        const excluded = fields.find((f) => f.Field === "eventSource")?.NotEquals ?? [];
        out.excludeKms = excluded.includes("kms.amazonaws.com");
        out.excludeRdsData = excluded.includes("rdsdata.amazonaws.com");
      } else if (category === "Data") {
        for (const t of fields.find((f) => f.Field === "resources.type")?.Equals ?? []) if (known.has(t) && !out.dataTypes.includes(t)) out.dataTypes.push(t);
      }
    }
    return out;
  }
  for (const sel of basic ?? []) {
    if (sel.IncludeManagementEvents !== false) {
      out.management = true;
      out.readWrite = sel.ReadWriteType ?? "All";
      const excluded = sel.ExcludeManagementEventSources ?? [];
      out.excludeKms = excluded.includes("kms.amazonaws.com");
      out.excludeRdsData = excluded.includes("rdsdata.amazonaws.com");
    }
    for (const d of sel.DataResources ?? []) if (d.Type && known.has(d.Type) && !out.dataTypes.includes(d.Type)) out.dataTypes.push(d.Type);
  }
  return out;
}

/** Only the UpdateTrail fields whose new value differs from the trail's current one. */
export interface TrailSettings {
  validation: boolean;
  multiRegion: boolean;
  kmsKey: string;
  sns: string;
}

export function trailChanges(current: TrailSettings, next: TrailSettings): { EnableLogFileValidation?: boolean; IsMultiRegionTrail?: boolean; KmsKeyId?: string; SnsTopicName?: string } {
  const out: { EnableLogFileValidation?: boolean; IsMultiRegionTrail?: boolean; KmsKeyId?: string; SnsTopicName?: string } = {};
  if (next.validation !== current.validation) out.EnableLogFileValidation = next.validation;
  if (next.multiRegion !== current.multiRegion) out.IsMultiRegionTrail = next.multiRegion;
  // An empty string removes SSE-KMS encryption / SNS delivery.
  if (next.kmsKey !== current.kmsKey) out.KmsKeyId = next.kmsKey;
  if (next.sns !== current.sns) out.SnsTopicName = next.sns;
  return out;
}
