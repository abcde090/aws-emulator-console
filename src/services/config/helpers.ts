/** Pure AWS Config helpers: managed rule catalogue, resource keys, query result rows. Unit tested. */

export interface ManagedRule {
  id: string;
  description: string;
  /** Resource types the rule evaluates; empty for periodic account-level rules. */
  scope: string[];
  periodic?: boolean;
  parameters?: string;
}

/** A selection of AWS Config managed rules (the identifiers AWS documents), for the Add rule form. */
export const MANAGED_RULES: ManagedRule[] = [
  { id: "S3_BUCKET_VERSIONING_ENABLED", description: "Checks if versioning is enabled for your S3 buckets.", scope: ["AWS::S3::Bucket"], parameters: '{"isMfaDeleteEnabled":"false"}' },
  { id: "S3_BUCKET_PUBLIC_READ_PROHIBITED", description: "Checks if your S3 buckets do not allow public read access.", scope: ["AWS::S3::Bucket"] },
  { id: "S3_BUCKET_PUBLIC_WRITE_PROHIBITED", description: "Checks if your S3 buckets do not allow public write access.", scope: ["AWS::S3::Bucket"] },
  { id: "S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED", description: "Checks if your S3 bucket has default encryption enabled.", scope: ["AWS::S3::Bucket"] },
  { id: "S3_BUCKET_LOGGING_ENABLED", description: "Checks if logging is enabled for your S3 buckets.", scope: ["AWS::S3::Bucket"] },
  { id: "S3_BUCKET_SSL_REQUESTS_ONLY", description: "Checks if S3 bucket policies require requests to use SSL/TLS.", scope: ["AWS::S3::Bucket"] },
  { id: "EC2_INSTANCE_NO_PUBLIC_IP", description: "Checks if EC2 instances have a public IP association.", scope: ["AWS::EC2::Instance"] },
  { id: "EC2_EBS_ENCRYPTION_BY_DEFAULT", description: "Checks that EBS encryption is enabled by default.", scope: [], periodic: true },
  { id: "ENCRYPTED_VOLUMES", description: "Checks if attached EBS volumes are encrypted.", scope: ["AWS::EC2::Volume"] },
  { id: "RESTRICTED_INCOMING_TRAFFIC", description: "Checks if security groups allow unrestricted incoming TCP traffic to the specified ports.", scope: ["AWS::EC2::SecurityGroup"], parameters: '{"blockedPort1":"20","blockedPort2":"21","blockedPort3":"3389","blockedPort4":"3306","blockedPort5":"4333"}' },
  { id: "INCOMING_SSH_DISABLED", description: "Checks if security groups allow unrestricted incoming SSH traffic.", scope: ["AWS::EC2::SecurityGroup"] },
  { id: "VPC_FLOW_LOGS_ENABLED", description: "Checks if VPC flow logs are found and enabled for VPCs.", scope: [], periodic: true },
  { id: "VPC_DEFAULT_SECURITY_GROUP_CLOSED", description: "Checks if the default security group of any VPC does not allow inbound or outbound traffic.", scope: ["AWS::EC2::SecurityGroup"] },
  { id: "IAM_PASSWORD_POLICY", description: "Checks if the account password policy for IAM users meets the specified requirements.", scope: [], periodic: true, parameters: '{"RequireUppercaseCharacters":"true","RequireLowercaseCharacters":"true","RequireSymbols":"true","RequireNumbers":"true","MinimumPasswordLength":"14"}' },
  { id: "IAM_ROOT_ACCESS_KEY_CHECK", description: "Checks if the root user access key is available.", scope: [], periodic: true },
  { id: "ROOT_ACCOUNT_MFA_ENABLED", description: "Checks if the root user requires MFA for console sign-in.", scope: [], periodic: true },
  { id: "IAM_USER_MFA_ENABLED", description: "Checks if IAM users have MFA enabled.", scope: [], periodic: true },
  { id: "IAM_POLICY_NO_STATEMENTS_WITH_ADMIN_ACCESS", description: "Checks if customer managed policies allow full \"*:*\" administrative privileges.", scope: ["AWS::IAM::Policy"] },
  { id: "ACCESS_KEYS_ROTATED", description: "Checks if active IAM access keys are rotated within maxAccessKeyAge days.", scope: [], periodic: true, parameters: '{"maxAccessKeyAge":"90"}' },
  { id: "CLOUD_TRAIL_ENABLED", description: "Checks if a CloudTrail trail is enabled in your account.", scope: [], periodic: true },
  { id: "CLOUD_TRAIL_LOG_FILE_VALIDATION_ENABLED", description: "Checks if CloudTrail creates a signed digest file with logs.", scope: [], periodic: true },
  { id: "MULTI_REGION_CLOUD_TRAIL_ENABLED", description: "Checks that there is at least one multi-Region CloudTrail trail.", scope: [], periodic: true },
  { id: "RDS_STORAGE_ENCRYPTED", description: "Checks if storage encryption is enabled for your RDS DB instances.", scope: ["AWS::RDS::DBInstance"] },
  { id: "RDS_INSTANCE_PUBLIC_ACCESS_CHECK", description: "Checks if RDS DB instances are not publicly accessible.", scope: ["AWS::RDS::DBInstance"] },
  { id: "RDS_MULTI_AZ_SUPPORT", description: "Checks whether high availability is enabled for your RDS DB instances.", scope: ["AWS::RDS::DBInstance"] },
  { id: "DYNAMODB_PITR_ENABLED", description: "Checks if point-in-time recovery is enabled for DynamoDB tables.", scope: ["AWS::DynamoDB::Table"] },
  { id: "LAMBDA_FUNCTION_PUBLIC_ACCESS_PROHIBITED", description: "Checks if the Lambda function policy prohibits public access.", scope: ["AWS::Lambda::Function"] },
  { id: "REQUIRED_TAGS", description: "Checks if your resources have the tags that you specify.", scope: ["AWS::S3::Bucket", "AWS::EC2::Instance"], parameters: '{"tag1Key":"Owner"}' },
  { id: "GUARDDUTY_ENABLED_CENTRALIZED", description: "Checks if GuardDuty is enabled in your account and Region.", scope: [], periodic: true },
  { id: "SECURITYHUB_ENABLED", description: "Checks if Security Hub is enabled for the account.", scope: [], periodic: true },
  { id: "KMS_CMK_NOT_SCHEDULED_FOR_DELETION", description: "Checks if KMS keys are not scheduled for deletion.", scope: ["AWS::KMS::Key"] },
  { id: "SQS_QUEUE_ENCRYPTED", description: "Checks if SQS queues are encrypted.", scope: ["AWS::SQS::Queue"] },
];

export function managedRule(id: string): ManagedRule | undefined {
  return MANAGED_RULES.find((r) => r.id === id);
}

/** Resource ids for URLs: "<resource type>|<resource id>". Resource types never contain "|". */
export function resourceKey(type: string, id: string): string {
  return `${type}|${id}`;
}

export function splitResourceKey(key: string): { type: string; id: string } {
  const i = key.indexOf("|");
  if (i <= 0 || i === key.length - 1) throw new Error(`"${key}" is not a resource key (type|id).`);
  return { type: key.slice(0, i), id: key.slice(i + 1) };
}

/** SelectResourceConfig returns each result as a JSON string; flatten nested objects to dotted keys. */
export function queryRows(results: readonly string[] | undefined): { columns: string[]; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  const columns: string[] = [];
  const flatten = (prefix: string, v: unknown, out: Record<string, unknown>) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(prefix ? `${prefix}.${k}` : k, x, out);
    } else {
      out[prefix || "value"] = Array.isArray(v) ? JSON.stringify(v) : v;
    }
  };
  for (const r of results ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r);
    } catch {
      parsed = r;
    }
    const row: Record<string, unknown> = {};
    flatten("", parsed, row);
    for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
    rows.push(row);
  }
  return { columns, rows };
}

/** "NON_COMPLIANT" with 3 contributors -> "3 Noncompliant resource(s)", as the Rules page shows it. */
export function complianceLabel(type: string | undefined, count: number | undefined): string {
  switch (type) {
    case "COMPLIANT":
      return "Compliant";
    case "NON_COMPLIANT":
      return count === undefined ? "Noncompliant" : `${count} Noncompliant resource(s)`;
    case "NOT_APPLICABLE":
      return "Not applicable";
    case "INSUFFICIENT_DATA":
      return "No results reported";
    default:
      return type ?? "No results reported";
  }
}

export function parseJsonObject(text: string, label: string): Record<string, unknown> | undefined {
  if (text.trim() === "") return undefined;
  const v: unknown = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label} must be a JSON object.`);
  return v as Record<string, unknown>;
}
