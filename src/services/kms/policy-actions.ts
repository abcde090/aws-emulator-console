"use server";

/** Key policy editor for the hand-built KMS key page (GetKeyPolicy / PutKeyPolicy). */

import { DescribeKeyCommand, GetKeyPolicyCommand, PutKeyPolicyCommand } from "@aws-sdk/client-kms";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { prettyPolicy, requirePolicy } from "../iam/policy-json.ts";

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function keyId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(v)) throw new Error("That is not a key ID.");
  return v;
}

export async function readKeyPolicy(id: string): Promise<Result<{ text: string; awsManaged: boolean }>> {
  return attempt(async () => {
    const k = keyId(id);
    const [p, d] = await Promise.all([clients.kms.send(new GetKeyPolicyCommand({ KeyId: k, PolicyName: "default" })), clients.kms.send(new DescribeKeyCommand({ KeyId: k }))]);
    return { text: prettyPolicy(p.Policy), awsManaged: d.KeyMetadata?.KeyManager === "AWS" };
  });
}

export async function saveKeyPolicy(id: string, text: string): Promise<Result<string>> {
  return attempt(async () => {
    const doc = requirePolicy(text, "resource");
    await clients.kms.send(new PutKeyPolicyCommand({ KeyId: keyId(id), PolicyName: "default", Policy: doc }));
    return "Key policy saved.";
  });
}
