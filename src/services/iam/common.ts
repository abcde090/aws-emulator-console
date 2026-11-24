/**
 * Shared IAM reads (paginated lists), live form options and small value helpers used by
 * the IAM resource definitions. Every call goes through ctx.clients.iam.
 */

import {
  ListGroupsCommand,
  ListOpenIDConnectProvidersCommand,
  ListPoliciesCommand,
  ListRolesCommand,
  ListSAMLProvidersCommand,
  ListUsersCommand,
  type Group,
  type Policy,
  type Role,
  type User,
} from "@aws-sdk/client-iam";
import type { ColumnDef, Ctx, FieldValue, Option, Row } from "../../console/types.ts";

export async function allUsers(ctx: Ctx): Promise<User[]> {
  const out: User[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListUsersCommand({ Marker: marker, MaxItems: 1000 }));
    out.push(...(r.Users ?? []));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

export async function allGroups(ctx: Ctx): Promise<Group[]> {
  const out: Group[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListGroupsCommand({ Marker: marker, MaxItems: 1000 }));
    out.push(...(r.Groups ?? []));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

export async function allRoles(ctx: Ctx): Promise<Role[]> {
  const out: Role[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 1000 }));
    out.push(...(r.Roles ?? []));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

export async function allPolicies(ctx: Ctx, scope: "All" | "AWS" | "Local" = "All"): Promise<Policy[]> {
  const out: Policy[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListPoliciesCommand({ Scope: scope, Marker: marker, MaxItems: 1000 }));
    out.push(...(r.Policies ?? []));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

export function policyType(arn: string | undefined): string {
  if (!arn) return "-";
  if (arn.startsWith("arn:aws:iam::aws:policy/job-function/")) return "AWS managed - job function";
  if (arn.startsWith("arn:aws:iam::aws:policy/")) return "AWS managed";
  return "Customer managed";
}

export async function policyOptions(ctx: Ctx): Promise<Option[]> {
  const policies = await allPolicies(ctx);
  return policies
    .filter((p) => p.Arn && p.PolicyName)
    .sort((a, b) => String(a.PolicyName).localeCompare(String(b.PolicyName)))
    .map((p) => ({ value: p.Arn as string, label: `${p.PolicyName} (${policyType(p.Arn)})` }));
}

export async function groupOptions(ctx: Ctx): Promise<Option[]> {
  return (await allGroups(ctx)).filter((g) => g.GroupName).map((g) => ({ value: g.GroupName as string, label: g.GroupName as string }));
}

export async function userOptions(ctx: Ctx): Promise<Option[]> {
  return (await allUsers(ctx)).filter((u) => u.UserName).map((u) => ({ value: u.UserName as string, label: u.UserName as string }));
}

/** Users and roles by ARN, for principal pickers (KMS key administrators, simulator ...). */
export async function principalArnOptions(ctx: Ctx): Promise<Option[]> {
  const [users, roles] = await Promise.all([allUsers(ctx), allRoles(ctx)]);
  return [
    ...users.filter((u) => u.Arn).map((u) => ({ value: u.Arn as string, label: `${u.UserName} (user)` })),
    ...roles.filter((r) => r.Arn).map((r) => ({ value: r.Arn as string, label: `${r.RoleName} (role)` })),
  ];
}

export async function oidcProviderOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.iam.send(new ListOpenIDConnectProvidersCommand({}));
  return (r.OpenIDConnectProviderList ?? []).filter((p) => p.Arn).map((p) => ({ value: p.Arn as string, label: (p.Arn as string).replace(/^.*:oidc-provider\//, "") }));
}

export async function samlProviderOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.iam.send(new ListSAMLProvidersCommand({}));
  return (r.SAMLProviderList ?? []).filter((p) => p.Arn).map((p) => ({ value: p.Arn as string, label: (p.Arn as string).replace(/^.*:saml-provider\//, "") }));
}

export function isNoSuchEntity(err: unknown): boolean {
  return err instanceof Error && (err.name === "NoSuchEntityException" || err.name === "NoSuchEntity");
}

/** Runs a read that may legitimately find nothing (NoSuchEntity) and returns null then. */
export async function maybe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isNoSuchEntity(err)) return null;
    throw err;
  }
}

/** True for the IAM simulator's (or the emulator's) access-denied errors. */
export function isAccessDenied(err: unknown): boolean {
  return err instanceof Error && /^AccessDenied/.test(err.name);
}

/** A secondary read: on a denial it gives `fallback` instead of failing the whole page. */
export async function orDenied<T, F>(fn: () => Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isAccessDenied(err)) return fallback;
    throw err;
  }
}

export const strings = (v: FieldValue | undefined): string[] => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string" && x !== "") : []);
export const text = (v: FieldValue | undefined): string => (typeof v === "string" ? v.trim() : "");

export const TAG_COLUMNS: ColumnDef[] = [
  { key: "Key", label: "Key", kind: "text" },
  { key: "Value", label: "Value", kind: "text" },
];

export function tagRows(tags: { Key?: string; Value?: string }[] | undefined): Row[] {
  return (tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Path field shared by create forms. */
export const PATH_PATTERN = "/|/[\\x21-\\x7E]*/";
