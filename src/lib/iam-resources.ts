/**
 * Resource ARNs for services beyond the core ones in iam-action.ts resourceArn(), so that
 * resource-scoped Allow statements match as they do in AWS (IDS-5, OG-6).
 *
 * Two sources, in order:
 * 1. Explicit field mappings per service (SecretId, TopicArn, logGroupName, parameter Name,
 *    InstanceId, DBInstanceIdentifier, rule Name, StreamName, cluster/service, StackName,
 *    AlarmNames, Athena WorkGroup, Route 53 HostedZoneId, CodeBuild project, SQS QueueName,
 *    BudgetName …).
 * 2. Any top-level input field named …Arn / …ARN / …Arns whose value is an ARN of the
 *    calling service (arn:aws:<prefix>:…). ARNs of other services (a RoleArn passed to Step
 *    Functions, a KMS key ARN) are never used: they are not the resource being acted on.
 *
 * When neither names a resource the caller keeps UNKNOWN_RESOURCE (fail closed).
 * Field names are matched case-insensitively, so SDK inputs (logGroupName, stateMachineArn)
 * and CLI flags turned into PascalCase (LogGroupName) both work.
 */

import { DEFAULT_REGION, isValidRegion } from "./regions.ts";

const ACCOUNT = "000000000000";

export type InputFields = Record<string, unknown>;

/**
 * A name the simulator must turn into the real ARN before checking (Secrets Manager adds a
 * random 6-character suffix to every secret ARN). The mapped `arn` is used when the lookup fails.
 */
export interface ResourceLookup {
  service: "secretsmanager";
  name: string;
  /** The Region the call goes to: the secret is looked up there. */
  region: string;
}

export interface MappedResource {
  arn: string;
  lookup?: ResourceLookup;
}

/** The value of `name` in `input`, matched case-insensitively. */
function field(input: InputFields, name: string): unknown {
  if (name in input) return input[name];
  const lower = name.toLowerCase();
  const k = Object.keys(input).find((key) => key.toLowerCase() === lower);
  return k === undefined ? undefined : input[k];
}

function str(input: InputFields, name: string): string | null {
  const v = field(input, name);
  return typeof v === "string" && v !== "" ? v : null;
}

/** A string or a list of strings; null when absent or when any item is not a non-empty string. */
function strs(input: InputFields, name: string): string[] | null {
  const v = field(input, name);
  if (typeof v === "string") return v === "" ? null : [v];
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "")) return v as string[];
  return null;
}

/** Builds `arn:aws:<service>:<region>:<account>:<resource>` for one Region. */
type ArnFn = (service: string, resource: string) => string;

const arnIn = (region: string): ArnFn => (service, resource) => `arn:aws:${service}:${region}:${ACCOUNT}:${resource}`;

const lastSegment = (v: string, sep = "/"): string => v.split(sep).pop() ?? v;

function secretResource(id: string, region: string): MappedResource {
  if (id.startsWith("arn:")) return { arn: id };
  // Real ARNs end in -<6 random characters>; "-??????" is the form AWS documents for policies.
  return { arn: arnIn(region)("secretsmanager", `secret:${id}-??????`), lookup: { service: "secretsmanager", name: id, region } };
}

function logsResources(input: InputFields, arn: ArnFn): string[] | null {
  const identifier = str(input, "logGroupIdentifier");
  const group = str(input, "logGroupName") ?? (identifier && !identifier.startsWith("arn:") ? identifier : null);
  if (!group) return identifier?.startsWith("arn:") ? [identifier.replace(/:\*$/, "") + ":*"] : null;
  const stream = str(input, "logStreamName");
  return [stream ? arn("logs", `log-group:${group}:log-stream:${stream}`) : arn("logs", `log-group:${group}:*`)];
}

function ssmResources(op: string, input: InputFields, arn: ArnFn): string[] | null {
  if (!/Parameter/.test(op)) return null;
  const param = (n: string) => (n.startsWith("arn:") ? n : arn("ssm", `parameter/${n.replace(/^\//, "")}`));
  const names = strs(input, "Names") ?? strs(input, "Name") ?? strs(input, "Path");
  return names ? names.map(param) : null;
}

const EC2_ID_FIELDS: Array<[field: string, type: string]> = [
  ["InstanceIds", "instance"],
  ["InstanceId", "instance"],
  ["VolumeId", "volume"],
  ["SnapshotId", "snapshot"],
  ["SecurityGroupId", "security-group"],
  ["GroupId", "security-group"],
  ["VpcId", "vpc"],
  ["SubnetId", "subnet"],
  ["KeyName", "key-pair"],
];

function ec2Resources(op: string, input: InputFields, arn: ArnFn): string[] | null {
  // Describe* calls support no resource-level permissions in AWS: they stay on "*".
  if (/^Describe/.test(op)) return null;
  for (const [name, type] of EC2_ID_FIELDS) {
    const ids = strs(input, name);
    if (ids) return ids.map((id) => arn("ec2", `${type}/${id}`));
  }
  return null;
}

function rdsResources(input: InputFields, arn: ArnFn): string[] | null {
  const out: string[] = [];
  const fields: Array<[string, string]> = [
    ["DBInstanceIdentifier", "db"],
    ["DBClusterIdentifier", "cluster"],
    ["DBSnapshotIdentifier", "snapshot"],
    ["DBClusterSnapshotIdentifier", "cluster-snapshot"],
  ];
  for (const [name, type] of fields) {
    const id = str(input, name);
    if (id) out.push(id.startsWith("arn:") ? id : arn("rds", `${type}:${id}`));
  }
  return out.length ? out : null;
}

function eventsResources(op: string, input: InputFields, arn: ArnFn): string[] | null {
  const bus = str(input, "EventBusName");
  const busName = bus ? lastSegment(bus) : "default";
  if (/Rule$|^(PutTargets|RemoveTargets|ListTargetsByRule)$/.test(op)) {
    const rule = str(input, "Rule") ?? str(input, "Name");
    if (!rule) return null;
    if (rule.startsWith("arn:")) return [rule];
    return [arn("events", busName === "default" ? `rule/${rule}` : `rule/${busName}/${rule}`)];
  }
  if (/EventBus$/.test(op)) {
    const name = str(input, "Name");
    return name ? [name.startsWith("arn:") ? name : arn("events", `event-bus/${name}`)] : null;
  }
  if (/Archive$/.test(op)) {
    const name = str(input, "ArchiveName");
    return name ? [arn("events", `archive/${name}`)] : null;
  }
  return null;
}

function kinesisResources(input: InputFields, arn: ArnFn): string[] | null {
  const name = str(input, "StreamName");
  return name ? [arn("kinesis", `stream/${name}`)] : null;
}

function ecsResources(op: string, input: InputFields, arn: ArnFn): string[] | null {
  const clusterRaw = str(input, "cluster") ?? (op === "CreateCluster" || op === "DeleteCluster" ? str(input, "clusterName") : null);
  const clusterName = clusterRaw ? lastSegment(clusterRaw) : "default";
  const clusterArn = clusterRaw?.startsWith("arn:") ? clusterRaw : arn("ecs", `cluster/${clusterName}`);
  const serviceArn = (s: string) => (s.startsWith("arn:") ? s : arn("ecs", `service/${clusterName}/${s}`));
  if (/^(CreateService)$/.test(op)) {
    const s = str(input, "serviceName");
    return s ? [serviceArn(s)] : null;
  }
  if (/^(UpdateService|DeleteService)$/.test(op)) {
    const s = str(input, "service");
    return s ? [serviceArn(s)] : null;
  }
  if (op === "DescribeServices") {
    const services = strs(input, "services");
    return services ? services.map(serviceArn) : null;
  }
  if (op === "DescribeClusters") {
    const clusters = strs(input, "clusters");
    return clusters ? clusters.map((c) => (c.startsWith("arn:") ? c : arn("ecs", `cluster/${c}`))) : null;
  }
  if (/Cluster|CapacityProviders$/.test(op) && clusterRaw) return [clusterArn];
  return null;
}

function cloudformationResources(input: InputFields, arn: ArnFn): string[] | null {
  const name = str(input, "StackName");
  if (!name) return null;
  // Stack ARNs end in /<stack id>; "/*" is the form AWS documents for policies.
  return [name.startsWith("arn:") ? name : arn("cloudformation", `stack/${name}/*`)];
}

function cloudwatchResources(input: InputFields, arn: ArnFn): string[] | null {
  const names = strs(input, "AlarmNames") ?? strs(input, "AlarmName");
  return names ? names.map((n) => arn("cloudwatch", `alarm:${n}`)) : null;
}

function snsResources(op: string, input: InputFields, arn: ArnFn): string[] | null {
  if (op === "CreateTopic") {
    const name = str(input, "Name");
    return name ? [arn("sns", name)] : null;
  }
  return null;
}

function statesResources(op: string, input: InputFields, arn: ArnFn): string[] | null {
  if (op === "CreateStateMachine") {
    const name = str(input, "name");
    return name ? [arn("states", `stateMachine:${name}`)] : null;
  }
  return null;
}

function cognitoResources(input: InputFields, arn: ArnFn): string[] | null {
  const id = str(input, "UserPoolId");
  return id ? [arn("cognito-idp", `userpool/${id}`)] : null;
}

function athenaResources(op: string, input: InputFields, arn: ArnFn): string[] | null {
  if (/DataCatalog/.test(op)) {
    const name = str(input, "Name") ?? str(input, "CatalogName");
    return name ? [arn("athena", `datacatalog/${name}`)] : null;
  }
  const wg = str(input, "WorkGroup") ?? (/WorkGroup$/.test(op) ? str(input, "Name") : null) ?? (op === "StartQueryExecution" ? "primary" : null);
  return wg ? [arn("athena", `workgroup/${wg}`)] : null;
}

/** Route 53 ARNs have no Region or account: arn:aws:route53:::hostedzone/Z123. */
function route53Resources(op: string, input: InputFields): string[] | null {
  // "Id" names a hosted zone only in hosted-zone calls (GetChange's Id is a change).
  const id = str(input, "HostedZoneId") ?? (/HostedZone/.test(op) ? str(input, "Id") : null);
  return id ? [`arn:aws:route53:::hostedzone/${lastSegment(id)}`] : null;
}

function codebuildResources(input: InputFields, arn: ArnFn): string[] | null {
  const project = (n: string) => (n.startsWith("arn:") ? n : arn("codebuild", `project/${n}`));
  const one = str(input, "projectName") ?? str(input, "name") ?? str(input, "project");
  if (one) return [project(one)];
  const names = strs(input, "names");
  if (names) return names.map(project);
  // Build ids are "<project>:<uuid>".
  const ids = strs(input, "ids") ?? strs(input, "id");
  return ids ? ids.map((i) => project(i.split(":")[0])) : null;
}

function sqsResources(input: InputFields, arn: ArnFn): string[] | null {
  const name = str(input, "QueueName");
  return name ? [arn("sqs", name)] : null;
}

/** Budgets ARNs have no Region: arn:aws:budgets::<account>:budget/<name>. */
function budgetsResources(input: InputFields): string[] | null {
  const name = str(input, "BudgetName") ?? str(input, "Name");
  return name ? [`arn:aws:budgets::${str(input, "AccountId") ?? ACCOUNT}:budget/${name}`] : null;
}

/** Explicit per-service mappings; null when the service or call is not covered. */
function explicitResources(prefix: string, op: string, input: InputFields, region: string): MappedResource[] | null {
  const arn = arnIn(region);
  const plain = (arns: string[] | null): MappedResource[] | null => (arns ? arns.map((a) => ({ arn: a })) : null);
  switch (prefix) {
    case "secretsmanager": {
      const id = str(input, "SecretId") ?? (op === "CreateSecret" ? str(input, "Name") : null);
      return id ? [secretResource(id, region)] : null;
    }
    case "logs":
      return plain(logsResources(input, arn));
    case "ssm":
      return plain(ssmResources(op, input, arn));
    case "ec2":
      return plain(ec2Resources(op, input, arn));
    case "rds":
      return plain(rdsResources(input, arn));
    case "events":
      return plain(eventsResources(op, input, arn));
    case "kinesis":
      return plain(kinesisResources(input, arn));
    case "ecs":
      return plain(ecsResources(op, input, arn));
    case "cloudformation":
      return plain(cloudformationResources(input, arn));
    case "cloudwatch":
      return plain(cloudwatchResources(input, arn));
    case "sns":
      return plain(snsResources(op, input, arn));
    case "states":
      return plain(statesResources(op, input, arn));
    case "cognito-idp":
      return plain(cognitoResources(input, arn));
    case "athena":
      return plain(athenaResources(op, input, arn));
    case "route53":
      return plain(route53Resources(op, input));
    case "codebuild":
      return plain(codebuildResources(input, arn));
    case "sqs":
      return plain(sqsResources(input, arn));
    case "budgets":
      return plain(budgetsResources(input));
    default:
      return null;
  }
}

const ARN_FIELD = /(Arn|ARN|Arns|ARNs)$/;

/** ARNs of the calling service in top-level …Arn fields (TopicArn, CertificateArn, ResourceARN …). */
export function arnFieldResources(prefix: string, input: InputFields): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!ARN_FIELD.test(key)) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v === "string" && v.split(":")[2] === prefix && /^arn:aws[a-z-]*:/.test(v)) out.push(v);
    }
  }
  return out;
}

/**
 * The resources a call acts on, for services iam-action.ts resourceArn() does not cover.
 * Null when nothing in the input names one (the caller then fails closed). `region` is the
 * Region the call goes to; Regional ARNs are built with it.
 */
export function mappedResources(prefix: string, op: string, input: InputFields, region: string = DEFAULT_REGION): MappedResource[] | null {
  if (!isValidRegion(region)) return null;
  const explicit = explicitResources(prefix, op, input, region);
  if (explicit && explicit.length) return explicit;
  const fromArns = arnFieldResources(prefix, input);
  return fromArns.length ? fromArns.map((a) => ({ arn: a })) : null;
}

/**
 * CLI flags after the operation as an SDK-like input: `--alarm-names a b` becomes
 * { AlarmNames: ["a", "b"] }. Null when a flag repeats or a value is in a form the CLI may
 * read differently (JSON, shorthand, comma lists), so the caller fails closed.
 */
export function cliFlagsToInput(rest: string[]): InputFields | null {
  const out: InputFields = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith("--") || flag.length < 3) continue;
    const values: string[] = [];
    for (let j = i + 1; j < rest.length && !rest[j].startsWith("--"); j++) values.push(rest[j]);
    const key = flag
      .slice(2)
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");
    if (key in out) return null;
    if (values.some((v) => /^[[{]/.test(v) || v.includes(","))) return null;
    if (values.length > 0) out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}
