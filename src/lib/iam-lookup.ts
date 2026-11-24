/**
 * Turns IamRequests that carry a `lookup` into the real resource ARN before the check, for
 * resources whose ARN cannot be built from the name alone (Secrets Manager's random suffix).
 * Uses an unchecked client: this is the IAM simulator itself. When the lookup fails (the
 * secret does not exist yet, or the emulator is down) the request keeps its fallback ARN.
 * The secret is looked up in the Region the call goes to (lookup.region).
 */

import { DescribeSecretCommand } from "@aws-sdk/client-secrets-manager";
import { uncheckedSecretsManager } from "./aws.ts";
import type { IamRequest } from "./iam-action.ts";
import type { ResourceLookup } from "./iam-resources.ts";

export type LookupFn = (lookup: ResourceLookup) => Promise<string | null>;

async function describeSecretArn(lookup: ResourceLookup): Promise<string | null> {
  try {
    const r = await uncheckedSecretsManager(lookup.region).send(new DescribeSecretCommand({ SecretId: lookup.name }));
    return r.ARN ?? null;
  } catch {
    return null; // Not found yet (CreateSecret) or unreachable: keep the documented "-??????" form.
  }
}

/** The same requests with looked-up ARNs. Pure apart from `find`, so it is unit-tested with a fake. */
export async function resolveLookups(requests: IamRequest[], find: LookupFn = describeSecretArn): Promise<IamRequest[]> {
  return Promise.all(
    requests.map(async (r) => {
      if (!r.lookup) return r;
      const real = await find(r.lookup);
      return { action: r.action, resource: real ?? r.resource };
    })
  );
}
