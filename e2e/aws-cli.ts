/**
 * Runs the aws CLI for e2e checks, always against the emulator. Every call sources
 * ~/projects/aws-emulator/emulator-env.sh first (this machine also has REAL AWS keys),
 * and the first call in a process checks that the account is 000000000000.
 * Arguments are passed as "$@", never pasted into the shell string.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const ENV_FILE = join(homedir(), "projects", "aws-emulator", "emulator-env.sh");
const SCRIPT = 'source "$0" && exec aws "$@"';
export const EMULATOR_ACCOUNT = "000000000000";

function rawAws(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/bin/bash", ["-c", SCRIPT, ENV_FILE, ...args, "--output", "json"], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`aws ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

let verified: Promise<void> | null = null;

export function verifyEmulatorAccount(): Promise<void> {
  verified ??= rawAws(["sts", "get-caller-identity"]).then((out) => {
    const account = (JSON.parse(out) as { Account?: string }).Account;
    if (account !== EMULATOR_ACCOUNT) {
      throw new Error(`STOP: the aws CLI is talking to account ${account}, not the emulator (${EMULATOR_ACCOUNT}). Refusing to continue.`);
    }
  });
  return verified;
}

/** aws <args> --output json, parsed. Empty output gives null. */
export async function aws<T = unknown>(...args: string[]): Promise<T | null> {
  await verifyEmulatorAccount();
  const out = (await rawAws(args)).trim();
  return out === "" ? null : (JSON.parse(out) as T);
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
