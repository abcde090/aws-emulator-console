/**
 * Pure helpers for the VPC console: tags, IPv4 CIDR maths for "VPC and more", route
 * targets, rule labels. No AWS calls here, so they are unit-tested (tests/vpc.test.mjs).
 */

export interface Ec2Tag {
  Key?: string;
  Value?: string;
}

export type Tag = { Key: string; Value: string };

export function nameOf(tags: Ec2Tag[] | undefined): string | null {
  const t = (tags ?? []).find((x) => x.Key === "Name");
  return t?.Value ? t.Value : null;
}

export function tagRows(tags: Ec2Tag[] | undefined): Tag[] {
  return (tags ?? []).filter((t) => typeof t.Key === "string").map((t) => ({ Key: t.Key as string, Value: t.Value ?? "" }));
}

/** Tags from a form (plus an optional Name), with the Name tag first and no duplicate keys. */
export function withName(name: unknown, tags: unknown): Tag[] {
  const list: Tag[] = Array.isArray(tags) ? (tags as Tag[]).filter((t) => t && typeof t.Key === "string" && t.Key !== "") : [];
  const n = typeof name === "string" ? name.trim() : "";
  const rest = n ? list.filter((t) => t.Key !== "Name") : list;
  return n ? [{ Key: "Name", Value: n }, ...rest] : rest;
}

// ---- IPv4 CIDR maths ----

export interface Cidr {
  base: number;
  prefix: number;
}

export function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
}

/** Parses "10.0.0.0/16"; the address must be the network address for that prefix. */
export function parseCidr(text: string): Cidr | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const base = ipToInt(m[1]);
  const prefix = Number(m[2]);
  if (base === null || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  if (base % size !== 0) return null;
  return { base, prefix };
}

export const formatCidr = (c: Cidr): string => `${intToIp(c.base)}/${c.prefix}`;

/** The console's "VPC and more" subnet size: four bits smaller than the VPC, at most /28. */
export function defaultSubnetPrefix(vpcPrefix: number): number {
  return Math.min(vpcPrefix + 4, 28);
}

/** The first `count` consecutive subnets of size /prefix inside the VPC CIDR. */
export function subnetCidrs(vpcCidr: string, count: number, prefix: number): string[] {
  const vpc = parseCidr(vpcCidr);
  if (!vpc) throw new Error(`${vpcCidr} is not a valid IPv4 CIDR block.`);
  if (prefix < vpc.prefix || prefix > 28) throw new Error(`Subnets must be between /${vpc.prefix} and /28.`);
  const size = 2 ** (32 - prefix);
  const available = 2 ** (prefix - vpc.prefix);
  if (count > available) throw new Error(`A ${vpcCidr} VPC has room for only ${available} /${prefix} subnets; ${count} are needed.`);
  return Array.from({ length: count }, (_, i) => formatCidr({ base: vpc.base + i * size, prefix }));
}

// ---- Routes ----

export interface RouteLike {
  DestinationCidrBlock?: string;
  DestinationIpv6CidrBlock?: string;
  DestinationPrefixListId?: string;
  GatewayId?: string;
  NatGatewayId?: string;
  TransitGatewayId?: string;
  VpcPeeringConnectionId?: string;
  NetworkInterfaceId?: string;
  InstanceId?: string;
  EgressOnlyInternetGatewayId?: string;
  LocalGatewayId?: string;
  CarrierGatewayId?: string;
  CoreNetworkArn?: string;
}

export function routeDestination(r: RouteLike): string {
  return r.DestinationCidrBlock ?? r.DestinationIpv6CidrBlock ?? r.DestinationPrefixListId ?? "";
}

export function routeTarget(r: RouteLike): string {
  return (
    r.GatewayId ?? r.NatGatewayId ?? r.TransitGatewayId ?? r.VpcPeeringConnectionId ?? r.EgressOnlyInternetGatewayId ??
    r.NetworkInterfaceId ?? r.InstanceId ?? r.LocalGatewayId ?? r.CarrierGatewayId ?? r.CoreNetworkArn ?? ""
  );
}

export type DestinationParam = { DestinationCidrBlock: string } | { DestinationIpv6CidrBlock: string } | { DestinationPrefixListId: string };

export function destinationParam(dest: string): DestinationParam {
  const d = dest.trim();
  if (d.startsWith("pl-")) return { DestinationPrefixListId: d };
  if (d.includes(":")) return { DestinationIpv6CidrBlock: d };
  return { DestinationCidrBlock: d };
}

export type TargetParam =
  | { GatewayId: string }
  | { NatGatewayId: string }
  | { TransitGatewayId: string }
  | { VpcPeeringConnectionId: string }
  | { NetworkInterfaceId: string }
  | { InstanceId: string }
  | { EgressOnlyInternetGatewayId: string };

/** Which CreateRoute/ReplaceRoute parameter a target ID goes in, from its prefix. */
export function targetParam(target: string): TargetParam {
  const t = target.trim();
  if (t.startsWith("igw-") || t.startsWith("vgw-")) return { GatewayId: t };
  if (t.startsWith("nat-")) return { NatGatewayId: t };
  if (t.startsWith("tgw-")) return { TransitGatewayId: t };
  if (t.startsWith("pcx-")) return { VpcPeeringConnectionId: t };
  if (t.startsWith("eni-")) return { NetworkInterfaceId: t };
  if (t.startsWith("i-")) return { InstanceId: t };
  if (t.startsWith("eigw-")) return { EgressOnlyInternetGatewayId: t };
  throw new Error(`${t} is not a route target this console knows (internet, NAT, transit or virtual private gateway, peering connection, network interface or instance).`);
}

// ---- Rules (security groups and network ACLs) ----

const PROTOCOLS: Record<string, string> = { "-1": "All", "6": "TCP", "17": "UDP", "1": "ICMP", "58": "ICMPv6", tcp: "TCP", udp: "UDP", icmp: "ICMP", icmpv6: "ICMPv6", all: "All" };

export function protocolLabel(p: string | undefined): string {
  if (p === undefined || p === "") return "-";
  return PROTOCOLS[p.toLowerCase()] ?? p;
}

export function portRangeLabel(protocol: string | undefined, from: number | undefined, to: number | undefined): string {
  if (protocol === "-1" || protocol === undefined) return "All";
  const proto = protocolLabel(protocol);
  if (proto === "ICMP" || proto === "ICMPv6") return from === undefined || from === -1 ? "All" : String(from);
  if (from === undefined || from === -1) return "All";
  if (from === 0 && to === 65535) return "All";
  return to === undefined || from === to ? String(from) : `${from} - ${to}`;
}

/** Console-style rule types, as offered in the Type dropdowns. */
export const RULE_TYPES: { value: string; label: string; protocol: string; from?: number; to?: number }[] = [
  { value: "all-traffic", label: "All traffic", protocol: "-1" },
  { value: "custom-tcp", label: "Custom TCP", protocol: "tcp" },
  { value: "custom-udp", label: "Custom UDP", protocol: "udp" },
  { value: "all-tcp", label: "All TCP", protocol: "tcp", from: 0, to: 65535 },
  { value: "all-udp", label: "All UDP", protocol: "udp", from: 0, to: 65535 },
  { value: "all-icmp", label: "All ICMP - IPv4", protocol: "icmp", from: -1, to: -1 },
  { value: "ssh", label: "SSH (22)", protocol: "tcp", from: 22, to: 22 },
  { value: "http", label: "HTTP (80)", protocol: "tcp", from: 80, to: 80 },
  { value: "https", label: "HTTPS (443)", protocol: "tcp", from: 443, to: 443 },
  { value: "rdp", label: "RDP (3389)", protocol: "tcp", from: 3389, to: 3389 },
  { value: "mysql", label: "MySQL/Aurora (3306)", protocol: "tcp", from: 3306, to: 3306 },
  { value: "postgresql", label: "PostgreSQL (5432)", protocol: "tcp", from: 5432, to: 5432 },
  { value: "mssql", label: "MSSQL (1433)", protocol: "tcp", from: 1433, to: 1433 },
  { value: "redis", label: "Custom TCP: Redis (6379)", protocol: "tcp", from: 6379, to: 6379 },
  { value: "nfs", label: "NFS (2049)", protocol: "tcp", from: 2049, to: 2049 },
  { value: "dns-udp", label: "DNS (UDP) (53)", protocol: "udp", from: 53, to: 53 },
  { value: "dns-tcp", label: "DNS (TCP) (53)", protocol: "tcp", from: 53, to: 53 },
  { value: "ephemeral", label: "Custom TCP: ephemeral ports (1024 - 65535)", protocol: "tcp", from: 1024, to: 65535 },
];

export function parsePortRange(text: string): { from: number; to: number } | null {
  const m = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(text);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from > 65535 || to > 65535 || to < from) return null;
  return { from, to };
}

/** Protocol and ports for a rule type; custom types need a port range ("22" or "1024-65535"). */
export function ruleTypeToPorts(type: string, portRange: unknown): { protocol: string; from?: number; to?: number } {
  const t = RULE_TYPES.find((r) => r.value === type);
  if (!t) throw new Error(`Unknown rule type ${type}.`);
  if (t.value === "custom-tcp" || t.value === "custom-udp") {
    const range = parsePortRange(typeof portRange === "string" ? portRange : "");
    if (!range) throw new Error("Enter a port (22) or a port range (1024-65535) between 0 and 65535.");
    return { protocol: t.protocol, from: range.from, to: range.to };
  }
  return { protocol: t.protocol, from: t.from, to: t.to };
}

/** Network ACL protocol numbers for a rule type. */
export function aclProtocolNumber(protocol: string): string {
  return { "-1": "-1", tcp: "6", udp: "17", icmp: "1" }[protocol] ?? protocol;
}

export function aclRuleKey(egress: boolean, ruleNumber: number): string {
  return `${egress ? "outbound" : "inbound"}:${ruleNumber}`;
}

export function parseAclRuleKey(key: string): { egress: boolean; ruleNumber: number } | null {
  const m = /^(inbound|outbound):(\d{1,5})$/.exec(key);
  if (!m) return null;
  return { egress: m[1] === "outbound", ruleNumber: Number(m[2]) };
}

/** Comma- or newline-separated list, trimmed, without empties. */
export function splitList(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
