/** Service Quotas data shared by the definition and the hand-built quota table (server only). */

import { ListAWSDefaultServiceQuotasCommand, ListServiceQuotasCommand, type ServiceQuota } from "@aws-sdk/client-service-quotas";
import type { Ctx } from "../../console/types.ts";
import { mergeQuotas, type QuotaRow } from "./helpers.ts";

async function page(fetch: (token?: string) => Promise<{ Quotas?: ServiceQuota[]; NextToken?: string }>): Promise<ServiceQuota[]> {
  const out: ServiceQuota[] = [];
  let token: string | undefined;
  do {
    const r = await fetch(token);
    out.push(...(r.Quotas ?? []));
    token = r.NextToken;
  } while (token && out.length < 5000);
  return out;
}

/** Applied (account) and AWS default values for every quota of a service. */
export async function quotasFor(ctx: Ctx, serviceCode: string): Promise<QuotaRow[]> {
  const [applied, defaults] = await Promise.all([
    page((t) => ctx.clients.servicequotas.send(new ListServiceQuotasCommand({ ServiceCode: serviceCode, NextToken: t, MaxResults: 100 }))),
    page((t) => ctx.clients.servicequotas.send(new ListAWSDefaultServiceQuotasCommand({ ServiceCode: serviceCode, NextToken: t, MaxResults: 100 }))),
  ]);
  return mergeQuotas(applied, defaults);
}
