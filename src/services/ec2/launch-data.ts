/**
 * Everything the Launch instance wizard shows, read from the emulator in one go: AMIs (Amazon's
 * Quick Start images and my AMIs), instance types, key pairs, VPCs, subnets, security groups
 * and instance profiles. Server only.
 */

import { secondary } from "../../console/secondary.ts";
import { DescribeImagesCommand, type Image } from "@aws-sdk/client-ec2";
import type { Ctx } from "../../console/types.ts";
import { amiFamily, nameTag, nextLaunchWizardName } from "./helpers.ts";
import { allInstanceTypes, allSecurityGroups, allSubnets, allVpcs, instanceProfileOptions, keyPairOptions } from "./options.ts";

export interface WizardImage {
  id: string;
  name: string;
  description: string;
  architecture: string;
  family: string;
  platform: string;
  rootDevice: string | null;
  rootSize: number | null;
  rootType: string | null;
  source: "quickstart" | "mine";
  created: string | null;
  freeTier: boolean;
}

export interface WizardInstanceType {
  type: string;
  vcpu: number | null;
  memoryGiB: number | null;
  architectures: string[];
  freeTier: boolean;
}

export interface WizardData {
  images: WizardImage[];
  instanceTypes: WizardInstanceType[];
  keyPairs: { name: string; label: string }[];
  vpcs: { id: string; label: string; isDefault: boolean }[];
  subnets: { id: string; vpcId: string; az: string; cidr: string; label: string; mapPublicIp: boolean }[];
  securityGroups: { id: string; name: string; vpcId: string; description: string }[];
  instanceProfiles: { name: string; label: string }[];
  suggestedGroupName: string;
  /** Lists that could not be read; the wizard shows these instead of the controls. */
  errors: Record<string, string>;
}

function wizardImage(i: Image, source: WizardImage["source"]): WizardImage | null {
  if (!i.ImageId || i.State !== "available") return null;
  const root = i.BlockDeviceMappings?.find((b) => b.DeviceName === i.RootDeviceName) ?? i.BlockDeviceMappings?.[0];
  return {
    id: i.ImageId,
    name: i.Name ?? i.ImageId,
    description: i.Description ?? "",
    architecture: i.Architecture ?? "",
    family: amiFamily(i),
    platform: i.PlatformDetails ?? "",
    rootDevice: i.RootDeviceName ?? root?.DeviceName ?? null,
    rootSize: root?.Ebs?.VolumeSize ?? null,
    rootType: root?.Ebs?.VolumeType ?? null,
    source,
    created: i.CreationDate ?? null,
    freeTier: (i as Image & { FreeTierEligible?: boolean }).FreeTierEligible === true,
  };
}

/** A wizard lookup that may be denied: its value, or `empty` with the error recorded under `key`. */
async function lookup<T>(errors: Record<string, string>, key: string, fn: () => Promise<T>, empty: T): Promise<T> {
  const r = await secondary(fn);
  if (r.ok) return r.value;
  errors[key] = r.error;
  return empty;
}

export async function loadWizardData(ctx: Ctx): Promise<WizardData> {
  const errors: Record<string, string> = {};
  const ec2 = ctx.clients.ec2;
  const [amazon, mine, types, keys, vpcs, subnets, groups, profiles] = await Promise.all([
    lookup(errors, "images", async () => (await ec2.send(new DescribeImagesCommand({ Owners: ["amazon"] }))).Images ?? [], [] as Image[]),
    lookup(errors, "myImages", async () => (await ec2.send(new DescribeImagesCommand({ Owners: ["self"] }))).Images ?? [], [] as Image[]),
    lookup(errors, "instanceTypes", () => allInstanceTypes(ctx), []),
    lookup(errors, "keyPairs", () => keyPairOptions(ctx), []),
    lookup(errors, "vpcs", () => allVpcs(ctx), []),
    lookup(errors, "subnets", () => allSubnets(ctx), []),
    lookup(errors, "securityGroups", () => allSecurityGroups(ctx), []),
    lookup(errors, "instanceProfiles", () => instanceProfileOptions(ctx), []),
  ]);
  const images = [
    ...amazon.map((i) => wizardImage(i, "quickstart")),
    ...mine.map((i) => wizardImage(i, "mine")),
  ].filter((i): i is WizardImage => i !== null);
  return {
    images: images.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? ""))),
    instanceTypes: types
      .filter((t) => t.InstanceType)
      .map((t) => ({
        type: t.InstanceType as string,
        vcpu: t.VCpuInfo?.DefaultVCpus ?? null,
        memoryGiB: t.MemoryInfo?.SizeInMiB !== undefined ? t.MemoryInfo.SizeInMiB / 1024 : null,
        architectures: (t.ProcessorInfo?.SupportedArchitectures ?? []).map(String),
        freeTier: t.FreeTierEligible === true,
      })),
    keyPairs: keys.map((k) => ({ name: k.value, label: k.label })),
    vpcs: vpcs.filter((v) => v.VpcId).map((v) => ({ id: v.VpcId as string, label: `${v.VpcId}${nameTag(v.Tags) ? ` (${nameTag(v.Tags)})` : ""} ${v.CidrBlock ?? ""}${v.IsDefault ? " (default)" : ""}`, isDefault: v.IsDefault === true })),
    subnets: subnets
      .filter((s) => s.SubnetId && s.VpcId)
      .map((s) => ({ id: s.SubnetId as string, vpcId: s.VpcId as string, az: s.AvailabilityZone ?? "", cidr: s.CidrBlock ?? "", label: `${s.SubnetId}${nameTag(s.Tags) ? ` (${nameTag(s.Tags)})` : ""}`, mapPublicIp: s.MapPublicIpOnLaunch === true })),
    securityGroups: groups.filter((g) => g.GroupId).map((g) => ({ id: g.GroupId as string, name: g.GroupName ?? "", vpcId: g.VpcId ?? "", description: g.Description ?? "" })),
    instanceProfiles: profiles.map((p) => ({ name: p.value, label: p.label })),
    suggestedGroupName: nextLaunchWizardName(groups.map((g) => g.GroupName ?? "")),
    errors,
  };
}
