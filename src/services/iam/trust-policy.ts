/**
 * Builds the trust policy the IAM console's "Create role" wizard writes for each trusted
 * entity type. Pure, so it is unit tested.
 */

export type TrustInput =
  | { type: "service"; service: string }
  | { type: "account"; accountId: string; externalId?: string; requireMfa?: boolean }
  | { type: "web"; provider: string; audience: string; accountId: string }
  | { type: "saml"; providerArn: string };

const WEB_BUILTINS = ["cognito-identity.amazonaws.com", "www.amazon.com", "graph.facebook.com", "accounts.google.com"];

export function trustPolicy(input: TrustInput): Record<string, unknown> {
  const doc = (statement: Record<string, unknown>) => ({ Version: "2012-10-17", Statement: [{ Effect: "Allow", ...statement }] });
  switch (input.type) {
    case "service":
      if (!/^[a-z0-9.-]+\.amazonaws\.com(\.cn)?$/.test(input.service)) throw new Error("Choose a service principal such as ec2.amazonaws.com.");
      return doc({ Principal: { Service: input.service }, Action: "sts:AssumeRole" });
    case "account": {
      if (!/^\d{12}$/.test(input.accountId)) throw new Error("An AWS account ID is 12 digits.");
      const condition: Record<string, unknown> = {};
      if (input.externalId) condition.StringEquals = { "sts:ExternalId": input.externalId };
      if (input.requireMfa) condition.Bool = { "aws:MultiFactorAuthPresent": "true" };
      return doc({ Principal: { AWS: `arn:aws:iam::${input.accountId}:root` }, Action: "sts:AssumeRole", ...(Object.keys(condition).length ? { Condition: condition } : {}) });
    }
    case "web": {
      if (!input.provider) throw new Error("Choose an identity provider.");
      if (!input.audience) throw new Error("Enter the audience (client ID or identity pool ID).");
      const builtin = WEB_BUILTINS.includes(input.provider);
      const host = input.provider.replace(/^arn:aws:iam::\d{12}:oidc-provider\//, "");
      const federated = builtin ? input.provider : input.provider.startsWith("arn:") ? input.provider : `arn:aws:iam::${input.accountId}:oidc-provider/${host}`;
      const audKey = input.provider === "www.amazon.com" ? "www.amazon.com:app_id" : input.provider === "graph.facebook.com" ? "graph.facebook.com:app_id" : `${host}:aud`;
      return doc({ Principal: { Federated: federated }, Action: "sts:AssumeRoleWithWebIdentity", Condition: { StringEquals: { [audKey]: input.audience } } });
    }
    case "saml":
      if (!input.providerArn.startsWith("arn:")) throw new Error("Choose a SAML provider.");
      return doc({
        Principal: { Federated: input.providerArn },
        Action: ["sts:AssumeRoleWithSAML", "sts:TagSession"],
        Condition: { StringEquals: { "SAML:aud": "https://signin.aws.amazon.com/saml" } },
      });
  }
}

/** "AWS service: ec2", "Account: 1234…" — the Trusted entities column of the Roles list. */
export function trustedEntities(doc: unknown): string[] {
  if (!doc || typeof doc !== "object") return [];
  const raw = (doc as { Statement?: unknown }).Statement;
  const statements = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: string[] = [];
  for (const s of statements) {
    const p = (s as { Principal?: unknown }).Principal;
    if (p === "*") out.push("Everyone (*)");
    if (!p || typeof p !== "object") continue;
    for (const [kind, v] of Object.entries(p as Record<string, unknown>)) {
      for (const one of Array.isArray(v) ? v : [v]) {
        const value = String(one);
        if (kind === "Service") out.push(`AWS service: ${value.replace(/\.amazonaws\.com$/, "")}`);
        else if (kind === "AWS") {
          const m = /^arn:aws:iam::(\d{12}):root$/.exec(value);
          out.push(m ? `Account: ${m[1]}` : /^\d{12}$/.test(value) ? `Account: ${value}` : value);
        } else if (kind === "Federated") out.push(`Identity provider: ${value.replace(/^arn:aws:iam::\d{12}:(oidc|saml)-provider\//, "")}`);
        else out.push(`${kind}: ${value}`);
      }
    }
  }
  return [...new Set(out)];
}
