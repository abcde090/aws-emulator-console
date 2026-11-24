/**
 * Launching instances: the one RunInstances path used by both the Launch instance wizard
 * (src/services/ec2/LaunchWizard.tsx) and the generic create form of the Instances resource.
 */

import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeImagesCommand,
  RunInstancesCommand,
  type BlockDeviceMapping,
  type InstanceNetworkInterfaceSpecification,
  type VolumeType,
} from "@aws-sdk/client-ec2";
import type { Ctx } from "../../console/types.ts";
import { buildIpPermission, encodeUserData, plural, type IpPermissionSpec } from "./helpers.ts";
import { checkLaunchSpec, type LaunchOutcome, type LaunchSpec, type NewSecurityGroupSpec } from "./launch-spec.ts";

export { VOLUME_TYPES } from "./launch-spec.ts";
import { tagSpec } from "./options.ts";

function newGroupPermissions(g: NewSecurityGroupSpec): IpPermissionSpec[] {
  const out: IpPermissionSpec[] = [];
  const add = (type: string, source: string, description: string) => {
    const p = buildIpPermission({ type, source, description });
    if (p.ok) out.push(p.value);
  };
  if (g.allowSsh) add("ssh", g.sshSource, "");
  if (g.allowHttps) add("https", "0.0.0.0/0", "");
  if (g.allowHttp) add("http", "0.0.0.0/0", "");
  return out;
}

async function rootDevice(ctx: Ctx, imageId: string, size: number | null, type: string | null): Promise<BlockDeviceMapping[] | undefined> {
  if (size === null && type === null) return undefined;
  const img = (await ctx.clients.ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }))).Images?.[0];
  const device = img?.RootDeviceName ?? img?.BlockDeviceMappings?.[0]?.DeviceName;
  if (!device) throw new Error(`The AMI ${imageId} reports no root device, so its storage can't be changed. Keep the AMI's default storage.`);
  return [{ DeviceName: device, Ebs: { VolumeSize: size ?? undefined, VolumeType: (type ?? undefined) as VolumeType | undefined, DeleteOnTermination: true } }];
}

/** Creates the wizard's security group (when asked) and runs the instances. */
export async function launchInstances(ctx: Ctx, s: LaunchSpec): Promise<LaunchOutcome> {
  const problem = checkLaunchSpec(s);
  if (problem) throw new Error(problem);
  const ec2 = ctx.clients.ec2;
  let createdGroup: string | null = null;
  if (s.newSecurityGroup) {
    const g = s.newSecurityGroup;
    const r = await ec2.send(new CreateSecurityGroupCommand({ GroupName: g.name, Description: g.description, VpcId: s.vpcId ?? undefined }));
    if (!r.GroupId) throw new Error("CreateSecurityGroup returned no group ID.");
    createdGroup = r.GroupId;
    const perms = newGroupPermissions(g);
    if (perms.length) await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: createdGroup, IpPermissions: perms }));
  }
  const groups = createdGroup ? [createdGroup, ...s.securityGroupIds] : s.securityGroupIds;
  const tags = s.name.trim() ? [{ Key: "Name", Value: s.name.trim() }, ...s.tags.filter((t) => t.Key !== "Name")] : s.tags;
  // A network interface spec is needed only to set auto-assign public IP explicitly.
  const nic: InstanceNetworkInterfaceSpecification[] | undefined =
    s.autoAssignPublicIp === "default" ? undefined : [{ DeviceIndex: 0, SubnetId: s.subnetId ?? undefined, Groups: groups, AssociatePublicIpAddress: s.autoAssignPublicIp === "enable", DeleteOnTermination: true }];
  const r = await ec2.send(
    new RunInstancesCommand({
      ImageId: s.imageId,
      InstanceType: s.instanceType as never,
      MinCount: s.count,
      MaxCount: s.count,
      KeyName: s.keyName ?? undefined,
      NetworkInterfaces: nic,
      SubnetId: nic ? undefined : s.subnetId ?? undefined,
      SecurityGroupIds: nic ? undefined : groups,
      BlockDeviceMappings: await rootDevice(ctx, s.imageId, s.volumeSize, s.volumeType),
      UserData: encodeUserData(s.userData),
      IamInstanceProfile: s.iamInstanceProfile ? { Name: s.iamInstanceProfile } : undefined,
      DisableApiTermination: s.terminationProtection || undefined,
      Monitoring: s.detailedMonitoring ? { Enabled: true } : undefined,
      TagSpecifications: tagSpec("instance", tags),
    })
  );
  const ids = (r.Instances ?? []).map((i) => i.InstanceId).filter((x): x is string => typeof x === "string");
  if (ids.length === 0) throw new Error("RunInstances returned no instances.");
  return { instanceIds: ids, securityGroupId: createdGroup };
}

export function launchMessage(o: LaunchOutcome): string {
  return `Successfully initiated launch of ${plural(o.instanceIds.length, "instance")} (${o.instanceIds.join(", ")})${o.securityGroupId ? ` and created security group ${o.securityGroupId}` : ""}.`;
}
