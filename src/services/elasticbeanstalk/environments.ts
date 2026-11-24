/** Elastic Beanstalk environments: create, deploy, health, events, logs, configuration. Id = environment ID. */

import {
  AbortEnvironmentUpdateCommand,
  CreateConfigurationTemplateCommand,
  CreateEnvironmentCommand,
  DescribeConfigurationSettingsCommand,
  DescribeEnvironmentHealthCommand,
  DescribeEnvironmentManagedActionsCommand,
  DescribeEnvironmentResourcesCommand,
  DescribeEventsCommand,
  DescribeInstancesHealthCommand,
  RebuildEnvironmentCommand,
  RequestEnvironmentInfoCommand,
  RestartAppServerCommand,
  RetrieveEnvironmentInfoCommand,
  SwapEnvironmentCNAMEsCommand,
  TerminateEnvironmentCommand,
  UpdateEnvironmentCommand,
  type EnvironmentDescription,
  type EnvironmentInfoType,
} from "@aws-sdk/client-elastic-beanstalk";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { Ctx, DetailTab, FieldDef, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import { ENV_NAME, environmentOptionSettings, joinId, logLocation, splitId, tagList, tierLabel, type OptionSetting } from "./helpers.ts";
import {
  applicationOptions,
  environment,
  environmentOptions,
  environments,
  instanceProfileOptions,
  platformOptions,
  roleOptions,
  subnetOptions,
  versionOptions,
  vpcOptions,
} from "./lookups.ts";
import { manageTagsAction, readTags, tagsTab, tolerantTab } from "./tagging.ts";

const LOG_WAIT_MS = 10_000;
const LOG_MAX_CHARS = 100_000;

export function envRow(e: EnvironmentDescription): Row {
  return {
    id: e.EnvironmentId ?? "",
    name: e.EnvironmentName ?? null,
    health: e.Health ?? null,
    healthStatus: e.HealthStatus ?? null,
    status: e.Status ?? null,
    application: e.ApplicationName ?? null,
    version: e.VersionLabel ?? null,
    createdAt: e.DateCreated ?? null,
    updatedAt: e.DateUpdated ?? null,
    domain: e.CNAME ?? null,
    platform: e.SolutionStackName ?? e.PlatformArn ?? null,
    tier: tierLabel(e.Tier),
    arn: e.EnvironmentArn ?? null,
  };
}

export const ENV_COLUMNS = [
  { key: "name", label: "Environment name", kind: "link" as const },
  { key: "health", label: "Health", kind: "status" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "application", label: "Application name", kind: "text" as const },
  { key: "id", label: "Environment ID", kind: "text" as const },
  { key: "version", label: "Running version", kind: "text" as const },
  { key: "createdAt", label: "Date created", kind: "date" as const },
  { key: "updatedAt", label: "Last modified", kind: "date" as const, hidden: true },
  { key: "domain", label: "Domain", kind: "text" as const },
  { key: "platform", label: "Platform", kind: "text" as const },
  { key: "tier", label: "Tier name", kind: "text" as const },
];

async function eventsTab(ctx: Ctx, envId: string): Promise<DetailTab> {
  const r = await ctx.clients.elasticbeanstalk.send(new DescribeEventsCommand({ EnvironmentId: envId, MaxRecords: 100 }));
  return {
    id: "events",
    label: "Events",
    kind: "table",
    columns: [
      { key: "time", label: "Time", kind: "date" },
      { key: "type", label: "Type", kind: "status" },
      { key: "details", label: "Details", kind: "text" },
    ],
    data: (r.Events ?? []).map((e) => ({ time: e.EventDate ?? null, type: e.Severity ?? null, details: e.Message ?? null })),
    emptyText: "No events.",
  };
}

async function healthTabs(ctx: Ctx, envId: string): Promise<DetailTab[]> {
  const [env, inst] = await Promise.all([
    ctx.clients.elasticbeanstalk.send(new DescribeEnvironmentHealthCommand({ EnvironmentId: envId, AttributeNames: ["All"] })),
    ctx.clients.elasticbeanstalk.send(new DescribeInstancesHealthCommand({ EnvironmentId: envId, AttributeNames: ["All"] })),
  ]);
  const ih = env.InstancesHealth;
  const codes = env.ApplicationMetrics?.StatusCodes;
  return [
    {
      id: "health",
      label: "Health",
      kind: "table",
      description: `Overall health: ${env.HealthStatus ?? "-"} (${env.Color ?? "-"}). ${env.Causes?.length ? `Causes: ${env.Causes.join(" ")}` : "No causes reported."}`,
      columns: [
        { key: "instance", label: "Instance ID", kind: "text" },
        { key: "status", label: "Status", kind: "status" },
        { key: "color", label: "Color", kind: "text" },
        { key: "type", label: "Instance type", kind: "text" },
        { key: "az", label: "Availability Zone", kind: "text" },
        { key: "requests", label: "Requests", kind: "count" },
        { key: "deployment", label: "Deployment", kind: "text" },
        { key: "launched", label: "Launched", kind: "date" },
        { key: "causes", label: "Causes", kind: "text" },
      ],
      data: (inst.InstanceHealthList ?? []).map((i) => ({
        instance: i.InstanceId ?? null,
        status: i.HealthStatus ?? null,
        color: i.Color ?? null,
        type: i.InstanceType ?? null,
        az: i.AvailabilityZone ?? null,
        requests: i.ApplicationMetrics?.RequestCount ?? null,
        deployment: i.Deployment ? `${i.Deployment.VersionLabel ?? ""} #${i.Deployment.DeploymentId ?? ""} ${i.Deployment.Status ?? ""}` : null,
        launched: i.LaunchedAt ?? null,
        causes: i.Causes?.join(" ") || null,
      })),
      emptyText: "No instance health data (enhanced health reporting may be off).",
    },
    {
      id: "health-summary",
      label: "Monitoring",
      kind: "keyvalue",
      description: env.RefreshedAt ? `Enhanced health, refreshed ${new Date(env.RefreshedAt).toISOString()}.` : undefined,
      data: {
        "Health status": env.HealthStatus ?? null,
        Color: env.Color ?? null,
        "Requests (last interval)": env.ApplicationMetrics?.RequestCount ?? null,
        "HTTP 2xx / 3xx / 4xx / 5xx": codes ? `${codes.Status2xx ?? 0} / ${codes.Status3xx ?? 0} / ${codes.Status4xx ?? 0} / ${codes.Status5xx ?? 0}` : null,
        "Instances Ok": ih?.Ok ?? null,
        "Instances Warning / Degraded / Severe": ih ? `${ih.Warning ?? 0} / ${ih.Degraded ?? 0} / ${ih.Severe ?? 0}` : null,
        "Instances Pending / No data / Unknown": ih ? `${ih.Pending ?? 0} / ${ih.NoData ?? 0} / ${ih.Unknown ?? 0}` : null,
      },
    },
  ];
}

async function optionSettings(ctx: Ctx, e: EnvironmentDescription) {
  const r = await ctx.clients.elasticbeanstalk.send(new DescribeConfigurationSettingsCommand({ ApplicationName: e.ApplicationName, EnvironmentName: e.EnvironmentName }));
  return r.ConfigurationSettings?.[0]?.OptionSettings ?? [];
}

/** The capacity options the Edit capacity dialog shows, as the environment has them now. */
async function capacityValues(ctx: Ctx, e: EnvironmentDescription): Promise<{ instanceTypes: string; minSize: number | null; maxSize: number | null }> {
  const settings = await optionSettings(ctx, e);
  const get = (ns: string, name: string) => settings.find((s) => s.Namespace === ns && s.OptionName === name)?.Value;
  const num = (x: string | undefined) => (x !== undefined && x !== "" && Number.isFinite(Number(x)) ? Number(x) : null);
  return {
    instanceTypes: get("aws:ec2:instances", "InstanceTypes") ?? "",
    minSize: num(get("aws:autoscaling:asg", "MinSize")),
    maxSize: num(get("aws:autoscaling:asg", "MaxSize")),
  };
}

async function configTab(ctx: Ctx, e: EnvironmentDescription): Promise<DetailTab> {
  const settings = await optionSettings(ctx, e);
  return {
    id: "configuration",
    label: "Configuration",
    kind: "table",
    description: "Every option setting DescribeConfigurationSettings returned. Change them with Actions > Edit configuration option.",
    columns: [
      { key: "namespace", label: "Namespace", kind: "code" },
      { key: "option", label: "Option", kind: "text" },
      { key: "value", label: "Value", kind: "code" },
    ],
    data: settings.map((s) => ({ namespace: s.Namespace ?? null, option: s.OptionName ?? null, value: s.Value ?? null })),
    emptyText: "No configuration settings.",
  };
}

async function resourcesTab(ctx: Ctx, envId: string): Promise<DetailTab> {
  const r = (await ctx.clients.elasticbeanstalk.send(new DescribeEnvironmentResourcesCommand({ EnvironmentId: envId }))).EnvironmentResources;
  const names = (xs: { Name?: string; Id?: string; URL?: string }[] | undefined) => (xs ?? []).map((x) => x.Name ?? x.Id ?? x.URL ?? "").filter(Boolean).join(", ") || "None";
  return {
    id: "resources",
    label: "Resources",
    kind: "keyvalue",
    description: "The AWS resources Elastic Beanstalk created for this environment.",
    data: {
      "Auto Scaling groups": names(r?.AutoScalingGroups),
      Instances: names(r?.Instances),
      "Launch templates": names(r?.LaunchTemplates),
      "Launch configurations": names(r?.LaunchConfigurations),
      "Load balancers": names(r?.LoadBalancers),
      "Alarms (triggers)": names(r?.Triggers),
      Queues: names(r?.Queues),
    },
  };
}

async function managedTab(ctx: Ctx, envId: string): Promise<DetailTab> {
  const r = await ctx.clients.elasticbeanstalk.send(new DescribeEnvironmentManagedActionsCommand({ EnvironmentId: envId }));
  return {
    id: "managed",
    label: "Managed updates",
    kind: "table",
    columns: [
      { key: "description", label: "Action", kind: "text" },
      { key: "type", label: "Type", kind: "text" },
      { key: "status", label: "Status", kind: "status" },
      { key: "window", label: "Window start", kind: "date" },
    ],
    data: (r.ManagedActions ?? []).map((a) => ({ description: a.ActionDescription ?? a.ActionId ?? null, type: a.ActionType ?? null, status: a.Status ?? null, window: a.WindowStartTime ?? null })),
    emptyText: "No managed actions are scheduled.",
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readLog(ctx: Ctx, url: string | undefined): Promise<string> {
  const loc = url ? logLocation(url) : null;
  if (!loc) return url ?? "(no location returned)";
  const obj = await ctx.clients.s3.send(new GetObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
  const body = (await obj.Body?.transformToString()) ?? "";
  return body.length > LOG_MAX_CHARS ? `${body.slice(0, LOG_MAX_CHARS)}\n… (truncated)` : body;
}

const optionFields = (section?: string): FieldDef[] => [
  { name: "instanceTypes", label: "Instance types", kind: "text", placeholder: "t3.micro, t3.small", section, help: "Comma-separated. Empty keeps the platform default." },
  { name: "minSize", label: "Min instances", kind: "number", section, validate: { min: 0, max: 10000, message: "Between 0 and 10000." } },
  { name: "maxSize", label: "Max instances", kind: "number", section, validate: { min: 1, max: 10000, message: "Between 1 and 10000." } },
];

const DEPLOYMENT_POLICIES = [
  { value: "AllAtOnce", label: "All at once" },
  { value: "Rolling", label: "Rolling" },
  { value: "RollingWithAdditionalBatch", label: "Rolling with additional batch" },
  { value: "Immutable", label: "Immutable" },
  { value: "TrafficSplitting", label: "Traffic splitting" },
];

export const environmentsResource: ResourceDef = {
  id: "environments",
  name: "Environments",
  singular: "environment",
  idField: "id",
  nameField: "name",
  description: "Running versions of an application on AWS resources (EC2 instances, Auto Scaling group, load balancer) that Elastic Beanstalk manages.",
  emptyText: "No environments. Create an environment to deploy an application.",
  columns: ENV_COLUMNS,

  async list(ctx) {
    return (await environments(ctx)).map(envRow);
  },

  async get(ctx, id) {
    const e = await environment(ctx, id);
    const row = envRow(e);
    const [events, health, config, resources, managed, tags] = await Promise.all([
      tolerantTab(() => eventsTab(ctx, id), { id: "events", label: "Events" }),
      healthTabs(ctx, id).catch((err: unknown): DetailTab[] => [{ id: "health", label: "Health", kind: "text", data: `Unavailable: ${err instanceof Error ? err.message : String(err)}` }]),
      tolerantTab(() => configTab(ctx, e), { id: "configuration", label: "Configuration" }),
      tolerantTab(() => resourcesTab(ctx, id), { id: "resources", label: "Resources" }),
      tolerantTab(() => managedTab(ctx, id), { id: "managed", label: "Managed updates" }),
      tolerantTab(async () => tagsTab(tagList(await readTags(ctx, e.EnvironmentArn)), "This environment has no tags."), { id: "tags", label: "Tags" }),
    ]);
    return {
      summary: {
        name: row.name,
        health: row.health,
        status: row.status,
        id: row.id,
        domain: row.domain,
        application: row.application,
        version: row.version,
        platform: e.PlatformArn ?? row.platform,
        tier: row.tier,
        description: e.Description ?? null,
        abortable: e.AbortableOperationInProgress ?? null,
        arn: row.arn,
      },
      summaryLabels: {
        name: "Environment name", health: "Health", status: "Status", id: "Environment ID", domain: "Domain", application: "Application name",
        version: "Running version", platform: "Platform", tier: "Environment tier", description: "Description", abortable: "Abortable operation in progress", arn: "Environment ARN",
      },
      tabs: [events, ...health, config, resources, managed, tags],
    };
  },

  create: {
    title: "Create environment",
    description: "Creates an environment with CreateEnvironment. Elastic Beanstalk launches it (status Launching) and reports health when it is Ready.",
    fields: [
      {
        name: "tier", label: "Environment tier", kind: "radio", default: "WebServer", section: "Environment tier",
        options: [
          { value: "WebServer", label: "Web server environment: run a website, web application or web API that serves HTTP requests" },
          { value: "Worker", label: "Worker environment: run a worker application that processes long-running workloads from an SQS queue" },
        ],
      },
      { name: "application", label: "Application name", kind: "select", required: true, options: applicationOptions, section: "Application information" },
      {
        name: "name", label: "Environment name", kind: "text", required: true, section: "Environment information", placeholder: "my-app-env",
        help: "4-40 letters, numbers and hyphens; can't start or end with a hyphen.", validate: { pattern: ENV_NAME, message: "Use 4-40 letters, numbers or hyphens, not starting or ending with a hyphen." },
      },
      { name: "cname", label: "Domain", kind: "text", section: "Environment information", showIf: { field: "tier", equals: "WebServer" }, help: "Subdomain prefix (<prefix>.<region>.elasticbeanstalk.com). Empty: Beanstalk generates one.", validate: { pattern: "[A-Za-z0-9-]{4,63}", message: "4-63 letters, numbers or hyphens." } },
      { name: "description", label: "Environment description", kind: "text", section: "Environment information" },
      { name: "platformArn", label: "Platform", kind: "select", required: true, options: platformOptions, section: "Platform", help: "Managed platform branch and version." },
      {
        name: "code", label: "Application code", kind: "radio", default: "sample", section: "Application code",
        options: [
          { value: "sample", label: "Sample application" },
          { value: "existing", label: "Existing version" },
        ],
      },
      { name: "version", label: "Version", kind: "select", required: true, options: versionOptions, section: "Application code", showIf: { field: "code", equals: "existing" }, help: "Must be a version of the application chosen above." },
      {
        name: "preset", label: "Presets", kind: "radio", default: "SingleInstance", section: "Presets", showIf: { field: "tier", equals: "WebServer" },
        options: [
          { value: "SingleInstance", label: "Single instance" },
          { value: "LoadBalanced", label: "High availability (load balanced, Auto Scaling)" },
        ],
      },
      { name: "loadBalancerType", label: "Load balancer type", kind: "select", default: "application", section: "Presets", showIf: { field: "preset", equals: "LoadBalanced" }, options: [{ value: "application", label: "Application Load Balancer" }, { value: "network", label: "Network Load Balancer" }, { value: "classic", label: "Classic Load Balancer" }] },
      { name: "serviceRole", label: "Service role", kind: "select", default: "", options: roleOptions, section: "Service access", help: "The role Elastic Beanstalk assumes to manage the environment (e.g. aws-elasticbeanstalk-service-role)." },
      { name: "instanceProfile", label: "EC2 instance profile", kind: "select", default: "", options: instanceProfileOptions, section: "Service access", help: "Gives the instances permissions (e.g. aws-elasticbeanstalk-ec2-role)." },
      { name: "keyName", label: "EC2 key pair", kind: "text", section: "Service access", help: "Key pair name for SSH." },
      { name: "vpcId", label: "VPC", kind: "select", default: "", options: vpcOptions, section: "Networking", help: "Empty: the default VPC." },
      { name: "subnets", label: "Instance subnets", kind: "multiselect", options: subnetOptions, section: "Networking", help: "Subnets in the chosen VPC (subnet | VPC | AZ | CIDR)." },
      { name: "publicIp", label: "Public IP address", kind: "checkbox", default: false, section: "Networking", help: "Assign public IPs to instances (only with a VPC)." },
      ...optionFields("Instance traffic and scaling"),
      {
        name: "healthReporting", label: "Health reporting", kind: "radio", default: "enhanced", section: "Monitoring",
        options: [{ value: "enhanced", label: "Enhanced" }, { value: "basic", label: "Basic" }],
      },
      { name: "managedUpdates", label: "Managed platform updates", kind: "checkbox", default: true, section: "Managed platform updates" },
      { name: "updateWindow", label: "Weekly update window", kind: "text", default: "Sun:10:00", section: "Managed platform updates", showIf: { field: "managedUpdates", equals: true }, validate: { pattern: "(Mon|Tue|Wed|Thu|Fri|Sat|Sun):[0-2]\\d:[0-5]\\d", message: "Day:HH:MM in UTC, e.g. Sun:10:00." } },
      { name: "updateLevel", label: "Update level", kind: "radio", default: "minor", section: "Managed platform updates", showIf: { field: "managedUpdates", equals: true }, options: [{ value: "minor", label: "Minor and patch" }, { value: "patch", label: "Patch only" }] },
      { name: "deploymentPolicy", label: "Deployment policy", kind: "select", default: "", options: DEPLOYMENT_POLICIES, section: "Rolling updates and deployments", help: "Empty: the platform default (All at once)." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const app = String(v.application);
      let versionLabel: string | undefined;
      if (v.code === "existing") {
        const { app: versionApp, child } = splitId(String(v.version));
        if (versionApp !== app) throw new Error(`Version ${child} belongs to application ${versionApp}, not ${app}. Choose a version of ${app}.`);
        versionLabel = child;
      }
      const worker = v.tier === "Worker";
      const tags = tagList(v.tags);
      const r = await ctx.clients.elasticbeanstalk.send(
        new CreateEnvironmentCommand({
          ApplicationName: app,
          EnvironmentName: String(v.name),
          CNAMEPrefix: !worker && typeof v.cname === "string" && v.cname ? v.cname : undefined,
          Description: typeof v.description === "string" && v.description ? v.description : undefined,
          PlatformArn: String(v.platformArn),
          VersionLabel: versionLabel,
          Tier: worker ? { Name: "Worker", Type: "SQS/HTTP" } : { Name: "WebServer", Type: "Standard" },
          OptionSettings: environmentOptionSettings(v),
          Tags: tags.length ? tags : undefined,
        })
      );
      if (!r.EnvironmentId) throw new Error("Elastic Beanstalk returned no environment ID.");
      return r.EnvironmentId;
    },
  },

  actions: [
    {
      id: "deploy",
      label: "Upload and deploy (deploy a version)",
      fields: [{ name: "version", label: "Application version", kind: "select", required: true, options: versionOptions, help: "A version of this environment's application." }],
      async initialValues(ctx, id): Promise<FieldValues> {
        const e = await environment(ctx, id);
        return e.ApplicationName && e.VersionLabel ? { version: joinId(e.ApplicationName, e.VersionLabel) } : {};
      },
      async run(ctx, id, v) {
        const e = await environment(ctx, id);
        const { app, child } = splitId(String(v.version));
        if (app !== e.ApplicationName) throw new Error(`Version ${child} belongs to ${app}; this environment runs application ${e.ApplicationName ?? "?"}.`);
        const r = await ctx.clients.elasticbeanstalk.send(new UpdateEnvironmentCommand({ EnvironmentId: id, VersionLabel: child }));
        return { message: `Deploying ${child}. Environment status: ${r.Status ?? "Updating"}. Watch the Events tab.` };
      },
    },
    {
      id: "restart",
      label: "Restart app server(s)",
      confirm: "Restarts the application server on every instance.",
      async run(ctx, id) {
        await ctx.clients.elasticbeanstalk.send(new RestartAppServerCommand({ EnvironmentId: id }));
        return { message: "Restart requested. Watch the Events tab." };
      },
    },
    {
      id: "rebuild",
      label: "Rebuild environment",
      danger: true,
      confirm: "Rebuilding deletes and recreates every resource in the environment (instances, load balancer, Auto Scaling group). The environment is unavailable while it rebuilds.",
      async run(ctx, id) {
        await ctx.clients.elasticbeanstalk.send(new RebuildEnvironmentCommand({ EnvironmentId: id }));
        return { message: "Rebuild requested. Watch the Events tab." };
      },
    },
    {
      id: "logs",
      label: "Request logs",
      fields: [{ name: "infoType", label: "Logs", kind: "radio", default: "tail", options: [{ value: "tail", label: "Last 100 lines" }, { value: "bundle", label: "Full logs" }] }],
      async run(ctx, id, v) {
        const infoType = (v.infoType === "bundle" ? "bundle" : "tail") as EnvironmentInfoType;
        const requestedAt = Date.now();
        await ctx.clients.elasticbeanstalk.send(new RequestEnvironmentInfoCommand({ EnvironmentId: id, InfoType: infoType }));
        for (let waited = 0; waited <= LOG_WAIT_MS; waited += 1000) {
          const r = await ctx.clients.elasticbeanstalk.send(new RetrieveEnvironmentInfoCommand({ EnvironmentId: id, InfoType: infoType }));
          const fresh = (r.EnvironmentInfo ?? []).filter((i) => !i.SampleTimestamp || new Date(i.SampleTimestamp).getTime() >= requestedAt - 1000);
          if (fresh.length) {
            const rows = await Promise.all(
              fresh.map(async (i) => ({ instance: i.Ec2InstanceId ?? "", time: i.SampleTimestamp ?? null, log: await readLog(ctx, i.Message).catch((err: unknown) => `Could not read the log: ${err instanceof Error ? err.message : String(err)}`) }))
            );
            return {
              message: `Retrieved ${infoType === "tail" ? "the last 100 lines" : "the full logs"} from ${rows.length} instance${rows.length === 1 ? "" : "s"}.`,
              table: {
                rowKey: "instance",
                columns: [
                  { key: "instance", label: "EC2 instance", kind: "text" },
                  { key: "time", label: "Time", kind: "date" },
                  { key: "log", label: "Log", kind: "code" },
                ],
                rows,
              },
            };
          }
          await sleep(1000);
        }
        return { message: `Logs were requested but were not ready after ${LOG_WAIT_MS / 1000} seconds. Run Request logs again in a moment.` };
      },
    },
    {
      id: "swap",
      label: "Swap environment domain",
      confirm: "Swaps the CNAMEs (domains) of the two environments, for a blue/green deployment.",
      fields: [{ name: "destination", label: "Environment to swap with", kind: "select", required: true, options: environmentOptions }],
      async run(ctx, id, v) {
        if (v.destination === id) throw new Error("Choose a different environment to swap with.");
        await ctx.clients.elasticbeanstalk.send(new SwapEnvironmentCNAMEsCommand({ SourceEnvironmentId: id, DestinationEnvironmentId: String(v.destination) }));
        return { message: "Domains swapped." };
      },
    },
    {
      id: "capacity",
      label: "Edit capacity",
      fields: optionFields(),
      async initialValues(ctx, id) {
        return capacityValues(ctx, await environment(ctx, id));
      },
      async run(ctx, id, v) {
        const current = await capacityValues(ctx, await environment(ctx, id));
        const settings: OptionSetting[] = environmentOptionSettings({ instanceTypes: v.instanceTypes, minSize: v.minSize, maxSize: v.maxSize }).filter((s) => {
          if (s.OptionName === "InstanceTypes") return s.Value !== current.instanceTypes.split(",").map((x) => x.trim()).filter(Boolean).join(",");
          if (s.OptionName === "MinSize") return Number(s.Value) !== current.minSize;
          if (s.OptionName === "MaxSize") return Number(s.Value) !== current.maxSize;
          return true;
        });
        if (!settings.length) return { message: "No changes to save." };
        const r = await ctx.clients.elasticbeanstalk.send(new UpdateEnvironmentCommand({ EnvironmentId: id, OptionSettings: settings }));
        return { message: `Configuration update submitted (${settings.map((s) => `${s.OptionName}=${s.Value}`).join(", ")}). Status: ${r.Status ?? "Updating"}.` };
      },
    },
    {
      id: "option",
      label: "Edit configuration option",
      fields: [
        { name: "namespace", label: "Namespace", kind: "text", required: true, placeholder: "aws:elasticbeanstalk:application:environment", help: "See the Configuration tab for namespaces and option names." },
        { name: "optionName", label: "Option name", kind: "text", required: true, placeholder: "MY_ENV_VAR" },
        { name: "value", label: "Value", kind: "text" },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.elasticbeanstalk.send(
          new UpdateEnvironmentCommand({ EnvironmentId: id, OptionSettings: [{ Namespace: String(v.namespace), OptionName: String(v.optionName), Value: typeof v.value === "string" ? v.value : "" }] })
        );
        return { message: `${v.namespace} ${v.optionName} update submitted. Status: ${r.Status ?? "Updating"}.` };
      },
    },
    {
      id: "save-config",
      label: "Save configuration",
      fields: [
        { name: "templateName", label: "Configuration name", kind: "text", required: true, validate: { pattern: "[^/]{1,100}", message: "1-100 characters, no slash." } },
        { name: "description", label: "Description", kind: "text" },
      ],
      async run(ctx, id, v) {
        const e = await environment(ctx, id);
        await ctx.clients.elasticbeanstalk.send(
          new CreateConfigurationTemplateCommand({ ApplicationName: e.ApplicationName, TemplateName: String(v.templateName), EnvironmentId: id, Description: typeof v.description === "string" && v.description ? v.description : undefined })
        );
        return { message: `Saved configuration ${v.templateName} for application ${e.ApplicationName ?? ""}. See Saved configurations.` };
      },
    },
    {
      id: "description",
      label: "Edit description",
      fields: [{ name: "description", label: "Environment description", kind: "text" }],
      async initialValues(ctx, id) {
        return { description: (await environment(ctx, id)).Description ?? "" };
      },
      async run(ctx, id, v) {
        const description = typeof v.description === "string" ? v.description : "";
        if (description === ((await environment(ctx, id)).Description ?? "")) return { message: "No changes to save." };
        await ctx.clients.elasticbeanstalk.send(new UpdateEnvironmentCommand({ EnvironmentId: id, Description: description }));
        return { message: "Description saved." };
      },
    },
    {
      id: "abort",
      label: "Abort current operation",
      danger: true,
      confirm: "Cancels the in-progress update and rolls the environment back to its previous configuration.",
      availableFor: (row) => row.abortable !== false,
      async run(ctx, id) {
        await ctx.clients.elasticbeanstalk.send(new AbortEnvironmentUpdateCommand({ EnvironmentId: id }));
        return { message: "Abort requested." };
      },
    },
    manageTagsAction(async (ctx, id) => (await environment(ctx, id)).EnvironmentArn ?? ""),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.elasticbeanstalk.send(new TerminateEnvironmentCommand({ EnvironmentId: id }));
    },
  },
};
