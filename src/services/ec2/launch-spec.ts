/**
 * The Launch instance request: its shape, parsing of untrusted input from the browser, and
 * the checks the console runs before calling RunInstances. Pure, so it is unit-tested.
 */

import { buildIpPermission } from "./helpers.ts";

export const VOLUME_TYPES = ["gp3", "gp2", "io1", "io2", "st1", "sc1", "standard"] as const;

export interface NewSecurityGroupSpec {
  name: string;
  description: string;
  allowSsh: boolean;
  sshSource: string;
  allowHttps: boolean;
  allowHttp: boolean;
}

export interface LaunchSpec {
  name: string;
  tags: { Key: string; Value: string }[];
  imageId: string;
  instanceType: string;
  keyName: string | null;
  vpcId: string | null;
  subnetId: string | null;
  autoAssignPublicIp: "enable" | "disable" | "default";
  securityGroupIds: string[];
  newSecurityGroup: NewSecurityGroupSpec | null;
  volumeSize: number | null;
  volumeType: string | null;
  userData: string;
  count: number;
  iamInstanceProfile: string | null;
  terminationProtection: boolean;
  detailedMonitoring: boolean;
}

export interface LaunchOutcome {
  instanceIds: string[];
  securityGroupId: string | null;
}

/** Checks a launch request from the browser; returns the first problem in console wording. */
export function checkLaunchSpec(s: LaunchSpec): string | null {
  if (!/^ami-[0-9a-f]+$/.test(s.imageId)) return "Choose an Amazon Machine Image (AMI).";
  if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(s.instanceType)) return "Choose an instance type.";
  if (!Number.isInteger(s.count) || s.count < 1 || s.count > 20) return "Number of instances must be between 1 and 20.";
  if (s.name.length > 256) return "The Name tag can be at most 256 characters.";
  if (s.keyName !== null && (s.keyName.length === 0 || s.keyName.length > 255)) return "Key pair name is not valid.";
  if (s.subnetId !== null && !/^subnet-[0-9a-f]+$/.test(s.subnetId)) return "Subnet is not valid.";
  if (s.vpcId !== null && !/^vpc-[0-9a-f]+$/.test(s.vpcId)) return "VPC is not valid.";
  if (s.securityGroupIds.some((g) => !/^sg-[0-9a-f]+$/.test(g))) return "A selected security group is not valid.";
  if (!s.newSecurityGroup && s.securityGroupIds.length === 0) return "Select at least one security group, or create a security group.";
  if (s.newSecurityGroup) {
    const g = s.newSecurityGroup;
    if (!/^[A-Za-z0-9 ._\-:/()#,@[\]+=&;{}!$*]{1,255}$/.test(g.name) || g.name.toLowerCase().startsWith("sg-")) return "Security group name: up to 255 characters (a-z, A-Z, 0-9, spaces and ._-:/()#,@[]+=&;{}!$*), not starting with sg-.";
    if (!g.description.trim() || g.description.length > 255) return "Security group description is required (up to 255 characters).";
    if (g.allowSsh && !buildIpPermission({ type: "ssh", source: g.sshSource }).ok) return "SSH source must be a CIDR block such as 0.0.0.0/0 or 203.0.113.0/24.";
  }
  if (s.volumeSize !== null && (!Number.isInteger(s.volumeSize) || s.volumeSize < 1 || s.volumeSize > 16384)) return "Root volume size must be between 1 and 16384 GiB.";
  if (s.volumeType !== null && !(VOLUME_TYPES as readonly string[]).includes(s.volumeType)) return "Choose a valid volume type.";
  if (Buffer.byteLength(s.userData, "utf8") > 16384) return "User data is limited to 16 KB.";
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const optNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Turns the wizard's JSON into a LaunchSpec, or explains what is malformed. Values are checked by checkLaunchSpec. */
export function parseLaunchSpec(raw: unknown): { ok: true; value: LaunchSpec } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "The launch request is missing." };
  const tags: { Key: string; Value: string }[] = [];
  if (Array.isArray(raw.tags)) {
    for (const t of raw.tags) {
      if (!isObj(t) || typeof t.Key !== "string" || typeof (t.Value ?? "") !== "string") return { ok: false, error: "Each tag needs a key and a value." };
      const key = t.Key.trim();
      if (key === "") continue;
      if (key.length > 128 || String(t.Value ?? "").length > 256) return { ok: false, error: "Tag keys are at most 128 characters, values 256." };
      tags.push({ Key: key, Value: String(t.Value ?? "") });
    }
  }
  if (tags.length > 49) return { ok: false, error: "At most 49 tags besides Name." };
  const sg = raw.newSecurityGroup;
  const auto = raw.autoAssignPublicIp;
  const spec: LaunchSpec = {
    name: typeof raw.name === "string" ? raw.name : "",
    tags,
    imageId: optStr(raw.imageId) ?? "",
    instanceType: optStr(raw.instanceType) ?? "",
    keyName: optStr(raw.keyName),
    vpcId: optStr(raw.vpcId),
    subnetId: optStr(raw.subnetId),
    autoAssignPublicIp: auto === "enable" || auto === "disable" ? auto : "default",
    securityGroupIds: Array.isArray(raw.securityGroupIds) ? raw.securityGroupIds.filter((g): g is string => typeof g === "string") : [],
    newSecurityGroup: isObj(sg)
      ? {
          name: typeof sg.name === "string" ? sg.name.trim() : "",
          description: typeof sg.description === "string" ? sg.description : "",
          allowSsh: sg.allowSsh === true,
          sshSource: typeof sg.sshSource === "string" ? sg.sshSource.trim() : "",
          allowHttps: sg.allowHttps === true,
          allowHttp: sg.allowHttp === true,
        }
      : null,
    volumeSize: optNum(raw.volumeSize),
    volumeType: optStr(raw.volumeType),
    userData: typeof raw.userData === "string" ? raw.userData : "",
    count: optNum(raw.count) ?? 1,
    iamInstanceProfile: optStr(raw.iamInstanceProfile),
    terminationProtection: raw.terminationProtection === true,
    detailedMonitoring: raw.detailedMonitoring === true,
  };
  const problem = checkLaunchSpec(spec);
  return problem ? { ok: false, error: problem } : { ok: true, value: spec };
}
