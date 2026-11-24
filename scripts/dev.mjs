#!/usr/bin/env node
/**
 * Runs the console against the local AWS Emulator:
 *   node scripts/dev.mjs          -> next dev   (npm run dev)
 *   node scripts/dev.mjs start    -> next start (npm start, after npm run build)
 *
 * Points every AWS tool at the emulator's own files in ~/.aws/emulator/<port>/ and drops
 * any real AWS credentials from the environment, so nothing here can reach real AWS.
 * Binds to 127.0.0.1 only. Starts Next with spawn and an argument list, never a shell.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function portFrom(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    console.error(`${name} must be a port number (1-65535), got "${raw}"`);
    process.exit(1);
  }
  return Number(raw);
}

const mode = process.argv[2] === "start" ? "start" : "dev";
const emulatorPort = portFrom("EMULATOR_PORT", 9297);
const port = portFrom("PORT", 3001);
const dir = join(homedir(), ".aws", "emulator", String(emulatorPort));
const files = { ca: join(dir, "ca.pem"), credentials: join(dir, "emulator_credentials"), config: join(dir, "config") };

const missing = Object.values(files).filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error(`AWS Emulator files not found:\n  ${missing.join("\n  ")}\nStart the emulator first: ./scripts/emulator.sh start`);
  process.exit(1);
}

const env = { ...process.env };
// Real AWS credentials and profiles must never reach the console or its child processes.
for (const key of Object.keys(env)) {
  if (/^AWS_/.test(key)) delete env[key];
}
Object.assign(env, {
  EMULATOR_PORT: String(emulatorPort),
  NODE_EXTRA_CA_CERTS: files.ca,
  AWS_SHARED_CREDENTIALS_FILE: files.credentials,
  AWS_CONFIG_FILE: files.config,
  AWS_EC2_METADATA_DISABLED: "true",
  AWS_REGION: "us-east-1",
  NEXT_TELEMETRY_DISABLED: "1",
});

const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
if (!existsSync(nextBin)) {
  console.error("Next.js is not installed. Run: npm ci --ignore-scripts");
  process.exit(1);
}

const child = spawn(process.execPath, [nextBin, mode, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
