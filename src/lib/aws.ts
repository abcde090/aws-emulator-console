/**
 * One AWS SDK client per service, all pointed at the local emulator and all checked by the
 * dashboard's IAM simulator before they send anything (see iam-enforce.ts).
 *
 * Credentials and the CA come from ~/.aws/emulator/<port>/ only. The SDK's default
 * credential chain is never used, so a missing emulator can never fall back to the real
 * AWS credentials in ~/.aws/credentials. Clients are rebuilt when those files change
 * (the emulator writes new keys on every start).
 */

import { readFileSync, statSync } from "node:fs";
import { Agent } from "node:https";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { IAMClient } from "@aws-sdk/client-iam";
import { STSClient } from "@aws-sdk/client-sts";
import { EC2Client } from "@aws-sdk/client-ec2";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { KMSClient } from "@aws-sdk/client-kms";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { SNSClient } from "@aws-sdk/client-sns";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { SFNClient } from "@aws-sdk/client-sfn";
import { KinesisClient } from "@aws-sdk/client-kinesis";
import { RDSClient } from "@aws-sdk/client-rds";
import { ElastiCacheClient } from "@aws-sdk/client-elasticache";
import { RedshiftClient } from "@aws-sdk/client-redshift";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SSMClient } from "@aws-sdk/client-ssm";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Route53Client } from "@aws-sdk/client-route-53";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EKSClient } from "@aws-sdk/client-eks";
import { EFSClient } from "@aws-sdk/client-efs";
import { ElasticBeanstalkClient } from "@aws-sdk/client-elastic-beanstalk";
import { GlacierClient } from "@aws-sdk/client-glacier";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { AthenaClient } from "@aws-sdk/client-athena";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { CodeCommitClient } from "@aws-sdk/client-codecommit";
import { CodePipelineClient } from "@aws-sdk/client-codepipeline";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { WAFV2Client } from "@aws-sdk/client-wafv2";
import { GuardDutyClient } from "@aws-sdk/client-guardduty";
import { SecurityHubClient } from "@aws-sdk/client-securityhub";
import { ConfigServiceClient } from "@aws-sdk/client-config-service";
import { BackupClient } from "@aws-sdk/client-backup";
import { BudgetsClient } from "@aws-sdk/client-budgets";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { GlueClient } from "@aws-sdk/client-glue";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { XRayClient } from "@aws-sdk/client-xray";
import { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { FirehoseClient } from "@aws-sdk/client-firehose";
import { ACMClient } from "@aws-sdk/client-acm";
import { RAMClient } from "@aws-sdk/client-ram";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";
import { DatabaseMigrationServiceClient } from "@aws-sdk/client-database-migration-service";
import { WellArchitectedClient } from "@aws-sdk/client-wellarchitected";
import { ComputeOptimizerClient } from "@aws-sdk/client-compute-optimizer";
import { FisClient } from "@aws-sdk/client-fis";
import { ResiliencehubClient } from "@aws-sdk/client-resiliencehub";
import { Route53ResolverClient } from "@aws-sdk/client-route53resolver";
import { PipesClient } from "@aws-sdk/client-pipes";
import { CognitoIdentityClient } from "@aws-sdk/client-cognito-identity";
import { DAXClient } from "@aws-sdk/client-dax";
import { DynamoDBStreamsClient } from "@aws-sdk/client-dynamodb-streams";
import { ApplicationAutoScalingClient } from "@aws-sdk/client-application-auto-scaling";
import { RedshiftDataClient } from "@aws-sdk/client-redshift-data";
import { ServiceDiscoveryClient } from "@aws-sdk/client-servicediscovery";
import { AccessAnalyzerClient } from "@aws-sdk/client-accessanalyzer";
import { emulatorRequestHandler, installEmulatorMiddleware, type Enforce, type StackOwner } from "./sdk-middleware.ts";
import { emulatorEndpoint, emulatorFiles, parseCredentialsIni, type StaticCredentials } from "./emulator-files.ts";
import { DEFAULT_REGION, GLOBAL_CLIENT_KEYS, GLOBAL_HOME_REGION, isValidRegion } from "./regions.ts";

export { isValidRegion, REGION_PATTERN } from "./regions.ts";

const CLIENT_CLASSES = {
  s3: S3Client,
  sqs: SQSClient,
  dynamodb: DynamoDBClient,
  iam: IAMClient,
  sts: STSClient,
  ec2: EC2Client,
  lambda: LambdaClient,
  kms: KMSClient,
  cloudwatch: CloudWatchClient,
  logs: CloudWatchLogsClient,
  sns: SNSClient,
  eventbridge: EventBridgeClient,
  sfn: SFNClient,
  kinesis: KinesisClient,
  rds: RDSClient,
  elasticache: ElastiCacheClient,
  redshift: RedshiftClient,
  cloudformation: CloudFormationClient,
  ssm: SSMClient,
  secretsmanager: SecretsManagerClient,
  route53: Route53Client,
  cloudfront: CloudFrontClient,
  apigateway: APIGatewayClient,
  ecs: ECSClient,
  eks: EKSClient,
  efs: EFSClient,
  elasticbeanstalk: ElasticBeanstalkClient,
  glacier: GlacierClient,
  cognito: CognitoIdentityProviderClient,
  athena: AthenaClient,
  codebuild: CodeBuildClient,
  codecommit: CodeCommitClient,
  codepipeline: CodePipelineClient,
  organizations: OrganizationsClient,
  elbv2: ElasticLoadBalancingV2Client,
  autoscaling: AutoScalingClient,
  cloudtrail: CloudTrailClient,
  wafv2: WAFV2Client,
  guardduty: GuardDutyClient,
  securityhub: SecurityHubClient,
  config: ConfigServiceClient,
  backup: BackupClient,
  budgets: BudgetsClient,
  costexplorer: CostExplorerClient,
  glue: GlueClient,
  scheduler: SchedulerClient,
  xray: XRayClient,
  servicequotas: ServiceQuotasClient,
  firehose: FirehoseClient,
  acm: ACMClient,
  ram: RAMClient,
  ssoadmin: SSOAdminClient,
  identitystore: IdentitystoreClient,
  apigatewayv2: ApiGatewayV2Client,
  dms: DatabaseMigrationServiceClient,
  wellarchitected: WellArchitectedClient,
  computeoptimizer: ComputeOptimizerClient,
  fis: FisClient,
  resiliencehub: ResiliencehubClient,
  route53resolver: Route53ResolverClient,
  pipes: PipesClient,
  cognitoidentity: CognitoIdentityClient,
  dax: DAXClient,
  dynamodbstreams: DynamoDBStreamsClient,
  applicationautoscaling: ApplicationAutoScalingClient,
  redshiftdata: RedshiftDataClient,
  servicediscovery: ServiceDiscoveryClient,
  accessanalyzer: AccessAnalyzerClient,
} as const;

type ClientClasses = typeof CLIENT_CLASSES;
export type ServiceKey = keyof ClientClasses;
export type AwsClients = { readonly [K in ServiceKey]: InstanceType<ClientClasses[K]> };

interface SharedConfig {
  fingerprint: string;
  endpoint: string;
  credentials: StaticCredentials;
  agent: Agent;
}

let shared: SharedConfig | null = null;

/** How long a file check is trusted: one stat per burst of calls, not per client property access. */
export const FINGERPRINT_TTL_MS = 1000;
let fingerprintCheckedAt = 0;

function fileStamp(path: string): string {
  const s = statSync(path);
  return `${s.mtimeMs}:${s.size}`;
}

/** Reads the emulator's CA and keys, again only when the files changed. */
function sharedConfig(now = Date.now()): SharedConfig {
  if (shared && now - fingerprintCheckedAt < FINGERPRINT_TTL_MS) return shared;
  const files = emulatorFiles();
  let fingerprint: string;
  try {
    fingerprint = `${fileStamp(files.ca)}|${fileStamp(files.credentials)}`;
  } catch {
    throw new Error(
      `AWS Emulator files not found in ${files.dir}. Start the emulator with ./scripts/emulator.sh start, then reload.`
    );
  }
  fingerprintCheckedAt = now;
  if (shared && shared.fingerprint === fingerprint) return shared;
  const credentials = parseCredentialsIni(readFileSync(files.credentials, "utf8"));
  if (!credentials) throw new Error(`No [default] keys in ${files.credentials}. Restart the emulator.`);
  const agent = new Agent({ ca: readFileSync(files.ca, "utf8"), keepAlive: true });
  const previous = shared;
  shared = { fingerprint, endpoint: emulatorEndpoint(), credentials, agent };
  if (previous) retire(previous.agent);
  return shared;
}

/** The IAM simulator check for a client that signs for `region` (resource ARNs carry it). */
function enforcerFor(region: string): Enforce {
  return async (clientName, commandName, input) => {
    const { enforceSimulatedIam } = await import("./iam-enforce");
    await enforceSimulatedIam(clientName, commandName, input, region);
  };
}

function buildClient<K extends ServiceKey>(key: K, cfg: SharedConfig, checked: boolean, region: string): InstanceType<ClientClasses[K]> {
  const Ctor = CLIENT_CLASSES[key] as unknown as new (config: Record<string, unknown>) => StackOwner;
  const client = new Ctor({
    region,
    endpoint: cfg.endpoint,
    credentials: cfg.credentials,
    // HTTP/1.1 for every client: the emulator refuses HTTP/2 (Kinesis defaults to it).
    requestHandler: emulatorRequestHandler(cfg.agent),
    maxAttempts: 2,
    ...(key === "s3" ? { forcePathStyle: true } : {}),
  });
  // The IAM simulator check runs first on every call of a checked client.
  installEmulatorMiddleware(client, checked ? enforcerFor(region) : null);
  return client as unknown as InstanceType<ClientClasses[K]>;
}

const caches = { checked: new Map<string, unknown>(), unchecked: new Map<string, unknown>() };
let cachedFingerprint = "";

/**
 * Closes the old keys' clients and keep-alive sockets after a key rotation. Calls already
 * in flight keep their sockets until they finish (the agent is destroyed a little later).
 */
function retire(agent: Agent): void {
  const old = [...caches.checked.values(), ...caches.unchecked.values()] as Array<{ destroy?: () => void }>;
  caches.checked.clear();
  caches.unchecked.clear();
  const timer = setTimeout(() => {
    for (const c of old) {
      try {
        c.destroy?.();
      } catch {
        // A client that cannot be destroyed is dropped anyway.
      }
    }
    agent.destroy();
  }, 30_000);
  timer.unref?.();
}

function getClient<K extends ServiceKey>(key: K, checked: boolean, region: string = DEFAULT_REGION): InstanceType<ClientClasses[K]> {
  if (!isValidRegion(region)) throw new Error(`"${String(region)}" is not a valid AWS Region name.`);
  const cfg = sharedConfig();
  if (cfg.fingerprint !== cachedFingerprint) {
    caches.checked.clear();
    caches.unchecked.clear();
    cachedFingerprint = cfg.fingerprint;
  }
  const cache = checked ? caches.checked : caches.unchecked;
  const cacheKey = `${region}:${key}`;
  const existing = cache.get(cacheKey) as InstanceType<ClientClasses[K]> | undefined;
  if (existing) return existing;
  const client = buildClient(key, cfg, checked, region);
  cache.set(cacheKey, client);
  return client;
}

/** Test hook: forgets the cached config and clients (destroying them), as a key rotation does. */
export function resetClientsForTests(): void {
  if (shared) retire(shared.agent);
  shared = null;
  fingerprintCheckedAt = 0;
  cachedFingerprint = "";
}

type ClientGetter = (key: ServiceKey) => unknown;

function clientSet(get: ClientGetter): AwsClients {
  return Object.freeze(
    Object.defineProperties(
      {},
      Object.fromEntries((Object.keys(CLIENT_CLASSES) as ServiceKey[]).map((key) => [key, { enumerable: true, get: () => get(key) }]))
    )
  ) as AwsClients;
}

/** The Region a console page in `region` uses for one client: global services keep their home Region. */
export function consoleClientRegion(key: ServiceKey, region: string): string {
  return GLOBAL_CLIENT_KEYS.has(key) ? GLOBAL_HOME_REGION : region;
}

/** The Region chosen in the top bar for the current request (the default outside a request). */
async function requestRegion(): Promise<string> {
  const { selectedRegion } = await import("./selected-region.ts");
  return selectedRegion();
}

type Sender = { send: (command: unknown, ...rest: unknown[]) => Promise<unknown> };
const requestProxies = new WeakMap<object, unknown>();

/**
 * A client whose send() signs for the Region of the request it runs in. The SDK fixes a
 * client's signing Region on its first call, so each send() is handed to the checked client
 * built for that Region; everything else (config, middleware) is the default Region's client.
 */
function requestRegionClient<K extends ServiceKey>(key: K): InstanceType<ClientClasses[K]> {
  const base = getClient(key, true, DEFAULT_REGION);
  const existing = requestProxies.get(base);
  if (existing) return existing as InstanceType<ClientClasses[K]>;
  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== "send") return Reflect.get(target, prop, receiver);
      return async (command: unknown, ...rest: unknown[]) => {
        const client = getClient(key, true, await requestRegion()) as unknown as Sender;
        return client.send(command, ...rest);
      };
    },
  });
  requestProxies.set(base, proxy);
  return proxy;
}

/**
 * Permission-checked clients for code that has no ctx (hand-built pages' server actions):
 * every call is checked against the acting identity and signs for the Region chosen in the
 * top bar, or for the home Region of a global service (IAM, S3, Route 53 …).
 */
export const clients: AwsClients = clientSet((key) =>
  GLOBAL_CLIENT_KEYS.has(key) ? getClient(key, true, GLOBAL_HOME_REGION) : requestRegionClient(key)
);

const regionSets = new Map<string, AwsClients>();
const consoleSets = new Map<string, AwsClients>();

/**
 * Permission-checked clients that all sign for `region` (cross-Region copies, CloudFront-scope
 * WAF). Same emulator endpoint, same IAM simulator check. Throws on a malformed Region name.
 */
export function clientsIn(region: string): AwsClients {
  if (!isValidRegion(region)) throw new Error(`"${String(region)}" is not a valid AWS Region name.`);
  const existing = regionSets.get(region);
  if (existing) return existing;
  const set = clientSet((key) => getClient(key, true, region));
  regionSets.set(region, set);
  return set;
}

/**
 * The clients a console page in `region` uses (ctx.clients): Regional services sign for
 * `region`, global services for their home Region, as the AWS console does.
 */
export function consoleClients(region: string): AwsClients {
  if (!isValidRegion(region)) throw new Error(`"${String(region)}" is not a valid AWS Region name.`);
  const existing = consoleSets.get(region);
  if (existing) return existing;
  const set = clientSet((key) => getClient(key, true, consoleClientRegion(key, region)));
  consoleSets.set(region, set);
  return set;
}

export const SERVICE_KEYS = Object.keys(CLIENT_CLASSES) as ServiceKey[];

/**
 * NOT permission-checked. Only for the simulator itself: loading the acting identity's
 * policies, listing identities to switch to, and listing keys for recursive S3 checks.
 * Never hand these to service definitions.
 */
export function uncheckedIam(): IAMClient {
  return getClient("iam", false);
}

export function uncheckedS3(): S3Client {
  return getClient("s3", false);
}

/** Simulator only: looks up a secret's real ARN (its random suffix) for the permission check. */
export function uncheckedSecretsManager(region: string = DEFAULT_REGION): SecretsManagerClient {
  return getClient("secretsmanager", false, region);
}
