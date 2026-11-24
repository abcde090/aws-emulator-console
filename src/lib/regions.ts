/**
 * The Regions the console offers and how each page uses them. Pure: no Next.js or SDK
 * imports, so the top bar (browser), the server and the unit tests share it.
 *
 * The list is the emulator's default-enabled commercial Regions (`aws account list-regions`
 * shows them ENABLED_BY_DEFAULT; opt-in Regions such as af-south-1 refuse the emulator's
 * keys, as they would for an account that has not opted in). Each was checked with
 * DynamoDB, SQS and EC2 calls.
 */

export const DEFAULT_REGION = "us-east-1";

/** Where AWS serves its global services (IAM, Organizations, Route 53, CloudFront, billing). */
export const GLOBAL_HOME_REGION = "us-east-1";

/** The cookie that holds the Region chosen in the top bar. */
export const REGION_COOKIE = "aws_console_region";

export interface ConsoleRegion {
  code: string;
  /** As the AWS console shows it, e.g. "US East (N. Virginia)". */
  name: string;
}

export const CONSOLE_REGIONS: readonly ConsoleRegion[] = Object.freeze([
  { code: "us-east-1", name: "US East (N. Virginia)" },
  { code: "us-east-2", name: "US East (Ohio)" },
  { code: "us-west-1", name: "US West (N. California)" },
  { code: "us-west-2", name: "US West (Oregon)" },
  { code: "ap-south-1", name: "Asia Pacific (Mumbai)" },
  { code: "ap-northeast-3", name: "Asia Pacific (Osaka)" },
  { code: "ap-northeast-2", name: "Asia Pacific (Seoul)" },
  { code: "ap-southeast-1", name: "Asia Pacific (Singapore)" },
  { code: "ap-southeast-2", name: "Asia Pacific (Sydney)" },
  { code: "ap-northeast-1", name: "Asia Pacific (Tokyo)" },
  { code: "ca-central-1", name: "Canada (Central)" },
  { code: "eu-central-1", name: "Europe (Frankfurt)" },
  { code: "eu-west-1", name: "Europe (Ireland)" },
  { code: "eu-west-2", name: "Europe (London)" },
  { code: "eu-west-3", name: "Europe (Paris)" },
  { code: "eu-north-1", name: "Europe (Stockholm)" },
  { code: "sa-east-1", name: "South America (São Paulo)" },
]);

const CONSOLE_REGION_CODES = new Set(CONSOLE_REGIONS.map((r) => r.code));

/** Signing Regions a client may be built for: "us-east-1", "eu-west-2", "us-gov-west-1" … */
export const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

export function isValidRegion(region: unknown): region is string {
  return typeof region === "string" && REGION_PATTERN.test(region);
}

/** True only for a Region the console offers (the allowlist above). */
export function isConsoleRegion(region: unknown): region is string {
  return typeof region === "string" && CONSOLE_REGION_CODES.has(region);
}

/**
 * The Region a cookie value names. Never trusted: anything that is not exactly one of the
 * offered Region codes (missing, empty, padded, another case, a lookalike) is the default.
 */
export function parseRegionCookie(raw: string | undefined): string {
  return isConsoleRegion(raw) ? raw : DEFAULT_REGION;
}

/** "US West (Oregon)" for "us-west-2"; the code itself for a Region not in the list. */
export function regionName(code: string): string {
  return CONSOLE_REGIONS.find((r) => r.code === code)?.name ?? code;
}

/**
 * SDK clients (keys of CLIENT_CLASSES in aws.ts) for services AWS runs globally. They always
 * sign for GLOBAL_HOME_REGION, whatever Region the top bar shows. S3 is here because its
 * bucket list is global and the emulator serves every bucket from any Region; IAM Identity
 * Center is here because the emulator keeps one instance for every Region.
 */
export const GLOBAL_CLIENT_KEYS: ReadonlySet<string> = new Set([
  "iam",
  "organizations",
  "route53",
  "cloudfront",
  "budgets",
  "costexplorer",
  "s3",
  "ssoadmin",
  "identitystore",
]);

/** Console services whose pages show "Global" in the top bar, as on AWS. */
export const GLOBAL_SERVICE_IDS: ReadonlySet<string> = new Set(["iam", "organizations", "route53", "cloudfront", "cost", "s3", "identitycenter"]);

/** Pages of a global service that are Regional all the same (IAM Access Analyzer analyzers). */
const REGIONAL_PAGES_OF_GLOBAL_SERVICES: ReadonlySet<string> = new Set(["iam/access-analyzer", "iam/access-analyzer-findings"]);

/** True when the page for this service (and resource list) is global. */
export function isGlobalPage(serviceId: string | undefined, resourceId?: string): boolean {
  if (!serviceId || !GLOBAL_SERVICE_IDS.has(serviceId)) return false;
  return !(resourceId && REGIONAL_PAGES_OF_GLOBAL_SERVICES.has(`${serviceId}/${resourceId}`));
}

/** The Region a page's calls use: the global home Region for global pages, else the chosen one. */
export function pageRegion(serviceId: string | undefined, resourceId: string | undefined, selected: string): string {
  return isGlobalPage(serviceId, resourceId) ? GLOBAL_HOME_REGION : selected;
}

/** The service and resource segments of a console path ("/dynamodb/tables/T" -> dynamodb, tables). */
export function pathSegments(pathname: string): { serviceId?: string; resourceId?: string } {
  const [serviceId, resourceId] = pathname.split(/[?#]/)[0].split("/").filter(Boolean);
  return { serviceId, resourceId };
}

/**
 * Where the console goes after a Region switch: the same page when it is a service home or a
 * resource list, else that resource's list (a detail page names a resource of the old Region).
 */
export function regionSwitchTarget(pathname: string): string {
  const parts = pathname.split(/[?#]/)[0].split("/").filter(Boolean);
  if (parts.length <= 2) return pathname || "/";
  return `/${parts[0]}/${parts[1]}`;
}
