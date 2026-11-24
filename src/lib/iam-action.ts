/**
 * Maps an AWS SDK call or an `aws` CLI command to the IAM actions and resource ARNs that real
 * AWS would authorise. Used by the dashboard's IAM simulator; the emulator itself never denies.
 *
 * One call can need several checks: DeleteObjects needs s3:DeleteObject on every key,
 * CopyObject needs s3:GetObject on the source and s3:PutObject on the target.
 * When the resource cannot be worked out, the request names UNKNOWN_RESOURCE, which
 * permissions.ts treats strictly (any matching Deny applies; only a Resource "*" Allow counts).
 */

export interface IamRequest {
  action: string;
  resource: string;
  /** Set when the real ARN must be looked up first (iam-lookup.ts); `resource` is the fallback. */
  lookup?: ResourceLookup;
}

import { cliFlagsToInput, mappedResources, type InputFields, type ResourceLookup } from "./iam-resources.ts";
import { DEFAULT_REGION, isValidRegion } from "./regions.ts";

const ACCOUNT = "000000000000";

/** The request's resource could not be worked out from its input. */
export const UNKNOWN_RESOURCE = "(unknown resource)";

/** SDK client class name to IAM service prefix. */
const CLIENT_PREFIX: Record<string, string> = {
  S3Client: "s3",
  SQSClient: "sqs",
  DynamoDBClient: "dynamodb",
  IAMClient: "iam",
  STSClient: "sts",
  EC2Client: "ec2",
  LambdaClient: "lambda",
  ElasticLoadBalancingV2Client: "elasticloadbalancing",
  AutoScalingClient: "autoscaling",
  OrganizationsClient: "organizations",
  KMSClient: "kms",
  CloudWatchClient: "cloudwatch",
  RDSClient: "rds",
  ElastiCacheClient: "elasticache",
  RedshiftClient: "redshift",
  SNSClient: "sns",
  EventBridgeClient: "events",
  SFNClient: "states",
  KinesisClient: "kinesis",
  CloudWatchLogsClient: "logs",
  CloudTrailClient: "cloudtrail",
  CloudFormationClient: "cloudformation",
  SSMClient: "ssm",
  SecretsManagerClient: "secretsmanager",
  Route53Client: "route53",
  CloudFrontClient: "cloudfront",
  APIGatewayClient: "apigateway",
  ECSClient: "ecs",
  EKSClient: "eks",
  EFSClient: "elasticfilesystem",
  ElasticBeanstalkClient: "elasticbeanstalk",
  GlacierClient: "glacier",
  CognitoIdentityProviderClient: "cognito-idp",
  AthenaClient: "athena",
  CodeBuildClient: "codebuild",
  CodeCommitClient: "codecommit",
  CodePipelineClient: "codepipeline",
  LightsailClient: "lightsail",
  SageMakerClient: "sagemaker",
  BedrockClient: "bedrock",
  WAFV2Client: "wafv2",
  GuardDutyClient: "guardduty",
  SecurityHubClient: "securityhub",
  ConfigServiceClient: "config",
  BackupClient: "backup",
  BudgetsClient: "budgets",
  CostExplorerClient: "ce",
  GlueClient: "glue",
  SchedulerClient: "scheduler",
  XRayClient: "xray",
  ServiceQuotasClient: "servicequotas",
  FirehoseClient: "firehose",
  ACMClient: "acm",
  RAMClient: "ram",
  SSOAdminClient: "sso",
  IdentitystoreClient: "identitystore",
  ApiGatewayV2Client: "apigateway",
  DatabaseMigrationServiceClient: "dms",
  WellArchitectedClient: "wellarchitected",
  ComputeOptimizerClient: "compute-optimizer",
  FisClient: "fis",
  ResiliencehubClient: "resiliencehub",
  Route53ResolverClient: "route53resolver",
  PipesClient: "pipes",
  CognitoIdentityClient: "cognito-identity",
  DAXClient: "dax",
  DynamoDBStreamsClient: "dynamodb",
  ApplicationAutoScalingClient: "application-autoscaling",
  RedshiftDataClient: "redshift-data",
  ServiceDiscoveryClient: "servicediscovery",
  AccessAnalyzerClient: "access-analyzer",
};

/** CLI service name to IAM service prefix, where they differ. */
const CLI_PREFIX: Record<string, string> = {
  s3api: "s3",
  s3control: "s3",
  elbv2: "elasticloadbalancing",
  elb: "elasticloadbalancing",
  stepfunctions: "states",
  sesv2: "ses",
  apigatewayv2: "apigateway",
  dynamodbstreams: "dynamodb",
  accessanalyzer: "access-analyzer",
  opensearch: "es",
  emr: "elasticmapreduce",
  efs: "elasticfilesystem",
  "iot-data": "iot",
  "lex-models": "lex",
  "lexv2-models": "lex",
};

/** CLI services whose name is also their IAM prefix. Any other service is denied for non-admins. */
const SAME_NAME_SERVICES = new Set([
  "acm", "apigateway", "appsync", "athena", "autoscaling", "application-autoscaling", "backup", "batch",
  "cloudformation", "cloudfront", "cloudtrail", "cloudwatch", "codebuild", "codecommit", "codedeploy",
  "codepipeline", "cognito-identity", "cognito-idp", "config", "dax", "dynamodb", "ec2", "ecr", "ecs", "eks",
  "elasticache", "es", "events", "firehose", "glue", "iam", "iot", "kafka", "kinesis", "kms", "lambda",
  "logs", "mq", "organizations", "pipes", "rds", "redshift", "redshift-data", "route53", "route53resolver", "s3", "sagemaker", "scheduler",
  "secretsmanager", "servicediscovery", "ses", "sns", "sqs", "ssm", "sts", "wafv2", "xray",
]);

function iamPrefix(service: string): string | null {
  if (CLI_PREFIX[service]) return CLI_PREFIX[service];
  return SAME_NAME_SERVICES.has(service) ? service : null;
}

/** API operations whose IAM action has a different name. */
const RENAMED_ACTIONS: Record<string, string> = {
  "s3:ListBuckets": "s3:ListAllMyBuckets",
  "s3:ListObjects": "s3:ListBucket",
  "s3:ListObjectsV2": "s3:ListBucket",
  "s3:HeadBucket": "s3:ListBucket",
  "s3:ListObjectVersions": "s3:ListBucketVersions",
  "s3:HeadObject": "s3:GetObject",
  "s3:CopyObject": "s3:PutObject",
  "s3:CreateMultipartUpload": "s3:PutObject",
  "s3:UploadPart": "s3:PutObject",
  "s3:UploadPartCopy": "s3:PutObject",
  "s3:CompleteMultipartUpload": "s3:PutObject",
  "s3:DeleteObjects": "s3:DeleteObject",
  "s3:GetBucketEncryption": "s3:GetEncryptionConfiguration",
  "s3:PutBucketEncryption": "s3:PutEncryptionConfiguration",
  "s3:DeleteBucketEncryption": "s3:PutEncryptionConfiguration",
  "s3:GetPublicAccessBlock": "s3:GetBucketPublicAccessBlock",
  "s3:PutPublicAccessBlock": "s3:PutBucketPublicAccessBlock",
  "s3:DeletePublicAccessBlock": "s3:PutBucketPublicAccessBlock",
  "s3:GetBucketCors": "s3:GetBucketCORS",
  "s3:PutBucketCors": "s3:PutBucketCORS",
  "s3:DeleteBucketCors": "s3:PutBucketCORS",
  "s3:GetBucketLifecycleConfiguration": "s3:GetLifecycleConfiguration",
  "s3:PutBucketLifecycleConfiguration": "s3:PutLifecycleConfiguration",
  "s3:DeleteBucketTagging": "s3:PutBucketTagging",
  "s3:DeleteBucketLifecycle": "s3:PutLifecycleConfiguration",
  "s3:ListMultipartUploads": "s3:ListBucketMultipartUploads",
  "s3:ListParts": "s3:ListMultipartUploadParts",
  "s3:GetBucketNotificationConfiguration": "s3:GetBucketNotification",
  "s3:PutBucketNotificationConfiguration": "s3:PutBucketNotification",
  "s3:GetBucketReplication": "s3:GetReplicationConfiguration",
  "s3:PutBucketReplication": "s3:PutReplicationConfiguration",
  "s3:DeleteBucketReplication": "s3:PutReplicationConfiguration",
  "s3:GetBucketInventoryConfiguration": "s3:GetInventoryConfiguration",
  "s3:ListBucketInventoryConfigurations": "s3:GetInventoryConfiguration",
  "s3:PutBucketInventoryConfiguration": "s3:PutInventoryConfiguration",
  "s3:DeleteBucketInventoryConfiguration": "s3:PutInventoryConfiguration",
  "s3:DeleteBucketOwnershipControls": "s3:PutBucketOwnershipControls",
  "s3:GetObjectLockConfiguration": "s3:GetBucketObjectLockConfiguration",
  "s3:PutObjectLockConfiguration": "s3:PutBucketObjectLockConfiguration",
  "s3:DeleteBucketWebsite": "s3:DeleteBucketWebsite",
  "s3:GetBucketAccelerateConfiguration": "s3:GetAccelerateConfiguration",
  "s3:PutBucketAccelerateConfiguration": "s3:PutAccelerateConfiguration",
  "s3:GetBucketRequestPayment": "s3:GetBucketRequestPayment",
  "s3:SelectObjectContent": "s3:GetObject",
  "s3:GetObjectAttributes": "s3:GetObjectAttributes",
  "sqs:SendMessageBatch": "sqs:SendMessage",
  "sqs:DeleteMessageBatch": "sqs:DeleteMessage",
  "sqs:ChangeMessageVisibilityBatch": "sqs:ChangeMessageVisibility",
  "lambda:Invoke": "lambda:InvokeFunction",
  "lambda:InvokeAsync": "lambda:InvokeFunction",
};

/** Actions AWS allows every signed-in principal, whatever its policies say. */
export const ALWAYS_ALLOWED = new Set(["sts:GetCallerIdentity"]);

/** Fields that identify the resource a call acts on. */
interface ResourceHints {
  Bucket?: string;
  Key?: string;
  TableName?: string;
  QueueUrl?: string;
  UserName?: string;
  RoleName?: string;
  GroupName?: string;
  FunctionName?: string;
  SerialNumber?: string;
  KeyId?: string;
  InstanceIds?: string[];
}

/**
 * Calls AWS authorises on "*" because they name no resource (list everything in the account).
 * Anything else whose resource cannot be read is UNKNOWN_RESOURCE, so a matching Deny applies.
 */
const ACCOUNT_LEVEL = [
  /^ec2:Describe/, /^elasticloadbalancing:Describe/, /^autoscaling:Describe/, /^organizations:(Describe|List)/,
  /^s3:ListAllMyBuckets$/, /^iam:(ListUsers|ListRoles|ListGroups|ListPolicies|ListInstanceProfiles|ListAccountAliases|GetAccountSummary|ListVirtualMFADevices|GetAccountPasswordPolicy)$/,
  /^sqs:ListQueues$/, /^dynamodb:(ListTables|ListBackups|ListGlobalTables)$/, /^lambda:(ListFunctions|ListLayers|ListEventSourceMappings)$/,
  /^kms:(ListKeys|ListAliases|DescribeCustomKeyStores)$/, /^sns:ListTopics$/, /^secretsmanager:ListSecrets$/,
  /^ssm:DescribeParameters$/, /^logs:DescribeLogGroups$/, /^cloudformation:(ListStacks|DescribeStacks)$/,
  /^cloudwatch:(DescribeAlarms|GetMetricData|ListMetrics|GetMetricStatistics)$/, /^sts:/,
  /^rds:Describe(DBInstances|DBClusters|DBSnapshots|DBClusterSnapshots|DBSubnetGroups|DBParameterGroups|DBEngineVersions|OrderableDBInstanceOptions|Events)$/,
  /^elasticache:Describe/, /^redshift:Describe(Clusters|ClusterSnapshots|ClusterSubnetGroups)$/,
  /^sns:(ListTopics|ListSubscriptions|ListPlatformApplications)$/, /^events:(ListRules|ListEventBuses|ListArchives|ListConnections|ListApiDestinations)$/,
  /^states:(ListStateMachines|ListActivities)$/, /^kinesis:(ListStreams|DescribeLimits)$/, /^logs:(DescribeLogGroups|DescribeQueryDefinitions|DescribeMetricFilters|DescribeDestinations)$/,
  /^cloudtrail:(DescribeTrails|ListTrails|LookupEvents|ListEventDataStores)$/, /^cloudformation:(ListStacks|DescribeStacks|ListExports|ListStackSets|ValidateTemplate)$/,
  /^ssm:(DescribeParameters|ListDocuments|ListCommands|ListCommandInvocations|DescribeInstanceInformation|DescribeAutomationExecutions|DescribeMaintenanceWindows|DescribeOpsItems)$/,
  /^route53:(ListHostedZones|ListHealthChecks|GetHostedZoneCount)$/, /^cloudfront:(ListDistributions|ListOriginAccessControls|ListCachePolicies)$/,
  /^apigateway:GET$/, /^ecs:(ListClusters|ListTaskDefinitions|ListTaskDefinitionFamilies|DescribeCapacityProviders)$/, /^eks:ListClusters$/,
  /^elasticfilesystem:DescribeFileSystems$/, /^elasticbeanstalk:(DescribeApplications|DescribeEnvironments|DescribeApplicationVersions|ListAvailableSolutionStacks)$/,
  /^glacier:ListVaults$/, /^cognito-idp:ListUserPools$/, /^athena:(ListWorkGroups|ListDataCatalogs|ListNamedQueries|ListQueryExecutions)$/,
  /^codebuild:(ListProjects|ListBuilds)$/, /^codecommit:ListRepositories$/, /^codepipeline:ListPipelines$/, /^lightsail:Get/, /^sagemaker:List/, /^bedrock:List/,
];

function resourceOrUnknown(action: string, resource: string | null): string {
  if (resource) return resource;
  return ACCOUNT_LEVEL.some((re) => re.test(action)) ? "*" : UNKNOWN_RESOURCE;
}

/**
 * The IAM requests an SDK call makes. `region` is the Region the client signs for: Regional
 * resource ARNs are built with it. Null (deny) for an unmapped call or a malformed Region.
 */
export function sdkCallToIam(clientName: string, commandName: string, input: unknown, region: string = DEFAULT_REGION): IamRequest[] | null {
  const prefix = CLIENT_PREFIX[clientName];
  if (!prefix || !commandName.endsWith("Command") || !isValidRegion(region)) return null;
  const op = commandName.slice(0, -"Command".length);
  const action = normaliseAction(`${prefix}:${op}`);
  const hints = (input ?? {}) as ResourceHints & Record<string, unknown>;
  const extra = extraRequests(prefix, op, action, hints, region);
  if (extra) return extra;
  return requestsFor(prefix, op, action, resourceArn(prefix, hints, region), hints, region);
}

/** One request per resource: the core mapping first, then iam-resources.ts, else unknown. */
function requestsFor(prefix: string, op: string, action: string, core: string | null, input: InputFields | null, region: string): IamRequest[] {
  if (core) return [{ action, resource: core }];
  const mapped = input ? mappedResources(prefix, op, input, region) : null;
  if (mapped) return mapped.map((m) => (m.lookup ? { action, resource: m.arn, lookup: m.lookup } : { action, resource: m.arn }));
  return [{ action, resource: resourceOrUnknown(action, null) }];
}

/** Calls that act on more than one resource. */
function extraRequests(prefix: string, op: string, action: string, input: ResourceHints & Record<string, unknown>, region: string): IamRequest[] | null {
  if (prefix === "s3" && op === "DeleteObjects") {
    const objects = (input.Delete as { Objects?: { Key?: string }[] } | undefined)?.Objects ?? [];
    if (!input.Bucket || objects.length === 0 || objects.some((o) => !o.Key)) return [{ action: "s3:DeleteObject", resource: UNKNOWN_RESOURCE }];
    return objects.map((o) => ({ action: "s3:DeleteObject", resource: `arn:aws:s3:::${input.Bucket}/${o.Key}` }));
  }
  if (prefix === "s3" && (op === "CopyObject" || op === "UploadPartCopy")) {
    return [
      { action: "s3:GetObject", resource: copySourceArn(input.CopySource) ?? UNKNOWN_RESOURCE },
      { action: "s3:PutObject", resource: resourceOrUnknown("s3:PutObject", resourceArn("s3", input, region)) },
    ];
  }
  if (prefix === "dynamodb" && /^(BatchWriteItem|BatchGetItem)$/.test(op)) {
    const tables = Object.keys((input.RequestItems as Record<string, unknown> | undefined) ?? {});
    return tables.length
      ? tables.map((t) => ({ action, resource: resourceOrUnknown(action, resourceArn("dynamodb", { TableName: t }, region)) }))
      : [{ action, resource: UNKNOWN_RESOURCE }];
  }
  if (prefix === "ec2" && Array.isArray(input.InstanceIds) && input.InstanceIds.length > 0 && !/^Describe/.test(op)) {
    return input.InstanceIds.map((id) => ({ action, resource: `arn:aws:ec2:${region}:${ACCOUNT}:instance/${id}` }));
  }
  return null;
}

function copySourceArn(copySource: unknown, decode = true): string | null {
  if (typeof copySource !== "string") return null;
  // The SDK takes a URL-encoded value; the CLI encodes what you type, so its value is used as is.
  const bare = copySource.replace(/^\//, "").split("?")[0];
  let clean = bare;
  try {
    clean = decode ? decodeURIComponent(bare) : bare;
  } catch {
    return null;
  }
  const slash = clean.indexOf("/");
  if (slash <= 0 || slash === clean.length - 1) return null;
  return `arn:aws:s3:::${clean}`;
}

function normaliseAction(action: string): string {
  return RENAMED_ACTIONS[action] ?? action;
}

/** The resource ARN the hints identify, or null when they do not identify one. */
function resourceArn(prefix: string, h: ResourceHints, region: string): string | null {
  switch (prefix) {
    case "s3":
      if (!h.Bucket) return null;
      return h.Key ? `arn:aws:s3:::${h.Bucket}/${h.Key}` : `arn:aws:s3:::${h.Bucket}`;
    case "dynamodb":
      return h.TableName ? `arn:aws:dynamodb:${region}:${ACCOUNT}:table/${h.TableName}` : null;
    case "sqs": {
      const name = h.QueueUrl?.split("/").pop();
      return name ? `arn:aws:sqs:${region}:${ACCOUNT}:${name}` : null;
    }
    case "iam":
      // Group membership calls carry both names; AWS authorises them on the group.
      if (h.GroupName) return `arn:aws:iam::${ACCOUNT}:group/${h.GroupName}`;
      if (h.UserName) return `arn:aws:iam::${ACCOUNT}:user/${h.UserName}`;
      if (h.RoleName) return `arn:aws:iam::${ACCOUNT}:role/${h.RoleName}`;
      if (h.SerialNumber?.startsWith("arn:")) return h.SerialNumber;
      return null;
    case "lambda":
      if (!h.FunctionName) return null;
      return h.FunctionName.startsWith("arn:")
        ? h.FunctionName
        : `arn:aws:lambda:${region}:${ACCOUNT}:function:${h.FunctionName}`;
    case "kms":
      // An alias is resolved to its key by AWS; the simulator cannot, so it stays unknown.
      if (!h.KeyId || h.KeyId.startsWith("alias/") || h.KeyId.includes(":alias/")) return null;
      return h.KeyId.startsWith("arn:") ? h.KeyId : `arn:aws:kms:${region}:${ACCOUNT}:key/${h.KeyId}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

/** Global options that take a value, e.g. `--region us-east-1`. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--region", "--output", "--profile", "--endpoint-url", "--query", "--color", "--ca-bundle",
  "--cli-read-timeout", "--cli-connect-timeout", "--cli-binary-format",
]);
const GLOBAL_BOOLEANS = new Set([
  "--debug", "--no-verify-ssl", "--no-paginate", "--no-sign-request", "--no-cli-pager",
  "--cli-auto-prompt", "--no-cli-auto-prompt",
]);

/** Splits `--flag=value` into `--flag value`, the way the aws CLI reads it. */
export function splitEqualsFlags(args: string[]): string[] {
  return args.flatMap((a) => {
    const m = /^(--[A-Za-z0-9-]+)=([\s\S]*)$/.exec(a);
    return m ? [m[1], m[2]] : [a];
  });
}

export interface CliCommandParts {
  service: string;
  operation: string;
  /** Every argument after the service except the operation word, flags included. */
  rest: string[];
  /** For `aws s3 ...`: the positional arguments, or null if they cannot be told apart. */
  s3Positionals?: string[] | null;
}

/**
 * Finds the service and operation. Before the service only exact global options are
 * accepted: the CLI also accepts abbreviations (`--reg`), and guessing whether one takes a
 * value would misplace the service, so those give null.
 */
export function cliCommandParts(rawArgs: string[]): CliCommandParts | null {
  const args = splitEqualsFlags(rawArgs);
  let i = 0;
  const skipGlobals = (): boolean => {
    while (i < args.length && args[i].startsWith("-")) {
      if (GLOBAL_OPTIONS_WITH_VALUE.has(args[i])) i += 2;
      else if (GLOBAL_BOOLEANS.has(args[i])) i += 1;
      else return false;
    }
    return true;
  };
  if (!skipGlobals()) return null;
  const serviceIdx = i++;
  // The CLI also takes operation flags before the operation (`aws s3 --force rb ...`);
  // only exact global options are accepted there, so nothing is read past the check.
  if (!skipGlobals()) return null;
  const opIdx = i;
  if (serviceIdx >= args.length || opIdx >= args.length) return null;
  const rest = [...args.slice(serviceIdx + 1, opIdx), ...args.slice(opIdx + 1)];
  const service = args[serviceIdx];
  return { service, operation: args[opIdx], rest, ...(service === "s3" ? { s3Positionals: s3Positionals(rest) } : {}) };
}

const CLI_FLAG_HINTS: Record<string, keyof ResourceHints> = {
  "--bucket": "Bucket",
  "--key": "Key",
  "--table-name": "TableName",
  "--queue-url": "QueueUrl",
  "--user-name": "UserName",
  "--role-name": "RoleName",
  "--group-name": "GroupName",
  "--function-name": "FunctionName",
  "--serial-number": "SerialNumber",
  "--key-id": "KeyId",
};

/** Real flags that also happen to be prefixes of a checked flag. */
const EXACT_FLAGS = new Set(["--instance-id", "--role", "--group", "--user"]);

/** Flags that change what the permission check must cover. */
const CHECKED_FLAGS = [
  ...Object.keys(CLI_FLAG_HINTS), "--copy-source", "--delete", "--recursive", "--force", "--instance-ids", "--instance-id",
];

/**
 * True when a checked flag is repeated (the CLI uses the last one) or abbreviated (the CLI
 * expands `--buck` to `--bucket`): either way the check could name the wrong resource.
 */
function hasAmbiguousFlags(rest: string[]): boolean {
  // Two flags that can both stand for one hint (--user-name and --user, --key-id and --key):
  // argparse keeps the last, which may not be the one read here.
  const flags = rest.filter((a) => a.startsWith("--"));
  for (const hint of Object.keys(CLI_FLAG_HINTS)) {
    if (flags.filter((t) => hint.startsWith(t) && t.length > 2).length > 1) return true;
  }
  const seen = new Set<string>();
  for (const a of rest) {
    if (!a.startsWith("--")) continue;
    if (CHECKED_FLAGS.includes(a)) {
      // An exact name always wins over an abbreviation, so --key is --key, not --key-id.
      if (seen.has(a)) return true;
      seen.add(a);
    } else if (!EXACT_FLAGS.has(a) && CHECKED_FLAGS.some((f) => f.startsWith(a))) {
      return true;
    }
  }
  return false;
}

function cliFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * Instance ids from `--instance-ids i-1 i-2`, `--instance-ids '["i-1","i-2"]'` or
 * `--instance-id i-1`. Null when a value is in a form the simulator cannot read.
 */
function cliInstanceIds(args: string[]): string[] | null {
  const values: string[] = [];
  for (const flag of ["--instance-ids", "--instance-id"]) {
    const i = args.indexOf(flag);
    if (i < 0) continue;
    for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) values.push(args[j]);
  }
  const ids: string[] = [];
  for (const v of values) {
    if (v.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(v);
        if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) return null;
        ids.push(...parsed);
      } catch {
        return null;
      }
    } else if (/^i-[0-9a-zA-Z]+$/.test(v)) {
      ids.push(v);
    } else {
      return null; // shorthand or anything else the CLI may read differently
    }
  }
  return ids;
}

function cliResourceHints(args: string[]): ResourceHints {
  const hints: ResourceHints = {};
  for (const [flag, field] of Object.entries(CLI_FLAG_HINTS)) {
    const v = cliFlagValue(args, flag);
    if (v !== undefined) (hints as Record<string, string>)[field] = v;
  }
  return hints;
}

export interface S3Uri {
  bucket: string;
  /** Key or prefix; "" for the whole bucket. */
  key: string;
}

export function parseS3Uri(value: string): S3Uri | null {
  if (!value.startsWith("s3://")) return null;
  const [bucket, ...keyParts] = value.slice("s3://".length).split("/");
  return bucket ? { bucket, key: keyParts.join("/") } : null;
}

export function objectArn(bucket: string, key: string): string {
  return key ? `arn:aws:s3:::${bucket}/${key}` : `arn:aws:s3:::${bucket}`;
}

/**
 * What a CLI command needs. `s3-recursive` commands act on whatever objects exist under a
 * prefix, so the caller lists them and checks each key.
 */
export type CliIamPlan =
  | { kind: "requests"; requests: IamRequest[] }
  | {
      kind: "s3-recursive";
      operation: "rm" | "cp" | "mv" | "sync";
      source?: S3Uri;
      target?: S3Uri;
      deleteExtra: boolean;
      /** `rb --force`: delete the bucket once it is empty. */
      deleteBucket?: boolean;
    };

/**
 * The Region a CLI command runs in: its `--region` value, else `fallback` (CloudShell's
 * Region). Null when that cannot be told for sure: a repeated or abbreviated `--region`
 * (the CLI expands `--regi`), or a value that is not a Region name.
 */
export function cliRegion(rawArgs: string[], fallback: string): string | null {
  const args = splitEqualsFlags(rawArgs);
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--region") {
      if (i + 1 >= args.length) return null;
      values.push(args[i + 1]);
      i++;
    } else if (a.startsWith("--") && a.length > 2 && "--region".startsWith(a)) {
      return null;
    }
  }
  if (values.length > 1) return null;
  const region = values.length === 1 ? values[0] : fallback;
  return isValidRegion(region) ? region : null;
}

/**
 * `args` are the CLI arguments after `aws`, as returned by parseAwsCommand. `region` is the
 * Region CloudShell runs in; a `--region` in the command wins, as it does for the CLI.
 */
export function cliArgsToIam(rawArgs: string[], defaultRegion: string = DEFAULT_REGION): CliIamPlan | null {
  const region = cliRegion(rawArgs, defaultRegion);
  if (!region) return null;
  const parts = cliCommandParts(rawArgs);
  if (!parts) return null;
  const { service, operation, rest } = parts;
  const ambiguous = hasAmbiguousFlags(rest);

  if (service === "s3") return ambiguous ? null : highLevelS3(operation, rest);

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(operation)) return null;
  const prefix = iamPrefix(service);
  if (!prefix) return null;
  const pascal = toPascal(operation);
  if (pascal === "Wait") return waiterPlan(prefix, rest, ambiguous, region);
  const action = normaliseAction(`${prefix}:${pascal}`);
  // A repeated or shortened resource flag may name a different resource from the one we
  // would read, so the whole command is checked as acting on an unknown resource.
  if (ambiguous) return { kind: "requests", requests: [{ action, resource: UNKNOWN_RESOURCE }] };

  const hints = cliResourceHints(rest);
  // On List calls --key abbreviates --key-marker, not an object key.
  if (/^List/.test(pascal)) delete hints.Key;
  if (prefix === "s3" && pascal === "DeleteObjects") {
    const keys = deleteObjectsKeys(cliFlagValue(rest, "--delete"));
    if (!keys || !hints.Bucket) return null;
    return { kind: "requests", requests: keys.map((k) => ({ action: "s3:DeleteObject", resource: objectArn(hints.Bucket!, k) })) };
  }
  if (prefix === "s3" && (pascal === "CopyObject" || pascal === "UploadPartCopy")) {
    const source = copySourceArn(cliFlagValue(rest, "--copy-source"), false);
    if (!source) return null;
    return {
      kind: "requests",
      requests: [
        { action: "s3:GetObject", resource: source },
        { action: "s3:PutObject", resource: resourceOrUnknown("s3:PutObject", resourceArn("s3", hints, region)) },
      ],
    };
  }
  if (prefix === "ec2" && !/^Describe/.test(pascal) && (rest.includes("--instance-ids") || rest.includes("--instance-id"))) {
    const instanceIds = cliInstanceIds(rest);
    if (!instanceIds) return null;
    if (instanceIds.length > 0) {
      return { kind: "requests", requests: instanceIds.map((id) => ({ action, resource: `arn:aws:ec2:${region}:${ACCOUNT}:instance/${id}` })) };
    }
  }
  // A flag the core hints don't read (--secret-id, --alarm-names …): iam-resources.ts.
  return { kind: "requests", requests: requestsFor(prefix, pascal, action, resourceArn(prefix, hints, region), cliFlagsToInput(rest), region) };
}

function toPascal(kebab: string): string {
  return kebab
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** `aws <service> wait <waiter>` polls a Describe/Get call; check that call. */
const WAITERS: Array<[prefix: string, waiter: RegExp, action: string]> = [
  ["ec2", /^instance-/, "ec2:DescribeInstances"],
  ["ec2", /^(volume-|snapshot-|image-)/, ""],
  ["dynamodb", /^table-/, "dynamodb:DescribeTable"],
  ["s3", /^bucket-/, "s3:ListBucket"],
  ["s3", /^object-/, "s3:GetObject"],
  ["lambda", /^function-/, "lambda:GetFunction"],
  ["cloudformation", /^stack-/, "cloudformation:DescribeStacks"],
];

function waiterPlan(prefix: string, rest: string[], ambiguous: boolean, region: string): CliIamPlan | null {
  const waiter = rest.find((a) => !a.startsWith("-"));
  if (!waiter) return null;
  const match = WAITERS.find(([p, re]) => p === prefix && re.test(waiter));
  if (!match) return null;
  const action = match[2] || `ec2:Describe${toPascal(waiter.split("-")[0])}s`;
  const resource = ambiguous ? UNKNOWN_RESOURCE : resourceOrUnknown(action, resourceArn(prefix, cliResourceHints(rest), region));
  return { kind: "requests", requests: [{ action, resource }] };
}

/** Keys from `--delete '{"Objects":[{"Key":"a"}]}'`. Only the JSON form is understood. */
function deleteObjectsKeys(value: string | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { Objects?: { Key?: unknown }[] };
    const keys = (parsed.Objects ?? []).map((o) => o.Key);
    return keys.length && keys.every((k): k is string => typeof k === "string" && k.length > 0) ? keys : null;
  } catch {
    return null;
  }
}

/** Flags of the high-level s3 commands that take no value. Every other flag takes one. */
const S3_BOOLEAN_FLAGS = new Set([
  "--recursive", "--dryrun", "--quiet", "--force", "--delete", "--only-show-errors", "--no-progress",
  "--follow-symlinks", "--no-follow-symlinks", "--exact-timestamps", "--size-only", "--human-readable",
  "--summarize", "--no-guess-mime-type", "--ignore-glacier-warnings", "--force-glacier-transfer",
  "--no-overwrite", "--debug", "--no-verify-ssl", "--no-paginate", "--no-sign-request", "--no-cli-pager",
]);

/**
 * The positional arguments of a high-level s3 command (paths and s3:// locations), skipping
 * flag values: `--exclude s3://x` names a pattern, not a location. Null if a flag lacks its value.
 */
export function s3Positionals(rest: string[]): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      if (S3_BOOLEAN_FLAGS.has(a)) continue;
      if (i + 1 >= rest.length) return null;
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function highLevelS3(operation: string, rest: string[]): CliIamPlan | null {
  const positionals = s3Positionals(rest);
  if (!positionals) return null;
  const uris = positionals.map(parseS3Uri).filter((u): u is S3Uri => u !== null);
  if (uris.length !== positionals.filter((p) => p !== "-").length) return null; // a local path
  const recursive = rest.includes("--recursive");
  const first = uris[0];
  const one = (action: string, resource: string): CliIamPlan => ({ kind: "requests", requests: [{ action, resource }] });

  if (["ls", "mb", "rb", "presign", "rm"].includes(operation) && positionals.length > 1) return null;
  switch (operation) {
    case "ls":
      return first ? one("s3:ListBucket", objectArn(first.bucket, "")) : one("s3:ListAllMyBuckets", "*");
    case "mb":
      return first ? one("s3:CreateBucket", objectArn(first.bucket, "")) : null;
    case "rb":
      // `rb --force` empties the bucket, then deletes it.
      if (!first) return null;
      return rest.includes("--force")
        ? { kind: "s3-recursive", operation: "rm", source: { bucket: first.bucket, key: "" }, deleteExtra: false, deleteBucket: true }
        : one("s3:DeleteBucket", objectArn(first.bucket, ""));
    case "presign":
      return first?.key ? one("s3:GetObject", objectArn(first.bucket, first.key)) : null;
    case "rm":
      if (!first) return null;
      if (recursive) return { kind: "s3-recursive", operation: "rm", source: first, deleteExtra: false };
      return first.key ? one("s3:DeleteObject", objectArn(first.bucket, first.key)) : null;
    case "cp":
    case "mv":
    case "sync":
      return transfer(operation, rest, positionals, recursive);
    default:
      return null;
  }
}

function transfer(operation: "cp" | "mv" | "sync", rest: string[], positional: string[], recursive: boolean): CliIamPlan | null {
  if (positional.length !== 2) return null;
  const [src, dst] = positional.map((p) => (p === "-" ? null : parseS3Uri(p)));
  if (!src && !dst) return null;

  if (operation === "sync" || recursive) {
    if (!src || !dst) return null; // stdin/stdout cannot be recursive
    return { kind: "s3-recursive", operation, source: src, target: dst, deleteExtra: operation === "sync" && rest.includes("--delete") };
  }

  const requests: IamRequest[] = [];
  if (src) {
    if (!src.key) return null;
    requests.push({ action: "s3:GetObject", resource: objectArn(src.bucket, src.key) });
    if (operation === "mv") requests.push({ action: "s3:DeleteObject", resource: objectArn(src.bucket, src.key) });
  }
  if (dst) {
    const name = src ? src.key.split("/").pop() ?? "" : "";
    const key = !dst.key || dst.key.endsWith("/") ? `${dst.key}${name}` : dst.key;
    if (!key) return null;
    requests.push({ action: "s3:PutObject", resource: objectArn(dst.bucket, key) });
  }
  return { kind: "requests", requests };
}

/** The checks a recursive S3 command needs, given the keys that exist under its prefixes. */
export function expandRecursive(
  plan: Extract<CliIamPlan, { kind: "s3-recursive" }>,
  sourceKeys: string[],
  targetKeys: string[]
): IamRequest[] {
  const { source, target, operation } = plan;
  const requests: IamRequest[] = [];
  if (source) requests.push({ action: "s3:ListBucket", resource: objectArn(source.bucket, "") });
  if (target && operation !== "rm") requests.push({ action: "s3:ListBucket", resource: objectArn(target.bucket, "") });
  for (const key of sourceKeys) {
    if (!source) break;
    if (operation === "rm") {
      requests.push({ action: "s3:DeleteObject", resource: objectArn(source.bucket, key) });
      continue;
    }
    requests.push({ action: "s3:GetObject", resource: objectArn(source.bucket, key) });
    if (target) {
      const relative = key.slice(source.key.length).replace(/^\//, "");
      const base = target.key && !target.key.endsWith("/") ? `${target.key}/` : target.key;
      requests.push({ action: "s3:PutObject", resource: objectArn(target.bucket, `${base}${relative}`) });
    }
    if (operation === "mv") requests.push({ action: "s3:DeleteObject", resource: objectArn(source.bucket, key) });
  }
  if (plan.deleteExtra && target) {
    for (const key of targetKeys) requests.push({ action: "s3:DeleteObject", resource: objectArn(target.bucket, key) });
  }
  if (plan.deleteBucket && source) requests.push({ action: "s3:DeleteBucket", resource: objectArn(source.bucket, "") });
  return requests;
}
