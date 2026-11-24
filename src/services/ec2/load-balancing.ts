/** Elastic Load Balancing v2: Load balancers (ALB/NLB with listeners) and Target groups. */

import {
  AddTagsCommand,
  CreateListenerCommand,
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  DeleteListenerCommand,
  DeleteLoadBalancerCommand,
  DeleteTargetGroupCommand,
  DeregisterTargetsCommand,
  DescribeListenersCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  DescribeTargetGroupAttributesCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ModifyLoadBalancerAttributesCommand,
  ModifyTargetGroupCommand,
  RegisterTargetsCommand,
  RemoveTagsCommand,
  SetSecurityGroupsCommand,
  type Action,
  type LoadBalancer,
  type ProtocolEnum,
  type TargetGroup,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type { Ctx, ResourceDef, Row, Tag } from "../../console/types.ts";
import { tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { plural, strList, tagRows } from "./helpers.ts";
import { allSubnets, allTargetGroups, liveInstanceOptions, securityGroupOptions, subnetOptions, targetGroupOptions, vpcOptions } from "./options.ts";

const ELB_NAME = "(?!internal-)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,30}[a-zA-Z0-9])?";
const TAG_COLUMNS = [
  { key: "Key", label: "Key", kind: "text" as const },
  { key: "Value", label: "Value", kind: "text" as const },
];
const tagsOf = (v: unknown): Tag[] => (Array.isArray(v) ? (v as Tag[]) : []);

async function lbByName(ctx: Ctx, name: string): Promise<LoadBalancer> {
  const lb = (await ctx.clients.elbv2.send(new DescribeLoadBalancersCommand({ Names: [name] }))).LoadBalancers?.[0];
  if (!lb?.LoadBalancerArn) throw new Error(`Load balancer ${name} was not found.`);
  return lb;
}

async function tgByName(ctx: Ctx, name: string): Promise<TargetGroup> {
  const tg = (await ctx.clients.elbv2.send(new DescribeTargetGroupsCommand({ Names: [name] }))).TargetGroups?.[0];
  if (!tg?.TargetGroupArn) throw new Error(`Target group ${name} was not found.`);
  return tg;
}

/** Applies the difference between a resource's tags and the edited list (AddTags / RemoveTags). */
async function saveTags(ctx: Ctx, arn: string, desired: Tag[]): Promise<string> {
  const current = (await ctx.clients.elbv2.send(new DescribeTagsCommand({ ResourceArns: [arn] }))).TagDescriptions?.[0]?.Tags;
  const d = tagDiff(current, desired);
  if (d.remove.length) await ctx.clients.elbv2.send(new RemoveTagsCommand({ ResourceArns: [arn], TagKeys: d.remove }));
  if (d.set.length) await ctx.clients.elbv2.send(new AddTagsCommand({ ResourceArns: [arn], Tags: d.set }));
  return tagDiffMessage(d);
}

async function currentTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  return tagRows((await ctx.clients.elbv2.send(new DescribeTagsCommand({ ResourceArns: [arn] }))).TagDescriptions?.[0]?.Tags);
}

/** Security groups in the load balancer's VPC (SetSecurityGroups rejects others). */
async function lbGroupOptions(ctx: Ctx, name?: string) {
  const all = await securityGroupOptions(ctx);
  if (!name) return all;
  const vpc = (await lbByName(ctx, name)).VpcId;
  return vpc ? all.filter((o) => o.label.endsWith(` - ${vpc}`)) : all;
}

/** Throws unless every subnet is in the chosen VPC (the console only lists that VPC's subnets). */
async function checkSubnetsInVpc(ctx: Ctx, vpcId: string, subnetIds: string[]): Promise<void> {
  const inVpc = new Set((await allSubnets(ctx, vpcId)).map((s) => s.SubnetId));
  const outside = subnetIds.filter((id) => !inVpc.has(id));
  if (outside.length) throw new Error(`Subnets ${outside.join(", ")} are not in ${vpcId}. Choose subnets in the load balancer's VPC.`);
}

const ATTR_DELETION = "deletion_protection.enabled";
const ATTR_CROSS_ZONE = "load_balancing.cross_zone.enabled";
const ATTR_IDLE = "idle_timeout.timeout_seconds";

async function lbAttributes(ctx: Ctx, arn: string): Promise<Map<string, string>> {
  const r = await ctx.clients.elbv2.send(new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: arn }));
  return new Map((r.Attributes ?? []).filter((a) => a.Key).map((a) => [a.Key as string, a.Value ?? ""]));
}

async function tagsFor(ctx: Ctx, arn: string): Promise<Row[]> {
  const r = await ctx.clients.elbv2.send(new DescribeTagsCommand({ ResourceArns: [arn] })).catch(() => null);
  return (r?.TagDescriptions?.[0]?.Tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

function actionText(actions: Action[] | undefined, tgNames: Map<string, string>): string {
  return (actions ?? [])
    .map((a) => {
      if (a.Type === "forward") {
        const arns = a.TargetGroupArn ? [a.TargetGroupArn] : (a.ForwardConfig?.TargetGroups ?? []).map((t) => t.TargetGroupArn ?? "");
        return `Forward to ${arns.map((x) => tgNames.get(x) ?? x).join(", ")}`;
      }
      if (a.Type === "fixed-response") return `Return fixed response ${a.FixedResponseConfig?.StatusCode ?? ""}`;
      if (a.Type === "redirect") return `Redirect to ${a.RedirectConfig?.Protocol ?? "#{protocol}"}://${a.RedirectConfig?.Host ?? "#{host}"}:${a.RedirectConfig?.Port ?? "#{port}"}`;
      return a.Type ?? "";
    })
    .join("; ");
}

const LISTENER_PROTOCOLS = [
  { value: "HTTP", label: "HTTP (Application Load Balancer)" },
  { value: "HTTPS", label: "HTTPS (Application Load Balancer, needs a certificate)" },
  { value: "TCP", label: "TCP (Network Load Balancer)" },
  { value: "UDP", label: "UDP (Network Load Balancer)" },
  { value: "TCP_UDP", label: "TCP_UDP (Network Load Balancer)" },
  { value: "TLS", label: "TLS (Network Load Balancer, needs a certificate)" },
];

function checkListenerProtocol(lbType: string | undefined, protocol: string): void {
  const alb = ["HTTP", "HTTPS"].includes(protocol);
  if (lbType === "application" && !alb) throw new Error("An Application Load Balancer listener uses HTTP or HTTPS.");
  if (lbType === "network" && alb) throw new Error("A Network Load Balancer listener uses TCP, UDP, TCP_UDP or TLS.");
}

/** Gateway Load Balancers have one GENEVE listener and no security groups. */
const notGateway = (row: Row): boolean => (row.type ?? row["Load balancer type"]) !== "gateway";

export const loadBalancers: ResourceDef = {
  id: "load-balancers",
  name: "Load Balancers",
  singular: "load balancer",
  idField: "name",
  nameField: "Load balancer name",
  description: "Application, Network and Gateway Load Balancers that distribute traffic across targets.",
  emptyText: "You don't have any load balancers.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "dnsName", label: "DNS name", kind: "text" },
    { key: "state", label: "State", kind: "status" },
    { key: "vpcId", label: "VPC ID", kind: "text" },
    { key: "azs", label: "Availability Zones", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "created", label: "Date created", kind: "date" },
    { key: "scheme", label: "Scheme", kind: "text", hidden: true },
  ],
  async list(ctx) {
    const out: Row[] = [];
    let marker: string | undefined;
    do {
      const r = await ctx.clients.elbv2.send(new DescribeLoadBalancersCommand({ Marker: marker }));
      for (const lb of r.LoadBalancers ?? [])
        out.push({ name: lb.LoadBalancerName ?? "", dnsName: lb.DNSName ?? null, state: lb.State?.Code ?? null, vpcId: lb.VpcId ?? null, azs: plural(lb.AvailabilityZones?.length ?? 0, "Availability Zone"), type: lb.Type ?? null, created: lb.CreatedTime ?? null, scheme: lb.Scheme ?? null });
      marker = r.NextMarker;
    } while (marker);
    return out;
  },
  async get(ctx, name) {
    const lb = await lbByName(ctx, name);
    const arn = lb.LoadBalancerArn as string;
    const [listeners, attrs, tags, tgs] = await Promise.all([
      ctx.clients.elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: arn })),
      ctx.clients.elbv2.send(new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: arn })).catch(() => ({ Attributes: [] })),
      tagsFor(ctx, arn),
      allTargetGroups(ctx),
    ]);
    const tgNames = new Map(tgs.map((t) => [t.TargetGroupArn ?? "", t.TargetGroupName ?? ""]));
    return {
      summary: { "Load balancer name": name, "Load balancer type": lb.Type ?? null, Status: lb.State?.Code ?? null, Scheme: lb.Scheme ?? null, "DNS name": lb.DNSName ?? null, "VPC": lb.VpcId ?? null, "IP address type": lb.IpAddressType ?? null, "Date created": lb.CreatedTime ?? null, ARN: arn },
      tabs: [
        {
          id: "listeners",
          label: "Listeners and rules",
          kind: "table",
          columns: [
            { key: "protocolPort", label: "Protocol:Port", kind: "text" },
            { key: "defaultAction", label: "Default action", kind: "text" },
            { key: "ssl", label: "Security policy", kind: "text" },
            { key: "arn", label: "Listener ARN", kind: "arn" },
          ],
          data: (listeners.Listeners ?? []).map((l) => ({ protocolPort: `${l.Protocol}:${l.Port}`, defaultAction: actionText(l.DefaultActions, tgNames), ssl: l.SslPolicy ?? null, arn: l.ListenerArn ?? null })),
          emptyText: "No listeners. Add one from Actions › Add listener.",
        },
        {
          id: "network",
          label: "Network mapping",
          kind: "table",
          columns: [
            { key: "az", label: "Availability Zone", kind: "text" },
            { key: "subnet", label: "Subnet", kind: "text" },
            { key: "addresses", label: "IPv4 address", kind: "text" },
          ],
          data: (lb.AvailabilityZones ?? []).map((z) => ({ az: z.ZoneName ?? null, subnet: z.SubnetId ?? null, addresses: (z.LoadBalancerAddresses ?? []).map((a) => a.IpAddress).join(", ") || "Assigned by AWS" })),
        },
        { id: "security", label: "Security", kind: "table", columns: [{ key: "group", label: "Security group ID", kind: "text" }], data: (lb.SecurityGroups ?? []).map((g) => ({ group: g })), emptyText: lb.Type === "network" ? "This Network Load Balancer has no security groups." : "No security groups." },
        { id: "attributes", label: "Attributes", kind: "table", columns: [{ key: "Key", label: "Attribute", kind: "text" }, { key: "Value", label: "Value", kind: "code" }], data: (attrs.Attributes ?? []).map((a) => ({ Key: a.Key ?? "", Value: a.Value ?? "" })), emptyText: "No attributes." },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tags, emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create load balancer",
    description: "Creates an Application or Network Load Balancer with CreateLoadBalancer, then its first listener with CreateListener.",
    fields: [
      { name: "type", label: "Load balancer type", kind: "radio", default: "application", section: "Load balancer types", options: [{ value: "application", label: "Application Load Balancer (HTTP/HTTPS, layer 7)" }, { value: "network", label: "Network Load Balancer (TCP/UDP/TLS, layer 4)" }, { value: "gateway", label: "Gateway Load Balancer (GENEVE, third-party virtual appliances)" }] },
      { name: "name", label: "Load balancer name", kind: "text", required: true, section: "Basic configuration", help: "Up to 32 letters, numbers and hyphens; can't begin or end with a hyphen or begin with internal-.", validate: { pattern: ELB_NAME, message: "Up to 32 letters, numbers and hyphens; no leading/trailing hyphen." } },
      { name: "scheme", label: "Scheme", kind: "radio", default: "internet-facing", section: "Basic configuration", showIf: { field: "type", equals: ["application", "network"] }, options: [{ value: "internet-facing", label: "Internet-facing" }, { value: "internal", label: "Internal" }] },
      { name: "ipType", label: "Load balancer IP address type", kind: "radio", default: "ipv4", section: "Basic configuration", showIf: { field: "type", equals: ["application", "network"] }, options: [{ value: "ipv4", label: "IPv4" }, { value: "dualstack", label: "Dualstack" }] },
      { name: "vpcId", label: "VPC", kind: "select", required: true, options: vpcOptions, section: "Network mapping" },
      { name: "subnets", label: "Availability Zones and subnets", kind: "multiselect", required: true, options: subnetOptions, section: "Network mapping", help: "One subnet per Availability Zone, all in the chosen VPC. An Application Load Balancer needs at least two AZs." },
      { name: "groups", label: "Security groups", kind: "multiselect", options: securityGroupOptions, section: "Security groups", showIf: { field: "type", equals: ["application", "network"] }, help: "Groups in the chosen VPC. For an Application Load Balancer, none selected uses the VPC's default group. A Network Load Balancer created without security groups can never have them added later." },
      { name: "protocol", label: "Listener protocol", kind: "select", default: "HTTP", required: true, options: LISTENER_PROTOCOLS, section: "Listeners and routing", showIf: { field: "type", equals: ["application", "network"] } },
      { name: "port", label: "Listener port", kind: "number", default: 80, required: true, section: "Listeners and routing", showIf: { field: "type", equals: ["application", "network"] }, validate: { min: 1, max: 65535, message: "Between 1 and 65535." } },
      { name: "targetGroup", label: "Default action: forward to target group", kind: "select", required: true, options: targetGroupOptions, section: "Listeners and routing", help: "Create the target group first on the Target Groups page. A Gateway Load Balancer forwards to a GENEVE target group on port 6081." },
      { name: "tags", label: "Tags", kind: "tags", section: "Load balancer tags" },
    ],
    async run(ctx, v) {
      const type = v.type === "network" || v.type === "gateway" ? v.type : "application";
      const gateway = type === "gateway";
      const protocol = String(v.protocol || "");
      if (!gateway) checkListenerProtocol(type, protocol);
      const tags = tagsOf(v.tags);
      const groups = strList(v.groups);
      await checkSubnetsInVpc(ctx, String(v.vpcId), strList(v.subnets));
      const r = await ctx.clients.elbv2.send(
        new CreateLoadBalancerCommand({
          Name: String(v.name),
          Type: type,
          Scheme: gateway ? undefined : v.scheme === "internal" ? "internal" : "internet-facing",
          IpAddressType: gateway ? undefined : v.ipType === "dualstack" ? "dualstack" : "ipv4",
          Subnets: strList(v.subnets),
          SecurityGroups: !gateway && groups.length ? groups : undefined,
          Tags: tags.length ? tags : undefined,
        })
      );
      const arn = r.LoadBalancers?.[0]?.LoadBalancerArn;
      if (!arn) throw new Error("CreateLoadBalancer returned no ARN.");
      // A Gateway Load Balancer listener has no protocol or port (it is always GENEVE 6081).
      await ctx.clients.elbv2.send(
        new CreateListenerCommand({ LoadBalancerArn: arn, Protocol: gateway ? undefined : (protocol as ProtocolEnum), Port: gateway ? undefined : Number(v.port), DefaultActions: [{ Type: "forward", TargetGroupArn: String(v.targetGroup) }] })
      );
      return String(v.name);
    },
  },
  actions: [
    {
      id: "add-listener",
      label: "Add listener",
      availableFor: notGateway,
      fields: [
        { name: "protocol", label: "Protocol", kind: "select", default: "HTTP", required: true, options: LISTENER_PROTOCOLS },
        { name: "port", label: "Port", kind: "number", default: 80, required: true, validate: { min: 1, max: 65535, message: "Between 1 and 65535." } },
        { name: "action", label: "Default action", kind: "radio", default: "forward", options: [{ value: "forward", label: "Forward to target group" }, { value: "fixed", label: "Return fixed response (Application Load Balancer)" }] },
        { name: "targetGroup", label: "Target group", kind: "select", required: true, options: targetGroupOptions, showIf: { field: "action", equals: "forward" } },
        { name: "statusCode", label: "Response code", kind: "text", default: "503", showIf: { field: "action", equals: "fixed" }, validate: { pattern: "[245]\\d\\d", message: "A 2XX, 4XX or 5XX code." } },
      ],
      async run(ctx, name, v) {
        const lb = await lbByName(ctx, name);
        const protocol = String(v.protocol);
        checkListenerProtocol(lb.Type, protocol);
        const action: Action = v.action === "fixed" ? { Type: "fixed-response", FixedResponseConfig: { StatusCode: String(v.statusCode || "503"), ContentType: "text/plain" } } : { Type: "forward", TargetGroupArn: String(v.targetGroup) };
        const r = await ctx.clients.elbv2.send(new CreateListenerCommand({ LoadBalancerArn: lb.LoadBalancerArn, Protocol: protocol as ProtocolEnum, Port: Number(v.port), DefaultActions: [action] }));
        return { message: `Added listener ${protocol}:${v.port} (${r.Listeners?.[0]?.ListenerArn ?? ""}).` };
      },
    },
    {
      id: "manage-listeners",
      label: "Manage listeners",
      async run(ctx, name) {
        const lb = await lbByName(ctx, name);
        const listeners = (await ctx.clients.elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: lb.LoadBalancerArn }))).Listeners ?? [];
        return {
          message: `${plural(listeners.length, "listener")}. Select listeners and choose Delete to remove them.`,
          table: {
            rowKey: "arn",
            columns: [{ key: "protocolPort", label: "Protocol:Port", kind: "text" }, { key: "arn", label: "Listener ARN", kind: "arn" }],
            rows: listeners.map((l) => ({ protocolPort: `${l.Protocol}:${l.Port}`, arn: l.ListenerArn ?? "" })),
            emptyText: "No listeners.",
            selectionAction: { actionId: "delete-listeners", label: "Delete", danger: true, valuesField: "arns" },
          },
        };
      },
    },
    {
      id: "delete-listeners",
      label: "Delete listeners",
      hidden: true,
      danger: true,
      fields: [{ name: "arns", label: "Listeners", kind: "multiselect", required: true }],
      async run(ctx, _name, v) {
        const arns = strList(v.arns);
        for (const arn of arns) await ctx.clients.elbv2.send(new DeleteListenerCommand({ ListenerArn: arn }));
        return { message: `Deleted ${plural(arns.length, "listener")}.` };
      },
    },
    {
      id: "security-groups",
      label: "Edit security groups",
      availableFor: notGateway,
      fields: [{ name: "groups", label: "Security groups", kind: "multiselect", required: true, options: lbGroupOptions, help: "Security groups in the load balancer's VPC." }],
      async initialValues(ctx, name) {
        return { groups: (await lbByName(ctx, name)).SecurityGroups ?? [] };
      },
      async run(ctx, name, v) {
        const lb = await lbByName(ctx, name);
        await ctx.clients.elbv2.send(new SetSecurityGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn, SecurityGroups: strList(v.groups) }));
        return { message: "Security groups updated." };
      },
    },
    {
      id: "attributes",
      label: "Edit load balancer attributes",
      fields: [
        { name: "deletionProtection", label: "Deletion protection", kind: "checkbox", default: false },
        { name: "crossZone", label: "Cross-zone load balancing (Network and Gateway Load Balancers)", kind: "checkbox", default: false, help: "Always on for Application Load Balancers." },
        { name: "idleTimeout", label: "Connection idle timeout (seconds, Application Load Balancer)", kind: "number", validate: { min: 1, max: 4000, message: "Between 1 and 4000." } },
      ],
      async initialValues(ctx, name) {
        const lb = await lbByName(ctx, name);
        const a = await lbAttributes(ctx, lb.LoadBalancerArn as string);
        const idle = Number(a.get(ATTR_IDLE));
        return {
          deletionProtection: a.get(ATTR_DELETION) === "true",
          crossZone: lb.Type === "application" ? true : a.get(ATTR_CROSS_ZONE) === "true",
          idleTimeout: a.has(ATTR_IDLE) && Number.isFinite(idle) ? idle : null,
        };
      },
      async run(ctx, name, v) {
        const lb = await lbByName(ctx, name);
        const current = await lbAttributes(ctx, lb.LoadBalancerArn as string);
        // Only attributes whose value differs from the current one are sent.
        const wanted: [string, string][] = [[ATTR_DELETION, String(v.deletionProtection === true)]];
        if (lb.Type === "network" || lb.Type === "gateway") wanted.push([ATTR_CROSS_ZONE, String(v.crossZone === true)]);
        if (lb.Type === "application" && typeof v.idleTimeout === "number") wanted.push([ATTR_IDLE, String(v.idleTimeout)]);
        const attrs = wanted.filter(([k, val]) => (current.get(k) ?? "") !== val).map(([Key, Value]) => ({ Key, Value }));
        if (!attrs.length) return { message: "No attribute changes." };
        await ctx.clients.elbv2.send(new ModifyLoadBalancerAttributesCommand({ LoadBalancerArn: lb.LoadBalancerArn, Attributes: attrs }));
        return { message: `Saved ${attrs.map((a) => `${a.Key}=${a.Value}`).join(", ")}.` };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "The load balancer's tags. Removing a row deletes that tag." }],
      async initialValues(ctx, name) {
        return { tags: await currentTags(ctx, (await lbByName(ctx, name)).LoadBalancerArn as string) };
      },
      async run(ctx, name, v) {
        return { message: await saveTags(ctx, (await lbByName(ctx, name)).LoadBalancerArn as string, tagsOf(v.tags)) };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      const lb = await lbByName(ctx, name);
      await ctx.clients.elbv2.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: lb.LoadBalancerArn }));
    },
  },
};

// ---- Target groups ----

export const targetGroups: ResourceDef = {
  id: "target-groups",
  name: "Target Groups",
  singular: "target group",
  idField: "name",
  nameField: "Target group name",
  description: "Groups of targets (instances, IP addresses, Lambda functions) that a load balancer routes to, with health checks.",
  emptyText: "You don't have any target groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "port", label: "Port", kind: "count" },
    { key: "protocol", label: "Protocol", kind: "text" },
    { key: "targetType", label: "Target type", kind: "text" },
    { key: "loadBalancer", label: "Load balancer", kind: "text" },
    { key: "vpcId", label: "VPC ID", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await allTargetGroups(ctx)).map((t) => ({
      name: t.TargetGroupName ?? "",
      port: t.Port ?? null,
      protocol: t.Protocol ?? null,
      targetType: t.TargetType ?? null,
      loadBalancer: (t.LoadBalancerArns ?? []).map((a) => a.split("/")[2] ?? a).join(", ") || "None associated",
      vpcId: t.VpcId ?? null,
      arn: t.TargetGroupArn ?? null,
    }));
  },
  async get(ctx, name) {
    const t = await tgByName(ctx, name);
    const arn = t.TargetGroupArn as string;
    const [health, attrs, tags] = await Promise.all([
      ctx.clients.elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn })),
      ctx.clients.elbv2.send(new DescribeTargetGroupAttributesCommand({ TargetGroupArn: arn })).catch(() => ({ Attributes: [] })),
      tagsFor(ctx, arn),
    ]);
    const targets = health.TargetHealthDescriptions ?? [];
    const count = (s: string) => targets.filter((x) => x.TargetHealth?.State === s).length;
    return {
      summary: { "Target group name": name, "Target type": t.TargetType ?? null, "Protocol : Port": `${t.Protocol ?? "-"}: ${t.Port ?? "-"}`, "Protocol version": t.ProtocolVersion ?? null, VPC: t.VpcId ?? null, "Total targets": targets.length, Healthy: count("healthy"), Unhealthy: count("unhealthy"), Unused: count("unused"), ARN: arn },
      tabs: [
        {
          id: "targets",
          label: "Targets",
          kind: "table",
          columns: [
            { key: "id", label: "Instance ID / IP", kind: "text" },
            { key: "port", label: "Port", kind: "count" },
            { key: "az", label: "Zone", kind: "text" },
            { key: "state", label: "Health status", kind: "status" },
            { key: "details", label: "Health status details", kind: "text" },
          ],
          data: targets.map((x) => ({ id: x.Target?.Id ?? null, port: x.Target?.Port ?? null, az: x.Target?.AvailabilityZone ?? null, state: x.TargetHealth?.State ?? null, details: x.TargetHealth?.Description ?? x.TargetHealth?.Reason ?? null })),
          emptyText: "No registered targets. Use Actions › Register targets.",
        },
        {
          id: "health",
          label: "Health checks",
          kind: "keyvalue",
          data: {
            Protocol: t.HealthCheckProtocol ?? null,
            Path: t.HealthCheckPath ?? null,
            Port: t.HealthCheckPort ?? null,
            "Healthy threshold": t.HealthyThresholdCount ?? null,
            "Unhealthy threshold": t.UnhealthyThresholdCount ?? null,
            Timeout: t.HealthCheckTimeoutSeconds ?? null,
            Interval: t.HealthCheckIntervalSeconds ?? null,
            "Success codes": t.Matcher?.HttpCode ?? t.Matcher?.GrpcCode ?? null,
            Enabled: t.HealthCheckEnabled ?? null,
          },
        },
        { id: "attributes", label: "Attributes", kind: "table", columns: [{ key: "Key", label: "Attribute", kind: "text" }, { key: "Value", label: "Value", kind: "code" }], data: (attrs.Attributes ?? []).map((a) => ({ Key: a.Key ?? "", Value: a.Value ?? "" })), emptyText: "No attributes." },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tags, emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create target group",
    description: "Creates a target group with CreateTargetGroup.",
    fields: [
      {
        name: "targetType", label: "Choose a target type", kind: "radio", default: "instance", section: "Basic configuration",
        options: [
          { value: "instance", label: "Instances" },
          { value: "ip", label: "IP addresses" },
          { value: "lambda", label: "Lambda function" },
          { value: "alb", label: "Application Load Balancer (for a Network Load Balancer)" },
        ],
      },
      { name: "name", label: "Target group name", kind: "text", required: true, section: "Basic configuration", help: "Up to 32 letters, numbers and hyphens.", validate: { pattern: ELB_NAME, message: "Up to 32 letters, numbers and hyphens; no leading/trailing hyphen." } },
      { name: "protocol", label: "Protocol", kind: "select", default: "HTTP", required: true, section: "Basic configuration", options: ["HTTP", "HTTPS", "TCP", "UDP", "TCP_UDP", "TLS", "GENEVE"].map((p) => ({ value: p, label: p })), help: "GENEVE (port 6081) for Gateway Load Balancer targets.", showIf: { field: "targetType", equals: ["instance", "ip", "alb"] } },
      { name: "port", label: "Port", kind: "number", default: 80, required: true, section: "Basic configuration", validate: { min: 1, max: 65535, message: "Between 1 and 65535." }, showIf: { field: "targetType", equals: ["instance", "ip", "alb"] } },
      { name: "vpcId", label: "VPC", kind: "select", required: true, options: vpcOptions, section: "Basic configuration", showIf: { field: "targetType", equals: ["instance", "ip", "alb"] } },
      { name: "hcProtocol", label: "Health check protocol", kind: "select", default: "HTTP", required: true, section: "Health checks", options: ["HTTP", "HTTPS", "TCP"].map((p) => ({ value: p, label: p })), showIf: { field: "targetType", equals: ["instance", "ip", "alb"] } },
      { name: "hcPath", label: "Health check path", kind: "text", default: "/", section: "Health checks", help: "HTTP/HTTPS only." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const lambda = v.targetType === "lambda";
      if (!lambda && !(typeof v.protocol === "string" && v.protocol)) throw new Error("Choose a protocol.");
      const tags = tagsOf(v.tags);
      const hcProtocol = String(v.hcProtocol || "HTTP");
      if (!lambda && !(typeof v.vpcId === "string" && v.vpcId)) throw new Error("Choose a VPC.");
      await ctx.clients.elbv2.send(
        new CreateTargetGroupCommand({
          Name: String(v.name),
          TargetType: String(v.targetType) as "instance" | "ip" | "lambda" | "alb",
          Protocol: lambda ? undefined : (String(v.protocol) as ProtocolEnum),
          Port: lambda ? undefined : Number(v.port),
          VpcId: lambda ? undefined : String(v.vpcId),
          HealthCheckProtocol: lambda ? undefined : (hcProtocol as ProtocolEnum),
          HealthCheckPath: lambda || hcProtocol === "TCP" ? undefined : String(v.hcPath || "/"),
          Tags: tags.length ? tags : undefined,
        })
      );
      return String(v.name);
    },
  },
  actions: [
    {
      id: "register",
      label: "Register targets",
      fields: [
        { name: "instances", label: "Instances", kind: "multiselect", options: liveInstanceOptions, help: "For instance target groups." },
        { name: "ips", label: "IP addresses or Lambda function ARN", kind: "text", help: "For IP or Lambda target groups: comma-separated IPv4 addresses or one function ARN." },
        { name: "port", label: "Ports for the selected targets", kind: "number", validate: { min: 1, max: 65535, message: "Between 1 and 65535." }, help: "Leave empty to use the target group's port." },
      ],
      async run(ctx, name, v) {
        const t = await tgByName(ctx, name);
        const port = typeof v.port === "number" ? v.port : undefined;
        const ids = [...strList(v.instances), ...(typeof v.ips === "string" ? v.ips.split(",").map((s) => s.trim()).filter(Boolean) : [])];
        if (ids.length === 0) throw new Error("Choose at least one target.");
        await ctx.clients.elbv2.send(new RegisterTargetsCommand({ TargetGroupArn: t.TargetGroupArn, Targets: ids.map((Id) => ({ Id, Port: t.TargetType === "lambda" ? undefined : port })) }));
        return { message: `Registered ${plural(ids.length, "target")}.` };
      },
    },
    {
      id: "manage-targets",
      label: "Deregister targets",
      async run(ctx, name) {
        const t = await tgByName(ctx, name);
        const targets = (await ctx.clients.elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: t.TargetGroupArn }))).TargetHealthDescriptions ?? [];
        return {
          message: "Select targets and choose Deregister.",
          table: {
            rowKey: "key",
            columns: [{ key: "id", label: "Target", kind: "text" }, { key: "port", label: "Port", kind: "count" }, { key: "state", label: "Health status", kind: "status" }],
            rows: targets.map((x) => ({ key: `${x.Target?.Id ?? ""}|${x.Target?.Port ?? ""}`, id: x.Target?.Id ?? null, port: x.Target?.Port ?? null, state: x.TargetHealth?.State ?? null })),
            emptyText: "No registered targets.",
            selectionAction: { actionId: "deregister", label: "Deregister", danger: true, valuesField: "targets" },
          },
        };
      },
    },
    {
      id: "deregister",
      label: "Deregister",
      hidden: true,
      danger: true,
      fields: [{ name: "targets", label: "Targets", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const t = await tgByName(ctx, name);
        const targets = strList(v.targets).map((k) => {
          const [Id, port] = k.split("|");
          return { Id, Port: port ? Number(port) : undefined };
        });
        await ctx.clients.elbv2.send(new DeregisterTargetsCommand({ TargetGroupArn: t.TargetGroupArn, Targets: targets }));
        return { message: `Deregistered ${plural(targets.length, "target")}.` };
      },
    },
    {
      id: "health-check",
      label: "Edit health check settings",
      fields: [
        { name: "protocol", label: "Health check protocol", kind: "select", default: "HTTP", required: true, options: ["HTTP", "HTTPS", "TCP"].map((p) => ({ value: p, label: p })) },
        { name: "path", label: "Health check path", kind: "text", default: "/", help: "HTTP/HTTPS only." },
        { name: "healthy", label: "Healthy threshold", kind: "number", default: 5, validate: { min: 2, max: 10, message: "Between 2 and 10." } },
        { name: "unhealthy", label: "Unhealthy threshold", kind: "number", default: 2, validate: { min: 2, max: 10, message: "Between 2 and 10." } },
        { name: "timeout", label: "Timeout (seconds)", kind: "number", default: 5, validate: { min: 2, max: 120, message: "Between 2 and 120." } },
        { name: "interval", label: "Interval (seconds)", kind: "number", default: 30, validate: { min: 5, max: 300, message: "Between 5 and 300." } },
        { name: "codes", label: "Success codes", kind: "text", default: "200", validate: { pattern: "[0-9,-]{3,30}", message: "Such as 200 or 200-299." } },
      ],
      availableFor: (row) => row.targetType !== "lambda" && row["Target type"] !== "lambda",
      async initialValues(ctx, name) {
        const t = await tgByName(ctx, name);
        return {
          protocol: t.HealthCheckProtocol && ["HTTP", "HTTPS", "TCP"].includes(t.HealthCheckProtocol) ? t.HealthCheckProtocol : "HTTP",
          path: t.HealthCheckPath ?? "",
          healthy: t.HealthyThresholdCount ?? null,
          unhealthy: t.UnhealthyThresholdCount ?? null,
          timeout: t.HealthCheckTimeoutSeconds ?? null,
          interval: t.HealthCheckIntervalSeconds ?? null,
          codes: t.Matcher?.HttpCode ?? "",
        };
      },
      async run(ctx, name, v) {
        const t = await tgByName(ctx, name);
        const protocol = (typeof v.protocol === "string" && v.protocol ? v.protocol : t.HealthCheckProtocol) as ProtocolEnum | undefined;
        await ctx.clients.elbv2.send(
          new ModifyTargetGroupCommand({
            TargetGroupArn: t.TargetGroupArn,
            HealthCheckProtocol: protocol,
            HealthCheckPath: protocol === "TCP" ? undefined : String(v.path || t.HealthCheckPath || "/"),
            HealthyThresholdCount: typeof v.healthy === "number" ? v.healthy : undefined,
            UnhealthyThresholdCount: typeof v.unhealthy === "number" ? v.unhealthy : undefined,
            HealthCheckTimeoutSeconds: typeof v.timeout === "number" ? v.timeout : undefined,
            HealthCheckIntervalSeconds: typeof v.interval === "number" ? v.interval : undefined,
            Matcher: protocol === "TCP" ? undefined : { HttpCode: String(v.codes || t.Matcher?.HttpCode || "200") },
          })
        );
        return { message: "Health check settings saved." };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "The target group's tags. Removing a row deletes that tag." }],
      async initialValues(ctx, name) {
        return { tags: await currentTags(ctx, (await tgByName(ctx, name)).TargetGroupArn as string) };
      },
      async run(ctx, name, v) {
        return { message: await saveTags(ctx, (await tgByName(ctx, name)).TargetGroupArn as string, tagsOf(v.tags)) };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      const t = await tgByName(ctx, name);
      await ctx.clients.elbv2.send(new DeleteTargetGroupCommand({ TargetGroupArn: t.TargetGroupArn }));
    },
  },
};
