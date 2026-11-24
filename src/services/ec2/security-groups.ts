/** EC2 Security groups with inbound and outbound rule editors. */

import { ec2TagAction } from "./tag-action.ts";
import {
  AuthorizeSecurityGroupEgressCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSecurityGroupsCommand,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  type SecurityGroupRule,
} from "@aws-sdk/client-ec2";
import type { ActionDef, ActionResult, Ctx, FieldDef, ResourceDef, Tag } from "../../console/types.ts";
import { buildIpPermission, nameTag, plural, RULE_PRESETS, ruleRow, strList, tagRows, withName, type IpPermissionSpec } from "./helpers.ts";
import { tagSpec, vpcOptions } from "./options.ts";

const RULE_TABLE_COLUMNS = [
  { key: "ruleId", label: "Security group rule ID", kind: "text" as const },
  { key: "type", label: "Type", kind: "text" as const },
  { key: "protocol", label: "Protocol", kind: "text" as const },
  { key: "portRange", label: "Port range", kind: "text" as const },
  { key: "source", label: "Source", kind: "text" as const },
  { key: "description", label: "Description", kind: "text" as const },
];

async function rulesOf(ctx: Ctx, id: string): Promise<SecurityGroupRule[]> {
  const out: SecurityGroupRule[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeSecurityGroupRulesCommand({ Filters: [{ Name: "group-id", Values: [id] }], NextToken: token }));
    out.push(...(r.SecurityGroupRules ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

const ruleFields = (direction: "inbound" | "outbound"): FieldDef[] => [
  { name: "type", label: "Type", kind: "select", required: true, default: "ssh", options: RULE_PRESETS.map((p) => ({ value: p.id, label: p.label })) },
  { name: "ports", label: "Port range", kind: "text", placeholder: "8080 or 8000-8100", help: "Only for Custom TCP and Custom UDP." },
  {
    name: "source",
    label: direction === "inbound" ? "Source" : "Destination",
    kind: "text",
    required: true,
    default: direction === "inbound" ? "0.0.0.0/0" : "0.0.0.0/0",
    help: "A CIDR block (0.0.0.0/0 = anywhere IPv4, ::/0 = anywhere IPv6, 203.0.113.5/32 = one address), a security group ID (sg-...) or a prefix list ID (pl-...).",
  },
  { name: "description", label: "Description", kind: "text", validate: { max: 255, message: "At most 255 characters." } },
];

function addRuleAction(direction: "inbound" | "outbound"): ActionDef {
  return {
    id: `add-${direction}`,
    label: direction === "inbound" ? "Add inbound rule" : "Add outbound rule",
    fields: ruleFields(direction),
    async run(ctx, id, v) {
      const p = buildIpPermission({ type: String(v.type), ports: typeof v.ports === "string" ? v.ports : "", source: String(v.source), description: typeof v.description === "string" ? v.description : "" });
      if (!p.ok) throw new Error(p.error);
      const input = { GroupId: id, IpPermissions: [p.value] };
      const r = direction === "inbound" ? await ctx.clients.ec2.send(new AuthorizeSecurityGroupIngressCommand(input)) : await ctx.clients.ec2.send(new AuthorizeSecurityGroupEgressCommand(input));
      return { message: `Added ${direction} rule ${r.SecurityGroupRules?.map((x) => x.SecurityGroupRuleId).join(", ") ?? ""}.` };
    },
  };
}

function editRulesAction(direction: "inbound" | "outbound"): ActionDef {
  return {
    id: `edit-${direction}`,
    label: direction === "inbound" ? "Edit inbound rules" : "Edit outbound rules",
    async run(ctx, id): Promise<ActionResult> {
      const rows = (await rulesOf(ctx, id)).filter((r) => (direction === "outbound") === (r.IsEgress === true)).map(ruleRow);
      return {
        message: `${plural(rows.length, `${direction} rule`)}. Select rules and choose Delete to remove them; use Add ${direction} rule to add one.`,
        table: {
          rowKey: "ruleId",
          columns: RULE_TABLE_COLUMNS,
          rows,
          emptyText: `This security group has no ${direction} rules.`,
          selectionAction: { actionId: `revoke-${direction}`, label: "Delete", danger: true, valuesField: "ruleIds" },
        },
      };
    },
  };
}

function revokeAction(direction: "inbound" | "outbound"): ActionDef {
  return {
    id: `revoke-${direction}`,
    label: `Delete ${direction} rules`,
    hidden: true,
    danger: true,
    fields: [{ name: "ruleIds", label: "Rules", kind: "multiselect", required: true }],
    async run(ctx, id, v) {
      const ids = strList(v.ruleIds);
      const input = { GroupId: id, SecurityGroupRuleIds: ids };
      if (direction === "inbound") await ctx.clients.ec2.send(new RevokeSecurityGroupIngressCommand(input));
      else await ctx.clients.ec2.send(new RevokeSecurityGroupEgressCommand(input));
      return { message: `Deleted ${plural(ids.length, `${direction} rule`)}.` };
    },
  };
}

const PRESET_INBOUND: { field: string; label: string; type: string }[] = [
  { field: "allowSsh", label: "Allow SSH traffic (TCP 22)", type: "ssh" },
  { field: "allowHttp", label: "Allow HTTP traffic (TCP 80)", type: "http" },
  { field: "allowHttps", label: "Allow HTTPS traffic (TCP 443)", type: "https" },
];

export const securityGroups: ResourceDef = {
  id: "security-groups",
  name: "Security Groups",
  singular: "security group",
  idField: "groupId",
  nameField: "Security group name",
  description: "Virtual firewalls that control inbound and outbound traffic for your instances.",
  emptyText: "No security groups found.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "groupId", label: "Security group ID", kind: "link" },
    { key: "groupName", label: "Security group name", kind: "text" },
    { key: "vpcId", label: "VPC ID", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "owner", label: "Owner", kind: "text" },
    { key: "inbound", label: "Inbound rules count", kind: "text" },
    { key: "outbound", label: "Outbound rules count", kind: "text" },
  ],
  async list(ctx) {
    const r = await ctx.clients.ec2.send(new DescribeSecurityGroupsCommand({}));
    return (r.SecurityGroups ?? []).map((g) => ({
      name: nameTag(g.Tags),
      groupId: g.GroupId ?? "",
      groupName: g.GroupName ?? null,
      vpcId: g.VpcId ?? null,
      description: g.Description ?? null,
      owner: g.OwnerId ?? null,
      inbound: plural((g.IpPermissions ?? []).reduce((n, p) => n + Math.max(1, (p.IpRanges?.length ?? 0) + (p.Ipv6Ranges?.length ?? 0) + (p.UserIdGroupPairs?.length ?? 0) + (p.PrefixListIds?.length ?? 0)), 0), "Permission entry"),
      outbound: plural((g.IpPermissionsEgress ?? []).reduce((n, p) => n + Math.max(1, (p.IpRanges?.length ?? 0) + (p.Ipv6Ranges?.length ?? 0) + (p.UserIdGroupPairs?.length ?? 0) + (p.PrefixListIds?.length ?? 0)), 0), "Permission entry"),
    }));
  },
  async get(ctx, id) {
    const g = (await ctx.clients.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [id] }))).SecurityGroups?.[0];
    if (!g) throw new Error(`Security group ${id} was not found.`);
    const rules = await rulesOf(ctx, id);
    const inbound = rules.filter((r) => !r.IsEgress).map(ruleRow);
    const outbound = rules.filter((r) => r.IsEgress).map(ruleRow);
    return {
      summary: { "Security group name": g.GroupName ?? null, "Security group ID": id, Description: g.Description ?? null, "VPC ID": g.VpcId ?? null, Owner: g.OwnerId ?? null, "Inbound rules count": inbound.length, "Outbound rules count": outbound.length },
      tabs: [
        { id: "inbound", label: "Inbound rules", kind: "table", columns: RULE_TABLE_COLUMNS, data: inbound, emptyText: "No inbound rules. No traffic is allowed in." },
        { id: "outbound", label: "Outbound rules", kind: "table", columns: RULE_TABLE_COLUMNS.map((c) => (c.key === "source" ? { ...c, label: "Destination" } : c)), data: outbound, emptyText: "No outbound rules. No traffic is allowed out." },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: tagRows(g.Tags), emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create security group",
    description: "Creates a security group with CreateSecurityGroup, then adds the inbound rules you choose. A new group allows all outbound traffic.",
    fields: [
      { name: "groupName", label: "Security group name", kind: "text", required: true, section: "Basic details", placeholder: "MyWebServerGroup", help: "Can't be changed after creation. Up to 255 characters; can't start with sg-.", validate: { pattern: "(?!sg-)[A-Za-z0-9 ._\\-:/()#,@\\[\\]+=&;{}!$*]{1,255}", message: "Up to 255 allowed characters, not starting with sg-." } },
      { name: "description", label: "Description", kind: "text", required: true, section: "Basic details", placeholder: "Allows SSH access to developers", validate: { max: 255, message: "At most 255 characters." } },
      { name: "vpcId", label: "VPC", kind: "select", required: true, options: vpcOptions, section: "Basic details" },
      ...PRESET_INBOUND.map((p): FieldDef => ({ name: p.field, label: p.label, kind: "checkbox", default: false, section: "Inbound rules" })),
      { name: "source", label: "Source for these rules", kind: "text", default: "0.0.0.0/0", section: "Inbound rules", help: "0.0.0.0/0 allows all IPv4 addresses. Add more rules later from the group's Actions menu." },
      { name: "name", label: "Name tag", kind: "text", section: "Tags" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const perms: IpPermissionSpec[] = [];
      for (const p of PRESET_INBOUND) {
        if (v[p.field] !== true) continue;
        const built = buildIpPermission({ type: p.type, source: String(v.source ?? "0.0.0.0/0") });
        if (!built.ok) throw new Error(built.error);
        perms.push(built.value);
      }
      const r = await ctx.clients.ec2.send(
        new CreateSecurityGroupCommand({ GroupName: String(v.groupName), Description: String(v.description), VpcId: String(v.vpcId), TagSpecifications: tagSpec("security-group", withName(v.name, Array.isArray(v.tags) ? (v.tags as Tag[]) : [])) })
      );
      if (!r.GroupId) throw new Error("CreateSecurityGroup returned no group ID.");
      if (perms.length) await ctx.clients.ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: r.GroupId, IpPermissions: perms }));
      return r.GroupId;
    },
  },
  actions: [
    addRuleAction("inbound"),
    editRulesAction("inbound"),
    revokeAction("inbound"),
    addRuleAction("outbound"),
    editRulesAction("outbound"),
    revokeAction("outbound"),
    ec2TagAction("security group", async (ctx, id) => (await ctx.clients.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [id] }))).SecurityGroups?.[0]?.Tags),
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteSecurityGroupCommand({ GroupId: id }));
    },
  },
};
