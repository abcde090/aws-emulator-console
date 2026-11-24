/**
 * Where AWS Emulator writes its files for this machine: ~/.aws/emulator/<port>/.
 * The emulator writes new keys on every start, so callers read them fresh.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_EMULATOR_PORT = 9297;
export const ACCOUNT_ID = "000000000000";

/** EMULATOR_PORT, validated: a port number, never a string that could change the host. */
export function emulatorPort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.EMULATOR_PORT;
  if (raw === undefined || raw === "") return DEFAULT_EMULATOR_PORT;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error(`EMULATOR_PORT must be a port number (1-65535), got "${raw}"`);
  }
  return Number(raw);
}

export function emulatorEndpoint(port = emulatorPort()): string {
  return `https://127.0.0.1:${port}`;
}

export interface EmulatorFiles {
  dir: string;
  config: string;
  credentials: string;
  ca: string;
}

export function emulatorFiles(port = emulatorPort(), home = homedir()): EmulatorFiles {
  const dir = join(home, ".aws", "emulator", String(port));
  return { dir, config: join(dir, "config"), credentials: join(dir, "emulator_credentials"), ca: join(dir, "ca.pem") };
}

export interface StaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Reads the [default] profile of an AWS credentials file. */
export function parseCredentialsIni(text: string, profile = "default"): StaticCredentials | null {
  let section: string | null = null;
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== profile) continue;
    const eq = line.indexOf("=");
    if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const accessKeyId = values.aws_access_key_id;
  const secretAccessKey = values.aws_secret_access_key;
  if (!accessKeyId || !secretAccessKey) return null;
  return values.aws_session_token ? { accessKeyId, secretAccessKey, sessionToken: values.aws_session_token } : { accessKeyId, secretAccessKey };
}
