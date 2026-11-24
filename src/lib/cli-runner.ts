/**
 * CloudShell: runs one `aws ...` line against the emulator.
 *
 * 1. cli-args.ts splits the line without a shell (pipes, redirects, $() are refused).
 * 2. cloudshell-guard.ts refuses commands that reach local files or start other programs.
 * 3. A non-admin identity is checked by the IAM simulator first (recursive S3 commands are
 *    expanded to every object they would touch).
 *    Resource ARNs use the command's --region, else the Region chosen in the top bar.
 * 4. The aws binary runs by absolute path with execFile and an argument list, never a shell,
 *    inside macOS sandbox-exec, in a fresh temp folder holding read-only copies of the
 *    emulator's config, keys and CA, with a minimal environment (AWS_REGION is the chosen
 *    Region) and no stdin.
 */

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { parseAwsCommand } from "./cli-args.ts";
import { checkCloudShellArgs, isInfoOnlyCommand } from "./cloudshell-guard.ts";
import { ALWAYS_ALLOWED, cliArgsToIam, cliCommandParts, expandRecursive, type CliIamPlan, type S3Uri } from "./iam-action.ts";
import { AccessDeniedError, assertAllPermissions, assertPermission, principalArn, type SimIdentity } from "./permissions.ts";
import { emulatorPort } from "./emulator-files.ts";
import { AWS_BINARY_CANDIDATES } from "./cloudshell-sandbox.ts";
import { executeSandboxed, findAwsBinary, type CloudShellResult } from "./cloudshell-exec.ts";
import { uncheckedS3 } from "./aws.ts";
import { resolveLookups } from "./iam-lookup.ts";
import { getActiveIdentity } from "./identity.ts";
import { selectedRegion } from "./selected-region.ts";

export type { CloudShellResult };

/** Most keys a recursive S3 command may touch for a non-admin check. */
const MAX_RECURSIVE_KEYS = 10_000;

const fail = (output: string): CloudShellResult => ({ ok: false, output, exitCode: null });

/** Keys under a prefix, listed with the unchecked client (the caller checked s3:ListBucket). */
async function listKeys(uri: S3Uri): Promise<string[]> {
  const s3 = uncheckedS3();
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: uri.bucket, Prefix: uri.key || undefined, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key !== undefined) keys.push(o.Key);
    if (keys.length > MAX_RECURSIVE_KEYS) throw new Error(`more than ${MAX_RECURSIVE_KEYS} objects under s3://${uri.bucket}/${uri.key}; too many to check`);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function checkPlan(identity: SimIdentity, plan: CliIamPlan): Promise<void> {
  if (plan.kind === "requests") {
    const requests = await resolveLookups(plan.requests);
    assertAllPermissions(identity, requests.filter((r) => !ALWAYS_ALLOWED.has(r.action)).map((r) => [r.action, r.resource] as const));
    return;
  }
  // Listing is itself an action: check it before looking at what is in the bucket.
  if (plan.source) assertPermission(identity, "s3:ListBucket", `arn:aws:s3:::${plan.source.bucket}`);
  if (plan.target && plan.operation !== "rm") assertPermission(identity, "s3:ListBucket", `arn:aws:s3:::${plan.target.bucket}`);
  const sourceKeys = plan.source ? await listKeys(plan.source) : [];
  const targetKeys = plan.deleteExtra && plan.target ? await listKeys(plan.target) : [];
  assertAllPermissions(identity, expandRecursive(plan, sourceKeys, targetKeys).map((r) => [r.action, r.resource] as const));
}

/** What `aws sts get-caller-identity` would print for the simulated (non-admin) identity. */
function simulatedCallerIdentity(identity: SimIdentity): string {
  const userId = identity.type === "admin" ? undefined : identity.principalId;
  return `${JSON.stringify({ UserId: userId, Account: identity.accountId, Arn: principalArn(identity) }, null, 4)}\n`;
}

/** Runs one CloudShell line as the active identity. Never throws. */
export async function runCloudShell(line: string): Promise<CloudShellResult> {
  if (typeof line !== "string" || line.length > 10_000) return fail("Command is missing or too long.");
  const parsed = parseAwsCommand(line.trim());
  if (!parsed.ok) return fail(parsed.error);
  const parts = cliCommandParts(parsed.args);
  const guard = checkCloudShellArgs(parsed.args, parts);
  if (!guard.ok) return fail(guard.error);

  let identity: SimIdentity;
  let region: string;
  try {
    [identity, region] = await Promise.all([getActiveIdentity(), selectedRegion()]);
  } catch (err: unknown) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  if (identity.type !== "admin" && !isInfoOnlyCommand(parsed.args)) {
    if (parts?.service === "sts" && parts.operation === "get-caller-identity") {
      return { ok: true, output: simulatedCallerIdentity(identity), exitCode: 0 };
    }
    const plan = cliArgsToIam(parsed.args, region);
    if (!plan) {
      return fail(new AccessDeniedError(identity, `aws ${parts?.service ?? "?"} ${parts?.operation ?? "?"}`, "*", "this command is not mapped to IAM actions, so it is denied for non-admin identities").message);
    }
    try {
      await checkPlan(identity, plan);
    } catch (err: unknown) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  if (process.platform !== "darwin") {
    return fail("CloudShell needs macOS sandbox-exec to run the aws CLI safely, so it is off on this platform.");
  }
  const binary = findAwsBinary();
  if (!binary) return fail(`The aws CLI was not found in ${AWS_BINARY_CANDIDATES.join(", ")}. Install it with: brew install awscli`);

  let port: number;
  try {
    port = emulatorPort();
  } catch (err: unknown) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  try {
    return await executeSandboxed(binary, parsed.args, port, region);
  } catch (err: unknown) {
    return fail(`CloudShell could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
}
