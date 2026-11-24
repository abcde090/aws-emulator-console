/**
 * AWS Secrets Manager: secrets (key/value or plaintext, KMS key, rotation), detail with
 * versions, rotation, replication, tags and resource permissions; delete with a recovery
 * window and restore. "Retrieve secret value" and the resource policy editor are on the
 * hand-built secret page (src/app/secretsmanager/secrets/[name]).
 */

import {
  CancelRotateSecretCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  ListSecretsCommand,
  ListSecretVersionIdsCommand,
  PutResourcePolicyCommand,
  RemoveRegionsFromReplicationCommand,
  ReplicateSecretToRegionsCommand,
  RestoreSecretCommand,
  RotateSecretCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateSecretCommand,
  type SecretListEntry,
} from "@aws-sdk/client-secrets-manager";
import { ListFunctionsCommand } from "@aws-sdk/client-lambda";
import type { ActionDef, Ctx, FieldValues, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { requirePolicy } from "../iam/policy-json.ts";
import { keyOptions } from "../kms/def.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { databaseSecretString, DB_ENGINES, SECRET_TYPES, secretStringFrom, type SecretType } from "./secret-value.ts";

const DB_TYPES: SecretType[] = ["rds", "docdb", "redshift", "otherdb"];
const SECRET_NAME = "[A-Za-z0-9/_+=.@-]{1,512}";
const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

async function allSecrets(ctx: Ctx): Promise<SecretListEntry[]> {
  const out: SecretListEntry[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.secretsmanager.send(new ListSecretsCommand({ NextToken: token, MaxResults: 100, IncludePlannedDeletion: true }));
    out.push(...(r.SecretList ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

const describeSecret = (ctx: Ctx, name: string) => ctx.clients.secretsmanager.send(new DescribeSecretCommand({ SecretId: name }));

const AWS_MANAGED = "aws/secretsmanager";

/** The encryption-key choice for a secret's KmsKeyId (a key ARN becomes its key ID, as in the picker). */
function kmsChoice(kmsKeyId: string | undefined): string {
  if (!kmsKeyId || kmsKeyId === "alias/aws/secretsmanager" || kmsKeyId.endsWith(":alias/aws/secretsmanager")) return AWS_MANAGED;
  const m = /:key\/(.+)$/.exec(kmsKeyId);
  return m ? m[1] : kmsKeyId;
}

const isActive = (row: Row): boolean => {
  const st = row.status ?? row.Status;
  return typeof st !== "string" || st === "Active";
};
const rotationOn = (row: Row): boolean => {
  const r = row.rotation ?? row.Rotation;
  return typeof r !== "string" || r === "Enabled";
};

async function encryptionKeyOptions(ctx: Ctx): Promise<Option[]> {
  return [{ value: "aws/secretsmanager", label: "aws/secretsmanager (AWS managed key)" }, ...(await keyOptions(ctx))];
}

function secretTags(d: { Tags?: { Key?: string; Value?: string }[] }): { Key: string; Value: string }[] {
  return (d.Tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

async function replicaOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  const d = await describeSecret(ctx, name);
  return (d.ReplicationStatus ?? []).filter((r) => r.Region).map((r) => ({ value: r.Region as string, label: `${r.Region} (${r.Status ?? "-"})` }));
}

async function lambdaOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.lambda.send(new ListFunctionsCommand({ Marker: marker }));
    out.push(...(r.Functions ?? []).filter((f) => f.FunctionArn).map((f) => ({ value: f.FunctionArn as string, label: f.FunctionName ?? (f.FunctionArn as string) })));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

function rotationRules(v: FieldValues): { AutomaticallyAfterDays?: number; ScheduleExpression?: string } {
  if (s(v.scheduleExpression)) return { ScheduleExpression: s(v.scheduleExpression) };
  return { AutomaticallyAfterDays: typeof v.rotationDays === "number" ? v.rotationDays : 30 };
}

const ROTATION_FIELDS = [
  { name: "rotationLambda", label: "Rotation function", kind: "select" as const, required: true, options: lambdaOptions, help: "A Lambda function whose resource policy lets Secrets Manager invoke it." },
  { name: "rotationDays", label: "Rotation schedule: every N days", kind: "number" as const, default: 30, validate: { min: 1, max: 1000, message: "Between 1 and 1000 days." } },
  { name: "scheduleExpression", label: "Schedule expression", kind: "text" as const, placeholder: "rate(10 days) or cron(0 16 1,15 * ? *)", help: "Overrides the number of days." },
  { name: "rotateImmediately", label: "Rotate immediately when the secret is stored", kind: "checkbox" as const, default: true },
];

export const secrets: ResourceDef = {
  id: "secrets",
  name: "Secrets",
  singular: "secret",
  idField: "name",
  nameField: "Secret name",
  detailHref: "secrets/{id}",
  description: "Store, rotate and retrieve database credentials, API keys and other secrets. Secrets scheduled for deletion are listed so you can restore them.",
  emptyText: "No secrets. Store a new secret to get started.",
  columns: [
    { key: "name", label: "Secret name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "lastRetrieved", label: "Last retrieved (UTC)", kind: "date" },
    { key: "status", label: "Status", kind: "status" },
    { key: "rotation", label: "Rotation", kind: "text" },
    { key: "created", label: "Created", kind: "date", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await allSecrets(ctx)).map((x) => ({
      name: x.Name ?? "",
      description: x.Description ?? "",
      lastRetrieved: x.LastAccessedDate ?? null,
      status: x.DeletedDate ? "Scheduled for deletion" : "Active",
      rotation: x.RotationEnabled ? "Enabled" : "Disabled",
      created: x.CreatedDate ?? null,
      arn: x.ARN ?? null,
    }));
  },

  async get(ctx, name) {
    const sm = ctx.clients.secretsmanager;
    const [d, versions] = await Promise.all([
      sm.send(new DescribeSecretCommand({ SecretId: name })),
      secondary(sm.send(new ListSecretVersionIdsCommand({ SecretId: name, IncludeDeprecated: true }))),
    ]);
    return {
      summary: {
        "Secret name": d.Name ?? name,
        "Secret ARN": d.ARN ?? null,
        "Secret description": d.Description ?? null,
        "Encryption key": d.KmsKeyId ?? "aws/secretsmanager",
        Status: d.DeletedDate ? "Scheduled for deletion" : "Active",
        "Deletion date": d.DeletedDate ?? null,
        Rotation: d.RotationEnabled ? "Enabled" : "Disabled",
        "Last retrieved": d.LastAccessedDate ?? null,
        "Last changed": d.LastChangedDate ?? null,
        Created: d.CreatedDate ?? null,
        "Owning service": d.OwningService ?? null,
      },
      tabs: [
        {
          id: "rotation",
          label: "Rotation",
          kind: "keyvalue",
          data: {
            "Rotation status": d.RotationEnabled ? "Enabled" : "Disabled",
            "Rotation schedule": d.RotationRules?.ScheduleExpression ?? (d.RotationRules?.AutomaticallyAfterDays ? `Every ${d.RotationRules.AutomaticallyAfterDays} days` : null),
            "Rotation window": d.RotationRules?.Duration ?? null,
            "Lambda rotation function": d.RotationLambdaARN ?? null,
            "Last rotated date": d.LastRotatedDate ?? null,
            "Next rotation date": d.NextRotationDate ?? null,
          },
        },
        {
          id: "versions",
          label: "Versions",
          kind: "table",
          columns: [
            { key: "id", label: "Version ID", kind: "code" },
            { key: "stages", label: "Staging labels", kind: "text" },
            { key: "created", label: "Created on", kind: "date" },
            { key: "lastAccessed", label: "Last accessed", kind: "date" },
          ],
          description: unavailableText(versions),
          data: (versions.ok ? versions.value.Versions ?? [] : []).map((v) => ({ id: v.VersionId ?? "", stages: (v.VersionStages ?? []).join(", ") || "(deprecated)", created: v.CreatedDate ?? null, lastAccessed: v.LastAccessedDate ?? null })),
          emptyText: "No versions.",
        },
        {
          id: "replication",
          label: "Replication",
          kind: "table",
          columns: [
            { key: "region", label: "Region", kind: "text" },
            { key: "status", label: "Replication status", kind: "status" },
            { key: "kms", label: "Encryption key", kind: "text" },
            { key: "message", label: "Status message", kind: "text" },
          ],
          data: (d.ReplicationStatus ?? []).map((r) => ({ region: r.Region ?? "", status: r.Status ?? null, kms: r.KmsKeyId ?? null, message: r.StatusMessage ?? null })),
          emptyText: "This secret isn't replicated to other Regions.",
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: (d.Tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" })),
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Store a new secret",
    description: "Creates the secret with CreateSecret, then configures rotation with RotateSecret if you turn it on.",
    fields: [
      { name: "secretType", label: "Secret type", kind: "radio", default: "rds", section: "Choose secret type", options: SECRET_TYPES },
      { name: "dbUsername", label: "User name", kind: "text", required: true, section: "Choose secret type", showIf: { field: "secretType", equals: DB_TYPES } },
      { name: "dbPassword", label: "Password", kind: "password", required: true, section: "Choose secret type", showIf: { field: "secretType", equals: DB_TYPES } },
      { name: "dbEngine", label: "Database engine", kind: "select", required: true, section: "Choose secret type", options: DB_ENGINES.map((e) => ({ value: e, label: e })), showIf: { field: "secretType", equals: ["rds", "otherdb"] } },
      { name: "dbHost", label: "Server address", kind: "text", required: true, section: "Choose secret type", placeholder: "mydb.abc123.us-east-1.rds.amazonaws.com", showIf: { field: "secretType", equals: DB_TYPES }, help: "The database endpoint (for RDS, the DB instance or cluster endpoint)." },
      { name: "dbPort", label: "Port", kind: "number", section: "Choose secret type", showIf: { field: "secretType", equals: DB_TYPES }, help: "Defaults to the engine's standard port.", validate: { min: 1, max: 65535, message: "Between 1 and 65535." } },
      { name: "dbName", label: "Database name", kind: "text", section: "Choose secret type", showIf: { field: "secretType", equals: DB_TYPES } },
      {
        name: "valueType", label: "Secret value", kind: "radio", default: "kv", section: "Choose secret type",
        showIf: { field: "secretType", equals: "other" },
        options: [
          { value: "kv", label: "Key/value pairs" },
          { value: "plaintext", label: "Plaintext" },
        ],
      },
      { name: "pairs", label: "Key/value pairs", kind: "tags", section: "Choose secret type", showIf: { field: "valueType", equals: "kv" }, help: "Stored as a JSON object, e.g. {\"username\":\"admin\"}." },
      { name: "plaintext", label: "Plaintext", kind: "textarea", required: true, section: "Choose secret type", showIf: { field: "valueType", equals: "plaintext" }, validate: { max: 65536, message: "At most 64 KB." } },
      { name: "kmsKeyId", label: "Encryption key", kind: "select", required: true, default: "aws/secretsmanager", options: encryptionKeyOptions, section: "Choose secret type", help: "Secrets Manager encrypts the secret value with this KMS key." },
      { name: "name", label: "Secret name", kind: "text", required: true, section: "Configure secret", placeholder: "prod/AppBeta/MySql", help: "Letters, numbers and /_+=.@- ; a path such as prod/app/db helps you organize secrets.", validate: { pattern: SECRET_NAME, message: "Use up to 512 letters, numbers and /_+=.@- characters." } },
      { name: "description", label: "Description", kind: "textarea", section: "Configure secret", validate: { max: 2048, message: "At most 2048 characters." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Configure secret" },
      { name: "resourcePolicy", label: "Resource permissions", kind: "json", section: "Configure secret", help: "Optional resource policy that grants other principals or accounts access to this secret." },
      { name: "rotation", label: "Automatic rotation", kind: "checkbox", default: false, section: "Configure rotation - optional" },
      ...ROTATION_FIELDS.map((f) => ({ ...f, section: "Configure rotation - optional", showIf: { field: "rotation", equals: true } })),
    ],
    async run(ctx, v) {
      const sm = ctx.clients.secretsmanager;
      const name = s(v.name);
      const type = (SECRET_TYPES.find((x) => x.value === v.secretType)?.value ?? "other") as SecretType;
      const secretString =
        type === "other"
          ? secretStringFrom(v.valueType === "plaintext" ? "plaintext" : "kv", v.pairs, v.plaintext)
          : databaseSecretString(type, { username: v.dbUsername, password: v.dbPassword, engine: v.dbEngine, host: v.dbHost, port: v.dbPort, dbname: v.dbName });
      const tags = Array.isArray(v.tags) ? (v.tags as { Key: string; Value: string }[]) : [];
      const kms = s(v.kmsKeyId);
      await sm.send(
        new CreateSecretCommand({
          Name: name,
          Description: s(v.description) || undefined,
          SecretString: secretString,
          KmsKeyId: kms && kms !== "aws/secretsmanager" ? kms : undefined,
          Tags: tags.length ? tags : undefined,
        })
      );
      if (s(v.resourcePolicy)) {
        await sm.send(new PutResourcePolicyCommand({ SecretId: name, ResourcePolicy: requirePolicy(v.resourcePolicy, "resource"), BlockPublicPolicy: true }));
      }
      if (v.rotation === true) {
        await sm.send(new RotateSecretCommand({ SecretId: name, RotationLambdaARN: s(v.rotationLambda), RotationRules: rotationRules(v), RotateImmediately: v.rotateImmediately === true }));
      }
      return name;
    },
  },

  actions: [
    {
      id: "edit-description",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "textarea", validate: { max: 2048, message: "At most 2048 characters." } }],
      availableFor: isActive,
      async initialValues(ctx, name) {
        return { description: (await describeSecret(ctx, name)).Description ?? "" };
      },
      async run(ctx, name, v) {
        const next = typeof v.description === "string" ? v.description : "";
        if (next === ((await describeSecret(ctx, name)).Description ?? "")) return { message: "No changes to the description." };
        await ctx.clients.secretsmanager.send(new UpdateSecretCommand({ SecretId: name, Description: next }));
        return { message: "Description updated." };
      },
    },
    {
      id: "edit-encryption-key",
      label: "Edit encryption key",
      fields: [{ name: "kmsKeyId", label: "Encryption key", kind: "select", required: true, options: encryptionKeyOptions, help: "New versions are encrypted with this key." }],
      availableFor: isActive,
      async initialValues(ctx, name) {
        return { kmsKeyId: kmsChoice((await describeSecret(ctx, name)).KmsKeyId) };
      },
      async run(ctx, name, v) {
        const choice = s(v.kmsKeyId) || AWS_MANAGED;
        if (choice === kmsChoice((await describeSecret(ctx, name)).KmsKeyId)) return { message: "No changes to the encryption key." };
        await ctx.clients.secretsmanager.send(new UpdateSecretCommand({ SecretId: name, KmsKeyId: choice === AWS_MANAGED ? "alias/aws/secretsmanager" : choice }));
        return { message: "Encryption key updated." };
      },
    },
    {
      id: "edit-rotation",
      label: "Edit rotation",
      fields: ROTATION_FIELDS,
      availableFor: isActive,
      async initialValues(ctx, name) {
        const d = await describeSecret(ctx, name);
        const values: FieldValues = { rotateImmediately: false };
        if (d.RotationLambdaARN) values.rotationLambda = d.RotationLambdaARN;
        if (d.RotationRules?.AutomaticallyAfterDays) values.rotationDays = d.RotationRules.AutomaticallyAfterDays;
        if (d.RotationRules?.ScheduleExpression) values.scheduleExpression = d.RotationRules.ScheduleExpression;
        return values;
      },
      async run(ctx, name, v) {
        await ctx.clients.secretsmanager.send(new RotateSecretCommand({ SecretId: name, RotationLambdaARN: s(v.rotationLambda), RotationRules: rotationRules(v), RotateImmediately: v.rotateImmediately === true }));
        return { message: "Rotation configured." };
      },
    },
    {
      id: "rotate-now",
      label: "Rotate secret immediately",
      confirm: "Invokes the rotation function now (RotateSecret). Rotation must already be configured.",
      availableFor: (row) => isActive(row) && rotationOn(row),
      async run(ctx, name) {
        const r = await ctx.clients.secretsmanager.send(new RotateSecretCommand({ SecretId: name, RotateImmediately: true }));
        return { message: `Rotation started. New version: ${r.VersionId ?? "-"}.` };
      },
    },
    {
      id: "disable-rotation",
      label: "Disable automatic rotation",
      danger: true,
      availableFor: (row) => isActive(row) && rotationOn(row),
      async run(ctx, name) {
        await ctx.clients.secretsmanager.send(new CancelRotateSecretCommand({ SecretId: name }));
        return { message: "Automatic rotation turned off." };
      },
    },
    {
      id: "replicate",
      label: "Replicate secret to other Regions",
      availableFor: isActive,
      fields: [
        { name: "region", label: "AWS Region", kind: "select", required: true, options: ["us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-2", "ap-northeast-1"].map((r) => ({ value: r, label: r })) },
        { name: "kms", label: "Encryption key in that Region", kind: "text", placeholder: "alias/aws/secretsmanager", help: "Leave empty for the AWS managed key." },
      ],
      async run(ctx, name, v) {
        const r = await ctx.clients.secretsmanager.send(new ReplicateSecretToRegionsCommand({ SecretId: name, AddReplicaRegions: [{ Region: s(v.region), KmsKeyId: s(v.kms) || undefined }] }));
        return { message: "Replication started.", json: r.ReplicationStatus };
      },
    },
    {
      id: "remove-replica",
      label: "Remove replica",
      danger: true,
      availableFor: isActive,
      fields: [{ name: "region", label: "Replica Region", kind: "select", required: true, options: replicaOptions }],
      async run(ctx, name, v) {
        const region = s(v.region);
        if (!region) throw new Error("This secret has no replicas.");
        await ctx.clients.secretsmanager.send(new RemoveRegionsFromReplicationCommand({ SecretId: name, RemoveReplicaRegions: [region] }));
        return { message: `Removed the replica in ${region}.` };
      },
    },
    {
      id: "edit-tags",
      label: "Edit tags",
      availableFor: isActive,
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Tags you remove here are removed from the secret (UntagResource); new or changed ones are set with TagResource." }],
      async initialValues(ctx, name) {
        return { tags: secretTags(await describeSecret(ctx, name)) };
      },
      async run(ctx, name, v) {
        const diff = tagDiff(secretTags(await describeSecret(ctx, name)), fieldTags(v.tags));
        if (diff.remove.length) await ctx.clients.secretsmanager.send(new UntagResourceCommand({ SecretId: name, TagKeys: diff.remove }));
        if (diff.set.length) await ctx.clients.secretsmanager.send(new TagResourceCommand({ SecretId: name, Tags: diff.set }));
        return { message: tagDiffMessage(diff) };
      },
    },
    {
      id: "delete-secret",
      label: "Delete secret",
      danger: true,
      availableFor: isActive,
      confirm: "The secret is scheduled for deletion after the waiting period. Until then you can't read it, but you can cancel the deletion.",
      fields: [{ name: "days", label: "Waiting period (days)", kind: "number", required: true, default: 30, validate: { min: 7, max: 30, message: "Between 7 and 30 days." } }],
      async run(ctx, name, v) {
        const r = await ctx.clients.secretsmanager.send(new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: typeof v.days === "number" ? v.days : 30 }));
        return { message: `Secret ${name} is scheduled for deletion on ${r.DeletionDate?.toISOString() ?? "-"}.` };
      },
    },
    {
      id: "cancel-deletion",
      label: "Cancel deletion",
      availableFor: (row) => !isActive(row),
      async run(ctx, name) {
        await ctx.clients.secretsmanager.send(new RestoreSecretCommand({ SecretId: name }));
        return { message: `Deletion of ${name} cancelled. The secret is available again.` };
      },
    },
  ] satisfies ActionDef[],
};

export const secretsmanagerService: ServiceDef = {
  id: "secretsmanager",
  name: "Secrets Manager",
  category: "Security, Identity, & Compliance",
  description: "Easily rotate, manage and retrieve secrets throughout their lifecycle.",
  resources: [secrets],
};
