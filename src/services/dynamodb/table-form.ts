/** Field options and value builders shared by the table create form and the table actions. */

import type { AttributeDefinition, Projection, ProjectionType, ScalarAttributeType, SSESpecification } from "@aws-sdk/client-dynamodb";
import type { FieldValues, Option } from "../../console/types.ts";
import { optionalText, text } from "./shared.ts";
import { REPLICA_REGIONS } from "./table-info.ts";

export const KEY_TYPES: Option[] = [
  { value: "S", label: "String" },
  { value: "N", label: "Number" },
  { value: "B", label: "Binary" },
];

export const PROJECTIONS: Option[] = [
  { value: "ALL", label: "All" },
  { value: "KEYS_ONLY", label: "Only keys" },
  { value: "INCLUDE", label: "Include: keys plus the attributes you list" },
];

export const ENCRYPTION: Option[] = [
  { value: "OWNED", label: "Owned by Amazon DynamoDB" },
  { value: "AWS_MANAGED", label: "AWS managed key (aws/dynamodb)" },
  { value: "CMK", label: "Stored in your account, and owned and managed by you (customer managed key)" },
];

export const REGION_OPTIONS: Option[] = REPLICA_REGIONS.map((r) => ({ value: r, label: r }));

export function projection(v: FieldValues, prefix: string): Projection {
  const type = (text(v[`${prefix}Projection`]) || "ALL") as ProjectionType;
  if (type !== "INCLUDE") return { ProjectionType: type };
  const attrs = text(v[`${prefix}NonKey`]).split(",").map((s) => s.trim()).filter(Boolean);
  if (attrs.length === 0) throw new Error("List at least one attribute to include in the index.");
  return { ProjectionType: "INCLUDE", NonKeyAttributes: attrs };
}

/** Adds attribute definitions, refusing one name with two types. */
export function addDef(defs: AttributeDefinition[], name: string, type: string): AttributeDefinition[] {
  const existing = defs.find((d) => d.AttributeName === name);
  if (existing) {
    if (existing.AttributeType !== type) throw new Error(`Attribute ${name} is used as both ${existing.AttributeType} and ${type}.`);
    return defs;
  }
  return [...defs, { AttributeName: name, AttributeType: type as ScalarAttributeType }];
}

export function sseSpec(v: FieldValues): SSESpecification | undefined {
  if (v.encryption === "AWS_MANAGED") return { Enabled: true, SSEType: "KMS" };
  if (v.encryption === "CMK") {
    const key = optionalText(v.kmsKey);
    if (!key) throw new Error("Choose an AWS KMS key.");
    return { Enabled: true, SSEType: "KMS", KMSMasterKeyId: key };
  }
  return undefined;
}
