/**
 * AWS Systems Manager: Fleet Manager, Run Command, Session Manager, Documents, Parameter
 * Store, Automation, Patch Manager, Maintenance Windows and OpsCenter.
 * Parameter names contain "/", so parameter details use the catch-all route /ssm/parameters/[...name].
 */

import type { ServiceDef } from "../../console/types.ts";
import { managedNodes, runCommand, sessions } from "./commands.ts";
import { automation, documents } from "./documents.ts";
import { maintenanceWindows, opsItems, patchBaselines } from "./operations.ts";
import { parameters } from "./parameters.ts";

export const ssmService: ServiceDef = {
  id: "ssm",
  name: "Systems Manager",
  category: "Management & Governance",
  description: "Operate EC2 and on-premises nodes at scale: run commands, store parameters, automate, patch and track operational issues.",
  resources: [managedNodes, opsItems, runCommand, sessions, automation, documents, parameters, patchBaselines, maintenanceWindows],
  notSupported: [
    "Maintenance window tasks (RegisterTaskWithMaintenanceWindow, DescribeMaintenanceWindowTasks) and executions",
    "Patch groups (RegisterPatchBaselineForPatchGroup, DescribePatchGroups)",
    "Compliance summaries (ListComplianceSummaries)",
    "Deleting OpsItems (after DeleteOpsItem the OpsItem still appears in DescribeOpsItems), so the console offers status changes only",
  ],
};
