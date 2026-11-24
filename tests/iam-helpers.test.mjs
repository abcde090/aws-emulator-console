import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPolicy, decodePolicy, prettyPolicy, requirePolicy } from "../src/services/iam/policy-json.ts";
import { trustPolicy, trustedEntities } from "../src/services/iam/trust-policy.ts";
import { parseActionNames, simulationRows } from "../src/services/iam/simulator-rows.ts";

const allow = (extra = {}) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*", ...extra }] });

test("decodePolicy handles URL-encoded and plain JSON", () => {
  assert.deepEqual(decodePolicy(encodeURIComponent('{"a":1}')), { a: 1 });
  assert.deepEqual(decodePolicy('{"a":1}'), { a: 1 });
  assert.equal(decodePolicy(""), null);
  assert.equal(decodePolicy("not json"), "not json");
  assert.equal(prettyPolicy('{"a":1}'), '{\n  "a": 1\n}');
});

test("checkPolicy: identity policies", () => {
  assert.equal(checkPolicy(allow(), "identity").ok, true);
  assert.equal(checkPolicy("{", "identity").ok, false);
  assert.equal(checkPolicy("[]", "identity").ok, false);
  const noResource = checkPolicy(JSON.stringify({ Version: "2012-10-17", Statement: { Effect: "Allow", Action: "s3:*" } }), "identity");
  assert.equal(noResource.ok, false);
  const principal = checkPolicy(allow({ Principal: "*" }), "identity");
  assert.equal(principal.ok, false);
  const badEffect = checkPolicy(allow({ Effect: "Maybe" }), "identity");
  assert.equal(badEffect.ok, false);
  const badAction = checkPolicy(allow({ Action: "nope" }), "identity");
  assert.equal(badAction.ok, false);
  const both = checkPolicy(allow({ NotAction: "s3:*" }), "identity");
  assert.equal(both.ok, false);
  assert.equal(checkPolicy(JSON.stringify({ Statement: [] }), "identity").ok, false);
});

test("checkPolicy: trust and resource policies need a Principal", () => {
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  assert.equal(checkPolicy(trust, "trust").ok, true);
  assert.equal(checkPolicy(allow(), "resource").ok, false);
  assert.throws(() => requirePolicy("", "trust"), /Policy validation failed/);
  assert.equal(requirePolicy(allow(), "identity"), allow());
});

test("checkPolicy: managed policy size limit", () => {
  const big = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: Array.from({ length: 400 }, (_, i) => `arn:aws:s3:::bucket-${i}/*`) }] });
  assert.equal(checkPolicy(big, "identity").ok, true);
  assert.equal(checkPolicy(big, "identity", true).ok, false);
});

test("trustPolicy builds the console's trust policies", () => {
  assert.deepEqual(trustPolicy({ type: "service", service: "ec2.amazonaws.com" }).Statement, [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }]);
  assert.throws(() => trustPolicy({ type: "service", service: "evil" }));
  const acct = trustPolicy({ type: "account", accountId: "111122223333", externalId: "x1", requireMfa: true }).Statement[0];
  assert.deepEqual(acct.Principal, { AWS: "arn:aws:iam::111122223333:root" });
  assert.deepEqual(acct.Condition, { StringEquals: { "sts:ExternalId": "x1" }, Bool: { "aws:MultiFactorAuthPresent": "true" } });
  assert.throws(() => trustPolicy({ type: "account", accountId: "123" }));
  const web = trustPolicy({ type: "web", provider: "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com", audience: "sts.amazonaws.com", accountId: "000000000000" }).Statement[0];
  assert.equal(web.Action, "sts:AssumeRoleWithWebIdentity");
  assert.deepEqual(web.Condition, { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" } });
  const cognito = trustPolicy({ type: "web", provider: "cognito-identity.amazonaws.com", audience: "us-east-1:abc", accountId: "000000000000" }).Statement[0];
  assert.deepEqual(cognito.Principal, { Federated: "cognito-identity.amazonaws.com" });
  const saml = trustPolicy({ type: "saml", providerArn: "arn:aws:iam::000000000000:saml-provider/corp" }).Statement[0];
  assert.deepEqual(saml.Action, ["sts:AssumeRoleWithSAML", "sts:TagSession"]);
});

test("trustedEntities summarises principals", () => {
  const doc = { Statement: [{ Principal: { Service: ["lambda.amazonaws.com"], AWS: "arn:aws:iam::111122223333:root", Federated: "arn:aws:iam::0:oidc-provider/x" } }, { Principal: "*" }] };
  assert.deepEqual(trustedEntities(doc), ["AWS service: lambda", "Account: 111122223333", "Identity provider: arn:aws:iam::0:oidc-provider/x", "Everyone (*)"]);
  assert.deepEqual(trustedEntities(null), []);
});

test("simulator parsing and rows", () => {
  assert.deepEqual(parseActionNames("s3:GetObject, ec2:Run*\ns3:GetObject"), ["s3:GetObject", "ec2:Run*"]);
  assert.throws(() => parseActionNames("bogus"));
  assert.deepEqual(parseActionNames("arn:aws:s3:::b/* *", true), ["arn:aws:s3:::b/*", "*"]);
  assert.throws(() => parseActionNames("bucket", true));
  assert.deepEqual(parseActionNames(undefined), []);
  const rows = simulationRows([{ EvalActionName: "s3:GetObject", EvalDecision: "implicitDeny" }, { EvalActionName: "s3:PutObject", EvalResourceName: "*", EvalDecision: "allowed", MatchedStatements: [{ SourcePolicyId: "p1", SourcePolicyType: "IAMPolicy" }] }]);
  assert.equal(rows[0].decision, "Denied (implicit deny)");
  assert.equal(rows[0].matched, "-");
  assert.equal(rows[1].matched, "p1 (IAMPolicy)");
});

test("IAM credential report CSV parses into one row per user", async () => {
  const { parseCredentialReport } = await import("../src/services/iam/credential-report.ts");
  const rows = parseCredentialReport("user,arn,mfa_active\n<root_account>,arn:aws:iam::000000000000:root,false\nalice,arn:aws:iam::000000000000:user/alice,true\n");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { user: "alice", arn: "arn:aws:iam::000000000000:user/alice", mfa_active: "true" });
  assert.deepEqual(parseCredentialReport(""), []);
});
