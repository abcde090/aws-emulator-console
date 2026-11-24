/**
 * Pure helpers for the Elastic Beanstalk console: composite ids for application versions and
 * saved configurations, the option settings a create form turns into, and log locations.
 */

import type { FieldValues, Tag } from "../../console/types.ts";

export interface OptionSetting {
  Namespace: string;
  OptionName: string;
  Value: string;
}

/**
 * Application versions and saved configurations belong to an application. Their console id
 * is "<application>/<name>": application names can't contain "/", so the first one splits.
 */
export function joinId(app: string, child: string): string {
  return `${app}/${child}`;
}

export function splitId(id: string): { app: string; child: string } {
  const i = id.indexOf("/");
  if (i <= 0 || i === id.length - 1) throw new Error(`"${id}" is not a valid id: expected <application name>/<name>.`);
  return { app: id.slice(0, i), child: id.slice(i + 1) };
}

export function tagList(v: unknown): Tag[] {
  return Array.isArray(v) ? (v as Tag[]).filter((t) => t && typeof t.Key === "string" && t.Key !== "") : [];
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The option settings the Create environment form sets. Only options the user chose are
 * sent; everything else keeps the platform default, as in the console.
 */
export function environmentOptionSettings(v: FieldValues): OptionSetting[] {
  const out: OptionSetting[] = [];
  const add = (Namespace: string, OptionName: string, Value: string) => out.push({ Namespace, OptionName, Value });
  if (v.tier !== "Worker" && (v.preset === "SingleInstance" || v.preset === "LoadBalanced")) add("aws:elasticbeanstalk:environment", "EnvironmentType", v.preset);
  if (v.tier !== "Worker" && v.preset === "LoadBalanced" && text(v.loadBalancerType)) add("aws:elasticbeanstalk:environment", "LoadBalancerType", text(v.loadBalancerType));
  if (text(v.serviceRole)) add("aws:elasticbeanstalk:environment", "ServiceRole", text(v.serviceRole));
  if (text(v.instanceProfile)) add("aws:autoscaling:launchconfiguration", "IamInstanceProfile", text(v.instanceProfile));
  if (text(v.keyName)) add("aws:autoscaling:launchconfiguration", "EC2KeyName", text(v.keyName));
  if (text(v.vpcId)) add("aws:ec2:vpc", "VPCId", text(v.vpcId));
  if (Array.isArray(v.subnets) && v.subnets.length) add("aws:ec2:vpc", "Subnets", (v.subnets as string[]).join(","));
  if (text(v.vpcId) && v.publicIp === true) add("aws:ec2:vpc", "AssociatePublicIpAddress", "true");
  if (text(v.instanceTypes)) add("aws:ec2:instances", "InstanceTypes", text(v.instanceTypes).split(",").map((s) => s.trim()).filter(Boolean).join(","));
  if (typeof v.minSize === "number") add("aws:autoscaling:asg", "MinSize", String(v.minSize));
  if (typeof v.maxSize === "number") add("aws:autoscaling:asg", "MaxSize", String(v.maxSize));
  if (v.healthReporting === "enhanced" || v.healthReporting === "basic") add("aws:elasticbeanstalk:healthreporting:system", "SystemType", v.healthReporting);
  if (text(v.deploymentPolicy)) add("aws:elasticbeanstalk:command", "DeploymentPolicy", text(v.deploymentPolicy));
  if (v.managedUpdates === true) {
    add("aws:elasticbeanstalk:managedactions", "ManagedActionsEnabled", "true");
    add("aws:elasticbeanstalk:managedactions", "PreferredStartTime", text(v.updateWindow) || "Sun:10:00");
    add("aws:elasticbeanstalk:managedactions:platformupdate", "UpdateLevel", v.updateLevel === "patch" ? "patch" : "minor");
  } else if (v.managedUpdates === false) {
    add("aws:elasticbeanstalk:managedactions", "ManagedActionsEnabled", "false");
  }
  return out;
}

/**
 * RetrieveEnvironmentInfo returns a presigned S3 URL. The bucket and key are the first path
 * segment and the rest (path-style URL), so the log can be read with the checked S3 client.
 */
export function logLocation(url: string): { bucket: string; key: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const parts = u.pathname.replace(/^\/+/, "").split("/");
  const bucket = parts.shift();
  const key = parts.map((p) => decodeURIComponent(p)).join("/");
  if (!bucket || !key) return null;
  if (/\.s3[.-]/.test(u.hostname) && !u.hostname.startsWith("s3")) {
    // Virtual-hosted style: <bucket>.s3.<region>.amazonaws.com/<key>
    return { bucket: u.hostname.split(".s3")[0], key: [bucket, ...parts.map((p) => decodeURIComponent(p))].join("/") };
  }
  return { bucket, key };
}

/** "WebServer/Standard" style label for a Tier. */
export function tierLabel(tier: { Name?: string; Type?: string } | undefined): string | null {
  if (!tier?.Name) return null;
  return tier.Name === "Worker" ? "Worker" : "Web server";
}

/** Splits an environment name rule check out so it can be tested. */
export const ENV_NAME = "(?!-)[A-Za-z0-9-]{4,40}(?<!-)";
