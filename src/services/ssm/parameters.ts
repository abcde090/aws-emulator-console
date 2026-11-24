/** Systems Manager Parameter Store: String, StringList and SecureString parameters with versions and labels. */

import {
  AddTagsToResourceCommand,
  DeleteParameterCommand,
  DescribeParametersCommand,
  GetParameterCommand,
  GetParameterHistoryCommand,
  LabelParameterVersionCommand,
  ListTagsForResourceCommand,
  PutParameterCommand,
  RemoveTagsFromResourceCommand,
  type ParameterMetadata,
  type ParameterType,
} from "@aws-sdk/client-ssm";
import { ListAliasesCommand, ListKeysCommand, type AliasListEntry, type KeyListEntry } from "@aws-sdk/client-kms";
import type { Ctx, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { secondary } from "../../console/secondary.ts";
import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { maskValue } from "./helpers.ts";

const PARAM_NAME = "/?[A-Za-z0-9_.\\-/]{1,2047}";

async function kmsOptions(ctx: Ctx): Promise<Option[]> {
  const kms = ctx.clients.kms;
  const keys: KeyListEntry[] = [];
  const aliases: AliasListEntry[] = [];
  let marker: string | undefined;
  do {
    const r = await kms.send(new ListKeysCommand({ Marker: marker }));
    keys.push(...(r.Keys ?? []));
    marker = r.Truncated ? r.NextMarker : undefined;
  } while (marker);
  do {
    const r = await kms.send(new ListAliasesCommand({ Marker: marker }));
    aliases.push(...(r.Aliases ?? []));
    marker = r.Truncated ? r.NextMarker : undefined;
  } while (marker);
  const custom = keys
    .filter((k) => k.KeyId)
    .map((k) => {
      const alias = aliases.find((a) => a.TargetKeyId === k.KeyId)?.AliasName;
      return { value: k.KeyArn ?? (k.KeyId as string), label: alias ? `${alias} (${k.KeyId})` : (k.KeyId as string) };
    });
  return [{ value: "alias/aws/ssm", label: "My current account: alias/aws/ssm (AWS managed key)" }, ...custom];
}

function paramRow(p: ParameterMetadata): Row {
  return {
    name: p.Name ?? "",
    tier: p.Tier ?? "Standard",
    type: p.Type ?? null,
    dataType: p.DataType ?? "text",
    description: p.Description ?? null,
    version: p.Version ?? null,
    lastModified: p.LastModifiedDate ?? null,
    lastModifiedUser: p.LastModifiedUser ?? null,
    keyId: p.KeyId ?? null,
    arn: p.ARN ?? null,
  };
}

async function currentTags(ctx: Ctx, name: string): Promise<Tag[]> {
  const r = await ctx.clients.ssm.send(new ListTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: name }));
  return (r.TagList ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

async function describe(ctx: Ctx, name: string): Promise<ParameterMetadata> {
  const r = await ctx.clients.ssm.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Name", Option: "Equals", Values: [name] }] }));
  const p = (r.Parameters ?? []).find((x) => x.Name === name);
  if (!p) throw new Error(`ParameterNotFound: parameter ${name} does not exist.`);
  return p;
}

const isSecure = { field: "type", equals: "SecureString" };

export const parameters: ResourceDef = {
  id: "parameters",
  name: "Parameter Store",
  singular: "parameter",
  idField: "name",
  nameField: "name",
  description: "Secure, hierarchical storage for configuration data and secrets.",
  emptyText: "You don't have any parameters. Create a parameter to store configuration values.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "tier", label: "Tier", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "dataType", label: "Data type", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "version", label: "Version", kind: "count" },
    { key: "lastModified", label: "Last modified", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ssm.send(new DescribeParametersCommand({ NextToken: token, MaxResults: 50 }));
      rows.push(...(r.Parameters ?? []).map(paramRow));
      token = r.NextToken;
    } while (token && rows.length < 5000);
    return rows;
  },

  async get(ctx, name) {
    const [meta, value, historyR, tagsR] = await Promise.all([
      describe(ctx, name),
      ctx.clients.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true })),
      secondary(ctx.clients.ssm.send(new GetParameterHistoryCommand({ Name: name, WithDecryption: false, MaxResults: 50 })).then((r) => r.Parameters ?? [])),
      secondary(currentTags(ctx, name)),
    ]);
    const history = historyR.ok ? historyR.value : [];
    const tags = tagsR.ok ? tagsR.value : [];
    const row = paramRow(meta);
    const p = value.Parameter;
    return {
      summary: { Name: name, Type: row.type, Tier: row.tier, Version: row.version, "Data type": row.dataType, Description: row.description, "KMS key ID": row.keyId, "Last modified": row.lastModified, "Last modified user": row.lastModifiedUser, ARN: row.arn },
      tabs: [
        {
          id: "overview",
          label: "Overview",
          kind: "keyvalue",
          description: p?.Type === "SecureString" ? "SecureString value shown decrypted (GetParameter WithDecryption)." : undefined,
          data: { Value: maskValue(p?.Type, p?.Value, true), Selector: p?.Selector ?? null, "Source result": p?.SourceResult ?? null },
        },
        {
          id: "history",
          label: "History",
          kind: "table",
          description: historyR.ok ? undefined : `Unavailable: ${historyR.error}`,
          data: history
            .map((h) => ({ version: h.Version ?? null, value: maskValue(h.Type, h.Value, false), labels: (h.Labels ?? []).join(", "), modified: h.LastModifiedDate ?? null, user: h.LastModifiedUser ?? null, description: h.Description ?? null }))
            .reverse(),
          columns: [
            { key: "version", label: "Version", kind: "count" },
            { key: "value", label: "Value", kind: "code" },
            { key: "labels", label: "Labels", kind: "text" },
            { key: "modified", label: "Last modified date", kind: "date" },
            { key: "user", label: "Last modified user", kind: "arn" },
            { key: "description", label: "Description", kind: "text" },
          ],
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          description: tagsR.ok ? undefined : `Unavailable: ${tagsR.error}`,
          data: tags.map((t) => ({ key: t.Key, value: t.Value })),
          columns: [
            { key: "key", label: "Key", kind: "text" },
            { key: "value", label: "Value", kind: "text" },
          ],
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create parameter",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Parameter details", placeholder: "/myapp/prod/db-url", help: "Use slashes to build a hierarchy, e.g. /dev/db/password.", validate: { pattern: PARAM_NAME, message: "Letters, numbers and . - _ /, up to 2,048 characters." } },
      { name: "description", label: "Description", kind: "text", section: "Parameter details", validate: { max: 1024, message: "Up to 1,024 characters." } },
      {
        name: "tier",
        label: "Tier",
        kind: "radio",
        section: "Parameter details",
        default: "Standard",
        options: [
          { value: "Standard", label: "Standard - up to 10,000 parameters, values up to 4 KB, no parameter policies, free" },
          { value: "Advanced", label: "Advanced - more than 10,000 parameters, values up to 8 KB, parameter policies, charges apply" },
        ],
      },
      {
        name: "type",
        label: "Type",
        kind: "radio",
        section: "Parameter details",
        default: "String",
        options: [
          { value: "String", label: "String - any string value" },
          { value: "StringList", label: "StringList - separate strings using commas" },
          { value: "SecureString", label: "SecureString - encrypt sensitive data using KMS keys" },
        ],
      },
      { name: "keyId", label: "KMS key source", kind: "select", section: "Parameter details", showIf: isSecure, default: "alias/aws/ssm", required: true, options: kmsOptions },
      {
        name: "dataType",
        label: "Data type",
        kind: "select",
        section: "Parameter details",
        default: "text",
        options: [
          { value: "text", label: "text" },
          { value: "aws:ec2:image", label: "aws:ec2:image" },
        ],
      },
      { name: "value", label: "Value", kind: "textarea", required: true, section: "Parameter details", validate: { max: 8192, message: "Up to 8 KB (4 KB for Standard)." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const type = String(v.type) as ParameterType;
      await ctx.clients.ssm.send(
        new PutParameterCommand({
          Name: name,
          Value: String(v.value),
          Type: type,
          Tier: String(v.tier) as "Standard",
          Description: typeof v.description === "string" && v.description !== "" ? v.description : undefined,
          KeyId: type === "SecureString" && typeof v.keyId === "string" && v.keyId !== "" ? v.keyId : undefined,
          DataType: String(v.dataType ?? "text"),
          Tags: Array.isArray(v.tags) && v.tags.length ? (v.tags as { Key: string; Value: string }[]) : undefined,
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit value",
      fields: [
        { name: "value", label: "Value", kind: "textarea", required: true, help: "Saving a changed value creates a new version of the parameter." },
        { name: "description", label: "Description", kind: "text", validate: { max: 1024, message: "Up to 1,024 characters." } },
      ],
      async initialValues(ctx, name) {
        const [meta, value] = await Promise.all([describe(ctx, name), ctx.clients.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))]);
        return { value: value.Parameter?.Value ?? "", description: meta.Description ?? "" };
      },
      async run(ctx, name, v) {
        const [meta, current] = await Promise.all([describe(ctx, name), ctx.clients.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))]);
        const value = String(v.value);
        const description = typeof v.description === "string" ? v.description : "";
        if (value === (current.Parameter?.Value ?? "") && description === (meta.Description ?? "")) return { message: "No changes: the parameter is unchanged." };
        const r = await ctx.clients.ssm.send(
          new PutParameterCommand({
            Name: name,
            Value: value,
            Overwrite: true,
            Type: meta.Type,
            Tier: meta.Tier,
            DataType: meta.DataType,
            AllowedPattern: meta.AllowedPattern,
            KeyId: meta.Type === "SecureString" ? meta.KeyId : undefined,
            Description: description,
          })
        );
        return { message: `Parameter ${name} updated to version ${r.Version ?? "?"}.` };
      },
    },
    {
      id: "label",
      label: "Attach labels",
      fields: [
        { name: "version", label: "Version", kind: "number", required: true, validate: { min: 1, max: 100000, message: "A version number." } },
        { name: "labels", label: "Labels", kind: "text", required: true, help: "Comma-separated, e.g. prod, stable. A label moves from any other version.", placeholder: "prod" },
      ],
      async run(ctx, name, v) {
        const labels = String(v.labels).split(",").map((l) => l.trim()).filter(Boolean);
        const r = await ctx.clients.ssm.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: Number(v.version), Labels: labels }));
        const invalid = r.InvalidLabels ?? [];
        if (invalid.length) throw new Error(`Invalid labels: ${invalid.join(", ")}`);
        return { message: `Labels ${labels.join(", ")} attached to version ${String(v.version)}.` };
      },
    },
    {
      id: "manage-tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags" }],
      async initialValues(ctx, name) {
        return { tags: await currentTags(ctx, name) };
      },
      async run(ctx, name, v) {
        const d = tagDiff(await currentTags(ctx, name), fieldTags(v.tags));
        if (d.remove.length) await ctx.clients.ssm.send(new RemoveTagsFromResourceCommand({ ResourceType: "Parameter", ResourceId: name, TagKeys: d.remove }));
        if (d.set.length) await ctx.clients.ssm.send(new AddTagsToResourceCommand({ ResourceType: "Parameter", ResourceId: name, Tags: d.set }));
        return { message: tagDiffMessage(d) };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.ssm.send(new DeleteParameterCommand({ Name: name }));
    },
  },
};
