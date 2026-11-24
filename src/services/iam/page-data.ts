/**
 * Server-side reads for the hand-built IAM pages. Each returns a Result so a page can show
 * an error banner instead of crashing. Uses the permission-checked clients.
 */

import { GetPolicyCommand, GetPolicyVersionCommand, GetRoleCommand, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { clients } from "../../lib/aws.ts";
import { makeCtx } from "../../console/server.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result, Row } from "../../console/types.ts";
import { accountSummary, principalRows } from "./account.ts";
import { orDenied } from "./common.ts";
import { prettyPolicy } from "./policy-json.ts";

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

export interface DashboardData {
  accountId: string;
  alias: string | null;
  summary: Record<string, number>;
}

export async function dashboardData(): Promise<Result<DashboardData>> {
  return attempt(async () => {
    const ctx = await makeCtx("iam");
    // The alias is secondary: a denied ListAccountAliases leaves it out instead of failing the dashboard.
    const [summary, aliases] = await Promise.all([accountSummary(ctx), orDenied(() => clients.iam.send(new ListAccountAliasesCommand({})), null)]);
    return { accountId: ctx.accountId, alias: aliases?.AccountAliases?.[0] ?? null, summary };
  });
}

export async function principals(): Promise<Result<Row[]>> {
  return attempt(async () => principalRows(await makeCtx("iam")));
}

export async function roleTrustPolicy(roleName: string): Promise<Result<string>> {
  return attempt(async () => prettyPolicy((await clients.iam.send(new GetRoleCommand({ RoleName: roleName }))).Role?.AssumeRolePolicyDocument));
}

export async function managedPolicyText(arn: string): Promise<Result<{ text: string; version: string }>> {
  return attempt(async () => {
    const p = (await clients.iam.send(new GetPolicyCommand({ PolicyArn: arn }))).Policy;
    const version = p?.DefaultVersionId ?? "v1";
    const v = await clients.iam.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: version }));
    return { text: prettyPolicy(v.PolicyVersion?.Document), version };
  });
}
