/**
 * Checks every AWS SDK call the dashboard makes against the active identity's policies.
 * Attached to each client in src/lib/aws.ts, so no server action can skip it.
 */

import { getActiveIdentity } from "./identity";
import { AccessDeniedError, assertAllPermissions } from "./permissions";
import { ALWAYS_ALLOWED, sdkCallToIam } from "./iam-action";
import { resolveLookups } from "./iam-lookup";
import { DEFAULT_REGION } from "./regions";

/** `region` is the Region the client signs for: resource ARNs are built with it. */
export async function enforceSimulatedIam(clientName: string | undefined, commandName: string | undefined, input: unknown, region: string = DEFAULT_REGION): Promise<void> {
  const identity = await getActiveIdentity();
  if (identity.type === "admin") return;
  const requests = clientName && commandName ? sdkCallToIam(clientName, commandName, input, region) : null;
  if (!requests) {
    throw new AccessDeniedError(identity, `${clientName ?? "?"}.${commandName ?? "?"}`, "*", "This call is not mapped to an IAM action, so it is denied.");
  }
  const resolved = await resolveLookups(requests);
  assertAllPermissions(
    identity,
    resolved.filter((r) => !ALWAYS_ALLOWED.has(r.action)).map((r): [string, string] => [r.action, r.resource])
  );
}

/**
 * For actions that never reach the AWS SDK (the EC2 container terminal, the Organizations
 * file store, Savings Plans and lifecycle policies kept on this screen): returns the
 * simulated AccessDenied message, or null when the active identity is allowed.
 */
export async function simulatedDenial(action: string, resource = "*"): Promise<string | null> {
  const identity = await getActiveIdentity();
  if (identity.type === "admin") return null;
  try {
    assertAllPermissions(identity, [[action, resource]]);
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Same check, throwing AccessDenied: for read paths that return data rather than a result. */
export async function requireSimulatedPermission(action: string, resource = "*"): Promise<void> {
  const denied = await simulatedDenial(action, resource);
  if (denied) throw new Error(denied);
}
