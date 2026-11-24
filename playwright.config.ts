import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// One output folder per run, outside the repo, so two runs (e.g. two agents) can never
// delete each other's files. The id is put in the environment so the worker processes,
// which load this file again, use the same folder.
process.env.E2E_RUN_ID ??= `${Date.now()}-${process.pid}`;
const outputDir = join(tmpdir(), "aws-emulator-console-e2e", process.env.E2E_RUN_ID);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  outputDir,
  // One emulator and one dev server: run tests one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3001",
    // Off by default (traces are large); E2E_TRACE=1 keeps one for each failed test.
    trace: process.env.E2E_TRACE ? "retain-on-failure" : "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3001",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
