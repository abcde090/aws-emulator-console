"use server";

/** Server actions used by the console shell (CloudShell, the identity menu and the Region menu). */

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { runCloudShell, type CloudShellResult } from "@/lib/cli-runner";
import { isConsoleRegion, REGION_COOKIE } from "@/lib/regions";
import { listSwitchableIdentities, type IdentityChoice } from "@/lib/identity";
import { errorMessage } from "@/console/serialize";
import type { Result } from "@/console/types";

export async function runCloudShellCommand(line: string): Promise<CloudShellResult> {
  try {
    return await runCloudShell(line);
  } catch (err: unknown) {
    return { ok: false, output: errorMessage(err), exitCode: null };
  }
}

export async function listIdentities(): Promise<Result<IdentityChoice[]>> {
  try {
    return { ok: true, data: await listSwitchableIdentities() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * Chooses the Region for every Regional page and CloudShell. Only the console's own Region
 * codes are accepted (the cookie is validated again on every read).
 */
export async function switchRegion(code: string): Promise<Result<{ region: string }>> {
  if (!isConsoleRegion(code)) return { ok: false, error: `"${String(code).slice(0, 40)}" is not a Region this console offers.` };
  try {
    const store = await cookies();
    store.set(REGION_COOKIE, code, { httpOnly: true, sameSite: "strict", path: "/", maxAge: ONE_YEAR_SECONDS });
    revalidatePath("/", "layout");
    return { ok: true, data: { region: code } };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}
