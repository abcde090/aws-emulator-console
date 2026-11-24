/**
 * The RDS "Create database" form: Standard create for RDS instances and Aurora clusters.
 */

import { CreateDBClusterCommand, CreateDBInstanceCommand } from "@aws-sdk/client-rds";
import type { Ctx, FieldDef, FieldValues } from "../../console/types.ts";
import { dbKey, ENGINES, IDENTIFIER, INSTANCE_CLASSES, isAurora } from "./format.ts";
import {
  clusterParameterGroupOptions,
  engineVersionOptions,
  kmsKeyOptions,
  optionalNumber,
  optionalText,
  optionGroupOptions,
  parameterGroupOptions,
  securityGroupOptions,
  strings,
  subnetGroupOptions,
  tagList,
  text,
} from "./shared.ts";

const CLASS_OPTIONS = INSTANCE_CLASSES.map((c) => ({ value: c, label: c }));
const FREE_TIER_CLASSES = new Set(["db.t3.micro", "db.t4g.micro"]);

export const createFields: FieldDef[] = [
  { name: "engine", label: "Engine type", kind: "radio", required: true, default: "postgres", options: ENGINES, section: "Engine options" },
  // One version picker per engine, so the list only offers versions of the chosen engine.
  ...ENGINES.map((e): FieldDef => ({
    name: versionField(e.value), label: "Engine version", kind: "select", default: "", options: (ctx: Ctx) => engineVersionOptions(ctx, e.value),
    section: "Engine options", showIf: { field: "engine", equals: e.value }, help: "Leave empty for the engine's default version.",
  })),
  {
    name: "template", label: "Templates", kind: "radio", default: "production", section: "Templates",
    help: "Production and Dev/Test don't change the API call; Free tier is checked against its limits before RDS is called.",
    options: [
      { value: "production", label: "Production: high availability and fast, consistent performance" },
      { value: "devtest", label: "Dev/Test: for development use outside a production environment" },
      { value: "freetier", label: "Free tier: Single-AZ db.t3.micro or db.t4g.micro, up to 20 GiB (RDS engines only)" },
    ],
  },
  {
    name: "deployment", label: "Deployment options", kind: "radio", default: "single", section: "Availability and durability",
    help: "For Aurora, Multi-AZ adds an Aurora Replica (reader instance) in a different Availability Zone.",
    options: [
      { value: "multi", label: "Multi-AZ DB instance deployment: a primary and a standby in different AZs" },
      { value: "single", label: "Single-AZ DB instance deployment: one DB instance, no standby" },
    ],
  },
  {
    name: "identifier", label: "DB instance identifier", kind: "text", required: true, default: "database-1", section: "Settings",
    help: "For Aurora this names the DB cluster; its instances are named <identifier>-instance-1, -2. 1-63 letters, numbers or hyphens, starting with a letter.",
    validate: { pattern: IDENTIFIER, message: "1-63 letters, numbers or hyphens; starts with a letter; no two hyphens in a row and no hyphen at the end." },
  },
  { name: "masterUsername", label: "Master username", kind: "text", required: true, default: "admin", section: "Credentials settings", validate: { pattern: "[a-zA-Z][a-zA-Z0-9_]{0,15}", message: "1-16 letters, numbers or underscores, starting with a letter." } },
  {
    name: "credentials", label: "Credentials management", kind: "radio", default: "secrets", section: "Credentials settings",
    options: [
      { value: "secrets", label: "Managed in AWS Secrets Manager: RDS generates a password and stores it in Secrets Manager" },
      { value: "self", label: "Self managed: create your own password" },
    ],
  },
  { name: "masterPassword", label: "Master password", kind: "password", required: true, section: "Credentials settings", showIf: { field: "credentials", equals: "self" }, validate: { pattern: "[^/\"@ ]{8,41}", message: "8-41 printable characters, not / \" @ or a space." } },
  { name: "instanceClass", label: "DB instance class", kind: "select", required: true, default: "db.t3.micro", options: CLASS_OPTIONS, section: "Instance configuration" },
  {
    name: "storageType", label: "Storage type", kind: "select", required: true, default: "gp3", section: "Storage", help: "Aurora manages storage itself; these settings apply to RDS engines.",
    options: [
      { value: "gp3", label: "General Purpose SSD (gp3)" },
      { value: "gp2", label: "General Purpose SSD (gp2)" },
      { value: "io1", label: "Provisioned IOPS SSD (io1)" },
      { value: "io2", label: "Provisioned IOPS SSD (io2)" },
      { value: "standard", label: "Magnetic" },
    ],
  },
  { name: "allocatedStorage", label: "Allocated storage (GiB)", kind: "number", required: true, default: 20, section: "Storage", validate: { min: 20, max: 65536, message: "Between 20 and 65,536 GiB." } },
  { name: "iops", label: "Provisioned IOPS", kind: "number", section: "Storage", help: "For io1, io2 and gp3 above 400 GiB.", validate: { min: 1000, max: 256000, message: "Between 1,000 and 256,000." } },
  { name: "maxStorage", label: "Maximum storage threshold (GiB)", kind: "number", section: "Storage", help: "Turns on storage autoscaling up to this size.", validate: { min: 21, max: 65536, message: "Between 21 and 65,536 GiB." } },
  { name: "subnetGroup", label: "DB subnet group", kind: "select", default: "", options: subnetGroupOptions, section: "Connectivity", help: "Chooses the VPC and subnets. Leave empty for the default subnet group." },
  {
    name: "publicAccess", label: "Public access", kind: "radio", default: "no", section: "Connectivity",
    options: [
      { value: "yes", label: "Yes: RDS assigns a public IP address" },
      { value: "no", label: "No: only resources inside the VPC can connect" },
    ],
  },
  { name: "securityGroups", label: "Existing VPC security groups", kind: "multiselect", options: securityGroupOptions, section: "Connectivity", help: "Leave empty for the VPC's default security group." },
  { name: "port", label: "Database port", kind: "number", section: "Connectivity", help: "Leave empty for the engine's default port.", validate: { min: 1150, max: 65535, message: "Between 1150 and 65535." } },
  { name: "iamAuth", label: "IAM database authentication", kind: "checkbox", default: false, section: "Database authentication" },
  { name: "dbName", label: "Initial database name", kind: "text", section: "Additional configuration", help: "If you leave this empty, RDS doesn't create a database.", validate: { pattern: "[a-zA-Z][a-zA-Z0-9_]{0,63}", message: "Letters, numbers and underscores, starting with a letter." } },
  { name: "parameterGroup", label: "DB parameter group", kind: "select", default: "", options: parameterGroupOptions, section: "Additional configuration", help: "Must match the engine family. Leave empty for the default group." },
  { name: "clusterParameterGroup", label: "DB cluster parameter group (Aurora)", kind: "select", default: "", options: clusterParameterGroupOptions, section: "Additional configuration" },
  { name: "optionGroup", label: "Option group", kind: "select", default: "", options: optionGroupOptions, section: "Additional configuration" },
  { name: "backupRetention", label: "Backup retention period (days)", kind: "number", default: 7, section: "Backup", help: "0 turns automated backups off (RDS engines only).", validate: { min: 0, max: 35, message: "Between 0 and 35 days." } },
  { name: "copyTags", label: "Copy tags to snapshots", kind: "checkbox", default: true, section: "Backup" },
  { name: "encrypted", label: "Enable encryption", kind: "checkbox", default: true, section: "Encryption" },
  { name: "kmsKey", label: "AWS KMS key", kind: "select", default: "", options: kmsKeyOptions, section: "Encryption", showIf: { field: "encrypted", equals: true }, help: "Leave empty for the AWS managed key (aws/rds)." },
  { name: "autoMinor", label: "Enable auto minor version upgrade", kind: "checkbox", default: true, section: "Maintenance" },
  { name: "deletionProtection", label: "Enable deletion protection", kind: "checkbox", default: false, section: "Deletion protection" },
  { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
];

/** The create form's version field for an engine, e.g. "version_aurora_mysql". */
export function versionField(engine: string): string {
  return `version_${engine.replace(/-/g, "_")}`;
}

function engineVersion(v: FieldValues, engine: string): string | undefined {
  return optionalText(v[versionField(engine)]);
}

function checkTemplate(v: FieldValues, aurora: boolean): void {
  if (v.template !== "freetier") return;
  if (aurora) throw new Error("The Free tier template is for RDS engines only, not Aurora.");
  if (!FREE_TIER_CLASSES.has(text(v.instanceClass))) throw new Error("Free tier: choose db.t3.micro or db.t4g.micro.");
  if (v.deployment === "multi") throw new Error("Free tier: Multi-AZ isn't available. Choose Single-AZ.");
  if (typeof v.allocatedStorage === "number" && v.allocatedStorage > 20) throw new Error("Free tier: allocated storage is at most 20 GiB.");
}

async function createAurora(ctx: Ctx, v: FieldValues, engine: string): Promise<string> {
  const id = text(v.identifier);
  const selfManaged = v.credentials === "self";
  const tags = tagList(v.tags);
  await ctx.clients.rds.send(
    new CreateDBClusterCommand({
      DBClusterIdentifier: id,
      Engine: engine,
      EngineVersion: engineVersion(v, engine),
      MasterUsername: text(v.masterUsername),
      MasterUserPassword: selfManaged ? text(v.masterPassword) : undefined,
      ManageMasterUserPassword: selfManaged ? undefined : true,
      DBSubnetGroupName: optionalText(v.subnetGroup),
      VpcSecurityGroupIds: strings(v.securityGroups).length ? strings(v.securityGroups) : undefined,
      Port: optionalNumber(v.port),
      DatabaseName: optionalText(v.dbName),
      DBClusterParameterGroupName: optionalText(v.clusterParameterGroup),
      BackupRetentionPeriod: Math.max(1, optionalNumber(v.backupRetention) ?? 7),
      CopyTagsToSnapshot: v.copyTags === true,
      StorageEncrypted: v.encrypted === true,
      KmsKeyId: v.encrypted === true ? optionalText(v.kmsKey) : undefined,
      EnableIAMDatabaseAuthentication: v.iamAuth === true,
      DeletionProtection: v.deletionProtection === true,
      Tags: tags.length ? tags : undefined,
    })
  );
  const count = v.deployment === "multi" ? 2 : 1;
  for (let n = 1; n <= count; n++) {
    await ctx.clients.rds.send(
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: `${id}-instance-${n}`,
        DBClusterIdentifier: id,
        Engine: engine,
        DBInstanceClass: text(v.instanceClass),
        PubliclyAccessible: v.publicAccess === "yes",
        DBParameterGroupName: optionalText(v.parameterGroup),
        AutoMinorVersionUpgrade: v.autoMinor === true,
        Tags: tags.length ? tags : undefined,
      })
    );
  }
  return dbKey("cluster", id);
}

async function createInstance(ctx: Ctx, v: FieldValues, engine: string): Promise<string> {
  const id = text(v.identifier);
  const selfManaged = v.credentials === "self";
  const tags = tagList(v.tags);
  const storageType = text(v.storageType) || "gp3";
  const iops = optionalNumber(v.iops);
  if ((storageType === "io1" || storageType === "io2") && iops === undefined) throw new Error("Provisioned IOPS storage needs a Provisioned IOPS value.");
  const maxStorage = optionalNumber(v.maxStorage);
  const allocated = optionalNumber(v.allocatedStorage) ?? 20;
  if (maxStorage !== undefined && maxStorage <= allocated) throw new Error("The maximum storage threshold must be larger than the allocated storage.");
  await ctx.clients.rds.send(
    new CreateDBInstanceCommand({
      DBInstanceIdentifier: id,
      Engine: engine,
      EngineVersion: engineVersion(v, engine),
      DBInstanceClass: text(v.instanceClass),
      MultiAZ: v.deployment === "multi",
      MasterUsername: text(v.masterUsername),
      MasterUserPassword: selfManaged ? text(v.masterPassword) : undefined,
      ManageMasterUserPassword: selfManaged ? undefined : true,
      StorageType: storageType,
      AllocatedStorage: allocated,
      Iops: storageType === "standard" || storageType === "gp2" ? undefined : iops,
      MaxAllocatedStorage: maxStorage,
      DBSubnetGroupName: optionalText(v.subnetGroup),
      PubliclyAccessible: v.publicAccess === "yes",
      VpcSecurityGroupIds: strings(v.securityGroups).length ? strings(v.securityGroups) : undefined,
      Port: optionalNumber(v.port),
      EnableIAMDatabaseAuthentication: v.iamAuth === true,
      DBName: optionalText(v.dbName),
      DBParameterGroupName: optionalText(v.parameterGroup),
      OptionGroupName: optionalText(v.optionGroup),
      BackupRetentionPeriod: optionalNumber(v.backupRetention) ?? 7,
      CopyTagsToSnapshot: v.copyTags === true,
      StorageEncrypted: v.encrypted === true,
      KmsKeyId: v.encrypted === true ? optionalText(v.kmsKey) : undefined,
      AutoMinorVersionUpgrade: v.autoMinor === true,
      DeletionProtection: v.deletionProtection === true,
      Tags: tags.length ? tags : undefined,
    })
  );
  return dbKey("db", id);
}

export async function createDatabase(ctx: Ctx, v: FieldValues): Promise<string> {
  const engine = text(v.engine);
  if (!ENGINES.some((e) => e.value === engine)) throw new Error("Choose an engine type.");
  const aurora = isAurora(engine);
  checkTemplate(v, aurora);
  return aurora ? createAurora(ctx, v, engine) : createInstance(ctx, v, engine);
}
