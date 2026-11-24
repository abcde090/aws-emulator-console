/** Network ACLs (numbered stateless rules, subnet associations) and security groups (stateful rules). */

import {
  AuthorizeSecurityGroupEgressCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateNetworkAclCommand,
  CreateNetworkAclEntryCommand,
  CreateSecurityGroupCommand,
  DeleteNetworkAclCommand,
  DeleteNetworkAclEntryCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupRulesCommand,
  ReplaceNetworkAclAssociationCommand,
  ReplaceNetworkAclEntryCommand,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  type IpPermission,
  type NetworkAcl,
  type NetworkAclEntry,
  type SecurityGroupRule,
} from "@aws-sdk/client-ec2";
import type { ActionDef, Ctx, FieldDef, Option, ResourceDef, Row } from "../../console/types.ts";
import { collect, describeAcls, describeSecurityGroups, describeSubnets, one, securityGroupOptions, strings, tagActions, tagsTab, tagSpec, text, vpcOptions } from "./ec2.ts";
import { aclProtocolNumber, aclRuleKey, nameOf, parseAclRuleKey, portRangeLabel, protocolLabel, RULE_TYPES, ruleTypeToPorts, withName } from "./helpers.ts";

const CIDR = "\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}|[0-9a-fA-F:]+/\\d{1,3}";
const typeOptions = RULE_TYPES.map((t) => ({ value: t.value, label: t.label }));

// ---- Network ACLs ----

function entryRow(e: NetworkAclEntry): Row {
  return {
    key: aclRuleKey(e.Egress === true, e.RuleNumber ?? 0),
    rule: e.RuleNumber === 32767 ? "*" : String(e.RuleNumber ?? ""),
    protocol: protocolLabel(e.Protocol),
    ports: portRangeLabel(e.Protocol, e.PortRange?.From, e.PortRange?.To),
    cidr: e.CidrBlock ?? e.Ipv6CidrBlock ?? null,
    action: e.RuleAction === "allow" ? "Allow" : "Deny",
  };
}

const ENTRY_COLUMNS = [
  { key: "rule", label: "Rule number", kind: "text" as const },
  { key: "protocol", label: "Protocol", kind: "text" as const },
  { key: "ports", label: "Port range", kind: "text" as const },
  { key: "cidr", label: "Source / Destination", kind: "text" as const },
  { key: "action", label: "Allow/Deny", kind: "text" as const },
];

const sortedEntries = (acl: NetworkAcl, egress: boolean) => (acl.Entries ?? []).filter((e) => (e.Egress === true) === egress).sort((a, b) => (a.RuleNumber ?? 0) - (b.RuleNumber ?? 0));

const getAcl = async (ctx: Ctx, id: string) => one(await describeAcls(ctx, undefined, [id]), "Network ACL", id);

function aclRuleAction(egress: boolean): ActionDef {
  const dir = egress ? "outbound" : "inbound";
  return {
    id: `add-${dir}`,
    label: `Add ${dir} rule`,
    fields: [
      { name: "ruleNumber", label: "Rule number", kind: "number", required: true, default: 100, help: "Rules are evaluated from the lowest number; the first match wins. 1-32766.", validate: { min: 1, max: 32766, message: "Between 1 and 32766." } },
      { name: "type", label: "Type", kind: "select", required: true, default: "https", options: typeOptions },
      { name: "portRange", label: "Port range", kind: "text", showIf: { field: "type", equals: "custom-tcp" }, placeholder: "1024-65535" },
      { name: "udpPortRange", label: "Port range (UDP)", kind: "text", showIf: { field: "type", equals: "custom-udp" }, placeholder: "53" },
      { name: "cidr", label: egress ? "Destination" : "Source", kind: "text", required: true, default: "0.0.0.0/0", validate: { pattern: CIDR, message: "Enter an IPv4 or IPv6 CIDR block." } },
      { name: "allow", label: "Allow/Deny", kind: "radio", default: "allow", options: [{ value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }] },
      { name: "replace", label: "Replace the existing rule with this number", kind: "checkbox", default: false },
    ],
    async run(ctx, id, v) {
      const p = ruleTypeToPorts(text(v.type), v.type === "custom-udp" ? v.udpPortRange : v.portRange);
      const cidr = text(v.cidr);
      const input = {
        NetworkAclId: id,
        RuleNumber: Number(v.ruleNumber),
        Egress: egress,
        Protocol: aclProtocolNumber(p.protocol),
        RuleAction: v.allow === "deny" ? ("deny" as const) : ("allow" as const),
        PortRange: p.protocol === "-1" || p.protocol === "icmp" ? undefined : { From: p.from, To: p.to },
        IcmpTypeCode: p.protocol === "icmp" ? { Type: -1, Code: -1 } : undefined,
        ...(cidr.includes(":") ? { Ipv6CidrBlock: cidr } : { CidrBlock: cidr }),
      };
      if (v.replace === true) await ctx.clients.ec2.send(new ReplaceNetworkAclEntryCommand(input));
      else await ctx.clients.ec2.send(new CreateNetworkAclEntryCommand(input));
      return { message: `${v.replace === true ? "Replaced" : "Added"} ${dir} rule ${String(v.ruleNumber)}.` };
    },
  };
}

export const networkAcls: ResourceDef = {
  id: "network-acls",
  name: "Network ACLs",
  singular: "network ACL",
  idField: "id",
  description: "Stateless subnet-level firewalls: numbered allow and deny rules, evaluated in order, for each direction.",
  emptyText: "You don't have any network ACLs in this Region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Network ACL ID", kind: "link" },
    { key: "associated", label: "Associated with", kind: "text" },
    { key: "isDefault", label: "Default", kind: "boolean" },
    { key: "vpcId", label: "VPC ID", kind: "text" },
    { key: "inbound", label: "Inbound rules count", kind: "count" },
    { key: "outbound", label: "Outbound rules count", kind: "count" },
    { key: "owner", label: "Owner", kind: "text" },
  ],
  async list(ctx) {
    return (await describeAcls(ctx)).map((a) => {
      const subnets = (a.Associations ?? []).map((x) => x.SubnetId).filter(Boolean);
      return {
        name: nameOf(a.Tags),
        id: a.NetworkAclId ?? "",
        associated: subnets.length === 0 ? null : subnets.length === 1 ? subnets[0] : `${subnets.length} Subnets`,
        isDefault: a.IsDefault ?? false,
        vpcId: a.VpcId ?? null,
        inbound: sortedEntries(a, false).length,
        outbound: sortedEntries(a, true).length,
        owner: a.OwnerId ?? null,
      };
    });
  },
  async get(ctx, id) {
    const a = await getAcl(ctx, id);
    return {
      summary: { "Network ACL ID": id, Name: nameOf(a.Tags), Default: a.IsDefault ? "Yes" : "No", "VPC ID": a.VpcId ?? null, Associated: (a.Associations ?? []).length, Owner: a.OwnerId ?? null },
      tabs: [
        { id: "inbound", label: "Inbound rules", kind: "table", columns: ENTRY_COLUMNS, data: sortedEntries(a, false).map(entryRow), description: "Evaluated from the lowest rule number. The * rule denies anything no rule matched.", emptyText: "No inbound rules." },
        { id: "outbound", label: "Outbound rules", kind: "table", columns: ENTRY_COLUMNS, data: sortedEntries(a, true).map(entryRow), description: "Network ACLs are stateless: allow return traffic (ephemeral ports 1024-65535) explicitly.", emptyText: "No outbound rules." },
        {
          id: "subnets",
          label: "Subnet associations",
          kind: "table",
          columns: [
            { key: "SubnetId", label: "Subnet ID", kind: "text" },
            { key: "NetworkAclAssociationId", label: "Association ID", kind: "text" },
          ],
          data: a.Associations ?? [],
          emptyText: "No subnet associations.",
        },
        tagsTab(a.Tags),
      ],
    };
  },
  create: {
    title: "Create network ACL",
    description: "Creates a network ACL with CreateNetworkAcl. A new network ACL denies all traffic until you add rules.",
    fields: [
      { name: "name", label: "Name", kind: "text", section: "Network ACL settings", placeholder: "my-network-acl-01" },
      { name: "vpcId", label: "VPC", kind: "select", required: true, options: vpcOptions, section: "Network ACL settings" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(new CreateNetworkAclCommand({ VpcId: text(v.vpcId), TagSpecifications: tagSpec("network-acl", withName(v.name, v.tags)) }));
      const id = r.NetworkAcl?.NetworkAclId;
      if (!id) throw new Error("CreateNetworkAcl returned no ID.");
      return id;
    },
  },
  actions: [
    aclRuleAction(false),
    aclRuleAction(true),
    {
      id: "remove-rules",
      label: "Remove rules",
      async run(ctx, id) {
        const a = await getAcl(ctx, id);
        const rows = [...sortedEntries(a, false), ...sortedEntries(a, true)].filter((e) => e.RuleNumber !== 32767).map((e) => ({ ...entryRow(e), direction: e.Egress ? "Outbound" : "Inbound" }));
        return {
          message: "Select rules to remove. The default * rules can't be removed.",
          table: { columns: [{ key: "direction", label: "Direction", kind: "text" }, ...ENTRY_COLUMNS], rows, rowKey: "key", emptyText: "No rules that can be removed.", selectionAction: { actionId: "delete-rules", label: "Remove", danger: true, valuesField: "rules" } },
        };
      },
    },
    {
      id: "delete-rules",
      label: "Remove selected rules",
      hidden: true,
      danger: true,
      fields: [{ name: "rules", label: "Rules", kind: "multiselect", required: true }],
      async run(ctx, id, v) {
        const keys = strings(v.rules).map(parseAclRuleKey).filter((k): k is { egress: boolean; ruleNumber: number } => k !== null);
        for (const k of keys) await ctx.clients.ec2.send(new DeleteNetworkAclEntryCommand({ NetworkAclId: id, Egress: k.egress, RuleNumber: k.ruleNumber }));
        return { message: `Removed ${keys.length} rule${keys.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "associate",
      label: "Edit subnet associations",
      fields: [{ name: "subnetIds", label: "Associated subnets", kind: "multiselect", options: aclSubnetOptions, help: "A subnet has exactly one network ACL. Selected subnets move to this ACL; subnets you clear go back to the VPC's default network ACL." }],
      initialValues: async (ctx, id) => ({ subnetIds: (one(await describeAcls(ctx, undefined, [id]), "Network ACL", id).Associations ?? []).map((a) => a.SubnetId ?? "").filter(Boolean) }),
      async run(ctx, id, v) {
        const acl = one(await describeAcls(ctx, undefined, [id]), "Network ACL", id);
        const current = (acl.Associations ?? []).map((a) => a.SubnetId ?? "").filter(Boolean);
        const wanted = strings(v.subnetIds);
        const add = wanted.filter((s) => !current.includes(s));
        const remove = current.filter((s) => !wanted.includes(s));
        if (!add.length && !remove.length) return { message: `No subnet association changes on ${id}.` };
        if (remove.length && acl.IsDefault) throw new Error("This is the VPC's default network ACL: a subnet leaves it only by being associated with another ACL.");
        const fallback = remove.length ? (await describeAcls(ctx, [{ Name: "vpc-id", Values: [acl.VpcId ?? ""] }, { Name: "default", Values: ["true"] }]))[0]?.NetworkAclId : undefined;
        if (remove.length && !fallback) throw new Error(`No default network ACL found in ${acl.VpcId ?? "the VPC"}.`);
        const others = add.length ? await describeAcls(ctx, [{ Name: "association.subnet-id", Values: add }]) : [];
        for (const subnetId of add) {
          const assoc = others.flatMap((x) => x.Associations ?? []).find((x) => x.SubnetId === subnetId)?.NetworkAclAssociationId;
          if (!assoc) throw new Error(`No network ACL association found for ${subnetId}.`);
          await ctx.clients.ec2.send(new ReplaceNetworkAclAssociationCommand({ AssociationId: assoc, NetworkAclId: id }));
        }
        for (const subnetId of remove) {
          const assoc = (acl.Associations ?? []).find((x) => x.SubnetId === subnetId)?.NetworkAclAssociationId;
          if (assoc && fallback) await ctx.clients.ec2.send(new ReplaceNetworkAclAssociationCommand({ AssociationId: assoc, NetworkAclId: fallback }));
        }
        return { message: `Associated ${add.length} subnet${add.length === 1 ? "" : "s"} with ${id}${remove.length ? `; moved ${remove.length} back to ${fallback}` : ""}.` };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteNetworkAclCommand({ NetworkAclId: id }));
    },
  },
};

/** Subnets in the network ACL's VPC (all subnets without an ACL id). */
async function aclSubnetOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  const vpcId = id ? one(await describeAcls(ctx, undefined, [id]), "Network ACL", id).VpcId : undefined;
  const subnets = await describeSubnets(ctx, vpcId ? [{ Name: "vpc-id", Values: [vpcId] }] : undefined);
  return subnets.filter((s) => s.SubnetId).map((s) => ({ value: s.SubnetId as string, label: `${s.SubnetId}${nameOf(s.Tags) ? ` (${nameOf(s.Tags)})` : ""} | ${s.CidrBlock ?? ""}${vpcId ? "" : ` | ${s.VpcId ?? ""}`}` }));
}

// ---- Security groups ----

async function sgRules(ctx: Ctx, groupId: string): Promise<SecurityGroupRule[]> {
  return collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeSecurityGroupRulesCommand({ Filters: [{ Name: "group-id", Values: [groupId] }], NextToken: t }));
    return { items: r.SecurityGroupRules, next: r.NextToken };
  });
}

function sgRuleRow(r: SecurityGroupRule): Row {
  const proto = r.IpProtocol ?? "-1";
  const type = proto === "-1" ? "All traffic" : RULE_TYPES.find((t) => t.protocol === proto && t.from === r.FromPort && t.to === r.ToPort && t.from !== undefined)?.label ?? `Custom ${protocolLabel(proto)}`;
  return {
    id: r.SecurityGroupRuleId ?? "",
    ipVersion: r.CidrIpv6 ? "IPv6" : r.CidrIpv4 ? "IPv4" : "-",
    type,
    protocol: protocolLabel(proto),
    ports: portRangeLabel(proto, r.FromPort, r.ToPort),
    peer: r.CidrIpv4 ?? r.CidrIpv6 ?? r.PrefixListId ?? r.ReferencedGroupInfo?.GroupId ?? null,
    description: r.Description ?? null,
  };
}

const SG_RULE_COLUMNS = [
  { key: "id", label: "Security group rule ID", kind: "text" as const },
  { key: "ipVersion", label: "IP version", kind: "text" as const },
  { key: "type", label: "Type", kind: "text" as const },
  { key: "protocol", label: "Protocol", kind: "text" as const },
  { key: "ports", label: "Port range", kind: "text" as const },
  { key: "peer", label: "Source / Destination", kind: "text" as const },
  { key: "description", label: "Description", kind: "text" as const },
];

function sgRuleFields(egress: boolean): FieldDef[] {
  const peer = egress ? "Destination" : "Source";
  return [
    { name: "type", label: "Type", kind: "select", required: true, default: egress ? "all-traffic" : "ssh", options: typeOptions },
    { name: "portRange", label: "Port range", kind: "text", showIf: { field: "type", equals: "custom-tcp" }, placeholder: "8080 or 8000-8100" },
    { name: "udpPortRange", label: "Port range (UDP)", kind: "text", showIf: { field: "type", equals: "custom-udp" }, placeholder: "53" },
    { name: "peerType", label: `${peer} type`, kind: "radio", default: "cidr", options: [{ value: "cidr", label: "CIDR block (Custom / Anywhere)" }, { value: "sg", label: "Security group" }, { value: "pl", label: "Prefix list" }] },
    { name: "cidr", label: `${peer} CIDR`, kind: "text", required: true, default: "0.0.0.0/0", showIf: { field: "peerType", equals: "cidr" }, help: "0.0.0.0/0 is Anywhere-IPv4; ::/0 is Anywhere-IPv6.", validate: { pattern: CIDR, message: "Enter an IPv4 or IPv6 CIDR block." } },
    { name: "groupId", label: `${peer} security group`, kind: "select", required: true, options: securityGroupOptions, showIf: { field: "peerType", equals: "sg" } },
    { name: "prefixList", label: "Prefix list ID", kind: "text", required: true, placeholder: "pl-12345678", showIf: { field: "peerType", equals: "pl" }, validate: { pattern: "pl-[0-9a-z]+", message: "Enter a prefix list ID such as pl-12345678." } },
    { name: "description", label: "Description", kind: "text", validate: { max: 255, message: "At most 255 characters." } },
  ];
}

function permissionFrom(v: Record<string, unknown>): IpPermission {
  const p = ruleTypeToPorts(text(v.type), v.type === "custom-udp" ? v.udpPortRange : v.portRange);
  const description = text(v.description) || undefined;
  const perm: IpPermission = { IpProtocol: p.protocol, FromPort: p.protocol === "-1" ? undefined : p.from, ToPort: p.protocol === "-1" ? undefined : p.to };
  if (v.peerType === "sg") return { ...perm, UserIdGroupPairs: [{ GroupId: text(v.groupId), Description: description }] };
  if (v.peerType === "pl") return { ...perm, PrefixListIds: [{ PrefixListId: text(v.prefixList), Description: description }] };
  const cidr = text(v.cidr);
  return cidr.includes(":") ? { ...perm, Ipv6Ranges: [{ CidrIpv6: cidr, Description: description }] } : { ...perm, IpRanges: [{ CidrIp: cidr, Description: description }] };
}

function sgRuleAction(egress: boolean): ActionDef {
  const dir = egress ? "outbound" : "inbound";
  return {
    id: `add-${dir}`,
    label: `Add ${dir} rule`,
    fields: sgRuleFields(egress),
    async run(ctx, id, v) {
      const perm = permissionFrom(v);
      if (egress) await ctx.clients.ec2.send(new AuthorizeSecurityGroupEgressCommand({ GroupId: id, IpPermissions: [perm] }));
      else await ctx.clients.ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: id, IpPermissions: [perm] }));
      return { message: `Added ${dir} rule to ${id}.` };
    },
  };
}

export const securityGroups: ResourceDef = {
  id: "security-groups",
  name: "Security groups",
  singular: "security group",
  idField: "id",
  description: "Stateful virtual firewalls for network interfaces: allow rules only; return traffic is allowed automatically.",
  emptyText: "You don't have any security groups in this Region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Security group ID", kind: "link" },
    { key: "groupName", label: "Security group name", kind: "text" },
    { key: "vpcId", label: "VPC ID", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "owner", label: "Owner", kind: "text" },
    { key: "inbound", label: "Inbound rules count", kind: "count" },
    { key: "outbound", label: "Outbound rules count", kind: "count" },
  ],
  async list(ctx) {
    const count = (perms: IpPermission[] | undefined) =>
      (perms ?? []).reduce((n, p) => n + Math.max(1, (p.IpRanges?.length ?? 0) + (p.Ipv6Ranges?.length ?? 0) + (p.UserIdGroupPairs?.length ?? 0) + (p.PrefixListIds?.length ?? 0)), 0);
    return (await describeSecurityGroups(ctx)).map((g) => ({
      name: nameOf(g.Tags),
      id: g.GroupId ?? "",
      groupName: g.GroupName ?? null,
      vpcId: g.VpcId ?? null,
      description: g.Description ?? null,
      owner: g.OwnerId ?? null,
      inbound: count(g.IpPermissions),
      outbound: count(g.IpPermissionsEgress),
    }));
  },
  async get(ctx, id) {
    const g = one(await describeSecurityGroups(ctx, undefined, [id]), "Security group", id);
    const rules = await sgRules(ctx, id);
    return {
      summary: { "Security group ID": id, "Security group name": g.GroupName ?? null, Name: nameOf(g.Tags), Description: g.Description ?? null, "VPC ID": g.VpcId ?? null, Owner: g.OwnerId ?? null, "Security group ARN": g.SecurityGroupArn ?? null },
      tabs: [
        { id: "inbound", label: "Inbound rules", kind: "table", columns: SG_RULE_COLUMNS, data: rules.filter((r) => !r.IsEgress).map(sgRuleRow), emptyText: "No inbound rules: no inbound traffic is allowed." },
        { id: "outbound", label: "Outbound rules", kind: "table", columns: SG_RULE_COLUMNS, data: rules.filter((r) => r.IsEgress).map(sgRuleRow), emptyText: "No outbound rules: no outbound traffic is allowed." },
        tagsTab(g.Tags),
      ],
    };
  },
  create: {
    title: "Create security group",
    description: "Creates a security group with CreateSecurityGroup. It starts with no inbound rules and one outbound rule allowing all traffic.",
    fields: [
      { name: "groupName", label: "Security group name", kind: "text", required: true, section: "Basic details", placeholder: "MyWebServerGroup", help: "Can't be changed after creation. Up to 255 characters; can't start with sg-.", validate: { pattern: "(?!sg-)[A-Za-z0-9 ._\\-:/()#,@\\[\\]+=&;{}!$*]{1,255}", message: "Up to 255 letters, numbers, spaces and ._-:/()#,@[]+=&;{}!$*; can't start with sg-." } },
      { name: "description", label: "Description", kind: "text", required: true, section: "Basic details", default: "", placeholder: "Allows SSH access to developers", validate: { max: 255, message: "At most 255 characters." } },
      { name: "vpcId", label: "VPC", kind: "select", required: true, options: vpcOptions, section: "Basic details" },
      { name: "name", label: "Name tag", kind: "text", section: "Tags - optional" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(new CreateSecurityGroupCommand({ GroupName: text(v.groupName), Description: text(v.description), VpcId: text(v.vpcId), TagSpecifications: tagSpec("security-group", withName(v.name, v.tags)) }));
      if (!r.GroupId) throw new Error("CreateSecurityGroup returned no group ID.");
      return r.GroupId;
    },
  },
  actions: [
    sgRuleAction(false),
    sgRuleAction(true),
    {
      id: "remove-rules",
      label: "Remove rules",
      async run(ctx, id) {
        const rows = (await sgRules(ctx, id)).map((r) => ({ ...sgRuleRow(r), direction: r.IsEgress ? "Outbound" : "Inbound" }));
        return { message: "Select rules to remove.", table: { columns: [{ key: "direction", label: "Direction", kind: "text" }, ...SG_RULE_COLUMNS], rows, rowKey: "id", emptyText: "No rules.", selectionAction: { actionId: "revoke-rules", label: "Remove", danger: true, valuesField: "ruleIds" } } };
      },
    },
    {
      id: "revoke-rules",
      label: "Remove selected rules",
      hidden: true,
      danger: true,
      fields: [{ name: "ruleIds", label: "Rules", kind: "multiselect", required: true }],
      async run(ctx, id, v) {
        const wanted = new Set(strings(v.ruleIds));
        const rules = (await sgRules(ctx, id)).filter((r) => r.SecurityGroupRuleId && wanted.has(r.SecurityGroupRuleId));
        const ingress = rules.filter((r) => !r.IsEgress).map((r) => r.SecurityGroupRuleId as string);
        const egress = rules.filter((r) => r.IsEgress).map((r) => r.SecurityGroupRuleId as string);
        if (ingress.length) await ctx.clients.ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: id, SecurityGroupRuleIds: ingress }));
        if (egress.length) await ctx.clients.ec2.send(new RevokeSecurityGroupEgressCommand({ GroupId: id, SecurityGroupRuleIds: egress }));
        return { message: `Removed ${ingress.length + egress.length} rule${ingress.length + egress.length === 1 ? "" : "s"}.` };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteSecurityGroupCommand({ GroupId: id }));
    },
  },
};
