/**
 * Service Quotas: AWS services, their quotas (applied vs AWS default) with requests for
 * increases (hand-built table on /servicequotas/services/<code>), and the request history.
 */

import { GetRequestedServiceQuotaChangeCommand, ListRequestedServiceQuotaChangeHistoryCommand, ListServicesCommand, type RequestedServiceQuotaChange } from "@aws-sdk/client-service-quotas";
import type { ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { quotasFor } from "./quotas.ts";

const services: ResourceDef = {
  id: "services",
  name: "AWS services",
  singular: "service",
  idField: "code",
  nameField: "name",
  description: "Choose a service to view its quotas and request increases.",
  emptyText: "No services.",
  columns: [
    { key: "name", label: "Service", kind: "link" },
    { key: "code", label: "Service code", kind: "code" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.servicequotas.send(new ListServicesCommand({ NextToken: token, MaxResults: 100 }));
      rows.push(...(r.Services ?? []).map((s) => ({ code: s.ServiceCode ?? "", name: s.ServiceName ?? s.ServiceCode ?? "" })));
      token = r.NextToken;
    } while (token);
    return rows;
  },
  async get(ctx, code) {
    const quotas = await quotasFor(ctx, code);
    const svc = (await services.list(ctx)).find((s) => s.code === code);
    if (!svc) throw new Error(`NoSuchResourceException: service ${code} is not in Service Quotas.`);
    return {
      summary: {
        name: svc.name,
        "Service code": code,
        Quotas: quotas.length,
        Adjustable: quotas.filter((q) => q.adjustable).length,
        "Increased from default": quotas.filter((q) => q.applied !== null && q.defaultValue !== null && q.applied > q.defaultValue).length,
      },
      summaryLabels: { name: "Service" },
    };
  },
};

function requestRow(r: RequestedServiceQuotaChange): Row {
  return {
    id: r.Id ?? "",
    service: r.ServiceName ?? r.ServiceCode ?? null,
    quota: r.QuotaName ?? r.QuotaCode ?? null,
    quotaCode: r.QuotaCode ?? null,
    desired: r.DesiredValue ?? null,
    status: r.Status ?? null,
    level: r.QuotaRequestedAtLevel ?? null,
    created: r.Created ?? null,
    updated: r.LastUpdated ?? null,
    caseId: r.CaseId ?? null,
    requester: r.Requester ?? null,
  };
}

const history: ResourceDef = {
  id: "history",
  name: "Quota request history",
  singular: "quota request",
  idField: "id",
  nameField: "quota",
  description: "Quota increase requests made from this account.",
  emptyText: "No quota requests. Open a service under AWS services and choose Request increase.",
  columns: [
    { key: "quota", label: "Quota name", kind: "link" },
    { key: "service", label: "Service", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "desired", label: "Requested value", kind: "count" },
    { key: "level", label: "Quota requested at", kind: "text" },
    { key: "created", label: "Date requested", kind: "date" },
    { key: "updated", label: "Last updated", kind: "date" },
    { key: "id", label: "Request ID", kind: "text", hidden: true },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.servicequotas.send(new ListRequestedServiceQuotaChangeHistoryCommand({ NextToken: token, MaxResults: 100 }));
      rows.push(...(r.RequestedQuotas ?? []).map(requestRow));
      token = r.NextToken;
    } while (token);
    return rows;
  },
  async get(ctx, id) {
    const r = await ctx.clients.servicequotas.send(new GetRequestedServiceQuotaChangeCommand({ RequestId: id }));
    if (!r.RequestedQuota) throw new Error(`NoSuchResourceException: request ${id}`);
    const x = requestRow(r.RequestedQuota);
    return {
      summary: {
        "Quota name": x.quota,
        Service: x.service,
        "Quota code": x.quotaCode,
        Status: x.status,
        "Requested value": x.desired,
        "Quota requested at": x.level,
        "Date requested": x.created,
        "Last updated": x.updated,
        "Case ID": x.caseId,
        Requester: x.requester,
        "Request ID": id,
      },
    };
  },
};

export const servicequotasService: ServiceDef = {
  id: "servicequotas",
  name: "Service Quotas",
  category: "Management & Governance",
  description: "View and manage the quotas (limits) for AWS services in your account, and request increases.",
  resources: [services, history],
  notSupported: [],
};
