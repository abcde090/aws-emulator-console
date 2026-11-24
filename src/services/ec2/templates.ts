/** EC2 Launch templates: create, versions, default version, launch instances from a template. */

import {
  CreateLaunchTemplateCommand,
  CreateLaunchTemplateVersionCommand,
  DeleteLaunchTemplateCommand,
  DeleteLaunchTemplateVersionsCommand,
  DescribeLaunchTemplatesCommand,
  DescribeLaunchTemplateVersionsCommand,
  ModifyLaunchTemplateCommand,
  RunInstancesCommand,
  type RequestLaunchTemplateData,
  type ResponseLaunchTemplateData,
  type VolumeType,
} from "@aws-sdk/client-ec2";
import type { Ctx, FieldDef, FieldValues, ResourceDef, Tag } from "../../console/types.ts";
import { decodeUserData, encodeUserData, plural, strList, tagRows, withName } from "./helpers.ts";
import { VOLUME_TYPES } from "./launch.ts";
import { instanceTypeOptions, keyPairOptions, securityGroupOptions, subnetOptions, tagSpec } from "./options.ts";

const LT_NAME = "[a-zA-Z0-9()./_-]{3,128}";

const dataFields = (section: string): FieldDef[] => [
  { name: "imageId", label: "AMI ID", kind: "text", section, placeholder: "ami-0123456789abcdef0", help: "Find AMI IDs on the AMI Catalog or AMIs pages. Leave empty to set it at launch.", validate: { pattern: "ami-[0-9a-f]+", message: "An AMI ID such as ami-0123456789abcdef0." } },
  { name: "instanceType", label: "Instance type", kind: "select", default: "", options: instanceTypeOptions, section },
  { name: "keyName", label: "Key pair name", kind: "select", default: "", options: keyPairOptions, section },
  { name: "subnetId", label: "Subnet", kind: "select", default: "", options: subnetOptions, section: "Network settings", help: "Don't include in launch template (-) to choose at launch." },
  { name: "securityGroups", label: "Security groups", kind: "multiselect", options: securityGroupOptions, section: "Network settings" },
  { name: "volumeSize", label: "Root volume size (GiB)", kind: "number", section: "Storage (volumes)", validate: { min: 1, max: 16384, message: "Between 1 and 16384 GiB." } },
  { name: "volumeType", label: "Root volume type", kind: "select", default: "", options: VOLUME_TYPES.map((t) => ({ value: t, label: t })), section: "Storage (volumes)" },
  { name: "rootDevice", label: "Root device name", kind: "text", default: "/dev/xvda", section: "Storage (volumes)", help: "Must match the AMI's root device (shown on the AMI's detail page)." },
  { name: "userData", label: "User data", kind: "textarea", section: "Advanced details" },
];

function templateData(v: FieldValues): RequestLaunchTemplateData {
  const s = (k: string) => (typeof v[k] === "string" && v[k] !== "" ? (v[k] as string) : undefined);
  const groups = strList(v.securityGroups);
  const subnet = s("subnetId");
  const size = typeof v.volumeSize === "number" ? v.volumeSize : undefined;
  const type = s("volumeType");
  return {
    ImageId: s("imageId"),
    InstanceType: s("instanceType") as never,
    KeyName: s("keyName"),
    NetworkInterfaces: subnet ? [{ DeviceIndex: 0, SubnetId: subnet, Groups: groups.length ? groups : undefined }] : undefined,
    SecurityGroupIds: subnet || groups.length === 0 ? undefined : groups,
    BlockDeviceMappings: size || type ? [{ DeviceName: s("rootDevice") ?? "/dev/xvda", Ebs: { VolumeSize: size, VolumeType: type as VolumeType | undefined } }] : undefined,
    UserData: encodeUserData(s("userData") ?? ""),
  };
}

/** The form values of an existing version's data, so Modify template starts from it. */
function dataValues(d: ResponseLaunchTemplateData | undefined): FieldValues {
  const nic = d?.NetworkInterfaces?.[0];
  const root = d?.BlockDeviceMappings?.[0];
  return {
    imageId: d?.ImageId ?? "",
    instanceType: d?.InstanceType ?? "",
    keyName: d?.KeyName ?? "",
    subnetId: nic?.SubnetId ?? "",
    securityGroups: d?.SecurityGroupIds ?? nic?.Groups ?? [],
    volumeSize: root?.Ebs?.VolumeSize ?? null,
    volumeType: root?.Ebs?.VolumeType ?? "",
    rootDevice: root?.DeviceName ?? "/dev/xvda",
    userData: decodeUserData(d?.UserData) ?? "",
  };
}

async function describe(ctx: Ctx, id: string) {
  const r = await ctx.clients.ec2.send(new DescribeLaunchTemplatesCommand({ LaunchTemplateIds: [id] }));
  const t = r.LaunchTemplates?.[0];
  if (!t) throw new Error(`Launch template ${id} was not found.`);
  return t;
}

export const launchTemplates: ResourceDef = {
  id: "launch-templates",
  name: "Launch Templates",
  singular: "launch template",
  idField: "id",
  nameField: "Launch template name",
  description: "Saved instance configurations you can launch from, or use in Auto Scaling groups.",
  emptyText: "You don't have any launch templates.",
  columns: [
    { key: "id", label: "Launch template ID", kind: "link" },
    { key: "name", label: "Launch template name", kind: "text" },
    { key: "defaultVersion", label: "Default version", kind: "count" },
    { key: "latestVersion", label: "Latest version", kind: "count" },
    { key: "created", label: "Create time", kind: "date" },
    { key: "createdBy", label: "Created by", kind: "arn" },
  ],

  async list(ctx) {
    const all = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ec2.send(new DescribeLaunchTemplatesCommand({ NextToken: token }));
      all.push(...(r.LaunchTemplates ?? []));
      token = r.NextToken;
    } while (token);
    return all.map((t) => ({
      id: t.LaunchTemplateId ?? "",
      name: t.LaunchTemplateName ?? null,
      defaultVersion: t.DefaultVersionNumber ?? null,
      latestVersion: t.LatestVersionNumber ?? null,
      created: t.CreateTime ?? null,
      createdBy: t.CreatedBy ?? null,
    }));
  },

  async get(ctx, id) {
    const t = await describe(ctx, id);
    const versions = (await ctx.clients.ec2.send(new DescribeLaunchTemplateVersionsCommand({ LaunchTemplateId: id }))).LaunchTemplateVersions ?? [];
    const def = versions.find((v) => v.DefaultVersion);
    return {
      summary: {
        "Launch template ID": id,
        "Launch template name": t.LaunchTemplateName ?? null,
        "Default version": t.DefaultVersionNumber ?? null,
        "Latest version": t.LatestVersionNumber ?? null,
        Owner: t.CreatedBy ?? null,
        "Create time": t.CreateTime ?? null,
      },
      tabs: [
        {
          id: "details",
          label: "Launch template version details",
          kind: "keyvalue",
          description: `Default version ${def?.VersionNumber ?? "-"}`,
          data: def
            ? {
                "AMI ID": def.LaunchTemplateData?.ImageId ?? null,
                "Instance type": def.LaunchTemplateData?.InstanceType ?? null,
                "Key pair name": def.LaunchTemplateData?.KeyName ?? null,
                "Security group IDs": def.LaunchTemplateData?.SecurityGroupIds?.join(", ") ?? def.LaunchTemplateData?.NetworkInterfaces?.[0]?.Groups?.join(", ") ?? null,
                Subnet: def.LaunchTemplateData?.NetworkInterfaces?.[0]?.SubnetId ?? null,
                "Version description": def.VersionDescription ?? null,
                "Created by": def.CreatedBy ?? null,
              }
            : {},
        },
        {
          id: "versions",
          label: "Versions",
          kind: "table",
          columns: [
            { key: "version", label: "Version", kind: "count" },
            { key: "default", label: "Default", kind: "boolean" },
            { key: "description", label: "Description", kind: "text" },
            { key: "ami", label: "AMI ID", kind: "text" },
            { key: "type", label: "Instance type", kind: "text" },
            { key: "created", label: "Create time", kind: "date" },
          ],
          data: versions.map((v) => ({ version: v.VersionNumber ?? null, default: v.DefaultVersion ?? false, description: v.VersionDescription ?? null, ami: v.LaunchTemplateData?.ImageId ?? null, type: v.LaunchTemplateData?.InstanceType ?? null, created: v.CreateTime ?? null })),
        },
        { id: "data", label: "Template data (default version)", kind: "json", data: def?.LaunchTemplateData ?? null, emptyText: "No template data." },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: tagRows(t.Tags), emptyText: "No tags." },
      ],
    };
  },

  create: {
    title: "Create launch template",
    description: "Creates a launch template (version 1) with CreateLaunchTemplate.",
    fields: [
      { name: "name", label: "Launch template name", kind: "text", required: true, section: "Launch template name and description", placeholder: "MyTemplate", help: "3-128 characters: letters, numbers and ( ) . / - _", validate: { pattern: LT_NAME, message: "3-128 letters, numbers and ( ) . / - _" } },
      { name: "description", label: "Template version description", kind: "text", section: "Launch template name and description", placeholder: "A prod webserver for MyApp", validate: { max: 255, message: "At most 255 characters." } },
      { name: "asg", label: "Provide guidance to help me set up a template that I can use with EC2 Auto Scaling", kind: "checkbox", default: false, section: "Launch template name and description", help: "Informational: Auto Scaling needs an AMI and an instance type in the template." },
      ...dataFields("Launch template contents"),
      { name: "tags", label: "Template tags", kind: "tags", section: "Template tags" },
    ],
    async run(ctx, v) {
      const data = templateData(v);
      if (v.asg === true && (!data.ImageId || !data.InstanceType)) throw new Error("For Auto Scaling, include an AMI and an instance type in the template.");
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      const r = await ctx.clients.ec2.send(
        new CreateLaunchTemplateCommand({ LaunchTemplateName: String(v.name), VersionDescription: typeof v.description === "string" && v.description ? v.description : undefined, LaunchTemplateData: data, TagSpecifications: tagSpec("launch-template", tags) })
      );
      if (!r.LaunchTemplate?.LaunchTemplateId) throw new Error("CreateLaunchTemplate returned no ID.");
      return r.LaunchTemplate.LaunchTemplateId;
    },
  },

  actions: [
    {
      id: "launch",
      label: "Launch instance from template",
      fields: [
        { name: "version", label: "Source template version", kind: "text", default: "$Default", help: "$Default, $Latest or a version number." , validate: { pattern: "\\$Default|\\$Latest|\\d+", message: "$Default, $Latest or a number." } },
        { name: "count", label: "Number of instances", kind: "number", default: 1, required: true, validate: { min: 1, max: 20, message: "Between 1 and 20." } },
        { name: "name", label: "Name", kind: "text", help: "Optional Name tag for the new instances." },
      ],
      async run(ctx, id, v) {
        const count = typeof v.count === "number" ? v.count : 1;
        const tags = withName(v.name, []);
        const r = await ctx.clients.ec2.send(
          new RunInstancesCommand({ LaunchTemplate: { LaunchTemplateId: id, Version: String(v.version || "$Default") }, MinCount: count, MaxCount: count, TagSpecifications: tagSpec("instance", tags) })
        );
        const ids = (r.Instances ?? []).map((i) => i.InstanceId).filter(Boolean);
        return { message: `Successfully initiated launch of ${plural(ids.length, "instance")}: ${ids.join(", ")}.` };
      },
    },
    {
      id: "new-version",
      label: "Modify template (Create new version)",
      fields: [
        { name: "description", label: "Template version description", kind: "text" },
        { name: "sourceVersion", label: "Source template version", kind: "text", help: "The form starts from the default version. Settings not shown here are copied from this version; leave it empty to start blank.", validate: { pattern: "\\d+", message: "A version number." } },
        ...dataFields(""),
      ],
      async initialValues(ctx, id) {
        const r = await ctx.clients.ec2.send(new DescribeLaunchTemplateVersionsCommand({ LaunchTemplateId: id, Versions: ["$Default"] }));
        const def = r.LaunchTemplateVersions?.[0];
        return { sourceVersion: def?.VersionNumber !== undefined ? String(def.VersionNumber) : "", ...dataValues(def?.LaunchTemplateData) };
      },
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(
          new CreateLaunchTemplateVersionCommand({
            LaunchTemplateId: id,
            SourceVersion: typeof v.sourceVersion === "string" && v.sourceVersion ? v.sourceVersion : undefined,
            VersionDescription: typeof v.description === "string" && v.description ? v.description : undefined,
            LaunchTemplateData: templateData(v),
          })
        );
        return { message: `Created version ${r.LaunchTemplateVersion?.VersionNumber ?? "?"}.` };
      },
    },
    {
      id: "set-default",
      label: "Set default version",
      fields: [{ name: "version", label: "Template version", kind: "number", required: true, validate: { min: 1, max: 100000, message: "A version number." } }],
      async initialValues(ctx, id) {
        return { version: (await describe(ctx, id)).DefaultVersionNumber ?? null };
      },
      async run(ctx, id, v) {
        await ctx.clients.ec2.send(new ModifyLaunchTemplateCommand({ LaunchTemplateId: id, DefaultVersion: String(v.version) }));
        return { message: `Version ${v.version} is now the default.` };
      },
    },
    {
      id: "delete-version",
      label: "Delete template version",
      danger: true,
      fields: [{ name: "version", label: "Template version", kind: "number", required: true, help: "You can't delete the default version.", validate: { min: 1, max: 100000, message: "A version number." } }],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new DeleteLaunchTemplateVersionsCommand({ LaunchTemplateId: id, Versions: [String(v.version)] }));
        const bad = r.UnsuccessfullyDeletedLaunchTemplateVersions?.[0];
        if (bad) throw new Error(`${bad.ResponseError?.Code ?? "Error"}: ${bad.ResponseError?.Message ?? "could not delete the version"}`);
        return { message: `Deleted version ${v.version}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteLaunchTemplateCommand({ LaunchTemplateId: id }));
    },
  },
};
