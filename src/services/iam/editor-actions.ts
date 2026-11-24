"use server";

/**
 * Server actions for the hand-built IAM screens: trust policy editor, managed policy
 * editor (new default version), account alias and the policy simulator. All use the
 * permission-checked IAM client and return Result values; they never throw to the browser.
 */

import {
  CreateAccountAliasCommand,
  CreatePolicyVersionCommand,
  DeleteAccountAliasCommand,
  DeletePolicyVersionCommand,
  ListPolicyVersionsCommand,
  SimulateCustomPolicyCommand,
  SimulatePrincipalPolicyCommand,
  UpdateAssumeRolePolicyCommand,
  type EvaluationResult,
} from "@aws-sdk/client-iam";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { requirePolicy } from "./policy-json.ts";
import { parseActionNames, simulationRows, type SimulationRow } from "./simulator-rows.ts";

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

const name = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.trim() === "" || v.length > 2048) throw new Error(`Missing ${what}.`);
  return v.trim();
};

export async function saveTrustPolicy(roleName: string, text: string): Promise<Result<string>> {
  return attempt(async () => {
    const doc = requirePolicy(text, "trust");
    await clients.iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: name(roleName, "role name"), PolicyDocument: doc }));
    return "Trust policy updated.";
  });
}

/** Saves an edited managed policy as a new default version, deleting the oldest non-default one when five exist (as the console offers). */
export async function savePolicyVersion(policyArn: string, text: string): Promise<Result<string>> {
  return attempt(async () => {
    const arn = name(policyArn, "policy ARN");
    if (arn.startsWith("arn:aws:iam::aws:policy/")) throw new Error("AWS managed policies can't be edited.");
    const doc = requirePolicy(text, "identity", true);
    const versions = (await clients.iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn }))).Versions ?? [];
    let removed = "";
    if (versions.length >= 5) {
      const oldest = versions.filter((v) => !v.IsDefaultVersion).sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0))[0];
      if (oldest?.VersionId) {
        await clients.iam.send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: oldest.VersionId }));
        removed = ` Deleted the oldest version ${oldest.VersionId} (a policy can have five versions).`;
      }
    }
    const r = await clients.iam.send(new CreatePolicyVersionCommand({ PolicyArn: arn, PolicyDocument: doc, SetAsDefault: true }));
    return `Saved as version ${r.PolicyVersion?.VersionId ?? "?"} and set as default.${removed}`;
  });
}

export async function createAccountAlias(alias: string): Promise<Result<string>> {
  return attempt(async () => {
    const a = name(alias, "alias");
    if (!/^[a-z0-9](([a-z0-9]|-(?!-))*[a-z0-9])?$/.test(a) || a.length < 3 || a.length > 63) throw new Error("An alias is 3-63 lowercase letters, numbers and single hyphens, starting and ending with a letter or number.");
    await clients.iam.send(new CreateAccountAliasCommand({ AccountAlias: a }));
    return `Account alias set to ${a}.`;
  });
}

export async function deleteAccountAlias(alias: string): Promise<Result<string>> {
  return attempt(async () => {
    await clients.iam.send(new DeleteAccountAliasCommand({ AccountAlias: name(alias, "alias") }));
    return `Deleted account alias ${alias}.`;
  });
}

export interface SimulationInput {
  mode: "principal" | "custom";
  principalArn: string;
  policy: string;
  actions: string;
  resources: string;
}

export async function runSimulation(input: SimulationInput): Promise<Result<SimulationRow[]>> {
  return attempt(async () => {
    const actions = parseActionNames(input?.actions);
    if (actions.length === 0) throw new Error("Enter at least one action, for example s3:GetObject.");
    if (actions.length > 100) throw new Error("Simulate at most 100 actions at a time.");
    const resources = parseActionNames(input?.resources, true);
    let results: EvaluationResult[];
    if (input?.mode === "custom") {
      const doc = requirePolicy(input.policy, "identity");
      results = (await clients.iam.send(new SimulateCustomPolicyCommand({ PolicyInputList: [doc], ActionNames: actions, ResourceArns: resources.length ? resources : undefined }))).EvaluationResults ?? [];
    } else {
      const arn = name(input?.principalArn, "principal");
      results = (await clients.iam.send(new SimulatePrincipalPolicyCommand({ PolicySourceArn: arn, ActionNames: actions, ResourceArns: resources.length ? resources : undefined }))).EvaluationResults ?? [];
    }
    return simulationRows(results);
  });
}
