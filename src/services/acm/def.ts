/**
 * AWS Certificate Manager: list, request a public certificate or import one, details
 * (domains with DNS validation records, certificate body), tags, re-import and delete.
 */

import {
  AddTagsToCertificateCommand,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  GetCertificateCommand,
  ImportCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RemoveTagsFromCertificateCommand,
  RenewCertificateCommand,
  RequestCertificateCommand,
  ResendValidationEmailCommand,
  UpdateCertificateOptionsCommand,
  type CertificateSummary,
  type KeyAlgorithm,
} from "@aws-sdk/client-acm";
import { ChangeResourceRecordSetsCommand, ListHostedZonesCommand } from "@aws-sdk/client-route-53";
import type { Ctx, FieldDef, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { domainList, matchingZone } from "./domains.ts";

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const certId = (arn: string) => arn.replace(/^.*:certificate\//, "");
const arnOf = (ctx: Ctx, id: string) => (id.startsWith("arn:") ? id : `arn:aws:acm:${ctx.region}:${ctx.accountId}:certificate/${id}`);

async function allCertificates(ctx: Ctx): Promise<CertificateSummary[]> {
  const out: CertificateSummary[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.acm.send(
      new ListCertificatesCommand({
        NextToken: token,
        MaxItems: 1000,
        // Without a key-type filter ListCertificates returns only RSA_2048 certificates.
        Includes: { keyTypes: ["RSA_1024", "RSA_2048", "RSA_3072", "RSA_4096", "EC_prime256v1", "EC_secp384r1", "EC_secp521r1"] },
      })
    );
    out.push(...(r.CertificateSummaryList ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function allHostedZones(ctx: Ctx): Promise<{ id: string; name: string; privateZone: boolean }[]> {
  const out: { id: string; name: string; privateZone: boolean }[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.route53.send(new ListHostedZonesCommand({ Marker: marker }));
    out.push(...(r.HostedZones ?? []).map((z) => ({ id: (z.Id ?? "").replace(/^\/hostedzone\//, ""), name: z.Name ?? "", privateZone: z.Config?.PrivateZone === true })));
    marker = r.IsTruncated ? r.NextMarker : undefined;
  } while (marker);
  return out;
}

async function currentTags(ctx: Ctx, arn: string): Promise<{ Key: string; Value: string }[]> {
  const r = await ctx.clients.acm.send(new ListTagsForCertificateCommand({ CertificateArn: arn }));
  return (r.Tags ?? []).map((x) => ({ Key: x.Key ?? "", Value: x.Value ?? "" }));
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const certType = (row: Row): string => str(row.type ?? row.Type);
const certStatus = (row: Row): string => str(row.status ?? row.Status);
const validationMethod = (row: Row): string => str(row["Validation method"]);
const isImported = (row: Row): boolean => certType(row) === "Imported";
const isAmazonIssued = (row: Row): boolean => certType(row) === "" || certType(row) === "Amazon Issued";
const isPending = (row: Row): boolean => certStatus(row) === "" || certStatus(row) === "PENDING_VALIDATION";

const TYPE_LABEL: Record<string, string> = { AMAZON_ISSUED: "Amazon Issued", IMPORTED: "Imported", PRIVATE: "Private" };

const pemField = (name: string, label: string, required: boolean, help: string): FieldDef => ({ name, label, kind: "textarea", required, help, placeholder: "-----BEGIN ...-----", section: "Certificate details", showIf: { field: "mode", equals: "import" } });

export const certificates: ResourceDef = {
  id: "certificates",
  name: "Certificates",
  singular: "certificate",
  idField: "id",
  nameField: "Certificate ID",
  description: "Public SSL/TLS certificates issued by ACM and certificates you import.",
  emptyText: "No certificates. Request or import a certificate to get started.",
  columns: [
    { key: "id", label: "Certificate ID", kind: "link" },
    { key: "domain", label: "Domain name", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "inUse", label: "In use", kind: "boolean" },
    { key: "renewal", label: "Renewal eligibility", kind: "text" },
    { key: "keyAlgorithm", label: "Key algorithm", kind: "text" },
    { key: "notAfter", label: "Expires", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await allCertificates(ctx)).map((c) => ({
      id: certId(c.CertificateArn ?? ""),
      domain: c.DomainName ?? "",
      type: TYPE_LABEL[c.Type ?? ""] ?? c.Type ?? null,
      status: c.Status ?? null,
      inUse: c.InUse ?? false,
      renewal: c.RenewalEligibility ?? null,
      keyAlgorithm: c.KeyAlgorithm ?? null,
      notAfter: c.NotAfter ?? null,
      arn: c.CertificateArn ?? null,
    }));
  },

  async get(ctx, id) {
    const arn = arnOf(ctx, id);
    const [d, tags] = await Promise.all([ctx.clients.acm.send(new DescribeCertificateCommand({ CertificateArn: arn })), secondary(currentTags(ctx, arn))]);
    const c = d.Certificate;
    if (!c) throw new Error(`Certificate ${id} not found.`);
    let body: string | null = null;
    let bodyError: string | null = null;
    if (c.Status === "ISSUED") {
      const g = await secondary(ctx.clients.acm.send(new GetCertificateCommand({ CertificateArn: arn })));
      if (g.ok) body = [g.value.Certificate, g.value.CertificateChain].filter(Boolean).join("\n");
      else bodyError = g.error;
    }
    const methods = [...new Set((c.DomainValidationOptions ?? []).map((o) => o.ValidationMethod).filter(Boolean))];
    return {
      summary: {
        "Certificate ID": certId(arn),
        "Certificate ARN": arn,
        Type: TYPE_LABEL[c.Type ?? ""] ?? c.Type ?? null,
        Status: c.Status ?? null,
        "Domain name": c.DomainName ?? null,
        "Number of additional names": Math.max(0, (c.SubjectAlternativeNames ?? []).length - 1),
        "In use": (c.InUseBy ?? []).length > 0 ? "Yes" : "No",
        "Renewal eligibility": c.RenewalEligibility ?? null,
        "Validation method": methods.join(", ") || null,
      },
      tabs: [
        {
          id: "domains",
          label: "Domains",
          kind: "table",
          columns: [
            { key: "domain", label: "Domain", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "method", label: "Validation", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
            { key: "cnameName", label: "CNAME name", kind: "code" },
            { key: "cnameValue", label: "CNAME value", kind: "code" },
          ],
          data: (c.DomainValidationOptions ?? []).map((o) => ({
            domain: o.DomainName ?? "",
            status: o.ValidationStatus ?? null,
            method: o.ValidationMethod ?? null,
            type: o.ResourceRecord?.Type ?? null,
            cnameName: o.ResourceRecord?.Name ?? null,
            cnameValue: o.ResourceRecord?.Value ?? null,
          })),
          description: "For DNS validation, create these CNAME records in the DNS configuration of each domain. If the domain is in a Route 53 hosted zone, use Actions > Create records in Route 53.",
          emptyText: "No domain validation records.",
        },
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            "In use by": (c.InUseBy ?? []).join(", ") || "-",
            "Requested at": c.CreatedAt ?? null,
            "Issued at": c.IssuedAt ?? null,
            "Imported at": c.ImportedAt ?? null,
            "Not before": c.NotBefore ?? null,
            "Not after": c.NotAfter ?? null,
            "Public key info": c.KeyAlgorithm ?? null,
            "Signature algorithm": c.SignatureAlgorithm ?? null,
            Subject: c.Subject ?? null,
            Issuer: c.Issuer ?? null,
            "Serial number": c.Serial ?? null,
            "Certificate transparency logging": c.Options?.CertificateTransparencyLoggingPreference ?? null,
            "Failure reason": c.FailureReason ?? null,
          },
        },
        { id: "names", label: "Additional names", kind: "table", columns: [{ key: "name", label: "Domain name", kind: "text" }], data: (c.SubjectAlternativeNames ?? []).map((name) => ({ name })), emptyText: "No additional names." },
        { id: "certificate", label: "Certificate body", kind: "text", data: body ?? "", description: bodyError ? `Unavailable: ${bodyError}` : undefined, emptyText: "The certificate body is available once the certificate is issued." },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: tags.ok ? tags.value : [], description: unavailableText(tags), emptyText: "No tags." },
      ],
    };
  },

  create: {
    title: "Request certificate",
    description: "Request a public certificate from Amazon (RequestCertificate), or import one you already have (ImportCertificate).",
    fields: [
      {
        name: "mode", label: "Certificate type", kind: "radio", default: "public", section: "Certificate type",
        options: [
          { value: "public", label: "Request a public certificate: Amazon issues a public SSL/TLS certificate" },
          { value: "import", label: "Import a certificate: upload a certificate and private key you got outside ACM" },
        ],
      },
      { name: "domain", label: "Fully qualified domain name", kind: "text", required: true, section: "Domain names", showIf: { field: "mode", equals: "public" }, placeholder: "www.example.com", help: "Use an asterisk (*) to request a wildcard certificate, e.g. *.example.com.", validate: { pattern: "(\\*\\.)?([a-zA-Z0-9-]{1,63}\\.)+[a-zA-Z]{2,63}", message: "Enter a fully qualified domain name such as www.example.com." } },
      { name: "additional", label: "Add another name to this certificate", kind: "textarea", section: "Domain names", showIf: { field: "mode", equals: "public" }, help: "Optional: one name per line (up to 99)." },
      {
        name: "validation", label: "Validation method", kind: "radio", default: "DNS", section: "Validation method", showIf: { field: "mode", equals: "public" },
        options: [
          { value: "DNS", label: "DNS validation - recommended" },
          { value: "EMAIL", label: "Email validation" },
        ],
      },
      { name: "keyAlgorithm", label: "Key algorithm", kind: "radio", default: "RSA_2048", section: "Key algorithm", showIf: { field: "mode", equals: "public" }, options: [{ value: "RSA_2048", label: "RSA 2048" }, { value: "EC_prime256v1", label: "ECDSA P 256" }, { value: "EC_secp384r1", label: "ECDSA P 384" }] },
      pemField("certificateBody", "Certificate body", true, "PEM-encoded certificate."),
      pemField("privateKey", "Certificate private key", true, "PEM-encoded, unencrypted private key that matches the certificate's public key."),
      pemField("chain", "Certificate chain", false, "Optional PEM-encoded intermediate certificates."),
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const tags = Array.isArray(v.tags) ? (v.tags as { Key: string; Value: string }[]) : [];
      if (v.mode === "import") {
        const r = await ctx.clients.acm.send(
          new ImportCertificateCommand({
            Certificate: Buffer.from(String(v.certificateBody ?? "")),
            PrivateKey: Buffer.from(String(v.privateKey ?? "")),
            CertificateChain: s(v.chain) ? Buffer.from(String(v.chain)) : undefined,
            Tags: tags.length ? tags : undefined,
          })
        );
        if (!r.CertificateArn) throw new Error("ImportCertificate returned no ARN.");
        return certId(r.CertificateArn);
      }
      const domain = s(v.domain);
      const sans = domainList(v.additional, domain);
      const r = await ctx.clients.acm.send(
        new RequestCertificateCommand({
          DomainName: domain,
          SubjectAlternativeNames: sans.length ? [domain, ...sans] : undefined,
          ValidationMethod: v.validation === "EMAIL" ? "EMAIL" : "DNS",
          KeyAlgorithm: (s(v.keyAlgorithm) || "RSA_2048") as KeyAlgorithm,
          Tags: tags.length ? tags : undefined,
        })
      );
      if (!r.CertificateArn) throw new Error("RequestCertificate returned no ARN.");
      return certId(r.CertificateArn);
    },
  },

  actions: [
    {
      id: "route53-records",
      label: "Create records in Route 53",
      confirm: "Creates (UPSERTs) each pending domain's CNAME validation record in the Route 53 hosted zone that matches the domain. ACM then validates the domain and issues the certificate.",
      availableFor: (row) => isAmazonIssued(row) && isPending(row) && (validationMethod(row) === "" || validationMethod(row).includes("DNS")),
      async run(ctx, id) {
        const d = await ctx.clients.acm.send(new DescribeCertificateCommand({ CertificateArn: arnOf(ctx, id) }));
        const pending = (d.Certificate?.DomainValidationOptions ?? []).filter((o) => o.ValidationMethod === "DNS" && o.ValidationStatus === "PENDING_VALIDATION" && o.ResourceRecord?.Name && o.ResourceRecord.Value);
        if (!pending.length) throw new Error("No domain is waiting for DNS validation. ACM may still be generating the CNAME records; try again in a few seconds.");
        const zones = await allHostedZones(ctx);
        const rows: Row[] = [];
        const done = new Set<string>();
        for (const o of pending) {
          const rec = o.ResourceRecord;
          const domain = o.DomainName ?? "";
          const zone = matchingZone(domain, zones);
          const name = rec?.Name ?? "";
          if (!zone) {
            rows.push({ domain, zone: null, record: name, result: "No matching hosted zone. Create the hosted zone in Route 53 first." });
            continue;
          }
          const key = `${zone.id}|${name}`;
          if (!done.has(key)) {
            await ctx.clients.route53.send(
              new ChangeResourceRecordSetsCommand({
                HostedZoneId: zone.id,
                ChangeBatch: { Comment: `ACM validation for ${domain}`, Changes: [{ Action: "UPSERT", ResourceRecordSet: { Name: name, Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: rec?.Value ?? "" }] } }] },
              })
            );
            done.add(key);
          }
          rows.push({ domain, zone: `${zone.name} (${zone.id})`, record: name, result: "Record created" });
        }
        return {
          message: `${done.size} CNAME record${done.size === 1 ? "" : "s"} created in Route 53. The status changes to Issued once ACM sees the records.`,
          table: {
            rowKey: "domain",
            columns: [
              { key: "domain", label: "Domain", kind: "text" },
              { key: "zone", label: "Hosted zone", kind: "text" },
              { key: "record", label: "CNAME name", kind: "code" },
              { key: "result", label: "Result", kind: "text" },
            ],
            rows,
          },
        };
      },
    },
    {
      id: "edit-tags",
      label: "Edit tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Tags you remove here are removed from the certificate; new or changed ones are added." }],
      async initialValues(ctx, id) {
        return { tags: await currentTags(ctx, arnOf(ctx, id)) };
      },
      async run(ctx, id, v) {
        const arn = arnOf(ctx, id);
        const diff = tagDiff(await currentTags(ctx, arn), fieldTags(v.tags));
        if (diff.remove.length) await ctx.clients.acm.send(new RemoveTagsFromCertificateCommand({ CertificateArn: arn, Tags: diff.remove.map((Key) => ({ Key })) }));
        if (diff.set.length) await ctx.clients.acm.send(new AddTagsToCertificateCommand({ CertificateArn: arn, Tags: diff.set }));
        return { message: tagDiffMessage(diff) };
      },
    },
    {
      id: "reimport",
      label: "Reimport certificate",
      availableFor: isImported,
      fields: [
        { name: "certificateBody", label: "Certificate body", kind: "textarea", required: true },
        { name: "privateKey", label: "Certificate private key", kind: "textarea", required: true },
        { name: "chain", label: "Certificate chain", kind: "textarea" },
      ],
      async run(ctx, id, v) {
        await ctx.clients.acm.send(
          new ImportCertificateCommand({ CertificateArn: arnOf(ctx, id), Certificate: Buffer.from(String(v.certificateBody ?? "")), PrivateKey: Buffer.from(String(v.privateKey ?? "")), CertificateChain: s(v.chain) ? Buffer.from(String(v.chain)) : undefined })
        );
        return { message: "Certificate reimported. Its ARN and associations are unchanged." };
      },
    },
    {
      id: "resend-email",
      label: "Resend validation email",
      availableFor: (row) => isAmazonIssued(row) && isPending(row) && (validationMethod(row) === "" || validationMethod(row).includes("EMAIL")),
      fields: [
        { name: "domain", label: "Domain", kind: "text", required: true },
        { name: "validationDomain", label: "Validation domain", kind: "text", required: true, help: "The base domain that receives the email (e.g. example.com)." },
      ],
      async run(ctx, id, v) {
        await ctx.clients.acm.send(new ResendValidationEmailCommand({ CertificateArn: arnOf(ctx, id), Domain: s(v.domain), ValidationDomain: s(v.validationDomain) }));
        return { message: "Validation email resent." };
      },
    },
    {
      id: "renew",
      label: "Renew now",
      availableFor: (row) => isAmazonIssued(row) && (certStatus(row) === "" || certStatus(row) === "ISSUED"),
      confirm: "Renews an eligible certificate (RenewCertificate). Only issued certificates that ACM manages can be renewed.",
      async run(ctx, id) {
        await ctx.clients.acm.send(new RenewCertificateCommand({ CertificateArn: arnOf(ctx, id) }));
        return { message: "Renewal requested." };
      },
    },
    {
      id: "transparency",
      label: "Edit certificate transparency logging",
      fields: [{ name: "pref", label: "Certificate transparency logging", kind: "radio", default: "ENABLED", options: [{ value: "ENABLED", label: "Enabled" }, { value: "DISABLED", label: "Disabled" }] }],
      // ACM accepts UpdateCertificateOptions only for issued, non-imported certificates.
      availableFor: (row) => !isImported(row) && (certStatus(row) === "" || certStatus(row) === "ISSUED"),
      async initialValues(ctx, id) {
        const d = await ctx.clients.acm.send(new DescribeCertificateCommand({ CertificateArn: arnOf(ctx, id) }));
        return { pref: d.Certificate?.Options?.CertificateTransparencyLoggingPreference === "DISABLED" ? "DISABLED" : "ENABLED" };
      },
      async run(ctx, id, v) {
        await ctx.clients.acm.send(new UpdateCertificateOptionsCommand({ CertificateArn: arnOf(ctx, id), Options: { CertificateTransparencyLoggingPreference: v.pref === "DISABLED" ? "DISABLED" : "ENABLED" } }));
        return { message: "Certificate options updated." };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.acm.send(new DeleteCertificateCommand({ CertificateArn: arnOf(ctx, id) }));
    },
  },
};

export const acmService: ServiceDef = {
  id: "acm",
  name: "Certificate Manager",
  category: "Security, Identity, & Compliance",
  description: "Provision and manage SSL/TLS certificates for use with AWS services.",
  resources: [certificates],
  notSupported: ["Email validation: AWS Emulator sends no validation email, so email-validated certificates stay Pending validation. Use DNS validation with a Route 53 hosted zone instead."],
};
