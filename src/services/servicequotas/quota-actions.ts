"use server";

/** Server action for "Request increase at account level" (permission-checked Service Quotas client). */

import { GetServiceQuotaCommand, RequestServiceQuotaIncreaseCommand } from "@aws-sdk/client-service-quotas";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { checkDesiredValue } from "./helpers.ts";

const CODE = /^[A-Za-z0-9_.-]{1,128}$/;

export async function requestIncrease(serviceCode: string, quotaCode: string, desired: number): Promise<Result<{ id: string; status: string }>> {
  try {
    if (typeof serviceCode !== "string" || !CODE.test(serviceCode) || typeof quotaCode !== "string" || !CODE.test(quotaCode)) throw new Error("Invalid service or quota code.");
    const q = await clients.servicequotas.send(new GetServiceQuotaCommand({ ServiceCode: serviceCode, QuotaCode: quotaCode }));
    if (q.Quota?.Adjustable === false) throw new Error("This quota is not adjustable.");
    const problem = checkDesiredValue(desired, q.Quota?.Value ?? null);
    if (problem) throw new Error(problem);
    const r = await clients.servicequotas.send(new RequestServiceQuotaIncreaseCommand({ ServiceCode: serviceCode, QuotaCode: quotaCode, DesiredValue: desired }));
    return { ok: true, data: { id: r.RequestedQuota?.Id ?? "", status: r.RequestedQuota?.Status ?? "PENDING" } };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}
