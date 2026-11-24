/**
 * Pure helpers for the EC2 console: tags, security group rules, user data, AMI families.
 * No SDK calls here, so everything is unit-tested in tests/ec2-helpers.test.mjs.
 */

export interface TagLike {
  Key?: string;
  Value?: string;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;
}

export function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The value of the Name tag, or null. */
export function nameTag(tags: TagLike[] | undefined): string | null {
  return tags?.find((t) => t.Key === "Name")?.Value ?? null;
}

/** Tags as table rows, sorted by key. */
export function tagRows(tags: TagLike[] | undefined): { Key: string; Value: string }[] {
  return (tags ?? [])
    .filter((t) => typeof t.Key === "string")
    .map((t) => ({ Key: t.Key as string, Value: t.Value ?? "" }))
    .sort((a, b) => a.Key.localeCompare(b.Key));
}

/** A Name tag (when given) followed by the other tags, without duplicates of Name. */
export function withName(name: unknown, tags: unknown): { Key: string; Value: string }[] {
  const rest = Array.isArray(tags) ? (tags as { Key: string; Value: string }[]).filter((t) => t.Key !== "Name") : [];
  const n = typeof name === "string" ? name.trim() : "";
  return n ? [{ Key: "Name", Value: n }, ...rest] : rest;
}

/** An AWS error's text (for cells and tabs that show a denied secondary lookup). */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The instance state from a list row ("state") or a detail summary ("Instance state");
 * null when neither is present, so availableFor() can fall back to "available".
 */
export function rowState(row: Record<string, unknown>): string | null {
  const s = row.state ?? row["Instance state"];
  return typeof s === "string" && s ? s : null;
}

/** True when the row's state is one of `states`, or when the state is unknown. */
export function stateIn(row: Record<string, unknown>, states: readonly string[]): boolean {
  const s = rowState(row);
  return s === null || states.includes(s);
}

/** The Connect dialog's SSH line: the command, or which prerequisite is missing. */
export function sshHint(host: string | null | undefined, keyName: string | null | undefined, user: string | null): string {
  if (host && keyName) return `ssh -i "${keyName}.pem" ${user ?? "<user name>"}@${host}`;
  if (!host && !keyName) return "The instance has no public IPv4 address or DNS name and no key pair, so SSH from outside the VPC is not possible.";
  if (!host) return "The instance has no public IPv4 address or DNS name, so SSH from outside the VPC is not possible. Use a bastion host or an Elastic IP.";
  return `The instance was launched without a key pair, so there is no private key to sign in with over SSH from ${host}.`;
}

// ---- Security group rules ----

export interface RulePreset {
  id: string;
  label: string;
  protocol: string;
  from: number;
  to: number;
}

/** The rule types the console offers, with their fixed protocol and ports. "custom-*" take a port range. */
export const RULE_PRESETS: RulePreset[] = [
  { id: "ssh", label: "SSH (TCP 22)", protocol: "tcp", from: 22, to: 22 },
  { id: "http", label: "HTTP (TCP 80)", protocol: "tcp", from: 80, to: 80 },
  { id: "https", label: "HTTPS (TCP 443)", protocol: "tcp", from: 443, to: 443 },
  { id: "rdp", label: "RDP (TCP 3389)", protocol: "tcp", from: 3389, to: 3389 },
  { id: "mysql", label: "MYSQL/Aurora (TCP 3306)", protocol: "tcp", from: 3306, to: 3306 },
  { id: "postgres", label: "PostgreSQL (TCP 5432)", protocol: "tcp", from: 5432, to: 5432 },
  { id: "custom-tcp", label: "Custom TCP", protocol: "tcp", from: -2, to: -2 },
  { id: "custom-udp", label: "Custom UDP", protocol: "udp", from: -2, to: -2 },
  { id: "all-icmp", label: "All ICMP - IPv4", protocol: "icmp", from: -1, to: -1 },
  { id: "all-tcp", label: "All TCP", protocol: "tcp", from: 0, to: 65535 },
  { id: "all-traffic", label: "All traffic", protocol: "-1", from: -1, to: -1 },
];

const KNOWN_PORTS: Record<string, string> = { "22": "SSH", "80": "HTTP", "443": "HTTPS", "3389": "RDP", "3306": "MYSQL/Aurora", "5432": "PostgreSQL" };

/** "SSH", "Custom TCP", "All traffic" ... the Type column of the console's rule tables. */
export function ruleTypeLabel(protocol: string | undefined, from: number | undefined, to: number | undefined): string {
  if (protocol === "-1" || protocol === "all") return "All traffic";
  if (protocol === "icmp" || protocol === "1") return from === -1 || from === undefined ? "All ICMP - IPv4" : "Custom ICMP - IPv4";
  const p = protocol === "6" ? "tcp" : protocol === "17" ? "udp" : protocol ?? "";
  if (p === "tcp" && from === 0 && to === 65535) return "All TCP";
  if (p === "udp" && from === 0 && to === 65535) return "All UDP";
  if (p === "tcp" && from !== undefined && from === to && KNOWN_PORTS[String(from)]) return KNOWN_PORTS[String(from)];
  if (p === "tcp") return "Custom TCP";
  if (p === "udp") return "Custom UDP";
  return `Custom protocol (${protocol ?? "?"})`;
}

export function protocolLabel(protocol: string | undefined): string {
  if (protocol === "-1" || protocol === "all") return "All";
  if (protocol === "tcp" || protocol === "6") return "TCP";
  if (protocol === "udp" || protocol === "17") return "UDP";
  if (protocol === "icmp" || protocol === "1") return "ICMP";
  return protocol ?? "-";
}

export function portRangeLabel(protocol: string | undefined, from: number | undefined, to: number | undefined): string {
  if (protocol === "-1" || from === undefined || from === -1) return "All";
  return from === to ? String(from) : `${from} - ${to}`;
}

/** Parses "22", "8000-8100" or "8000 - 8100" into a valid TCP/UDP port range. */
export function parsePortRange(text: string): { from: number; to: number } | null {
  const m = text.trim().match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from > 65535 || to > 65535 || from > to) return null;
  return { from, to };
}

const CIDR4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(3[0-2]|[12]?\d)$/;
const CIDR6 = /^[0-9a-fA-F:]+\/(12[0-8]|1[01]\d|\d?\d)$/;
const PREFIX_LIST = /^pl-[0-9a-f]+$/;
const GROUP_ID = /^sg-[0-9a-f]+$/;

export type RuleSource = { kind: "ipv4"; value: string } | { kind: "ipv6"; value: string } | { kind: "group"; value: string } | { kind: "prefix-list"; value: string };

/** A rule's source or destination: an IPv4/IPv6 CIDR, a security group ID or a prefix list ID. */
export function parseRuleSource(text: string): RuleSource | null {
  const v = text.trim();
  if (CIDR4.test(v)) return { kind: "ipv4", value: v };
  if (v.includes(":") && CIDR6.test(v)) return { kind: "ipv6", value: v };
  if (GROUP_ID.test(v)) return { kind: "group", value: v };
  if (PREFIX_LIST.test(v)) return { kind: "prefix-list", value: v };
  return null;
}

export interface IpPermissionSpec {
  IpProtocol: string;
  FromPort?: number;
  ToPort?: number;
  IpRanges?: { CidrIp: string; Description?: string }[];
  Ipv6Ranges?: { CidrIpv6: string; Description?: string }[];
  UserIdGroupPairs?: { GroupId: string; Description?: string }[];
  PrefixListIds?: { PrefixListId: string; Description?: string }[];
}

/** Builds one IpPermission from the rule editor's fields, or explains what is wrong. */
export function buildIpPermission(input: { type: string; ports?: string; source: string; description?: string }): { ok: true; value: IpPermissionSpec } | { ok: false; error: string } {
  const preset = RULE_PRESETS.find((p) => p.id === input.type);
  if (!preset) return { ok: false, error: `Unknown rule type "${input.type}".` };
  let from = preset.from;
  let to = preset.to;
  if (from === -2) {
    const range = parsePortRange(input.ports ?? "");
    if (!range) return { ok: false, error: "Enter a port (22) or a port range (8000-8100) between 0 and 65535." };
    from = range.from;
    to = range.to;
  }
  const source = parseRuleSource(input.source);
  if (!source) return { ok: false, error: "The source must be a CIDR block (0.0.0.0/0, 10.0.0.0/16, ::/0), a security group ID (sg-...) or a prefix list ID (pl-...)." };
  const description = input.description?.trim() ? input.description.trim() : undefined;
  const ports = preset.protocol === "-1" ? {} : { FromPort: from, ToPort: to };
  const base: IpPermissionSpec = { IpProtocol: preset.protocol, ...ports };
  switch (source.kind) {
    case "ipv4":
      return { ok: true, value: { ...base, IpRanges: [{ CidrIp: source.value, Description: description }] } };
    case "ipv6":
      return { ok: true, value: { ...base, Ipv6Ranges: [{ CidrIpv6: source.value, Description: description }] } };
    case "group":
      return { ok: true, value: { ...base, UserIdGroupPairs: [{ GroupId: source.value, Description: description }] } };
    case "prefix-list":
      return { ok: true, value: { ...base, PrefixListIds: [{ PrefixListId: source.value, Description: description }] } };
  }
}

export interface SecurityGroupRuleLike {
  SecurityGroupRuleId?: string;
  IsEgress?: boolean;
  IpProtocol?: string;
  FromPort?: number;
  ToPort?: number;
  CidrIpv4?: string;
  CidrIpv6?: string;
  PrefixListId?: string;
  ReferencedGroupInfo?: { GroupId?: string };
  Description?: string;
}

/** One row of the console's inbound/outbound rules tables. */
export function ruleRow(r: SecurityGroupRuleLike): Record<string, string | null> {
  return {
    ruleId: r.SecurityGroupRuleId ?? null,
    type: ruleTypeLabel(r.IpProtocol, r.FromPort, r.ToPort),
    protocol: protocolLabel(r.IpProtocol),
    portRange: portRangeLabel(r.IpProtocol, r.FromPort, r.ToPort),
    source: r.CidrIpv4 ?? r.CidrIpv6 ?? r.ReferencedGroupInfo?.GroupId ?? r.PrefixListId ?? null,
    description: r.Description ?? null,
  };
}

// ---- User data ----

export function encodeUserData(text: string): string | undefined {
  return text.trim() === "" ? undefined : Buffer.from(text, "utf8").toString("base64");
}

export function decodeUserData(b64: string | undefined): string | null {
  if (!b64) return null;
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

// ---- AMIs ----

export interface AmiLike {
  ImageId?: string;
  Name?: string;
  Description?: string;
  PlatformDetails?: string;
  Platform?: string;
  Architecture?: string;
}

/** The Quick Start family an AMI belongs to, judged from its platform, name and description. */
export function amiFamily(a: AmiLike): string {
  const text = `${a.Name ?? ""} ${a.Description ?? ""}`.toLowerCase();
  if (a.Platform === "windows" || (a.PlatformDetails ?? "").toLowerCase().startsWith("windows") || text.includes("windows")) return "Windows";
  if (text.includes("ubuntu")) return "Ubuntu";
  if (text.includes("red hat") || text.includes("rhel")) return "Red Hat";
  if (text.includes("suse")) return "SUSE Linux";
  if (text.includes("debian")) return "Debian";
  if (text.includes("macos") || text.includes("mac os")) return "macOS";
  if (text.includes("amazon linux") || text.startsWith("al20") || text.startsWith("amzn")) return "Amazon Linux";
  return "Other";
}

/** The default login user the console's Connect page suggests for an AMI. */
export function defaultLoginUser(a: AmiLike): string | null {
  const family = amiFamily(a);
  if (family === "Windows") return null;
  if (family === "Ubuntu") return "ubuntu";
  if (family === "Debian") return "admin";
  if (family === "Amazon Linux" || family === "Red Hat" || family === "SUSE Linux") return "ec2-user";
  return null;
}

/** "launch-wizard-3": the next free number after the existing launch-wizard-N group names. */
export function nextLaunchWizardName(existing: string[]): string {
  let max = 0;
  for (const name of existing) {
    const m = name.match(/^launch-wizard-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `launch-wizard-${max + 1}`;
}

/** The console's status check summary: "2/2 checks passed", "1/2 checks passed", "Initializing". */
export function statusCheckSummary(instanceStatus: string | undefined, systemStatus: string | undefined, attached?: string | undefined): string | null {
  const statuses = [systemStatus, instanceStatus, attached].filter((s): s is string => typeof s === "string" && s !== "not-applicable");
  if (statuses.length === 0) return null;
  if (statuses.includes("initializing")) return "Initializing";
  if (statuses.every((s) => s === "insufficient-data")) return "Insufficient data";
  const passed = statuses.filter((s) => s === "ok").length;
  return `${passed}/${statuses.length} checks passed`;
}
