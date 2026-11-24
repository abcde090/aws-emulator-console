/** API Gateway custom domain names (with API mappings) and client certificates. */

import { secondary, unavailableText } from "../../console/secondary.ts";
import {
  CreateBasePathMappingCommand,
  CreateDomainNameCommand,
  DeleteBasePathMappingCommand,
  DeleteClientCertificateCommand,
  DeleteDomainNameCommand,
  GenerateClientCertificateCommand,
  GetBasePathMappingsCommand,
  GetClientCertificateCommand,
  GetClientCertificatesCommand,
  GetDomainNameCommand,
  GetDomainNamesCommand,
  UpdateClientCertificateCommand,
  type ClientCertificate,
  type DomainName,
} from "@aws-sdk/client-api-gateway";
import { ListCertificatesCommand } from "@aws-sdk/client-acm";
import type { Ctx, Option, ResourceDef } from "../../console/types.ts";
import { optText, restPages, restStageOptions, splitApiStage, tagRows, tagsRecord, TAG_COLUMNS } from "./common.ts";

const DOMAIN = "(?=.{1,253}$)(\\*\\.)?([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}";

async function allDomains(ctx: Ctx): Promise<DomainName[]> {
  const out: DomainName[] = [];
  let position: string | undefined;
  do {
    const r = await ctx.clients.apigateway.send(new GetDomainNamesCommand({ limit: 500, position }));
    out.push(...(r.items ?? []));
    position = r.position;
  } while (position);
  return out;
}

async function certificateOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.acm.send(new ListCertificatesCommand({ NextToken: token }));
    for (const c of r.CertificateSummaryList ?? []) if (c.CertificateArn) out.push({ value: c.CertificateArn, label: `${c.DomainName ?? ""} (${c.CertificateArn})` });
    token = r.NextToken;
  } while (token);
  return out;
}

/** This domain's API mappings; the root mapping's base path is "(none)". */
async function mappingOptions(ctx: Ctx, domainName?: string): Promise<Option[]> {
  if (!domainName) return [];
  const out: Option[] = [];
  let position: string | undefined;
  do {
    const r = await ctx.clients.apigateway.send(new GetBasePathMappingsCommand({ domainName, limit: 500, position }));
    for (const m of r.items ?? []) {
      const path = m.basePath ?? "(none)";
      out.push({ value: path, label: `/${path === "(none)" ? "" : path} -> ${m.restApiId ?? ""} (${m.stage ?? ""})` });
    }
    position = r.position;
  } while (position);
  return out;
}

const endpointOf = (d: DomainName): string => (d.endpointConfiguration?.types ?? []).join(", ") || (d.regionalDomainName ? "REGIONAL" : d.distributionDomainName ? "EDGE" : "");

export const customDomains: ResourceDef = {
  id: "custom-domains",
  name: "Custom domain names",
  singular: "custom domain name",
  idField: "name",
  nameField: "Domain name",
  description: "Map your own domain name to REST API stages.",
  emptyText: "You don't have any custom domain names.",
  columns: [
    { key: "name", label: "Domain name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "endpointType", label: "Endpoint type", kind: "text" },
    { key: "target", label: "API Gateway domain name", kind: "text" },
    { key: "certificate", label: "ACM certificate ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await allDomains(ctx)).map((d) => ({
      name: d.domainName ?? "",
      status: d.domainNameStatus ?? null,
      endpointType: endpointOf(d),
      target: d.regionalDomainName ?? d.distributionDomainName ?? null,
      certificate: d.regionalCertificateArn ?? d.certificateArn ?? null,
    }));
  },

  async get(ctx, name) {
    const d = await ctx.clients.apigateway.send(new GetDomainNameCommand({ domainName: name }));
    const mapsR = await secondary(restPages((position) => ctx.clients.apigateway.send(new GetBasePathMappingsCommand({ domainName: name, limit: 500, position }))));
    return {
      summary: {
        "Domain name": d.domainName ?? name,
        Status: d.domainNameStatus ?? null,
        "Endpoint type": endpointOf(d),
        "API Gateway domain name": d.regionalDomainName ?? d.distributionDomainName ?? null,
        "Hosted zone ID": d.regionalHostedZoneId ?? d.distributionHostedZoneId ?? null,
        "ACM certificate ARN": d.regionalCertificateArn ?? d.certificateArn ?? null,
      },
      tabs: [
        {
          id: "mappings",
          label: "API mappings",
          kind: "table",
          columns: [
            { key: "path", label: "Path", kind: "text" },
            { key: "api", label: "API ID", kind: "text" },
            { key: "stage", label: "Stage", kind: "text" },
          ],
          data: mapsR.ok ? mapsR.value.map((m) => ({ path: m.basePath ?? "(none)", api: m.restApiId ?? "", stage: m.stage ?? null })) : [],
          emptyText: unavailableText(mapsR, "No API mappings. Use Configure API mappings to route this domain to a stage."),
        },
        { id: "settings", label: "Configuration", kind: "keyvalue", data: { "Security policy": d.securityPolicy ?? null, "Domain name ARN": d.domainNameArn ?? null, "Status message": d.domainNameStatusMessage ?? null } },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(d.tags), emptyText: "No tags." },
      ],
    };
  },

  create: {
    title: "Create domain name",
    description: "Creates a custom domain name with CreateDomainName. Point a DNS record (for example a Route 53 alias) at the API Gateway domain name it returns.",
    fields: [
      { name: "name", label: "Domain name", kind: "text", required: true, section: "Domain details", placeholder: "api.example.com", validate: { pattern: DOMAIN, message: "Enter a domain name such as api.example.com." } },
      {
        name: "endpointType", label: "Endpoint type", kind: "radio", default: "REGIONAL", section: "Endpoint configuration",
        options: [
          { value: "REGIONAL", label: "Regional" },
          { value: "EDGE", label: "Edge-optimized" },
        ],
      },
      { name: "certificate", label: "ACM certificate", kind: "select", required: true, options: certificateOptions, section: "Endpoint configuration", help: "Request or import a certificate in AWS Certificate Manager first." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const cert = String(v.certificate);
      const edge = v.endpointType === "EDGE";
      await ctx.clients.apigateway.send(
        new CreateDomainNameCommand({
          domainName: name,
          endpointConfiguration: { types: [edge ? "EDGE" : "REGIONAL"] },
          regionalCertificateArn: edge ? undefined : cert,
          certificateArn: edge ? cert : undefined,
          tags: tagsRecord(v.tags),
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "add-mapping",
      label: "Configure API mappings",
      fields: [
        { name: "stage", label: "API and stage", kind: "select", required: true, options: (ctx) => restStageOptions(ctx.clients) },
        { name: "path", label: "Path", kind: "text", help: "Leave empty to map the domain root.", validate: { pattern: "[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*", message: "Letters, numbers and -._~ separated by /." } },
      ],
      async run(ctx, name, v) {
        const { apiId, stage } = splitApiStage(v.stage);
        const r = await ctx.clients.apigateway.send(new CreateBasePathMappingCommand({ domainName: name, restApiId: apiId, stage, basePath: optText(v.path) }));
        return { message: `Mapped /${r.basePath && r.basePath !== "(none)" ? r.basePath : ""} to stage ${stage} of API ${apiId}.` };
      },
    },
    {
      id: "remove-mapping",
      label: "Remove API mapping",
      danger: true,
      fields: [{ name: "path", label: "API mapping", kind: "select", required: true, options: mappingOptions }],
      async run(ctx, name, v) {
        const basePath = optText(v.path) ?? "(none)";
        await ctx.clients.apigateway.send(new DeleteBasePathMappingCommand({ domainName: name, basePath }));
        return { message: `Removed the mapping for path ${basePath}.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.apigateway.send(new DeleteDomainNameCommand({ domainName: name }));
    },
  },
};

async function allCerts(ctx: Ctx): Promise<ClientCertificate[]> {
  const out: ClientCertificate[] = [];
  let position: string | undefined;
  do {
    const r = await ctx.clients.apigateway.send(new GetClientCertificatesCommand({ limit: 500, position }));
    out.push(...(r.items ?? []));
    position = r.position;
  } while (position);
  return out;
}

export const clientCertificates: ResourceDef = {
  id: "client-certificates",
  name: "Client certificates",
  singular: "client certificate",
  idField: "id",
  nameField: "ID",
  description: "Certificates API Gateway presents to your HTTP back ends so they can verify calls come from API Gateway.",
  emptyText: "You don't have any client certificates.",
  columns: [
    { key: "id", label: "ID", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
    { key: "expires", label: "Expires", kind: "date" },
  ],

  async list(ctx) {
    return (await allCerts(ctx)).map((c) => ({ id: c.clientCertificateId ?? "", description: c.description ?? null, created: c.createdDate ?? null, expires: c.expirationDate ?? null }));
  },

  async get(ctx, id) {
    const c = await ctx.clients.apigateway.send(new GetClientCertificateCommand({ clientCertificateId: id }));
    return {
      summary: { ID: id, Description: c.description ?? null, Created: c.createdDate ?? null, Expires: c.expirationDate ?? null },
      tabs: [
        { id: "pem", label: "PEM-encoded certificate", kind: "text", data: c.pemEncodedCertificate ?? "", emptyText: "No certificate body was returned." },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(c.tags), emptyText: "No tags." },
      ],
    };
  },

  create: {
    title: "Generate certificate",
    description: "Generates a client certificate with GenerateClientCertificate.",
    fields: [
      { name: "description", label: "Description", kind: "text", section: "Certificate details" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.apigateway.send(new GenerateClientCertificateCommand({ description: optText(v.description), tags: tagsRecord(v.tags) }));
      if (!r.clientCertificateId) throw new Error("GenerateClientCertificate returned no ID.");
      return r.clientCertificateId;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "text", help: "Clear the box to remove the description." }],
      async initialValues(ctx, id) {
        const c = await ctx.clients.apigateway.send(new GetClientCertificateCommand({ clientCertificateId: id }));
        return { description: c.description ?? "" };
      },
      async run(ctx, id, v) {
        await ctx.clients.apigateway.send(new UpdateClientCertificateCommand({ clientCertificateId: id, patchOperations: [{ op: "replace", path: "/description", value: optText(v.description) ?? "" }] }));
        return { message: "Saved the description." };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.apigateway.send(new DeleteClientCertificateCommand({ clientCertificateId: id }));
    },
  },
};
