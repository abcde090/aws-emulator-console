/**
 * Runs the aws CLI for CloudShell: a fresh temp folder, macOS sandbox-exec, an argument list
 * (never a shell), a minimal environment and no stdin. The caller has already run
 * cloudshell-guard.ts and the IAM simulator. No Next.js imports, so it can be tested directly.
 */

import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emulatorFiles } from "./emulator-files.ts";
import {
  AWS_BINARY_CANDIDATES,
  buildChildEnv,
  buildSandboxProfile,
  capOutput,
  CLOUDSHELL_MAX_OUTPUT,
  CLOUDSHELL_TIMEOUT_MS,
  rewriteCliConfig,
  type WorkPaths,
} from "./cloudshell-sandbox.ts";

export interface CloudShellResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
}

export function findAwsBinary(): string | null {
  for (const candidate of AWS_BINARY_CANDIDATES) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

async function prepareWorkDir(port: number): Promise<WorkPaths> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cloudshell-")));
  const conf = join(dir, "conf");
  const paths: WorkPaths = {
    dir,
    home: join(dir, "home"),
    bin: join(dir, "bin"),
    config: join(conf, "config"),
    credentials: join(conf, "emulator_credentials"),
    ca: join(conf, "ca.pem"),
  };
  await mkdir(conf, { mode: 0o700 });
  await mkdir(paths.home, { mode: 0o700 });
  const src = emulatorFiles(port);
  await copyFile(src.credentials, paths.credentials);
  await copyFile(src.ca, paths.ca);
  await writeFile(paths.config, rewriteCliConfig(await readFile(src.config, "utf8"), paths.ca));
  await Promise.all([chmod(paths.credentials, 0o400), chmod(paths.ca, 0o400), chmod(paths.config, 0o400)]);
  await mkdir(paths.bin, { mode: 0o700 });
  // Expose only mandoc in PATH so `aws help` / `aws <service> help` can render man pages.
  await symlink("/usr/bin/mandoc", join(paths.bin, "mandoc")).catch(() => {});
  await chmod(paths.bin, 0o500);
  await writeFile(join(dir, "sandbox.sb"), buildSandboxProfile(paths, port), { mode: 0o400 });
  return paths;
}

function runSandboxed(binary: string, args: string[], paths: WorkPaths, port: number, region: string): Promise<CloudShellResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "/usr/bin/sandbox-exec",
      ["-f", join(paths.dir, "sandbox.sb"), binary, ...args],
      {
        // An empty folder: relative paths in the command cannot name the key files in conf/.
        cwd: paths.home,
        // The whole environment: nothing from this process (NODE_ENV included) is passed on.
        env: buildChildEnv(paths, port, region) as unknown as NodeJS.ProcessEnv,
        timeout: CLOUDSHELL_TIMEOUT_MS,
        maxBuffer: CLOUDSHELL_MAX_OUTPUT,
        killSignal: "SIGKILL",
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const output = capOutput(`${stdout}${stderr}`.replace(/.\x08/g, ""));
        if (!err) return resolve({ ok: true, output, exitCode: 0 });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (e.killed) return resolve({ ok: false, output: `${output}\n[stopped after ${CLOUDSHELL_TIMEOUT_MS / 1000} s]`, exitCode: null });
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ ok: false, output: `${output}\n[output over ${CLOUDSHELL_MAX_OUTPUT} bytes; stopped]`, exitCode: null });
        resolve({ ok: false, output: output || e.message, exitCode: typeof e.code === "number" ? e.code : null });
      }
    );
    child.stdin?.end();
  });
}

/**
 * Runs the CLI with `args` in a fresh sandboxed folder, in `region` (AWS_REGION and
 * AWS_DEFAULT_REGION), and removes the folder afterwards.
 */
export async function executeSandboxed(binary: string, args: string[], port: number, region: string): Promise<CloudShellResult> {
  let paths: WorkPaths | null = null;
  try {
    paths = await prepareWorkDir(port);
    return await runSandboxed(binary, args, paths, port, region);
  } finally {
    if (paths) {
      const dir = paths.dir;
      // bin/ is read-only during the run; make it removable again.
      await chmod(paths.bin, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
        console.error(`CloudShell: could not remove ${dir}:`, err);
      });
    }
  }
}
