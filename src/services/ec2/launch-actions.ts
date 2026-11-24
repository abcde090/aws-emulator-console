"use server";

/**
 * Server actions for the hand-built EC2 screens (Launch instance wizard, Create key pair).
 * They use the same permission-checked clients (via makeCtx) as the engine and never throw.
 */

import { revalidatePath } from "next/cache";
import { errorMessage } from "../../console/serialize.ts";
import { makeCtx } from "../../console/server.ts";
import type { Result, Tag } from "../../console/types.ts";
import { createKeyPair, importKeyPair, type CreatedKeyPair } from "./key-pairs.ts";
import { launchInstances, launchMessage } from "./launch.ts";
import { parseLaunchSpec } from "./launch-spec.ts";

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const data = await fn();
    try {
      revalidatePath("/ec2", "layout");
    } catch {
      // Only refreshes cached pages; the call itself succeeded.
    }
    return { ok: true, data };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function tagList(raw: unknown): Tag[] {
  if (!Array.isArray(raw)) return [];
  const out: Tag[] = [];
  for (const t of raw.slice(0, 50)) {
    const tag = t as { Key?: unknown; Value?: unknown } | null;
    if (!tag || typeof tag.Key !== "string" || tag.Key.trim() === "") continue;
    out.push({ Key: tag.Key.trim().slice(0, 128), Value: typeof tag.Value === "string" ? tag.Value.slice(0, 256) : "" });
  }
  return out;
}

export async function launchFromWizard(raw: unknown): Promise<Result<{ instanceIds: string[]; securityGroupId: string | null; message: string }>> {
  return attempt(async () => {
    const parsed = parseLaunchSpec(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    const o = await launchInstances(await makeCtx(), parsed.value);
    return { ...o, message: launchMessage(o) };
  });
}

export async function createKeyPairFromForm(raw: unknown): Promise<Result<CreatedKeyPair>> {
  return attempt(async () => {
    const v = (raw ?? {}) as { name?: unknown; type?: unknown; format?: unknown; tags?: unknown };
    return createKeyPair(await makeCtx(), {
      name: typeof v.name === "string" ? v.name : "",
      type: v.type === "ed25519" ? "ed25519" : "rsa",
      format: v.format === "ppk" ? "ppk" : "pem",
      tags: tagList(v.tags),
    });
  });
}

export async function importKeyPairFromForm(raw: unknown): Promise<Result<{ name: string; keyPairId: string | null; fingerprint: string | null }>> {
  return attempt(async () => {
    const v = (raw ?? {}) as { name?: unknown; publicKey?: unknown; tags?: unknown };
    return importKeyPair(await makeCtx(), v.name, v.publicKey, tagList(v.tags));
  });
}
