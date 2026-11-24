/** IAM identity providers (OpenID Connect and SAML 2.0). */

import {
  AddClientIDToOpenIDConnectProviderCommand,
  CreateOpenIDConnectProviderCommand,
  CreateSAMLProviderCommand,
  DeleteOpenIDConnectProviderCommand,
  DeleteSAMLProviderCommand,
  GetOpenIDConnectProviderCommand,
  GetSAMLProviderCommand,
  ListOpenIDConnectProvidersCommand,
  ListSAMLProvidersCommand,
  RemoveClientIDFromOpenIDConnectProviderCommand,
  UpdateOpenIDConnectProviderThumbprintCommand,
  UpdateSAMLProviderCommand,
} from "@aws-sdk/client-iam";
import type { Ctx, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { fieldTags } from "../../console/tags.ts";
import { TAG_COLUMNS, tagRows, text } from "./common.ts";

const isOidc = (arn: string) => arn.includes(":oidc-provider/");
/** Provider type from a list row ("type") or the detail summary ("Provider type"). */
const rowType = (row: Row) => String(row.type ?? row["Provider type"] ?? "");
const oidcRow = (row: Row) => rowType(row) !== "SAML";
const samlRow = (row: Row) => rowType(row) !== "OpenID Connect";

async function oidcDetails(ctx: Ctx, arn: string) {
  return ctx.clients.iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: arn }));
}

async function audienceOptions(ctx: Ctx, arn?: string): Promise<Option[]> {
  if (!arn || !isOidc(arn)) return [];
  return ((await oidcDetails(ctx, arn)).ClientIDList ?? []).map((a) => ({ value: a, label: a }));
}
const lines = (v: unknown) => (typeof v === "string" ? v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : []);

export const providers: ResourceDef = {
  id: "identity-providers",
  name: "Identity providers",
  singular: "identity provider",
  idField: "arn",
  nameField: "Provider",
  description: "Use an identity provider (IdP) to manage your user identities outside of AWS and give these external identities permissions to use AWS resources in your account.",
  emptyText: "No identity providers. Add an OpenID Connect or SAML provider to federate users.",
  columns: [
    { key: "provider", label: "Provider", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const iam = ctx.clients.iam;
    const [oidc, saml] = await Promise.all([iam.send(new ListOpenIDConnectProvidersCommand({})), iam.send(new ListSAMLProvidersCommand({}))]);
    const oidcRows = await Promise.all(
      (oidc.OpenIDConnectProviderList ?? []).filter((p) => p.Arn).map(async (p) => {
        const d = await iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: p.Arn }));
        return { provider: d.Url ?? (p.Arn as string).replace(/^.*:oidc-provider\//, ""), type: "OpenID Connect", created: d.CreateDate ?? null, arn: p.Arn as string };
      })
    );
    const samlRows = (saml.SAMLProviderList ?? []).filter((p) => p.Arn).map((p) => ({ provider: (p.Arn as string).replace(/^.*:saml-provider\//, ""), type: "SAML", created: p.CreateDate ?? null, arn: p.Arn as string }));
    return [...oidcRows, ...samlRows];
  },

  async get(ctx, arn) {
    if (isOidc(arn)) {
      const d = await ctx.clients.iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: arn }));
      return {
        summary: { Provider: d.Url ?? arn, "Provider type": "OpenID Connect", ARN: arn, "Creation time": d.CreateDate ?? null },
        tabs: [
          { id: "audiences", label: "Audiences", kind: "table", columns: [{ key: "aud", label: "Audience", kind: "code" }], data: (d.ClientIDList ?? []).map((aud) => ({ aud })), emptyText: "No audiences." },
          { id: "thumbprints", label: "Thumbprints", kind: "table", columns: [{ key: "t", label: "Thumbprint", kind: "code" }], data: (d.ThumbprintList ?? []).map((t) => ({ t })), emptyText: "No thumbprints. IAM uses its library of trusted root certificate authorities." },
          { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(d.Tags), emptyText: "No tags associated with the resource." },
        ],
      };
    }
    const d = await ctx.clients.iam.send(new GetSAMLProviderCommand({ SAMLProviderArn: arn }));
    return {
      summary: { Provider: arn.replace(/^.*:saml-provider\//, ""), "Provider type": "SAML", ARN: arn, "Creation time": d.CreateDate ?? null, "Valid until": d.ValidUntil ?? null },
      tabs: [
        { id: "metadata", label: "Metadata document", kind: "text", data: d.SAMLMetadataDocument ?? "", emptyText: "No metadata document." },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(d.Tags), emptyText: "No tags associated with the resource." },
      ],
    };
  },

  create: {
    title: "Add provider",
    fields: [
      {
        name: "type", label: "Provider type", kind: "radio", default: "oidc", section: "Configure provider",
        options: [
          { value: "saml", label: "SAML: establish trust between your AWS account and a SAML 2.0 compatible identity provider such as Shibboleth or Active Directory Federation Services" },
          { value: "oidc", label: "OpenID Connect: establish trust between your AWS account and an identity provider such as Google or Salesforce" },
        ],
      },
      { name: "url", label: "Provider URL", kind: "text", required: true, section: "Configure provider", placeholder: "https://example.com", showIf: { field: "type", equals: "oidc" }, help: "Specify the secure OpenID Connect URL for authentication requests.", validate: { pattern: "https://[^\\s]+", message: "Must begin with https://" } },
      { name: "audience", label: "Audience", kind: "text", required: true, section: "Configure provider", showIf: { field: "type", equals: "oidc" }, help: "Specify the client ID issued by the identity provider for your app." },
      { name: "thumbprints", label: "Thumbprints", kind: "textarea", section: "Configure provider", showIf: { field: "type", equals: "oidc" }, help: "Optional. One 40-character hex thumbprint per line." },
      { name: "name", label: "Provider name", kind: "text", required: true, section: "Configure provider", showIf: { field: "type", equals: "saml" }, validate: { pattern: "[\\w._-]{1,128}", message: "Up to 128 letters, numbers, periods, underscores and hyphens." } },
      { name: "metadata", label: "Metadata document", kind: "textarea", required: true, section: "Configure provider", showIf: { field: "type", equals: "saml" }, help: "Paste the SAML metadata XML from your IdP (at least 1,000 characters).", validate: { min: 1000, max: 10000000, message: "The metadata document must be at least 1,000 characters." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Add tags - optional" },
    ],
    async run(ctx, v) {
      const tags = fieldTags(v.tags);
      if (v.type === "saml") {
        const r = await ctx.clients.iam.send(new CreateSAMLProviderCommand({ Name: text(v.name), SAMLMetadataDocument: String(v.metadata ?? ""), Tags: tags.length ? tags : undefined }));
        if (!r.SAMLProviderArn) throw new Error("CreateSAMLProvider returned no ARN.");
        return r.SAMLProviderArn;
      }
      const thumbs = lines(v.thumbprints);
      const r = await ctx.clients.iam.send(
        new CreateOpenIDConnectProviderCommand({ Url: text(v.url), ClientIDList: [text(v.audience)], ThumbprintList: thumbs.length ? thumbs : undefined, Tags: tags.length ? tags : undefined })
      );
      if (!r.OpenIDConnectProviderArn) throw new Error("CreateOpenIDConnectProvider returned no ARN.");
      return r.OpenIDConnectProviderArn;
    },
  },

  actions: [
    {
      id: "add-audience",
      label: "Add audience",
      availableFor: oidcRow,
      fields: [{ name: "audience", label: "Audience", kind: "text", required: true, help: "OpenID Connect providers only." }],
      async run(ctx, arn, v) {
        if (!isOidc(arn)) throw new Error("Audiences apply to OpenID Connect providers only.");
        await ctx.clients.iam.send(new AddClientIDToOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: arn, ClientID: text(v.audience) }));
        return { message: `Added audience ${text(v.audience)}.` };
      },
    },
    {
      id: "remove-audience",
      label: "Remove audience",
      danger: true,
      availableFor: oidcRow,
      fields: [{ name: "audience", label: "Audience", kind: "select", required: true, options: audienceOptions }],
      async run(ctx, arn, v) {
        if (!isOidc(arn)) throw new Error("Audiences apply to OpenID Connect providers only.");
        await ctx.clients.iam.send(new RemoveClientIDFromOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: arn, ClientID: text(v.audience) }));
        return { message: `Removed audience ${text(v.audience)}.` };
      },
    },
    {
      id: "thumbprints",
      label: "Manage thumbprints",
      availableFor: oidcRow,
      fields: [{ name: "thumbprints", label: "Thumbprints", kind: "textarea", required: true, help: "One per line. Replaces the current list." }],
      async initialValues(ctx, arn): Promise<FieldValues> {
        return isOidc(arn) ? { thumbprints: ((await oidcDetails(ctx, arn)).ThumbprintList ?? []).join("\n") } : {};
      },
      async run(ctx, arn, v) {
        if (!isOidc(arn)) throw new Error("Thumbprints apply to OpenID Connect providers only.");
        await ctx.clients.iam.send(new UpdateOpenIDConnectProviderThumbprintCommand({ OpenIDConnectProviderArn: arn, ThumbprintList: lines(v.thumbprints) }));
        return { message: "Thumbprints updated." };
      },
    },
    {
      id: "replace-metadata",
      label: "Replace metadata",
      availableFor: samlRow,
      async initialValues(ctx, arn): Promise<FieldValues> {
        if (isOidc(arn)) return {};
        return { metadata: (await ctx.clients.iam.send(new GetSAMLProviderCommand({ SAMLProviderArn: arn }))).SAMLMetadataDocument ?? "" };
      },
      fields: [{ name: "metadata", label: "Metadata document", kind: "textarea", required: true, validate: { min: 1000, max: 10000000, message: "At least 1,000 characters." } }],
      async run(ctx, arn, v) {
        if (isOidc(arn)) throw new Error("Metadata applies to SAML providers only.");
        await ctx.clients.iam.send(new UpdateSAMLProviderCommand({ SAMLProviderArn: arn, SAMLMetadataDocument: String(v.metadata ?? "") }));
        return { message: "Metadata document replaced." };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, arn) {
      if (isOidc(arn)) await ctx.clients.iam.send(new DeleteOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: arn }));
      else await ctx.clients.iam.send(new DeleteSAMLProviderCommand({ SAMLProviderArn: arn }));
    },
  },
};
