/**
 * The console's IAM simulator: evaluates identity-based policies the way AWS does for a
 * single account, without resource policies, permission boundaries or SCPs.
 *
 * Order of evaluation (as in AWS):
 *  1. An explicit Deny that matches wins.
 *  2. Otherwise an Allow that matches grants.
 *  3. Otherwise the request is implicitly denied.
 *
 * The simulator never grants more than AWS would: statements with a Condition are not
 * evaluated, so an Allow with a Condition is not counted while a Deny with a Condition
 * still applies. A policy that failed to load denies everything.
 */

/** The request's resource could not be worked out (same value as in iam-action.ts). */
export const UNKNOWN_RESOURCE = "(unknown resource)";

export interface PolicyStatement {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Condition?: unknown;
  Principal?: unknown;
  NotPrincipal?: unknown;
}

export interface PolicyDocument {
  Version?: string;
  Id?: string;
  Statement?: PolicyStatement | PolicyStatement[];
}

export interface LoadedPolicy {
  /** Where the policy came from, e.g. "managed:ReadOnly" or "group dev / inline:x". */
  name: string;
  document: PolicyDocument;
}

export interface AdminIdentity {
  type: "admin";
  name: string;
  accountId: string;
  arn?: string;
}

export interface PrincipalIdentity {
  type: "user" | "role" | "invalid";
  name: string;
  accountId: string;
  policies: LoadedPolicy[];
  /** Anything that could not be loaded. Non-empty means deny-all. */
  loadErrors?: string[];
  /** UserId / RoleId from IAM, when it was loaded. */
  principalId?: string;
}

export type SimIdentity = AdminIdentity | PrincipalIdentity;

export interface Evaluation {
  allowed: boolean;
  reason: string;
}

export function principalArn(identity: SimIdentity): string {
  switch (identity.type) {
    case "admin":
      return identity.arn ?? `arn:aws:iam::${identity.accountId}:user/${identity.name}`;
    case "user":
      return `arn:aws:iam::${identity.accountId}:user/${identity.name}`;
    case "role":
      return `arn:aws:sts::${identity.accountId}:assumed-role/${identity.name}/console`;
    default:
      return `(invalid identity: ${identity.name})`;
  }
}

export class AccessDeniedError extends Error {
  readonly action: string;
  readonly resource: string;
  readonly reason: string;

  constructor(identity: SimIdentity, action: string, resource: string, reason: string) {
    super(
      `AccessDenied (simulated by the console): ${principalArn(identity)} is not authorized to perform: ${action} on resource: ${resource} because ${reason}`
    );
    this.name = "AccessDeniedError";
    this.action = action;
    this.resource = resource;
    this.reason = reason;
  }
}

const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const statementsOf = (doc: PolicyDocument): PolicyStatement[] =>
  doc.Statement === undefined ? [] : Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];

/** IAM wildcard match: `*` is any run of characters, `?` is exactly one. */
export function wildcardMatch(pattern: string, value: string, caseInsensitive = false): boolean {
  const p = caseInsensitive ? pattern.toLowerCase() : pattern;
  const v = caseInsensitive ? value.toLowerCase() : value;
  // Iterative glob matcher with backtracking on the last `*`.
  let pi = 0;
  let vi = 0;
  let star = -1;
  let mark = 0;
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === v[vi])) {
      pi++;
      vi++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = vi;
    } else if (star !== -1) {
      pi = star + 1;
      vi = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

function actionMatches(st: PolicyStatement, action: string): boolean {
  if (st.Action !== undefined) return asList(st.Action).some((p) => wildcardMatch(p, action, true));
  if (st.NotAction !== undefined) return !asList(st.NotAction).some((p) => wildcardMatch(p, action, true));
  return false;
}

/**
 * Whether the statement covers the resource. For UNKNOWN_RESOURCE a Deny always covers
 * (any matching Deny applies) and an Allow covers only through `Resource: "*"`.
 */
function resourceMatches(st: PolicyStatement, resource: string, effect: "Allow" | "Deny"): boolean {
  if (resource === UNKNOWN_RESOURCE) {
    if (effect === "Deny") return true;
    return st.Resource !== undefined && asList(st.Resource).includes("*");
  }
  if (st.Resource !== undefined) return asList(st.Resource).some((p) => wildcardMatch(p, resource));
  if (st.NotResource !== undefined) return !asList(st.NotResource).some((p) => wildcardMatch(p, resource));
  return false;
}

export function evaluatePermissions(identity: SimIdentity, action: string, resource = "*"): Evaluation {
  if (identity.type === "admin") return { allowed: true, reason: "the emulator admin is allowed everything" };
  if (identity.type === "invalid") {
    return { allowed: false, reason: `the active identity is not valid (${(identity.loadErrors ?? []).join("; ") || identity.name})` };
  }
  const loadErrors = identity.loadErrors ?? [];
  if (loadErrors.length > 0) {
    return { allowed: false, reason: `its policies could not be loaded, so everything is denied: ${loadErrors.join("; ")}` };
  }

  let allowedBy: string | null = null;
  let skippedConditional: string | null = null;
  for (const policy of identity.policies) {
    for (const st of statementsOf(policy.document)) {
      const effect = st.Effect === "Deny" ? "Deny" : st.Effect === "Allow" ? "Allow" : null;
      if (!effect || !actionMatches(st, action) || !resourceMatches(st, resource, effect)) continue;
      if (effect === "Deny") {
        return { allowed: false, reason: `an explicit Deny in ${policy.name} matches` };
      }
      if (st.Condition !== undefined) {
        skippedConditional ??= policy.name;
        continue;
      }
      allowedBy ??= policy.name;
    }
  }
  if (allowedBy) return { allowed: true, reason: `allowed by ${allowedBy}` };
  if (skippedConditional) {
    return {
      allowed: false,
      reason: `the only matching Allow (in ${skippedConditional}) has a Condition, which the simulator cannot evaluate, so it is not counted`,
    };
  }
  return { allowed: false, reason: "no identity-based policy allows it (implicit deny)" };
}

export function assertPermission(identity: SimIdentity, action: string, resource = "*"): void {
  const r = evaluatePermissions(identity, action, resource);
  if (!r.allowed) throw new AccessDeniedError(identity, action, resource, r.reason);
}

export function assertAllPermissions(identity: SimIdentity, requests: ReadonlyArray<readonly [string, string]>): void {
  for (const [action, resource] of requests) assertPermission(identity, action, resource);
}
