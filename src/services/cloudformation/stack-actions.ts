"use server";

/**
 * Server reads for the hand-built CloudFormation screens (stack wizard and change set page).
 * Writes go through the engine (createResource / runAction on the stacks definition).
 * Every call uses the permission-checked CloudFormation client.
 */

import { DescribeChangeSetCommand, DescribeStacksCommand, GetTemplateSummaryCommand, type Change, type DescribeChangeSetCommandOutput } from "@aws-sdk/client-cloudformation";
import { clients } from "../../lib/aws.ts";
import { errorMessage, toPlain } from "../../console/serialize.ts";
import type { Result, Row } from "../../console/types.ts";
import { changeDetailRows, changeRows, isStackName, templateSource, type CurrentParameter, type TemplateParameter } from "./helpers.ts";

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

export interface TemplateSummary {
  description: string | null;
  parameters: TemplateParameter[];
  capabilities: string[];
  capabilitiesReason: string | null;
  resourceTypes: string[];
}

export interface TemplateInput {
  source: string;
  body: string;
  url: string;
  /** For "current": the stack whose template is reused. */
  stackName?: string;
}

/** GetTemplateSummary for the template the user chose: its parameters and required capabilities. */
export async function summarizeTemplate(input: TemplateInput): Promise<Result<TemplateSummary>> {
  return attempt(async () => {
    const i = (input ?? {}) as Partial<TemplateInput>;
    const current = i.source === "current";
    if (current && !isStackName(i.stackName)) throw new Error("Missing stack name.");
    const src = templateSource(i.source, i.body, i.url, current);
    const r = await clients.cloudformation.send(
      new GetTemplateSummaryCommand("UsePreviousTemplate" in src ? { StackName: i.stackName } : src)
    );
    return {
      description: r.Description ?? null,
      parameters: (r.Parameters ?? []).filter((p) => p.ParameterKey).map((p) => ({
        key: p.ParameterKey as string,
        type: p.ParameterType ?? null,
        defaultValue: p.DefaultValue ?? null,
        description: p.Description ?? null,
        noEcho: p.NoEcho === true,
        allowedValues: p.ParameterConstraints?.AllowedValues ?? [],
      })),
      capabilities: (r.Capabilities ?? []).map(String),
      capabilitiesReason: r.CapabilitiesReason ?? null,
      resourceTypes: r.ResourceTypes ?? [],
    };
  });
}

export interface StackForUpdate {
  name: string;
  status: string | null;
  parameters: CurrentParameter[];
}

export async function stackForUpdate(name: string): Promise<Result<StackForUpdate>> {
  return attempt(async () => {
    if (!isStackName(name)) throw new Error("That is not a valid stack name.");
    const r = await clients.cloudformation.send(new DescribeStacksCommand({ StackName: name }));
    const s = r.Stacks?.[0];
    if (!s) throw new Error(`Stack ${name} does not exist.`);
    return {
      name: s.StackName ?? name,
      status: s.StackStatus ?? null,
      parameters: (s.Parameters ?? []).filter((p) => p.ParameterKey).map((p) => ({ key: p.ParameterKey as string, value: p.ParameterValue ?? null })),
    };
  });
}

export interface ChangeSetView {
  summary: Row;
  status: string | null;
  executionStatus: string | null;
  changes: Row[];
  details: Row[];
  parameters: Row[];
  raw: unknown;
}

export async function describeChangeSet(stack: string, changeSet: string): Promise<Result<ChangeSetView>> {
  return attempt(async () => {
    if (!isStackName(stack) || !isStackName(changeSet)) throw new Error("That is not a valid stack or change set name.");
    const changes: Change[] = [];
    let token: string | undefined;
    let first: DescribeChangeSetCommandOutput | null = null;
    for (let i = 0; i < 20; i++) {
      const r = await clients.cloudformation.send(new DescribeChangeSetCommand({ StackName: stack, ChangeSetName: changeSet, NextToken: token }));
      first ??= r;
      changes.push(...(r.Changes ?? []));
      token = r.NextToken;
      if (!token) break;
    }
    if (!first) throw new Error(`Change set ${changeSet} not found.`);
    return {
      summary: {
        "Change set name": first.ChangeSetName ?? changeSet,
        "Stack name": first.StackName ?? stack,
        Status: first.Status ?? null,
        "Execution status": first.ExecutionStatus ?? null,
        "Status reason": first.StatusReason ?? null,
        Description: first.Description ?? null,
        "Created time": first.CreationTime ? first.CreationTime.toISOString() : null,
        "Change set ID": first.ChangeSetId ?? null,
        Capabilities: (first.Capabilities ?? []).join(", ") || null,
      },
      status: first.Status ?? null,
      executionStatus: first.ExecutionStatus ?? null,
      changes: changeRows(changes),
      details: changeDetailRows(changes),
      parameters: (first.Parameters ?? []).map((p) => ({ key: p.ParameterKey ?? null, value: p.ParameterValue ?? null })),
      raw: toPlain(changes),
    };
  });
}
