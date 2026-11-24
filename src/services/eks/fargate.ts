/**
 * Fargate profiles. AWS Emulator implements Create/Describe/DeleteFargateProfile but not
 * ListFargateProfiles, so profiles are managed by name from the cluster's Actions menu.
 */

import { CreateFargateProfileCommand, DeleteFargateProfileCommand, DescribeFargateProfileCommand } from "@aws-sdk/client-eks";
import type { ActionDef } from "../../console/types.ts";
import { tagsToRecord } from "./helpers.ts";
import { roleOptions, subnetOptions } from "./lookups.ts";

const PROFILE_NAME = "[0-9A-Za-z][A-Za-z0-9_-]{0,99}";
const nameField = { name: "profileName", label: "Fargate profile name", kind: "text" as const, required: true, validate: { pattern: PROFILE_NAME, message: "Letters, numbers, hyphens and underscores, starting with a letter or number." } };

export const fargateActions: ActionDef[] = [
  {
    id: "fargate-create",
    label: "Add Fargate profile",
    fields: [
      nameField,
      { name: "podExecutionRoleArn", label: "Pod execution role", kind: "select", required: true, options: roleOptions, help: "The role Fargate uses to pull images and write logs (normally with AmazonEKSFargatePodExecutionRolePolicy)." },
      { name: "subnets", label: "Subnets", kind: "multiselect", required: true, options: subnetOptions, help: "Private subnets only (no route to an internet gateway) in the cluster's VPC." },
      { name: "namespace", label: "Namespace", kind: "text", required: true, placeholder: "default", help: "Pods in this namespace (and matching the labels) run on Fargate." },
      { name: "labels", label: "Match labels", kind: "tags", help: "Pod labels the selector must match." },
      { name: "tags", label: "Tags", kind: "tags" },
    ],
    async run(ctx, cluster, v) {
      const labels = tagsToRecord(v.labels);
      const tags = tagsToRecord(v.tags);
      const r = await ctx.clients.eks.send(
        new CreateFargateProfileCommand({
          clusterName: cluster,
          fargateProfileName: String(v.profileName),
          podExecutionRoleArn: String(v.podExecutionRoleArn),
          subnets: Array.isArray(v.subnets) ? (v.subnets as string[]) : [],
          selectors: [{ namespace: String(v.namespace), labels: Object.keys(labels).length ? labels : undefined }],
          tags: Object.keys(tags).length ? tags : undefined,
        })
      );
      return { message: `Fargate profile ${r.fargateProfile?.fargateProfileName ?? v.profileName} is ${r.fargateProfile?.status ?? "being created"}.`, json: r.fargateProfile };
    },
  },
  {
    id: "fargate-view",
    label: "View Fargate profile",
    fields: [nameField],
    async run(ctx, cluster, v) {
      const p = (await ctx.clients.eks.send(new DescribeFargateProfileCommand({ clusterName: cluster, fargateProfileName: String(v.profileName) }))).fargateProfile;
      return { message: `Fargate profile ${p?.fargateProfileName ?? v.profileName}: ${p?.status ?? "status unknown"}.`, json: p };
    },
  },
  {
    id: "fargate-delete",
    label: "Delete Fargate profile",
    danger: true,
    fields: [nameField],
    async run(ctx, cluster, v) {
      const p = (await ctx.clients.eks.send(new DeleteFargateProfileCommand({ clusterName: cluster, fargateProfileName: String(v.profileName) }))).fargateProfile;
      return { message: `Fargate profile ${p?.fargateProfileName ?? v.profileName} is ${p?.status ?? "being deleted"}.` };
    },
  },
];
