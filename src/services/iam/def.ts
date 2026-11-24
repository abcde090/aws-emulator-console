/**
 * IAM: Dashboard, User groups, Users, Roles, Policies, Identity providers, Account settings,
 * Access reports (Access Analyzer, Credential report) and the Policy simulator, in the console's left-nav order. Hand-built screens:
 * src/app/iam/dashboard, src/app/iam/policy-simulator, src/app/iam/roles/[name]
 * (trust policy editor) and src/app/iam/policies/[arn] (policy editor / new version).
 */

import type { ServiceDef } from "../../console/types.ts";
import { accountSettings, dashboard, simulator } from "./account.ts";
import { analyzerFindings, analyzers } from "./access-analyzer.ts";
import { credentialReport } from "./credential-report.ts";
import { groups } from "./groups.ts";
import { policies } from "./policies.ts";
import { providers } from "./providers.ts";
import { roles } from "./roles.ts";
import { users } from "./users.ts";

export const iamService: ServiceDef = {
  id: "iam",
  name: "IAM",
  category: "Security, Identity, & Compliance",
  description: "Manage access to AWS resources: users, groups, roles, policies and identity providers.",
  resources: [dashboard, groups, users, roles, policies, providers, accountSettings, analyzers, analyzerFindings, credentialReport, simulator],
  notSupported: [
    "Access Analyzer unused access findings: AWS Emulator doesn't support ListFindingsV2 yet, so only external access findings are listed.",
  ],
};
