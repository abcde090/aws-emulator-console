"use server";

/**
 * Server actions for the hand-built secret page: Retrieve secret value, edit the value
 * (PutSecretValue) and the resource permissions editor. Permission-checked client only.
 */

import { DeleteResourcePolicyCommand, GetResourcePolicyCommand, GetSecretValueCommand, PutResourcePolicyCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { prettyPolicy, requirePolicy } from "../iam/policy-json.ts";
import { parseSecretString, type SecretValue } from "./secret-value.ts";

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function secretId(v: unknown): string {
  if (typeof v !== "string" || v === "" || v.length > 2048) throw new Error("Missing secret name.");
  return v;
}

export interface RetrievedSecret {
  value: SecretValue;
  raw: string;
  versionId: string | null;
  stages: string[];
}

export async function retrieveSecretValue(name: string): Promise<Result<RetrievedSecret>> {
  return attempt(async () => {
    const r = await clients.secretsmanager.send(new GetSecretValueCommand({ SecretId: secretId(name) }));
    const raw = r.SecretString ?? "";
    const value: SecretValue = r.SecretString !== undefined ? parseSecretString(raw) : { kind: "binary", bytes: r.SecretBinary?.byteLength ?? 0 };
    return { value, raw, versionId: r.VersionId ?? null, stages: r.VersionStages ?? [] };
  });
}

export async function saveSecretValue(name: string, text: string): Promise<Result<string>> {
  return attempt(async () => {
    if (typeof text !== "string" || text === "") throw new Error("The secret value can't be empty.");
    if (text.length > 65536) throw new Error("A secret value is at most 64 KB.");
    const r = await clients.secretsmanager.send(new PutSecretValueCommand({ SecretId: secretId(name), SecretString: text }));
    return `Saved a new version (${r.VersionId ?? "-"}) labelled ${(r.VersionStages ?? []).join(", ") || "AWSCURRENT"}.`;
  });
}

export async function readResourcePolicy(name: string): Promise<Result<string>> {
  return attempt(async () => prettyPolicy((await clients.secretsmanager.send(new GetResourcePolicyCommand({ SecretId: secretId(name) }))).ResourcePolicy));
}

export async function saveResourcePolicy(name: string, text: string): Promise<Result<string>> {
  return attempt(async () => {
    const doc = requirePolicy(text, "resource");
    await clients.secretsmanager.send(new PutResourcePolicyCommand({ SecretId: secretId(name), ResourcePolicy: doc, BlockPublicPolicy: true }));
    return "Resource permissions saved.";
  });
}

export async function removeResourcePolicy(name: string): Promise<Result<string>> {
  return attempt(async () => {
    await clients.secretsmanager.send(new DeleteResourcePolicyCommand({ SecretId: secretId(name) }));
    return "Resource permissions removed.";
  });
}
