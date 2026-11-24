/** Route 53 health checks: endpoint and calculated health checks, their checkers' status and tags. */

import {
  CreateHealthCheckCommand,
  DeleteHealthCheckCommand,
  GetHealthCheckCommand,
  GetHealthCheckLastFailureReasonCommand,
  GetHealthCheckStatusCommand,
  ListHealthChecksCommand,
  ListTagsForResourcesCommand,
  UpdateHealthCheckCommand,
  type HealthCheck,
  type HealthCheckConfig,
  type HealthCheckType,
  type UpdateHealthCheckRequest,
} from "@aws-sdk/client-route-53";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { healthStatus } from "./records.ts";
import { replaceTags, tagsOf } from "./hosted-zones.ts";

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/;

async function listChecks(ctx: Ctx): Promise<HealthCheck[]> {
  const out: HealthCheck[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.route53.send(new ListHealthChecksCommand({ Marker: marker, MaxItems: 100 }));
    out.push(...(r.HealthChecks ?? []));
    marker = r.IsTruncated ? r.NextMarker : undefined;
  } while (marker);
  return out;
}

async function nameTags(ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 10) {
    const r = await ctx.clients.route53.send(new ListTagsForResourcesCommand({ ResourceType: "healthcheck", ResourceIds: ids.slice(i, i + 10) }));
    for (const set of r.ResourceTagSets ?? []) {
      const name = set.Tags?.find((t) => t.Key === "Name")?.Value;
      if (set.ResourceId && name) names.set(set.ResourceId, name);
    }
  }
  return names;
}

/** What the console shows in the Description column: what is being monitored. */
export function describeCheck(c: Partial<HealthCheckConfig> | undefined): string {
  if (!c) return "";
  if (c.Type === "CALCULATED") return `Calculated: healthy if at least ${c.HealthThreshold ?? 0} of ${(c.ChildHealthChecks ?? []).length} health checks are healthy`;
  if (c.Type === "CLOUDWATCH_METRIC") return `CloudWatch alarm ${c.AlarmIdentifier?.Name ?? ""}`;
  if (c.Type === "RECOVERY_CONTROL") return `Routing control ${c.RoutingControlArn ?? ""}`;
  const host = c.FullyQualifiedDomainName ?? c.IPAddress ?? "";
  const proto = (c.Type ?? "").startsWith("HTTPS") ? "https" : (c.Type ?? "").startsWith("HTTP") ? "http" : "tcp";
  const path = proto === "tcp" ? "" : c.ResourcePath ?? "/";
  return `${proto}://${host}:${c.Port ?? ""}${path}`;
}

async function statusOf(ctx: Ctx, id: string, type: string | undefined): Promise<string> {
  try {
    const r = await ctx.clients.route53.send(new GetHealthCheckStatusCommand({ HealthCheckId: id }));
    return healthStatus(r.HealthCheckObservations);
  } catch (err: unknown) {
    // Calculated health checks have no checkers of their own.
    return type === "CALCULATED" ? "Unknown" : `Could not read: ${errorMessage(err)}`;
  }
}

async function checkOptions(ctx: Ctx): Promise<Option[]> {
  const checks = await listChecks(ctx);
  const names = await nameTags(ctx, checks.map((c) => c.Id ?? "").filter(Boolean));
  return checks.filter((c) => c.Id).map((c) => ({ value: c.Id as string, label: `${names.get(c.Id as string) ?? c.Id} - ${describeCheck(c.HealthCheckConfig)}` }));
}

const str = (v: FieldValues[string]): string => (typeof v === "string" ? v.trim() : "");
const numOrUndef = (v: FieldValues[string]): number | undefined => (typeof v === "number" ? v : undefined);


async function currentConfig(ctx: Ctx, id: string): Promise<HealthCheckConfig> {
  const r = await ctx.clients.route53.send(new GetHealthCheckCommand({ HealthCheckId: id }));
  if (!r.HealthCheck?.HealthCheckConfig) throw new Error(`Route 53 returned no configuration for health check ${id}.`);
  return r.HealthCheck.HealthCheckConfig;
}

const isCalculated = (c: Partial<HealthCheckConfig>): boolean => c.Type === "CALCULATED";
const isHttp = (c: Partial<HealthCheckConfig>): boolean => (c.Type ?? "").startsWith("HTTP");
const isStrMatch = (c: Partial<HealthCheckConfig>): boolean => (c.Type ?? "").endsWith("_STR_MATCH");

/** The Edit health check form, filled from the current configuration. */
export function healthCheckFormValues(c: Partial<HealthCheckConfig>): FieldValues {
  const base: FieldValues = { inverted: c.Inverted === true, disabled: c.Disabled === true };
  if (isCalculated(c)) return { ...base, children: c.ChildHealthChecks ?? [], healthThreshold: c.HealthThreshold ?? null };
  return {
    ...base,
    endpoint: c.IPAddress ?? c.FullyQualifiedDomainName ?? "",
    port: c.Port ?? null,
    path: isHttp(c) ? c.ResourcePath ?? "" : "",
    searchString: isStrMatch(c) ? c.SearchString ?? "" : "",
    failureThreshold: c.FailureThreshold ?? null,
  };
}

/**
 * The UpdateHealthCheck parameters for what the user changed (no HealthCheckId). An empty
 * object means nothing changed. Fields that don't apply to the check's type are ignored.
 */
export function healthCheckUpdate(c: Partial<HealthCheckConfig>, v: FieldValues): Omit<UpdateHealthCheckRequest, "HealthCheckId"> {
  const out: Omit<UpdateHealthCheckRequest, "HealthCheckId"> = {};
  if (isCalculated(c)) {
    const children = Array.isArray(v.children) ? (v.children as string[]).filter((x) => typeof x === "string" && x !== "") : [];
    const now = c.ChildHealthChecks ?? [];
    if (children.length === 0) throw new Error("Choose at least one health check to monitor.");
    if (children.length !== now.length || children.some((x) => !now.includes(x))) out.ChildHealthChecks = children;
    const threshold = numOrUndef(v.healthThreshold);
    if (threshold !== undefined && threshold !== c.HealthThreshold) out.HealthThreshold = threshold;
    if (threshold !== undefined && threshold > children.length) throw new Error(`The threshold can't be more than the ${children.length} health checks it monitors.`);
  } else if (c.Type !== "CLOUDWATCH_METRIC" && c.Type !== "RECOVERY_CONTROL") {
    const endpoint = str(v.endpoint);
    const nowEndpoint = c.IPAddress ?? c.FullyQualifiedDomainName ?? "";
    if (!endpoint) throw new Error("Enter the endpoint's IP address or domain name.");
    if (endpoint !== nowEndpoint) {
      if (IPV4.test(endpoint) || IPV6.test(endpoint)) out.IPAddress = endpoint;
      else out.FullyQualifiedDomainName = endpoint;
    }
    const port = numOrUndef(v.port);
    if (port !== undefined && port !== c.Port) out.Port = port;
    if (isHttp(c)) {
      const path = str(v.path);
      if (!path && c.ResourcePath) out.ResetElements = ["ResourcePath"];
      else if (path && path !== c.ResourcePath) out.ResourcePath = path;
    }
    if (isStrMatch(c)) {
      const search = str(v.searchString);
      if (!search) throw new Error("A string-matching health check needs a search string.");
      if (search !== c.SearchString) out.SearchString = search;
    }
    const failure = numOrUndef(v.failureThreshold);
    if (failure !== undefined && failure !== c.FailureThreshold) out.FailureThreshold = failure;
  }
  const inverted = v.inverted === true;
  if (inverted !== (c.Inverted === true)) out.Inverted = inverted;
  const disabled = v.disabled === true;
  if (disabled !== (c.Disabled === true)) out.Disabled = disabled;
  return out;
}

function endpointConfig(v: FieldValues): HealthCheckConfig {
  const endpoint = str(v.endpoint);
  if (!endpoint) throw new Error("Enter the endpoint's IP address or domain name.");
  const isIp = IPV4.test(endpoint) || IPV6.test(endpoint);
  const protocol = str(v.protocol) || "HTTP";
  const search = str(v.searchString);
  if (search && protocol === "TCP") throw new Error("String matching works only with HTTP and HTTPS.");
  const type = (search ? `${protocol}_STR_MATCH` : protocol) as HealthCheckType;
  return {
    Type: type,
    IPAddress: isIp ? endpoint : undefined,
    FullyQualifiedDomainName: isIp ? str(v.hostName) || undefined : endpoint,
    Port: numOrUndef(v.port) ?? (protocol === "HTTPS" ? 443 : 80),
    ResourcePath: protocol === "TCP" ? undefined : str(v.path) || "/",
    SearchString: search || undefined,
    RequestInterval: v.requestInterval === "10" ? 10 : 30,
    FailureThreshold: numOrUndef(v.failureThreshold) ?? 3,
    MeasureLatency: v.measureLatency === true,
    EnableSNI: protocol === "HTTPS" ? v.enableSni === true : undefined,
    Inverted: v.inverted === true,
    Disabled: v.disabled === true,
  };
}

function calculatedConfig(v: FieldValues): HealthCheckConfig {
  const children = Array.isArray(v.children) ? (v.children as string[]) : [];
  if (children.length === 0) throw new Error("Choose at least one health check to monitor.");
  const threshold = numOrUndef(v.healthThreshold) ?? 1;
  if (threshold > children.length) throw new Error(`The threshold can't be more than the ${children.length} health checks you chose.`);
  return { Type: "CALCULATED", ChildHealthChecks: children, HealthThreshold: threshold, Inverted: v.inverted === true, Disabled: v.disabled === true };
}

const createFields: FieldDef[] = [
  { name: "name", label: "Name", kind: "text", required: true, section: "Configure health check", help: "Saved as the health check's Name tag.", validate: { max: 255, message: "At most 255 characters." } },
  {
    name: "what", label: "What to monitor", kind: "radio", default: "endpoint", section: "Configure health check",
    options: [
      { value: "endpoint", label: "Endpoint" },
      { value: "calculated", label: "Status of other health checks (calculated health check)" },
    ],
  },
  { name: "endpoint", label: "IP address or domain name", kind: "text", required: true, section: "Monitor an endpoint", showIf: { field: "what", equals: "endpoint" }, placeholder: "example.com or 192.0.2.44", help: "Route 53 sends health check requests to this endpoint." },
  { name: "hostName", label: "Host name", kind: "text", section: "Monitor an endpoint", showIf: { field: "what", equals: "endpoint" }, help: "For an IP address endpoint: the value Route 53 passes in the Host header." },
  {
    name: "protocol", label: "Protocol", kind: "select", default: "HTTP", section: "Monitor an endpoint", showIf: { field: "what", equals: "endpoint" },
    options: [
      { value: "HTTP", label: "HTTP" },
      { value: "HTTPS", label: "HTTPS" },
      { value: "TCP", label: "TCP" },
    ],
  },
  { name: "port", label: "Port", kind: "number", default: 80, section: "Monitor an endpoint", showIf: { field: "what", equals: "endpoint" }, validate: { min: 1, max: 65535, message: "Between 1 and 65535." } },
  { name: "path", label: "Path", kind: "text", default: "/", section: "Monitor an endpoint", showIf: { field: "what", equals: "endpoint" }, help: "HTTP and HTTPS only, such as /images/test.html.", validate: { max: 255, message: "At most 255 characters." } },
  { name: "searchString", label: "Search string", kind: "text", section: "Monitor an endpoint", showIf: { field: "what", equals: "endpoint" }, help: "String matching: Route 53 searches the first 5,120 bytes of the response body for this text.", validate: { max: 255, message: "At most 255 characters." } },
  {
    name: "requestInterval", label: "Request interval", kind: "radio", default: "30", section: "Advanced configuration", showIf: { field: "what", equals: "endpoint" },
    options: [
      { value: "30", label: "Standard (30 seconds)" },
      { value: "10", label: "Fast (10 seconds)" },
    ],
  },
  { name: "failureThreshold", label: "Failure threshold", kind: "number", default: 3, section: "Advanced configuration", showIf: { field: "what", equals: "endpoint" }, help: "Consecutive checks an endpoint must pass or fail to change status.", validate: { min: 1, max: 10, message: "Between 1 and 10." } },
  { name: "measureLatency", label: "Latency graphs", kind: "checkbox", default: false, section: "Advanced configuration", showIf: { field: "what", equals: "endpoint" }, help: "Measure latency between health checkers and the endpoint. Can't be changed later." },
  { name: "enableSni", label: "Enable SNI", kind: "checkbox", default: true, section: "Advanced configuration", showIf: { field: "what", equals: "endpoint" }, help: "HTTPS only: send the host name to the endpoint in the TLS handshake." },
  { name: "children", label: "Health checks to monitor", kind: "multiselect", options: checkOptions, section: "Monitor other health checks", showIf: { field: "what", equals: "calculated" } },
  { name: "healthThreshold", label: "Report healthy when at least this many are healthy", kind: "number", default: 1, section: "Monitor other health checks", showIf: { field: "what", equals: "calculated" }, validate: { min: 0, max: 256, message: "Between 0 and 256." } },
  { name: "inverted", label: "Invert health check status", kind: "checkbox", default: false, section: "Advanced configuration", help: "Route 53 considers the health check unhealthy when the endpoint is healthy, and the other way round." },
  { name: "disabled", label: "Disable health check", kind: "checkbox", default: false, section: "Advanced configuration", help: "A disabled health check is always considered healthy." },
];

export const healthChecks: ResourceDef = {
  id: "health-checks",
  name: "Health checks",
  singular: "health check",
  idField: "id",
  nameField: "name",
  description: "Health checks monitor the health of your resources, such as web servers, and other health checks.",
  emptyText: "No health checks to display.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "description", label: "Description", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "version", label: "Version", kind: "count", hidden: true },
  ],

  async list(ctx) {
    const checks = await listChecks(ctx);
    // Names come from tags; without tag access the list still shows the checks.
    const names = await nameTags(ctx, checks.map((c) => c.Id ?? "").filter(Boolean)).catch(() => new Map<string, string>());
    return Promise.all(
      checks.map(async (c): Promise<Row> => ({
        id: c.Id ?? "",
        name: names.get(c.Id ?? "") ?? null,
        status: c.Id ? await statusOf(ctx, c.Id, c.HealthCheckConfig?.Type) : null,
        description: describeCheck(c.HealthCheckConfig),
        type: c.HealthCheckConfig?.Type ?? null,
        version: c.HealthCheckVersion ?? null,
      }))
    );
  },

  async get(ctx, id) {
    const r = await ctx.clients.route53.send(new GetHealthCheckCommand({ HealthCheckId: id }));
    const c = r.HealthCheck;
    if (!c) throw new Error(`Route 53 returned no health check for ${id}.`);
    const cfg: Partial<HealthCheckConfig> = c.HealthCheckConfig ?? {};
    const calculated = cfg.Type === "CALCULATED";
    let statusError: string | null = null;
    const soft = <T,>(p: Promise<T>): Promise<T | null> =>
      p.catch((err: unknown) => {
        statusError ??= errorMessage(err);
        return null;
      });
    const [tags, status, lastFailure] = await Promise.all([
      tagsOf(ctx, "healthcheck", id).catch((): Tag[] => []),
      calculated ? Promise.resolve(null) : soft(ctx.clients.route53.send(new GetHealthCheckStatusCommand({ HealthCheckId: id }))),
      calculated ? Promise.resolve(null) : soft(ctx.clients.route53.send(new GetHealthCheckLastFailureReasonCommand({ HealthCheckId: id }))),
    ]);
    const observations = (status?.HealthCheckObservations ?? []).map((o) => ({ region: o.Region ?? null, ip: o.IPAddress ?? null, status: o.StatusReport?.Status ?? null, checked: o.StatusReport?.CheckedTime ?? null }));
    const failures = (lastFailure?.HealthCheckObservations ?? []).map((o) => ({ region: o.Region ?? null, ip: o.IPAddress ?? null, status: o.StatusReport?.Status ?? null, checked: o.StatusReport?.CheckedTime ?? null }));
    const name = tags.find((t) => t.Key === "Name")?.Value ?? id;
    return {
      summary: { name, id, status: calculated ? "Unknown" : statusError ? `Unavailable: ${statusError}` : healthStatus(status?.HealthCheckObservations), description: describeCheck(cfg), version: c.HealthCheckVersion ?? null },
      summaryLabels: { name: "Name", id: "Health check ID", status: "Status", description: "Description", version: "Version" },
      tabs: [
        {
          id: "info",
          label: "Info",
          kind: "keyvalue",
          data: {
            Type: cfg.Type ?? null,
            "IP address": cfg.IPAddress ?? null,
            "Domain name": cfg.FullyQualifiedDomainName ?? null,
            Port: cfg.Port ?? null,
            Path: cfg.ResourcePath ?? null,
            "Search string": cfg.SearchString ?? null,
            "Request interval (seconds)": cfg.RequestInterval ?? null,
            "Failure threshold": cfg.FailureThreshold ?? null,
            "Latency measurement": cfg.MeasureLatency ?? null,
            SNI: cfg.EnableSNI ?? null,
            Inverted: cfg.Inverted ?? null,
            Disabled: cfg.Disabled ?? null,
            "Child health checks": calculated ? (cfg.ChildHealthChecks ?? []).join(", ") || "None" : null,
            "Health threshold": calculated ? cfg.HealthThreshold ?? null : null,
            "Health checker regions": (cfg.Regions ?? []).join(", ") || null,
            "Caller reference": c.CallerReference ?? null,
          },
        },
        {
          id: "checkers",
          label: "Health checkers",
          kind: "table",
          columns: [
            { key: "region", label: "Health checker region", kind: "text" },
            { key: "ip", label: "Health checker IP", kind: "code" },
            { key: "checked", label: "Last checked", kind: "date" },
            { key: "status", label: "Status", kind: "status" },
          ],
          data: observations,
          description: "The most recent status that each Route 53 health checker reported.",
          emptyText: calculated ? "Calculated health checks take their status from other health checks, not from health checkers." : "No health checker reports yet.",
        },
        {
          id: "last-failure",
          label: "Last failure reason",
          kind: "table",
          columns: [
            { key: "region", label: "Health checker region", kind: "text" },
            { key: "ip", label: "Health checker IP", kind: "code" },
            { key: "checked", label: "Time", kind: "date" },
            { key: "status", label: "Reason", kind: "text" },
          ],
          data: failures,
          emptyText: "No failures reported.",
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tags,
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create health check",
    description: "Creates a Route 53 health check with CreateHealthCheck. You can then attach it to records that use failover, weighted, latency, geolocation or multivalue routing.",
    fields: createFields,
    async run(ctx, v) {
      const config = v.what === "calculated" ? calculatedConfig(v) : endpointConfig(v);
      const r = await ctx.clients.route53.send(new CreateHealthCheckCommand({ CallerReference: `console-${Date.now()}-${Math.round(performance.now())}`, HealthCheckConfig: config }));
      const id = r.HealthCheck?.Id;
      if (!id) throw new Error("Route 53 returned no health check ID.");
      const name = str(v.name);
      if (name) await replaceTags(ctx, "healthcheck", id, [{ Key: "Name", Value: name }]);
      return id;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit health check",
      fields: [
        { name: "endpoint", label: "IP address or domain name", kind: "text", help: "Endpoint health checks only." },
        { name: "port", label: "Port", kind: "number", help: "Endpoint health checks only.", validate: { min: 1, max: 65535, message: "Between 1 and 65535." } },
        { name: "path", label: "Path", kind: "text", help: "HTTP and HTTPS health checks only. Clear it to reset to /.", validate: { max: 255, message: "At most 255 characters." } },
        { name: "searchString", label: "Search string", kind: "text", help: "String-matching health checks only.", validate: { max: 255, message: "At most 255 characters." } },
        { name: "failureThreshold", label: "Failure threshold", kind: "number", help: "Endpoint health checks only.", validate: { min: 1, max: 10, message: "Between 1 and 10." } },
        { name: "children", label: "Health checks to monitor", kind: "multiselect", options: checkOptions, help: "Calculated health checks only." },
        { name: "healthThreshold", label: "Health threshold", kind: "number", help: "Calculated health checks only.", validate: { min: 0, max: 256, message: "Between 0 and 256." } },
        { name: "inverted", label: "Invert health check status", kind: "checkbox", default: false },
        { name: "disabled", label: "Disable health check", kind: "checkbox", default: false, help: "A disabled health check is always considered healthy." },
      ],
      initialValues: async (ctx, id) => healthCheckFormValues(await currentConfig(ctx, id)),
      async run(ctx, id, v) {
        const r0 = await ctx.clients.route53.send(new GetHealthCheckCommand({ HealthCheckId: id }));
        const changes = healthCheckUpdate(r0.HealthCheck?.HealthCheckConfig ?? {}, v);
        if (Object.keys(changes).length === 0) return { message: "No changes to the health check." };
        const r = await ctx.clients.route53.send(new UpdateHealthCheckCommand({ HealthCheckId: id, HealthCheckVersion: r0.HealthCheck?.HealthCheckVersion, ...changes }));
        return { message: `Health check updated to version ${r.HealthCheck?.HealthCheckVersion ?? "?"}.`, json: r.HealthCheck?.HealthCheckConfig };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "The health check's tags. The Name tag is the name the console shows; only the changes are saved." }],
      initialValues: async (ctx, id) => ({ tags: await tagsOf(ctx, "healthcheck", id) }),
      async run(ctx, id, v) {
        const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
        return { message: await replaceTags(ctx, "healthcheck", id, tags) };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.route53.send(new DeleteHealthCheckCommand({ HealthCheckId: id }));
    },
  },
};
