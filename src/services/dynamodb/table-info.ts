/**
 * Pure mapping from DescribeTable output to the words the DynamoDB console uses.
 * Only `import type` from the SDK, so the unit tests can load it directly.
 */

import type { AttributeDefinition, KeySchemaElement, Projection, TableDescription } from "@aws-sdk/client-dynamodb";

const TYPE_WORDS: Record<string, string> = { S: "String", N: "Number", B: "Binary" };

export interface KeyNames {
  partition: string | null;
  sort: string | null;
}

export function keyNames(schema: KeySchemaElement[] | undefined): KeyNames {
  return {
    partition: schema?.find((k) => k.KeyType === "HASH")?.AttributeName ?? null,
    sort: schema?.find((k) => k.KeyType === "RANGE")?.AttributeName ?? null,
  };
}

export function attrType(defs: AttributeDefinition[] | undefined, name: string | null): string | null {
  if (!name) return null;
  return defs?.find((d) => d.AttributeName === name)?.AttributeType ?? null;
}

/** "pk (String)" as in the console's key columns. */
export function keyLabel(defs: AttributeDefinition[] | undefined, name: string | null): string | null {
  if (!name) return null;
  const t = attrType(defs, name);
  return t ? `${name} (${TYPE_WORDS[t] ?? t})` : name;
}

export function capacityMode(t: TableDescription): "On-demand" | "Provisioned" {
  return t.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST" ? "On-demand" : "Provisioned";
}

export function capacityText(t: TableDescription, which: "read" | "write"): string {
  if (capacityMode(t) === "On-demand") return "On-demand";
  const units = which === "read" ? t.ProvisionedThroughput?.ReadCapacityUnits : t.ProvisionedThroughput?.WriteCapacityUnits;
  return `Provisioned (${units ?? 0})`;
}

export function encryptionText(t: TableDescription): string {
  const sse = t.SSEDescription;
  if (!sse || sse.Status === "DISABLED" || !sse.SSEType) return "Owned by Amazon DynamoDB";
  if (sse.SSEType === "KMS") return sse.KMSMasterKeyArn?.includes(":alias/aws/dynamodb") ? "AWS managed key" : "AWS KMS key";
  return sse.SSEType;
}

export function tableClassText(t: TableDescription): string {
  return t.TableClassSummary?.TableClass === "STANDARD_INFREQUENT_ACCESS" ? "DynamoDB Standard-IA" : "DynamoDB Standard";
}

export function projectionText(p: Projection | undefined): string {
  if (!p?.ProjectionType) return "-";
  if (p.ProjectionType === "INCLUDE") return `Include: ${(p.NonKeyAttributes ?? []).join(", ")}`;
  return p.ProjectionType === "KEYS_ONLY" ? "Keys only" : "All";
}

export function averageItemSize(t: TableDescription): number | null {
  const n = t.ItemCount ?? 0;
  return n > 0 && typeof t.TableSizeBytes === "number" ? Math.round(t.TableSizeBytes / n) : null;
}

export interface IndexRow {
  name: string;
  type: "Global" | "Local";
  status: string | null;
  partitionKey: string | null;
  sortKey: string | null;
  projection: string;
  readCapacity: string;
  writeCapacity: string;
  size: number | null;
  items: number | null;
  [key: string]: unknown;
}

export function indexRows(t: TableDescription): IndexRow[] {
  const defs = t.AttributeDefinitions;
  const onDemand = capacityMode(t) === "On-demand";
  const gsis: IndexRow[] = (t.GlobalSecondaryIndexes ?? []).map((g) => {
    const k = keyNames(g.KeySchema);
    return {
      name: g.IndexName ?? "",
      type: "Global",
      status: g.IndexStatus ?? null,
      partitionKey: keyLabel(defs, k.partition),
      sortKey: keyLabel(defs, k.sort),
      projection: projectionText(g.Projection),
      readCapacity: onDemand ? "On-demand" : String(g.ProvisionedThroughput?.ReadCapacityUnits ?? 0),
      writeCapacity: onDemand ? "On-demand" : String(g.ProvisionedThroughput?.WriteCapacityUnits ?? 0),
      size: g.IndexSizeBytes ?? null,
      items: g.ItemCount ?? null,
    };
  });
  const lsis: IndexRow[] = (t.LocalSecondaryIndexes ?? []).map((l) => {
    const k = keyNames(l.KeySchema);
    return {
      name: l.IndexName ?? "",
      type: "Local",
      // LSIs have no status of their own: they live and die with the table.
      status: t.TableStatus ?? null,
      partitionKey: keyLabel(defs, k.partition),
      sortKey: keyLabel(defs, k.sort),
      projection: projectionText(l.Projection),
      readCapacity: "Shares table capacity",
      writeCapacity: "Shares table capacity",
      size: l.IndexSizeBytes ?? null,
      items: l.ItemCount ?? null,
    };
  });
  return [...gsis, ...lsis];
}

/** Region names offered for global table replicas. */
export const REPLICA_REGIONS = [
  "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "eu-west-1", "eu-west-2", "eu-central-1",
  "eu-north-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-south-1", "sa-east-1",
];
