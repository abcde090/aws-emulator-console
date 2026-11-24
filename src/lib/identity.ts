/**
 * The "act as" identity. The dashboard always talks to the emulator as its admin; when you
 * switch to an IAM user or role, the simulator (permissions.ts) checks each call against
 * that identity's policies before it is sent.
 *
 * Policies are loaded with the UNCHECKED IAM client, because loading them is the
 * simulator's own work. Anything that fails or comes back truncated is recorded in
 * loadErrors, which denies everything (fail closed).
 */

import { cache } from "react";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  GetGroupPolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  GetUserCommand,
  GetUserPolicyCommand,
  ListAttachedGroupPoliciesCommand,
  ListAttachedRolePoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupPoliciesCommand,
  ListGroupsForUserCommand,
  ListRolePoliciesCommand,
  ListRolesCommand,
  ListUserPoliciesCommand,
  ListUsersCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { uncheckedIam } from "./aws.ts";
import { ACCOUNT_ID } from "./emulator-files.ts";
import { parseIdentityCookie } from "./identity-cookie.ts";
import { parsePolicyDocument } from "./policy-document.ts";
import type { LoadedPolicy, SimIdentity } from "./permissions.ts";

export const IDENTITY_COOKIE = "aws_active_identity";
const PAGE_SIZE = 1000;

export type ActiveIdentity = SimIdentity;

const errorText = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

class PolicyCollector {
  readonly policies: LoadedPolicy[] = [];
  readonly errors: string[] = [];
  private readonly iam: IAMClient;

  constructor(iam: IAMClient) {
    this.iam = iam;
  }

  /** Runs one load step; a failure is recorded, never thrown. */
  async step<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err: unknown) {
      this.errors.push(`${label}: ${errorText(err)}`);
      return null;
    }
  }

  truncated(label: string, isTruncated: boolean | undefined): void {
    if (isTruncated) this.errors.push(`${label}: the list was truncated, so not every policy could be loaded`);
  }

  addDocument(name: string, raw: string | undefined): void {
    const parsed = parsePolicyDocument(raw);
    if (parsed.ok) this.policies.push({ name, document: parsed.document });
    else this.errors.push(`${name}: ${parsed.error}`);
  }

  async addManaged(owner: string, attached: { PolicyArn?: string; PolicyName?: string }[] | undefined): Promise<void> {
    for (const p of attached ?? []) {
      const arn = p.PolicyArn;
      const label = `${owner} / managed ${p.PolicyName ?? arn ?? "?"}`;
      if (!arn) {
        this.errors.push(`${label}: no policy ARN`);
        continue;
      }
      await this.step(label, async () => {
        const policy = await this.iam.send(new GetPolicyCommand({ PolicyArn: arn }));
        const versionId = policy.Policy?.DefaultVersionId;
        if (!versionId) throw new Error("no default version");
        const version = await this.iam.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: versionId }));
        this.addDocument(label, version.PolicyVersion?.Document);
      });
    }
  }
}

async function loadUser(name: string): Promise<SimIdentity> {
  const iam = uncheckedIam();
  const c = new PolicyCollector(iam);
  const user = await c.step(`user ${name}`, () => iam.send(new GetUserCommand({ UserName: name })));
  if (user) {
    const owner = `user ${name}`;
    const attached = await c.step(`${owner} attached policies`, () =>
      iam.send(new ListAttachedUserPoliciesCommand({ UserName: name, MaxItems: PAGE_SIZE }))
    );
    c.truncated(`${owner} attached policies`, attached?.IsTruncated);
    await c.addManaged(owner, attached?.AttachedPolicies);

    const inline = await c.step(`${owner} inline policies`, () => iam.send(new ListUserPoliciesCommand({ UserName: name, MaxItems: PAGE_SIZE })));
    c.truncated(`${owner} inline policies`, inline?.IsTruncated);
    for (const policyName of inline?.PolicyNames ?? []) {
      const r = await c.step(`${owner} / inline ${policyName}`, () => iam.send(new GetUserPolicyCommand({ UserName: name, PolicyName: policyName })));
      if (r) c.addDocument(`${owner} / inline ${policyName}`, r.PolicyDocument);
    }

    const groups = await c.step(`${owner} groups`, () => iam.send(new ListGroupsForUserCommand({ UserName: name, MaxItems: PAGE_SIZE })));
    c.truncated(`${owner} groups`, groups?.IsTruncated);
    for (const g of groups?.Groups ?? []) {
      const groupName = g.GroupName ?? "";
      const gOwner = `group ${groupName}`;
      const gAttached = await c.step(`${gOwner} attached policies`, () =>
        iam.send(new ListAttachedGroupPoliciesCommand({ GroupName: groupName, MaxItems: PAGE_SIZE }))
      );
      c.truncated(`${gOwner} attached policies`, gAttached?.IsTruncated);
      await c.addManaged(gOwner, gAttached?.AttachedPolicies);
      const gInline = await c.step(`${gOwner} inline policies`, () => iam.send(new ListGroupPoliciesCommand({ GroupName: groupName, MaxItems: PAGE_SIZE })));
      c.truncated(`${gOwner} inline policies`, gInline?.IsTruncated);
      for (const policyName of gInline?.PolicyNames ?? []) {
        const r = await c.step(`${gOwner} / inline ${policyName}`, () => iam.send(new GetGroupPolicyCommand({ GroupName: groupName, PolicyName: policyName })));
        if (r) c.addDocument(`${gOwner} / inline ${policyName}`, r.PolicyDocument);
      }
    }
  }
  return { type: "user", name, accountId: ACCOUNT_ID, policies: c.policies, loadErrors: c.errors, principalId: user?.User?.UserId };
}

async function loadRole(name: string): Promise<SimIdentity> {
  const iam = uncheckedIam();
  const c = new PolicyCollector(iam);
  const owner = `role ${name}`;
  const role = await c.step(owner, () => iam.send(new GetRoleCommand({ RoleName: name })));
  if (role) {
    const attached = await c.step(`${owner} attached policies`, () =>
      iam.send(new ListAttachedRolePoliciesCommand({ RoleName: name, MaxItems: PAGE_SIZE }))
    );
    c.truncated(`${owner} attached policies`, attached?.IsTruncated);
    await c.addManaged(owner, attached?.AttachedPolicies);
    const inline = await c.step(`${owner} inline policies`, () => iam.send(new ListRolePoliciesCommand({ RoleName: name, MaxItems: PAGE_SIZE })));
    c.truncated(`${owner} inline policies`, inline?.IsTruncated);
    for (const policyName of inline?.PolicyNames ?? []) {
      const r = await c.step(`${owner} / inline ${policyName}`, () => iam.send(new GetRolePolicyCommand({ RoleName: name, PolicyName: policyName })));
      if (r) c.addDocument(`${owner} / inline ${policyName}`, r.PolicyDocument);
    }
  }
  const roleId = role?.Role?.RoleId;
  return { type: "role", name, accountId: ACCOUNT_ID, policies: c.policies, loadErrors: c.errors, principalId: roleId ? `${roleId}:console` : undefined };
}

const loadActiveIdentity = cache(async (): Promise<SimIdentity> => {
  const store = await cookies();
  const parsed = parseIdentityCookie(store.get(IDENTITY_COOKIE)?.value);
  switch (parsed.type) {
    case "admin":
      return { type: "admin", name: "emulator", accountId: ACCOUNT_ID };
    case "invalid":
      return { type: "invalid", name: "invalid cookie", accountId: ACCOUNT_ID, policies: [], loadErrors: [parsed.error] };
    case "user":
      return loadUser(parsed.name);
    case "role":
      return loadRole(parsed.name);
  }
});

/** The identity the current request acts as. Loaded once per request. */
export async function getActiveIdentity(): Promise<ActiveIdentity> {
  return loadActiveIdentity();
}

export interface IdentityChoice {
  type: "user" | "role";
  name: string;
  arn: string;
}

/** Real IAM users and roles that can be switched to (simulator work: unchecked client). */
export async function listSwitchableIdentities(): Promise<IdentityChoice[]> {
  const iam = uncheckedIam();
  const [users, roles] = await Promise.all([
    iam.send(new ListUsersCommand({ MaxItems: PAGE_SIZE })),
    iam.send(new ListRolesCommand({ MaxItems: PAGE_SIZE })),
  ]);
  return [
    ...(users.Users ?? []).map((u) => ({ type: "user" as const, name: u.UserName ?? "", arn: u.Arn ?? "" })),
    ...(roles.Roles ?? []).map((r) => ({ type: "role" as const, name: r.RoleName ?? "", arn: r.Arn ?? "" })),
  ].filter((c) => c.name !== "");
}

export type SwitchResult = { ok: true } | { ok: false; error: string };

/** Server action: act as an IAM user or role, or as the emulator admin again. */
export async function switchIdentity(target: { type: "admin" } | { type: "user" | "role"; name: string }): Promise<SwitchResult> {
  "use server";
  try {
    const store = await cookies();
    if (target.type === "admin") {
      store.delete(IDENTITY_COOKIE);
    } else {
      const value = JSON.stringify({ type: target.type, name: target.name });
      const parsed = parseIdentityCookie(value);
      if (parsed.type !== target.type) return { ok: false, error: "That is not a valid IAM user or role name." };
      const exists = (await listSwitchableIdentities()).some((c) => c.type === target.type && c.name === target.name);
      if (!exists) return { ok: false, error: `No IAM ${target.type} named ${target.name} exists in the emulator.` };
      store.set(IDENTITY_COOKIE, value, { httpOnly: true, sameSite: "strict", path: "/" });
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: errorText(err) };
  }
}
