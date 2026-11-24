/**
 * IAM roles: the Create role wizard (trusted entity type, permissions, boundary, name), the
 * role detail (permissions, trust relationships, tags, last used, instance profiles) and delete.
 * The trust policy editor lives on the hand-built role page (src/app/iam/roles/[name]).
 */

import {
  AddRoleToInstanceProfileCommand,
  CreateInstanceProfileCommand,
  CreateRoleCommand,
  DeleteInstanceProfileCommand,
  DeleteRoleCommand,
  DeleteServiceLinkedRoleCommand,
  GetRoleCommand,
  ListInstanceProfilesForRoleCommand,
  RemoveRoleFromInstanceProfileCommand,
  UpdateRoleCommand,
} from "@aws-sdk/client-iam";
import type { Ctx, Option, ResourceDef } from "../../console/types.ts";
import { fieldTags } from "../../console/tags.ts";
import { secondary } from "../../console/secondary.ts";
import { allRoles, orDenied, oidcProviderOptions, PATH_PATTERN, policyOptions, samlProviderOptions, strings, TAG_COLUMNS, tagRows, text } from "./common.ts";
import { attach, clearPermissions, entityTags, inlineDocuments, PERMISSION_COLUMNS, permissionActions, permissionRows } from "./permissions.ts";
import { decodePolicy, requirePolicy } from "./policy-json.ts";
import { trustedEntities, trustPolicy, type TrustInput } from "./trust-policy.ts";

const ROLE_NAME = "[\\w+=,.@-]{1,64}";

/** Common use cases, as in the console's "Service or use case" list. */
const SERVICES: Option[] = [
  { value: "ec2.amazonaws.com", label: "EC2" },
  { value: "lambda.amazonaws.com", label: "Lambda" },
  { value: "ecs-tasks.amazonaws.com", label: "Elastic Container Service - ECS Task" },
  { value: "ecs.amazonaws.com", label: "Elastic Container Service" },
  { value: "eks.amazonaws.com", label: "EKS - Cluster" },
  { value: "states.amazonaws.com", label: "Step Functions" },
  { value: "events.amazonaws.com", label: "EventBridge" },
  { value: "scheduler.amazonaws.com", label: "EventBridge Scheduler" },
  { value: "apigateway.amazonaws.com", label: "API Gateway" },
  { value: "glue.amazonaws.com", label: "Glue" },
  { value: "codebuild.amazonaws.com", label: "CodeBuild" },
  { value: "codepipeline.amazonaws.com", label: "CodePipeline" },
  { value: "cloudformation.amazonaws.com", label: "CloudFormation" },
  { value: "firehose.amazonaws.com", label: "Kinesis Data Firehose" },
  { value: "rds.amazonaws.com", label: "RDS" },
  { value: "redshift.amazonaws.com", label: "Redshift" },
  { value: "s3.amazonaws.com", label: "S3 (replication, batch operations)" },
  { value: "sns.amazonaws.com", label: "SNS" },
  { value: "backup.amazonaws.com", label: "AWS Backup" },
  { value: "ssm.amazonaws.com", label: "Systems Manager" },
  { value: "elasticbeanstalk.amazonaws.com", label: "Elastic Beanstalk" },
  { value: "dms.amazonaws.com", label: "Database Migration Service" },
  { value: "config.amazonaws.com", label: "Config" },
  { value: "cloudtrail.amazonaws.com", label: "CloudTrail" },
  { value: "sagemaker.amazonaws.com", label: "SageMaker" },
];

const WEB_PROVIDERS: Option[] = [
  { value: "cognito-identity.amazonaws.com", label: "Amazon Cognito" },
  { value: "www.amazon.com", label: "Login with Amazon" },
  { value: "graph.facebook.com", label: "Facebook" },
  { value: "accounts.google.com", label: "Google" },
];

async function webProviderOptions(ctx: Ctx): Promise<Option[]> {
  return [...WEB_PROVIDERS, ...(await oidcProviderOptions(ctx))];
}

/** Turns the wizard's fields into a trust policy; exported for tests through trust-policy.ts. */
function trustFromValues(ctx: Ctx, v: Record<string, unknown>): string {
  const type = String(v.trustedEntity ?? "");
  if (type === "custom") return requirePolicy(v.customTrust, "trust");
  let input: TrustInput;
  if (type === "service") input = { type: "service", service: String(v.service ?? "") };
  else if (type === "account") {
    input = {
      type: "account",
      accountId: v.accountChoice === "other" ? String(v.otherAccount ?? "").trim() : ctx.accountId,
      externalId: v.requireExternalId === true ? String(v.externalId ?? "").trim() : undefined,
      requireMfa: v.requireMfa === true,
    };
  } else if (type === "web") input = { type: "web", provider: String(v.webProvider ?? ""), audience: String(v.audience ?? "").trim(), accountId: ctx.accountId };
  else if (type === "saml") input = { type: "saml", providerArn: String(v.samlProvider ?? "") };
  else throw new Error("Choose a trusted entity type.");
  return JSON.stringify(trustPolicy(input));
}

export const roles: ResourceDef = {
  id: "roles",
  name: "Roles",
  singular: "role",
  idField: "name",
  nameField: "Role name",
  description: "An IAM role is an identity you can create that has specific permissions with credentials that are valid for short durations. Roles can be assumed by entities that you trust.",
  emptyText: "No roles to display.",
  detailHref: "roles/{id}",
  columns: [
    { key: "name", label: "Role name", kind: "link" },
    { key: "trusted", label: "Trusted entities", kind: "text" },
    { key: "lastActivity", label: "Last activity", kind: "date" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "path", label: "Path", kind: "text", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const list = await allRoles(ctx);
    // ListRoles doesn't return RoleLastUsed; GetRole does. A denied GetRole leaves the cell empty.
    const lastUsed = await Promise.all(
      list.map((r) => (r.RoleName ? orDenied(async () => (await ctx.clients.iam.send(new GetRoleCommand({ RoleName: r.RoleName }))).Role?.RoleLastUsed?.LastUsedDate ?? null, null) : null))
    );
    return list.map((r, i) => ({
      name: r.RoleName ?? "",
      trusted: trustedEntities(decodePolicy(r.AssumeRolePolicyDocument)).join(", ") || "-",
      lastActivity: lastUsed[i] ?? null,
      created: r.CreateDate ?? null,
      path: r.Path ?? "/",
      arn: r.Arn ?? null,
    }));
  },

  async get(ctx, name) {
    const iam = ctx.clients.iam;
    const [r, perms, inline, tags, profiles] = await Promise.all([
      iam.send(new GetRoleCommand({ RoleName: name })),
      secondary(() => permissionRows(ctx, "role", name)),
      secondary(() => inlineDocuments(ctx, "role", name)),
      secondary(() => entityTags(ctx, "role", name)),
      secondary(() => iam.send(new ListInstanceProfilesForRoleCommand({ RoleName: name }))),
    ]);
    const role = r.Role;
    const trust = decodePolicy(role?.AssumeRolePolicyDocument);
    return {
      summary: {
        "Role name": role?.RoleName ?? name,
        ARN: role?.Arn ?? null,
        Description: role?.Description ?? null,
        "Creation date": role?.CreateDate ?? null,
        "Last activity": role?.RoleLastUsed?.LastUsedDate ?? "None",
        "Maximum session duration": role?.MaxSessionDuration ? `${role.MaxSessionDuration / 3600} hour(s)` : null,
        "Instance profile ARN": profiles.ok ? (profiles.value.InstanceProfiles ?? []).map((p) => p.Arn).join(", ") || null : "Unavailable (access denied)",
        "Permissions boundary": role?.PermissionsBoundary?.PermissionsBoundaryArn ?? "Not set",
        Path: role?.Path ?? "/",
      },
      tabs: [
        { id: "permissions", label: "Permissions", kind: "table", columns: PERMISSION_COLUMNS.filter((c) => c.key !== "attachedVia"), data: perms.ok ? perms.value : [], emptyText: perms.ok ? "No permissions policies attached." : `Unavailable: ${perms.error}` },
        { id: "inline", label: "Inline policies", kind: "json", data: inline.ok ? inline.value : null, emptyText: inline.ok ? "No inline policies." : `Unavailable: ${inline.error}` },
        { id: "trust", label: "Trust relationships (current)", kind: "json", data: trust, description: `Trusted entities: ${trustedEntities(trust).join(", ") || "none"}` },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tags.ok ? tagRows(tags.value) : [], emptyText: tags.ok ? "No tags associated with the resource." : `Unavailable: ${tags.error}` },
        {
          id: "last-used",
          label: "Last accessed",
          kind: "keyvalue",
          data: { "Last used": role?.RoleLastUsed?.LastUsedDate ?? "Not accessed in the tracking period", Region: role?.RoleLastUsed?.Region ?? null },
        },
      ],
    };
  },

  create: {
    title: "Create role",
    description: "Builds the trust policy for the trusted entity you choose, then calls CreateRole and attaches the permissions policies.",
    fields: [
      {
        name: "trustedEntity", label: "Trusted entity type", kind: "radio", default: "service", section: "Select trusted entity",
        options: [
          { value: "service", label: "AWS service: allow AWS services like EC2, Lambda, or others to perform actions in this account" },
          { value: "account", label: "AWS account: allow entities in other AWS accounts belonging to you or a 3rd party to perform actions in this account" },
          { value: "web", label: "Web identity: allows users federated by the specified external web identity provider to assume this role" },
          { value: "saml", label: "SAML 2.0 federation: allow users federated with SAML 2.0 from a corporate directory to perform actions in this account" },
          { value: "custom", label: "Custom trust policy: create a custom trust policy to enable others to perform actions in this account" },
        ],
      },
      { name: "service", label: "Service or use case", kind: "select", required: true, options: SERVICES, section: "Select trusted entity", showIf: { field: "trustedEntity", equals: "service" } },
      {
        name: "accountChoice", label: "An AWS account", kind: "radio", default: "this", section: "Select trusted entity", showIf: { field: "trustedEntity", equals: "account" },
        options: [
          { value: "this", label: "This account" },
          { value: "other", label: "Another AWS account" },
        ],
      },
      { name: "otherAccount", label: "Account ID", kind: "text", section: "Select trusted entity", showIf: { field: "accountChoice", equals: "other" }, help: "Identifier of the account that can use this role.", validate: { pattern: "\\d{12}", message: "12 digits." } },
      { name: "requireExternalId", label: "Require external ID (Best practice when a third party will assume this role)", kind: "checkbox", default: false, section: "Select trusted entity", showIf: { field: "trustedEntity", equals: "account" } },
      { name: "externalId", label: "External ID", kind: "text", section: "Select trusted entity", showIf: { field: "requireExternalId", equals: true }, validate: { min: 2, max: 1224, message: "Between 2 and 1224 characters." } },
      { name: "requireMfa", label: "Require MFA", kind: "checkbox", default: false, section: "Select trusted entity", showIf: { field: "trustedEntity", equals: "account" }, help: "Adds a condition that requires multi-factor authentication." },
      { name: "webProvider", label: "Identity provider", kind: "select", required: true, options: webProviderOptions, section: "Select trusted entity", showIf: { field: "trustedEntity", equals: "web" } },
      { name: "audience", label: "Audience", kind: "text", required: true, section: "Select trusted entity", showIf: { field: "trustedEntity", equals: "web" }, help: "Client ID, application ID or identity pool ID." },
      { name: "samlProvider", label: "SAML 2.0-based provider", kind: "select", required: true, options: samlProviderOptions, section: "Select trusted entity", showIf: { field: "trustedEntity", equals: "saml" } },
      {
        name: "customTrust", label: "Custom trust policy", kind: "json", required: true, section: "Select trusted entity", showIf: { field: "trustedEntity", equals: "custom" },
        default: JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "Statement1", Effect: "Allow", Principal: {}, Action: "sts:AssumeRole" }] }, null, 2),
      },
      { name: "policies", label: "Permissions policies", kind: "multiselect", options: policyOptions, section: "Add permissions" },
      { name: "useBoundary", label: "Use a permissions boundary to control the maximum role permissions", kind: "checkbox", default: false, section: "Add permissions" },
      { name: "boundary", label: "Permissions boundary policy", kind: "select", required: true, options: policyOptions, section: "Add permissions", showIf: { field: "useBoundary", equals: true } },
      { name: "roleName", label: "Role name", kind: "text", required: true, section: "Name, review, and create", help: "Maximum 64 characters. Use alphanumeric and '+=,.@-_' characters.", validate: { pattern: ROLE_NAME, message: "Use up to 64 letters, numbers and +=,.@-_ characters." } },
      { name: "description", label: "Description", kind: "textarea", section: "Name, review, and create", help: "Maximum 1000 characters.", validate: { max: 1000, message: "At most 1000 characters." } },
      { name: "maxSession", label: "Maximum session duration (hours)", kind: "number", default: 1, section: "Name, review, and create", validate: { min: 1, max: 12, message: "Between 1 and 12 hours." } },
      { name: "path", label: "Path", kind: "text", default: "/", section: "Name, review, and create", validate: { pattern: PATH_PATTERN, message: "A path starts and ends with /." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Add tags - optional" },
    ],
    async run(ctx, v) {
      const name = text(v.roleName);
      const tags = fieldTags(v.tags);
      const trust = trustFromValues(ctx, v);
      await ctx.clients.iam.send(
        new CreateRoleCommand({
          RoleName: name,
          AssumeRolePolicyDocument: trust,
          Description: text(v.description) || undefined,
          MaxSessionDuration: typeof v.maxSession === "number" ? v.maxSession * 3600 : undefined,
          Path: text(v.path) || "/",
          PermissionsBoundary: v.useBoundary === true ? text(v.boundary) : undefined,
          Tags: tags.length ? tags : undefined,
        })
      );
      for (const p of strings(v.policies)) await attach(ctx, "role", name, p);
      if (v.trustedEntity === "service" && v.service === "ec2.amazonaws.com") {
        // Like the console: an EC2 role gets an instance profile with the same name.
        await ctx.clients.iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: name, Path: text(v.path) || "/" }));
        await ctx.clients.iam.send(new AddRoleToInstanceProfileCommand({ InstanceProfileName: name, RoleName: name }));
      }
      return name;
    },
  },

  actions: [
    ...permissionActions("role"),
    {
      id: "edit",
      label: "Edit description and session duration",
      fields: [
        { name: "description", label: "Description", kind: "textarea", validate: { max: 1000, message: "At most 1000 characters." } },
        { name: "maxSession", label: "Maximum session duration (hours)", kind: "number", required: true, default: 1, validate: { min: 1, max: 12, message: "Between 1 and 12 hours." } },
      ],
      async initialValues(ctx, name) {
        const role = (await ctx.clients.iam.send(new GetRoleCommand({ RoleName: name }))).Role;
        return { description: role?.Description ?? "", maxSession: (role?.MaxSessionDuration ?? 3600) / 3600 };
      },
      async run(ctx, name, v) {
        const role = (await ctx.clients.iam.send(new GetRoleCommand({ RoleName: name }))).Role;
        const description = text(v.description);
        const seconds = typeof v.maxSession === "number" ? Math.round(v.maxSession * 3600) : undefined;
        const descChanged = description !== (role?.Description ?? "");
        const sessionChanged = seconds !== undefined && seconds !== role?.MaxSessionDuration;
        if (!descChanged && !sessionChanged) return { message: `No changes to role ${name}.` };
        await ctx.clients.iam.send(
          new UpdateRoleCommand({ RoleName: name, Description: descChanged ? description : undefined, MaxSessionDuration: sessionChanged ? seconds : undefined })
        );
        return { message: `Updated role ${name}.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      const iam = ctx.clients.iam;
      const role = (await iam.send(new GetRoleCommand({ RoleName: name }))).Role;
      if (role?.Path?.startsWith("/aws-service-role/")) {
        await iam.send(new DeleteServiceLinkedRoleCommand({ RoleName: name }));
        return;
      }
      for (const p of (await iam.send(new ListInstanceProfilesForRoleCommand({ RoleName: name }))).InstanceProfiles ?? []) {
        if (!p.InstanceProfileName) continue;
        await iam.send(new RemoveRoleFromInstanceProfileCommand({ InstanceProfileName: p.InstanceProfileName, RoleName: name }));
        // The console creates an instance profile with the role's name for EC2 roles and deletes it with the role.
        if (p.InstanceProfileName === name) await iam.send(new DeleteInstanceProfileCommand({ InstanceProfileName: p.InstanceProfileName }));
      }
      await clearPermissions(ctx, "role", name);
      await iam.send(new DeleteRoleCommand({ RoleName: name }));
    },
  },
};
